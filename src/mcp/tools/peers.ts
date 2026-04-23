/**
 * Peer registry MCP tools — `sm_peers_*` family.
 *
 * Thin forwarders over the live `/peers/*` HTTP surface. Lets agents manage +
 * query the peer registry (the "atlas of external data sources") without
 * dropping to curl. Pairs with the CRUD/health/proxy routes defined in
 * `src/peers/http-routes.ts`.
 *
 * Design notes:
 *   - Every tool is a straight pass-through. URL-encode `:name` because peer
 *     names are user-supplied; the server still validates slug format but we
 *     don't want a stray slash to silently land at a different route.
 *   - `sm_peers_list.tags` is a `string[]` on our side but the server reads
 *     it from the query string as comma-separated — we join with `,` before
 *     setting the param.
 *   - `sm_peers_fetch` takes `path` + an optional `client_query` object. The
 *     HTTP route reads `path` from the query string and forwards every
 *     *other* query param to the peer, so we merge `client_query` entries
 *     into the outgoing query string alongside `path`.
 *   - `sm_peers_query.path` is a query-string param (controls which peer path
 *     we POST to), not part of the body. `body` is whatever the caller passed.
 *   - `auth` is declared as a loose object with `kind` required. JSON Schema
 *     `oneOf` discriminators don't buy much over the server's runtime
 *     validator, which already returns a descriptive 400 for malformed auth.
 *
 * @module
 */

import type { Args, HttpFn, Tool } from './types.ts';
import { formatHttpError, requireString, validateName } from './types.ts';

// ============================================================================
// Tool definitions
// ============================================================================

const PEER_TYPES = ['smallstore', 'tigerflare', 'sheetlog', 'http-json', 'webdav', 'generic'] as const;

