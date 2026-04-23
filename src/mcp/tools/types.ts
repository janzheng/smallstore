/**
 * Shared types + helpers for MCP tool families.
 *
 * Each tool family (core, inbox, peers, ...) exports:
 *
 *   export const X_TOOLS: Tool[];
 *   export async function handleXTool(name: string, args: Args, http: HttpFn): Promise<unknown>;
 *
 * The server composes them by spreading TOOLS arrays + dispatching by name
 * across handler functions. Adding a new family = new file + two new imports
 * in `src/mcp/server.ts`, nothing else.
 */

// ============================================================================
// MCP tool metadata
// ============================================================================

/**
 * MCP tool metadata — mirrors the @modelcontextprotocol/sdk shape.
 * Tools are serialized from `tools/list` and matched by name on `tools/call`.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Arbitrary-shape tool arguments as they arrive from the MCP client. */
export type Args = Record<string, unknown>;

// ============================================================================
// HTTP helper — shared across all tool families
// ============================================================================

/**
 * Result shape from an HTTP call to the smallstore server. Kept permissive
 * (`body: unknown`) so callers can decide between pass-through and parse.
 */
export interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Shared HTTP forwarder. The MCP server wires auth + URL + body-serialization
 * + response-size-caps once, then hands this function to every tool family.
 * Tool handlers don't reach fetch directly.
 */
export type HttpFn = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<HttpResult>;

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Require `args[name]` to be a non-empty string. Throws a clear Error with
 * the argument name so MCP errors are self-describing in the client.
 */
export function requireString(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing required string argument: "${name}"`);
  }
  return v;
}

/**
 * Reject obviously-unsafe names that could escape path segments. Collection
 * names, inbox names, peer names all share this — they're all used in URL
 * paths. More restrictive than HTTP allows by design: agents should only
 * address things with sensible slugs.
 *
 * Optional `label` is interpolated into the error message so "collection" /
 * "inbox" / "peer" give clear failure modes.
 */
export function validateName(name: string, label = 'name'): void {
  if (!name || typeof name !== 'string') {
    throw new Error(`${label} must be a non-empty string`);
  }
  // Allow letters, digits, underscore, dash, forward slash (for sub-paths),
  // and dot (for file-style names like `notes.md`). Reject everything else,
  // especially `?`, `#`, spaces, and CR/LF.
  if (!/^[A-Za-z0-9._\-/]+$/.test(name)) {
    throw new Error(
      `${label} "${name}" contains characters outside [A-Za-z0-9._\\-/]`,
    );
  }
  if (name.length > 512) {
    throw new Error(`${label} too long (max 512 chars)`);
  }
}

/**
 * Build an Error message from an HTTP result. Prefers the server's
 * `error` / `message` fields when the body parses as JSON with that shape;
 * falls back to the raw body or status code. Used by every tool handler
 * to surface server errors back to the agent.
 */
export function formatHttpError(
  prefix: string,
  r: { status: number; body: unknown },
): string {
  if (r.body && typeof r.body === 'object') {
    const obj = r.body as Record<string, unknown>;
    const message = typeof obj.message === 'string' ? obj.message : undefined;
    const error = typeof obj.error === 'string' ? obj.error : undefined;
    if (message || error) {
      return `${prefix} (${r.status}): ${error ? error + ': ' : ''}${message ?? ''}`.trim();
    }
  }
  return `${prefix} (${r.status}): ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '')}`;
}

/**
 * URL-encode both collection + optional key segments when building paths
 * like `/api/:collection` or `/api/:collection/:key`. Used by the core
 * tools (sm_read / sm_write / sm_delete) to avoid double-encoding `/`-
 * containing keys and to reject control characters.
 */
export function encodeCollectionKey(collection: string, key?: string): string {
  validateName(collection, 'collection');
  if (key === undefined) return `/api/${encodeURIComponent(collection)}`;
  return `/api/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`;
}
