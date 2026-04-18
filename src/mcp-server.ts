#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
/**
 * Smallstore MCP Server (Phase 1)
 *
 * Stdio MCP server that forwards tool calls to a running Smallstore HTTP server
 * (started via `deno task serve`). Exposes read/write/list/query/sync/adapters
 * as MCP tools so Claude Code and other MCP clients can drive any configured
 * Smallstore adapter.
 *
 * Env vars:
 *   SMALLSTORE_URL    Base URL of the running server (default: http://localhost:9998)
 *   SMALLSTORE_TOKEN  Optional Bearer token; sent as `Authorization: Bearer ...`
 *
 * Run:
 *   deno task mcp
 *
 * Register in ~/.claude.json under "mcpServers.smallstore":
 *   {
 *     "command": "deno",
 *     "args": ["run", "--allow-net", "--allow-read", "--allow-env",
 *              "/absolute/path/to/smallstore/src/mcp-server.ts"],
 *     "env": { "SMALLSTORE_URL": "http://localhost:9998" }
 *   }
 *
 * @module
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ============================================================================
// Config
// ============================================================================

const RAW_URL = Deno.env.get('SMALLSTORE_URL') ?? 'http://localhost:9998';

// Cap the response body buffered from the HTTP server. A huge sm_list or
// sm_read on Notion/Airtable can otherwise OOM the MCP subprocess since the
// body is buffered + re-stringified with 2-space indent. 10 MB default; set
// SMALLSTORE_MAX_RESPONSE_BYTES to override.
const MAX_RESPONSE_BYTES = (() => {
  const raw = Deno.env.get('SMALLSTORE_MAX_RESPONSE_BYTES');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
})();
try {
  const u = new URL(RAW_URL);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`SMALLSTORE_URL must be http(s), got "${u.protocol}"`);
  }
} catch (err) {
  // Fail fast at startup — much better UX than cryptic errors on first tool call.
  console.error(`[smallstore-mcp] Invalid SMALLSTORE_URL "${RAW_URL}": ${err instanceof Error ? err.message : err}`);
  Deno.exit(1);
}
const SMALLSTORE_URL = RAW_URL.replace(/\/+$/, '');

const SMALLSTORE_TOKEN = Deno.env.get('SMALLSTORE_TOKEN');
if (SMALLSTORE_TOKEN !== undefined && /[\r\n]/.test(SMALLSTORE_TOKEN)) {
  console.error('[smallstore-mcp] SMALLSTORE_TOKEN contains CR/LF — rejecting to avoid HTTP header injection.');
  Deno.exit(1);
}

// ============================================================================
// HTTP helper
// ============================================================================

interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function http(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (SMALLSTORE_TOKEN) headers['Authorization'] = `Bearer ${SMALLSTORE_TOKEN}`;

  const url = `${SMALLSTORE_URL}${path}`;

  // Serialize upfront so BigInt / circular refs / other non-JSON values fail
  // with a clear "bad argument" message instead of a cryptic TypeError from
  // deep inside fetch().
  let serializedBody: string | undefined;
  if (body !== undefined) {
    try {
      serializedBody = JSON.stringify(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`sm_write/sm_query body is not JSON-serializable: ${msg}`);
    }
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: serializedBody });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Smallstore HTTP server unreachable at ${SMALLSTORE_URL} — ${msg}. Is 'deno task serve' running?`);
  }

  // Stream-read with a byte cap so we can't OOM the MCP subprocess on a
  // huge Notion/Airtable payload. Bail out with a clear error rather than
  // silently truncate — truncating JSON would produce parse errors
  // downstream anyway.
  const text = await readCapped(res, MAX_RESPONSE_BYTES);
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel();
        throw new Error(
          `Smallstore response exceeded ${maxBytes} bytes. Use a prefix/limit to narrow the request, or raise SMALLSTORE_MAX_RESPONSE_BYTES.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    try { reader.releaseLock(); } catch { /* already cancelled */ }
  }
  return chunks.join('');
}

/**
 * Collection names with reserved sub-route words would collide with the
 * server's /api/:collection/{keys,query,search,metadata,schema} endpoints.
 */
const RESERVED_COLLECTION_SEGMENTS = new Set([
  'keys', 'query', 'search', 'metadata', 'schema', 'slice', 'split', 'deduplicate',
]);