export const PEERS_TOOLS: Tool[] = [
  {
    name: 'sm_peers_list',
    description:
      'List peers in the registry (external data sources this Smallstore knows how to reach). ' +
      'Supports substring filtering by `name`, exact filtering by `type`, tag-AND filtering via `tags`, ' +
      'and cursor pagination. Disabled peers are hidden by default — pass `include_disabled: true` to see them. ' +
      'Use this for discovery before `sm_peers_fetch` / `sm_peers_query`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Substring filter on peer name.' },
        type: {
          type: 'string',
          enum: [...PEER_TYPES],
          description: 'Filter by peer type.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Match peers whose tags contain ALL of these values (AND semantics). Sent as a comma-separated query param.',
        },
        include_disabled: { type: 'boolean', description: 'Include disabled peers in the result. Default false.' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a previous response.' },
        limit: { type: 'number', description: 'Max peers per page. Server caps at 500.' },
      },
    },
  },
  {
    name: 'sm_peers_get',
    description:
      'Fetch the full metadata for a single peer by name. Returns `{ peer: Peer }` with url, type, tags, ' +
      'auth shape (but not secret values — those live in Worker env), capabilities, disabled flag, timestamps. ' +
      '404s if no peer with that name exists.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Peer name (slug, e.g. "my-tigerflare").' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sm_peers_create',
    description:
      'Register a new peer in the registry. `name` must be a slug (`^[a-z0-9][a-z0-9_-]*$`) and must be unique. ' +
      '`type` is one of smallstore|tigerflare|sheetlog|http-json|webdav|generic. ' +
      '`auth` is a discriminated union on `kind`: ' +
      '`{ kind: "none" }`, ' +
      '`{ kind: "bearer", token_env: "MY_TOKEN" }`, ' +
      '`{ kind: "header", name: "X-API-Key", value_env: "MY_KEY" }`, ' +
      '`{ kind: "query", name: "api_key", value_env: "MY_KEY" }`, ' +
      '`{ kind: "basic", user_env: "MY_USER", pass_env: "MY_PASS" }`. ' +
      'IMPORTANT: `*_env` fields reference Worker environment variables — the actual secret value must be ' +
      'provisioned separately via `wrangler secret put` (or equivalent). The registry never stores secrets itself.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique slug (e.g. "prod-tigerflare", "notion-main").' },
        type: {
          type: 'string',
          enum: [...PEER_TYPES],
          description: 'Peer backend type — determines how health probes and the proxy shape the request.',
        },
        url: { type: 'string', description: 'Base URL of the peer (e.g. "https://tigerflare.example.com"). No trailing slash required.' },
        auth: {
          type: 'object',
          description:
            'Authentication config (optional; omitted = no auth). Shape: ' +
            '{ kind: "none" } | ' +
            '{ kind: "bearer", token_env } | ' +
            '{ kind: "header", name, value_env } | ' +
            '{ kind: "query", name, value_env } | ' +
            '{ kind: "basic", user_env, pass_env }. ' +
            '`*_env` fields name a Worker env var that holds the secret — set via `wrangler secret put`.',
          properties: {
            kind: {
              type: 'string',
              enum: ['none', 'bearer', 'header', 'query', 'basic'],
              description: 'Auth scheme.',
            },
            token_env: { type: 'string', description: 'Env var name (bearer).' },
            name: { type: 'string', description: 'Header or query param name (header/query).' },
            value_env: { type: 'string', description: 'Env var name holding the header/query value.' },
            user_env: { type: 'string', description: 'Env var name (basic auth username).' },
            pass_env: { type: 'string', description: 'Env var name (basic auth password).' },
          },
          required: ['kind'],
        },
        headers: {
          type: 'object',
          description: 'Static headers to attach to every request through this peer. string → string.',
          additionalProperties: { type: 'string' },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-form labels used for routing + listing filters (e.g. ["prod", "readonly"]).',
        },
        description: { type: 'string', description: 'Human-readable description of what this peer is.' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Declared capability strings (e.g. ["read", "append"]). Advisory — agents can use for routing.',
        },
        disabled: { type: 'boolean', description: 'If true, peer is created but blocked from health/fetch/query routes. Default false.' },
      },
      required: ['name', 'type', 'url'],
    },
  },
  {
    name: 'sm_peers_update',
    description:
      'Partially update a peer. `patch` is a subset of the Peer shape — any field you pass is overwritten, ' +
      'fields you omit are left alone. ' +
      'Use this to flip `disabled`, rotate the `auth` config, retag, or rename the peer (pass `patch.name` to rename — ' +
      'the server handles the id/slug bookkeeping). Read-only fields (`id`, `created_at`) are stripped server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Current peer name (the one in the URL).' },
        patch: {
          type: 'object',
          description: 'Partial Peer object. Pass only the fields you want to change. Shape mirrors sm_peers_create body.',
        },
      },
      required: ['name', 'patch'],
    },
  },
  {
    name: 'sm_peers_delete',
    description:
      'Remove a peer from the registry permanently. This does NOT touch the peer service itself — it just forgets ' +
      'the route. If you only want to stop proxying for a while, use `sm_peers_update` with `patch: { disabled: true }` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Peer name to delete.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sm_peers_health',
    description:
      'Probe a peer for reachability. Runs a HEAD/OPTIONS/GET depending on the peer type and reports `{ ok, latency_ms, status?, error? }`. ' +
      'Disabled peers return 409 with `ok: false` — flip `disabled: false` to re-enable. ' +
      'Use this before driving heavy traffic through `sm_peers_fetch` / `sm_peers_query` to fail fast.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Peer name.' },
        timeout_ms: { type: 'number', description: 'Probe timeout in milliseconds. Server picks a sensible default when omitted.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sm_peers_fetch',
    description:
      'Authenticated GET through a peer. Smallstore signs the request with the peer\'s configured auth (bearer/header/query/basic) ' +
      'from Worker env, appends any static `headers` from the peer record, and forwards the response status + body. ' +
      'Use `sm_peers_fetch` for GETs; use `sm_peers_query` for POSTs. ' +
      '`path` is appended to the peer\'s base URL. Extra query params to send to the peer go in `client_query` — they\'re merged ' +
      'into the outgoing URL alongside the peer\'s own auth-injected params.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Peer name.' },
        path: { type: 'string', description: 'Path to fetch on the peer, relative to its base URL (e.g. "/api/users", "/v1/records/123").' },
        client_query: {
          type: 'object',
          description: 'Additional query params to forward to the peer. string → string. The server merges these with any `kind: "query"` auth params.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'sm_peers_query',
    description:
      'Authenticated POST through a peer. Same auth/header injection as `sm_peers_fetch`, but for write-shaped or search-shaped ' +
      'requests that need a body. The caller provides the `body` (JSON or raw string) and Smallstore forwards it with the ' +
      'declared `content_type`. Use `sm_peers_query` for POSTs; `sm_peers_fetch` for GETs. ' +
      '`path` (default `"/"`) is sent as a `?path=` query param — the server uses it to pick the peer path to POST to; it is NOT the body.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Peer name.' },
        path: { type: 'string', description: 'Path to POST to on the peer. Default "/".' },
        body: {
          description: 'Request body. Pass a JSON value (object/array/etc.) or a raw string. Forwarded verbatim with the given content_type.',
        },
        content_type: {
          type: 'string',
          description: 'Content-Type header for the POST. Default "application/json".',
        },
      },
      required: ['name', 'body'],
    },
  },
];

