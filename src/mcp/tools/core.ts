/**
 * Core smallstore MCP tools — the original `sm_*` surface that predates
 * the tool-family split. Wraps `/api/*`, `/_sync`, `/_sync/jobs`, `/_adapters`.
 *
 * Semantics unchanged from the pre-reorg `src/mcp-server.ts`. If you're
 * adding a new tool for an existing smallstore HTTP route, it goes here.
 * For mailroom-specific tools, see `./inbox.ts`. For peer-registry tools,
 * see `./peers.ts`.
 */

import {
  encodeCollectionKey,
  formatHttpError,
  requireString,
  validateName,
  type Args,
  type HttpFn,
  type Tool,
} from './types.ts';

// ============================================================================
// Tool metadata
// ============================================================================

export const CORE_TOOLS: Tool[] = [
  {
    name: 'sm_read',
    description:
      'Read a single record from a Smallstore collection (or a nested path). Returns the stored value along with collection/adapter metadata. Omitting `key` reads the whole collection, which can be expensive on Notion/Airtable/Sheets — prefer passing a specific key or using sm_list/sm_query when possible.',
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
    description:
      'Write (overwrite) a record at collection/key with the given JSON object. Uses HTTP PUT, so existing values at the key are replaced.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        key: { type: 'string', description: 'Record key / sub-path.' },
        data: { description: 'JSON object (or any JSON value) to store at collection/key.' },
      },
      required: ['collection', 'key', 'data'],
    },
  },
  {
    name: 'sm_append',
    description:
      "Non-destructive append to a collection. Use this instead of sm_write when the adapter is append-log-shaped (Sheetlog, Google Sheets, audit logs). Unlike sm_write — which for these adapters is a destructive wipe-and-replace because of the sheet-as-array KV shape — sm_append maps to the adapter's native append primitive. Returns 501 NotImplemented for adapters without native append. For Sheetlog, pass items with matching column keys; auto-generated `_id` is included in the response (server-side assignment in sheetlog v0.1.17+).",
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name (or collection/sub-path). For Sheetlog mounts, this is the adapter mount path (e.g. "sheets/Sheet1").' },
        items: { description: 'Single row object or array of row objects. Keys should match the sheet column headers; missing headers are filled with empty. Sheetlog will auto-generate `_id` if the `_id` column exists and the payload omits it.' },
      },
      required: ['collection', 'items'],
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
    description:
      'List keys in a collection with optional pagination. Returns `{ keys, hasMore, cursor?, total? }`. Pass back `cursor` or advance `offset` to fetch the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        options: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: 'Only include keys starting with this prefix.' },
            limit: { type: 'number', description: 'Maximum number of keys per page (server-enforced when the adapter supports it).' },
            offset: { type: 'number', description: 'Absolute offset into the full key list. Ignored if `cursor` is set.' },
            cursor: { type: 'string', description: 'Opaque cursor from a previous page. Adapter-specific (Upstash SCAN, Notion page cursor, Airtable offset, etc.).' },
          },
        },
      },
      required: ['collection'],
    },
  },
  {
    name: 'sm_query',
    description:
      'Structured query over a collection using a MongoDB-style filter object. Forwards to POST /api/:collection/query.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name.' },
        filter: { type: 'object', description: 'Filter object (e.g. { status: "active", "meta.tag": { "$in": ["a", "b"] } }). Can also be a full QueryOptions object with where/limit/sort.' },
      },
      required: ['collection', 'filter'],
    },
  },
  {
    name: 'sm_sync',
    description:
      "Sync data between two configured adapters (push/pull/bidirectional). Wraps syncAdapters() via the server's /_sync endpoint. source_adapter/target_adapter are ADAPTER names (e.g. \"notion\", \"local\"), not collection names. By default waits for completion and returns the result inline; pass background:true for long-running syncs that write progress to a JSONL log (poll `sm_sync_status` or tail the file).",
    inputSchema: {
      type: 'object',
      properties: {
        source_adapter: { type: 'string', description: 'Source adapter name (e.g. "notion", "local"). Must match an adapter configured on the server. Call sm_adapters to list available adapter names.' },
        target_adapter: { type: 'string', description: 'Target adapter name. Must match an adapter configured on the server.' },
        background: { type: 'boolean', description: 'When true, return a jobId + logPath immediately and run the sync in the background. Default: false (wait for completion).' },
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
    name: 'sm_sync_status',
    description:
      'Check the status of a sync job by its jobId. Returns the summary + the last N events from the JSONL log. Use with background: true sync calls.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job ID returned from sm_sync (background mode).' },
        tail: { type: 'number', description: 'Max events to return (default 50). Pass a very large number or string "all" for everything.' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'sm_sync_jobs',
    description:
      'List recent sync jobs (newest first) with their status + summary. Useful for post-mortem after a crash or to see what ran overnight.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max jobs to return (default 50).' },
      },
    },
  },
  {
    name: 'sm_adapters',
    description:
      'List configured adapters, mounts, and default adapter on the running Smallstore server. Useful for agent orientation.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ============================================================================
// Handlers
// ============================================================================

export async function handleCoreTool(
  name: string,
  args: Args,
  http: HttpFn,
): Promise<unknown> {
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

    case 'sm_append': {
      const collection = requireString(args, 'collection');
      validateName(collection, 'collection');
      if (!('items' in args)) throw new Error('sm_append requires an "items" argument (single object or array)');
      const r = await http('POST', `/api/${encodeURIComponent(collection)}/append`, { items: args.items });
      if (!r.ok) throw new Error(formatHttpError('sm_append failed', r));
      return r.body;
    }

    case 'sm_list': {
      const collection = requireString(args, 'collection');
      validateName(collection, 'collection');
      const options = (args.options as { prefix?: string; limit?: number; offset?: number; cursor?: string } | undefined) ?? {};
      const qs = new URLSearchParams();
      if (options.prefix) qs.set('prefix', options.prefix);
      if (options.limit !== undefined) qs.set('limit', String(options.limit));
      if (options.offset !== undefined) qs.set('offset', String(options.offset));
      if (options.cursor !== undefined) qs.set('cursor', options.cursor);
      const path = `/api/${encodeURIComponent(collection)}/keys${qs.toString() ? `?${qs}` : ''}`;
      const r = await http('GET', path);
      if (!r.ok) throw new Error(formatHttpError('sm_list failed', r));
      return r.body;
    }

    case 'sm_query': {
      const collection = requireString(args, 'collection');
      validateName(collection, 'collection');
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
      const background = args.background === true;
      const options = (args.options as Record<string, unknown> | undefined) ?? {};
      const path = background ? '/_sync' : '/_sync?wait=true';
      const r = await http('POST', path, { source, target, options });
      if (!r.ok) throw new Error(formatHttpError('sm_sync failed', r));
      return r.body;
    }

    case 'sm_sync_status': {
      const jobId = requireString(args, 'jobId');
      if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
        throw new Error('sm_sync_status: invalid jobId');
      }
      const tail = args.tail;
      const qs = tail !== undefined ? `?tail=${encodeURIComponent(String(tail))}` : '';
      const r = await http('GET', `/_sync/jobs/${encodeURIComponent(jobId)}${qs}`);
      if (!r.ok) throw new Error(formatHttpError('sm_sync_status failed', r));
      return r.body;
    }

    case 'sm_sync_jobs': {
      const limit = args.limit;
      const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
      const r = await http('GET', `/_sync/jobs${qs}`);
      if (!r.ok) throw new Error(formatHttpError('sm_sync_jobs failed', r));
      return r.body;
    }

    case 'sm_adapters': {
      const r = await http('GET', '/_adapters');
      if (!r.ok) throw new Error(formatHttpError('sm_adapters failed', r));
      return r.body;
    }

    default:
      // Caller should have dispatched elsewhere; return null as a "not my tool"
      // signal rather than throw, so the server can try other families.
      return null;
  }
}

/** Names owned by this family. The server uses this to dispatch fast. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set(
  CORE_TOOLS.map((t) => t.name),
);