function validateCollection(collection: string): void {
  const trimmed = collection.trim();
  if (trimmed.length === 0) throw new Error('collection must be a non-empty string');
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`collection contains reserved path characters: ${JSON.stringify(collection)}`);
  }
  if (RESERVED_COLLECTION_SEGMENTS.has(trimmed)) {
    throw new Error(`collection name "${trimmed}" collides with a Smallstore sub-route — rename the collection`);
  }
}

function encodeCollectionKey(collection: string, key?: string): string {
  validateCollection(collection);
  const col = encodeURIComponent(collection);
  if (key === undefined || key === '') return `/api/${col}`;
  // Preserve slashes in keys so nested paths keep their shape on the server.
  const k = key.split('/').map(encodeURIComponent).join('/');
  return `/api/${col}/${k}`;
}

// ============================================================================
// Tool definitions
// ============================================================================

const TOOLS = [
  {
    name: 'sm_read',
    description: 'Read a single record from a Smallstore collection (or a nested path). Returns the stored value along with collection/adapter metadata. Omitting `key` reads the whole collection, which can be expensive on Notion/Airtable/Sheets — prefer passing a specific key or using sm_list/sm_query when possible.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name (e.g. "users", "notes").' },
        key: { type: 'string', description: 'Record key / sub-path within the collection (e.g. "alice"). Omit to read the whole collection — expensive on remote adapters.' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'sm_write',
    description: 'Write (overwrite) a record at collection/key with the given JSON object. Uses HTTP PUT, so existing values at the key are replaced.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        key: { type: 'string', description: 'Record key / sub-path.' },
        data: {
          description: 'JSON object (or any JSON value) to store at collection/key.',
        },
      },
      required: ['collection', 'key', 'data'],
    },
  },
  {
    name: 'sm_delete',
    description: 'Delete a record at collection/key.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        key: { type: 'string', description: 'Record key / sub-path.' },
      },
      required: ['collection', 'key'],
    },
  },
  {
    name: 'sm_list',
    description: 'List keys in a collection. Optionally filter by prefix. Note: limit is enforced client-side after fetching all keys.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        options: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: 'Only include keys starting with this prefix.' },
            limit: { type: 'number', description: 'Maximum number of keys to return.' },
          },
        },
      },
      required: ['collection'],
    },
  },
  {
    name: 'sm_query',
    description: 'Structured query over a collection using a MongoDB-style filter object. Forwards to POST /api/:collection/query.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        filter: {
          type: 'object',
          description: 'Filter object (e.g. { status: "active", "meta.tag": { "$in": ["a", "b"] } }). Can also be a full QueryOptions object with where/limit/sort.',
        },
      },
      required: ['collection', 'filter'],
    },
  },
  {
    name: 'sm_sync',
    description: 'Sync data between two configured adapters (push/pull/bidirectional). Wraps syncAdapters() via the server\'s /_sync endpoint. source_adapter/target_adapter are ADAPTER names (e.g. "notion", "local"), not collection names.',
    inputSchema: {
      type: 'object',
      properties: {
        source_adapter: { type: 'string', description: 'Source adapter name (e.g. "notion", "local"). Must match an adapter configured on the server. Call sm_adapters to list available adapter names.' },
        target_adapter: { type: 'string', description: 'Target adapter name. Must match an adapter configured on the server.' },
        options: {
          type: 'object',
          description: 'SyncAdapterOptions: { mode?: "push"|"pull"|"sync", prefix?, targetPrefix?, overwrite?, skipUnchanged?, dryRun?, batchDelay?, syncId?, conflictResolution?: "source-wins"|"target-wins"|"skip" }. Function-valued options (transform/onProgress) are not supported over HTTP.',
          properties: {
            mode: { type: 'string', enum: ['push', 'pull', 'sync'] },
            prefix: { type: 'string' },
            targetPrefix: { type: 'string' },
            overwrite: { type: 'boolean' },
            skipUnchanged: { type: 'boolean' },
            dryRun: { type: 'boolean' },
            batchDelay: { type: 'number' },
            syncId: { type: 'string' },
            conflictResolution: { type: 'string', enum: ['source-wins', 'target-wins', 'skip'] },
          },
        },
      },
      required: ['source_adapter', 'target_adapter'],
    },
  },
  {
    name: 'sm_adapters',
    description: 'List configured adapters, mounts, and default adapter on the running Smallstore server. Useful for agent orientation.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ============================================================================
// Tool handlers
// ============================================================================

type Args = Record<string, unknown>;

function requireString(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing required string argument: "${name}"`);
  }
  return v;
}

function formatHttpError(prefix: string, r: HttpResult): string {
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return `${prefix}: HTTP ${r.status} — ${body}`;
}

async function callTool(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case 'sm_read': {
      const collection = requireString(args, 'collection');
      const key = typeof args.key === 'string' ? args.key : undefined;
      const r = await http('GET', encodeCollectionKey(collection, key));
      if (!r.ok) throw new Error(formatHttpError('sm_read failed', r));
      return r.body;
    }

    case 'sm_write': {
      const collection = requireString(args, 'collection');
      const key = requireString(args, 'key');
      if (!('data' in args)) throw new Error('sm_write requires a "data" argument');
      const r = await http('PUT', encodeCollectionKey(collection, key), { data: args.data });
      if (!r.ok) throw new Error(formatHttpError('sm_write failed', r));
      return r.body;
    }

    case 'sm_delete': {
      const collection = requireString(args, 'collection');
      const key = requireString(args, 'key');
      const r = await http('DELETE', encodeCollectionKey(collection, key));
      if (!r.ok) throw new Error(formatHttpError('sm_delete failed', r));
      return r.body;
    }

    case 'sm_list': {
      const collection = requireString(args, 'collection');
      const options = (args.options as { prefix?: string; limit?: number } | undefined) ?? {};
      const qs = new URLSearchParams();
      if (options.prefix) qs.set('prefix', options.prefix);
      const path = `/api/${encodeURIComponent(collection)}/keys${qs.toString() ? `?${qs}` : ''}`;
      const r = await http('GET', path);
      if (!r.ok) throw new Error(formatHttpError('sm_list failed', r));
      // Client-side limit — server returns all keys matching the prefix.
      // Preserve the true server-side total under `totalAvailable` so the
      // caller can detect "there's more than you see".
      if (options.limit && r.body && typeof r.body === 'object' && Array.isArray((r.body as { keys?: unknown[] }).keys)) {
        const b = r.body as { keys: unknown[]; total?: number; totalAvailable?: number };
        const serverTotal = typeof b.total === 'number' ? b.total : b.keys.length;
        return {
          ...b,
          keys: b.keys.slice(0, options.limit),
          total: Math.min(options.limit, serverTotal),
          totalAvailable: serverTotal,
          truncated: serverTotal > options.limit,
        };
      }
      return r.body;
    }

    case 'sm_query': {
      const collection = requireString(args, 'collection');
      validateCollection(collection);
      // Reject empty filters — on remote-backed adapters (Notion, Airtable)
      // an empty filter is a full-collection scan, which is often a costly
      // footgun. Callers that actually want everything should use sm_list.
      const filter = args.filter as Record<string, unknown> | undefined;
      if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) {
        throw new Error('sm_query requires a non-empty filter object. Use sm_list to list all records.');
      }
      const r = await http('POST', `/api/${encodeURIComponent(collection)}/query`, filter);
      if (!r.ok) throw new Error(formatHttpError('sm_query failed', r));
      return r.body;
    }

    case 'sm_sync': {
      const source = requireString(args, 'source_adapter');
      const target = requireString(args, 'target_adapter');
      const options = (args.options as Record<string, unknown> | undefined) ?? {};
      const r = await http('POST', '/_sync', { source, target, options });
      if (!r.ok) throw new Error(formatHttpError('sm_sync failed', r));
      return r.body;
    }

    case 'sm_adapters': {
      const r = await http('GET', '/_adapters');
      if (!r.ok) throw new Error(formatHttpError('sm_adapters failed', r));
      return r.body;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// Server wiring
// ============================================================================

const server = new Server(
  { name: 'smallstore', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (req: { params: { name: string; arguments?: Args } }) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Args;
  try {
    const result = await callTool(name, args);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
});

const transport = new StdioServerTransport();

// Graceful shutdown — close the transport + server on SIGTERM / SIGINT so
// in-flight fetches get a chance to cancel instead of the process being
// killed mid-request. Claude Code normally kills the subprocess; this is
// a best-effort drain.
async function shutdown(signal: string) {
  try { await server.close(); } catch { /* ignore */ }
  try { await transport.close(); } catch { /* ignore */ }
  // Exit with the signal's conventional code (128 + signum).
  Deno.exit(signal === 'SIGINT' ? 130 : 143);
}
try { Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM')); } catch { /* unsupported on some platforms */ }
try { Deno.addSignalListener('SIGINT', () => shutdown('SIGINT')); } catch { /* unsupported on some platforms */ }

await server.connect(transport);