// ============================================================================
// Handler
// ============================================================================

export async function handlePeersTool(
  name: string,
  args: Args,
  http: HttpFn,
): Promise<unknown> {
  switch (name) {
    case 'sm_peers_list': {
      const qs = new URLSearchParams();
      if (typeof args.name === 'string' && args.name) qs.set('name', args.name);
      if (typeof args.type === 'string' && args.type) qs.set('type', args.type);
      if (Array.isArray(args.tags) && args.tags.length > 0) {
        const tags = (args.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (tags.length > 0) qs.set('tags', tags.join(','));
      }
      if (typeof args.include_disabled === 'boolean' && args.include_disabled) {
        qs.set('include_disabled', 'true');
      }
      if (typeof args.cursor === 'string' && args.cursor) qs.set('cursor', args.cursor);
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
        qs.set('limit', String(args.limit));
      }
      const path = `/peers${qs.toString() ? `?${qs}` : ''}`;
      const r = await http('GET', path);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_list failed', r));
      return r.body;
    }

    case 'sm_peers_get': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      const r = await http('GET', `/peers/${encodeURIComponent(peerName)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_get failed', r));
      return r.body;
    }

    case 'sm_peers_create': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      const type = requireString(args, 'type');
      const url = requireString(args, 'url');

      const body: Record<string, unknown> = { name: peerName, type, url };
      if (args.auth !== undefined) body.auth = args.auth;
      if (args.headers !== undefined) body.headers = args.headers;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.description !== undefined) body.description = args.description;
      if (args.capabilities !== undefined) body.capabilities = args.capabilities;
      if (args.disabled !== undefined) body.disabled = args.disabled;

      const r = await http('POST', '/peers', body);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_create failed', r));
      return r.body;
    }

    case 'sm_peers_update': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      const patch = args.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('sm_peers_update requires a "patch" argument (object)');
      }
      const r = await http('PUT', `/peers/${encodeURIComponent(peerName)}`, patch);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_update failed', r));
      return r.body;
    }

    case 'sm_peers_delete': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      const r = await http('DELETE', `/peers/${encodeURIComponent(peerName)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_delete failed', r));
      return r.body;
    }

    case 'sm_peers_health': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      const qs = new URLSearchParams();
      if (typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)) {
        qs.set('timeout_ms', String(args.timeout_ms));
      }
      const path = `/peers/${encodeURIComponent(peerName)}/health${qs.toString() ? `?${qs}` : ''}`;
      const r = await http('GET', path);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_health failed', r));
      return r.body;
    }

    case 'sm_peers_fetch': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      const fetchPath = requireString(args, 'path');

      const qs = new URLSearchParams();
      qs.set('path', fetchPath);
      const clientQuery = args.client_query;
      if (clientQuery && typeof clientQuery === 'object' && !Array.isArray(clientQuery)) {
        for (const [k, v] of Object.entries(clientQuery as Record<string, unknown>)) {
          if (k === 'path') continue; // `path` is reserved for the fetch target
          if (v === undefined || v === null) continue;
          qs.append(k, typeof v === 'string' ? v : String(v));
        }
      }

      const url = `/peers/${encodeURIComponent(peerName)}/fetch?${qs}`;
      const r = await http('GET', url);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_fetch failed', r));
      return r.body;
    }

    case 'sm_peers_query': {
      const peerName = requireString(args, 'name');
      validateName(peerName, 'name');
      if (!('body' in args)) {
        throw new Error('sm_peers_query requires a "body" argument (JSON value or string)');
      }

      const queryPath = typeof args.path === 'string' && args.path.length > 0 ? args.path : '/';
      // `content_type` is accepted for forward-compat with the route (which
      // reads the client Content-Type), but the shared HTTP forwarder always
      // sends application/json. See #discovered note in the sprint report.
      const qs = new URLSearchParams();
      qs.set('path', queryPath);

      const url = `/peers/${encodeURIComponent(peerName)}/query?${qs}`;
      const r = await http('POST', url, args.body);
      if (!r.ok) throw new Error(formatHttpError('sm_peers_query failed', r));
      return r.body;
    }

    default:
      throw new Error(`Unknown peers tool: "${name}"`);
  }
}
