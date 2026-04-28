/**
 * HTTP route registration for the peer registry plugin.
 *
 * Mounts peer CRUD + health + proxy routes onto a Hono app. Caller supplies:
 *   - peerStore: the CRUD store (adapter-backed)
 *   - requireAuth: middleware (same shape used by messaging routes)
 *   - env: the Worker env bag for auth resolution (proxy routes look up
 *     env[token_env] at request time; env is passed through rather than
 *     captured so per-request env can be plumbed in if needed later)
 *
 * Routes mounted (all behind `requireAuth`):
 *
 *   CRUD:
 *     GET    /peers                              — list (cursor/limit/type/tags/name/include_disabled)
 *     GET    /peers/:name                        — metadata
 *     POST   /peers                              — create
 *     PUT    /peers/:name                        — partial update (including rename via patch.name)
 *     DELETE /peers/:name                        — remove
 *
 *   Operational:
 *     GET    /peers/:name/health                 — probe (HEAD/OPTIONS/GET per type)
 *     GET    /peers/:name/fetch?path=<path>      — authenticated proxy GET
 *     POST   /peers/:name/query                  — authenticated proxy POST
 *
 * Disabled peers 404 from all operational routes but remain visible via
 * CRUD (so you can toggle `disabled: false` to bring them back). This
 * mirrors the rules-store behavior.
 *
 * See `.brief/peer-registry.md` § "MVP design" for the behavioral spec
 * + § "Success criteria" for the full worked example of registering
 * a tigerflare peer and proxying through it.
 */

import type { Context, Hono, Next } from 'hono';
import type { Peer, PeerAuth, PeerStore, PeerType, PeerQueryFilter } from './types.ts';
import { defaultEnvAllowlist } from './env-allowlist.ts';
import { isValidPath, probePeer, proxyGet, proxyPost } from './proxy.ts';

export type RequireAuth = (c: Context, next: Next) => Promise<Response | void> | Response | void;

export interface RegisterPeersRoutesOptions {
  /** Adapter-backed peer store. */
  peerStore: PeerStore;
  /** Auth middleware — same shape as messaging routes. */
  requireAuth: RequireAuth;
  /**
   * Env bag used for auth resolution on proxy/health routes. Typically
   * passed straight from the Worker's `env`. Worker env vars don't change
   * per-request so capturing at registration time is fine.
   */
  env: Record<string, string | undefined>;
}

// ============================================================================
// Route registration
// ============================================================================

export function registerPeersRoutes(
  app: Hono<any>,
  opts: RegisterPeersRoutesOptions,
): void {
  const { peerStore, requireAuth, env } = opts;

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  app.get('/peers', requireAuth, async (c) => {
    const filter: PeerQueryFilter = {};
    const name = c.req.query('name');
    if (name) filter.name = name;
    const type = c.req.query('type');
    if (type) filter.type = type as PeerType;
    const tagsRaw = c.req.query('tags');
    if (tagsRaw) {
      filter.tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);
    }
    const includeDisabled = c.req.query('include_disabled');
    if (includeDisabled === 'true' || includeDisabled === '1') {
      filter.include_disabled = true;
    }
    const cursor = c.req.query('cursor');
    if (cursor) filter.cursor = cursor;
    const limit = parseLimit(c.req.query('limit'));
    if (limit !== undefined) filter.limit = limit;

    const result = await peerStore.list(filter);
    return c.json(result);
  });

  app.get('/peers/:name', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const peer = await peerStore.get(name);
    if (!peer) return notFound(c, `peer "${name}" not registered`);
    return c.json({ peer });
  });

  app.post('/peers', requireAuth, async (c) => {
    const body = await readJson(c);
    const validation = validatePeerInput(body);
    if (validation.error) return badRequest(c, validation.error);

    try {
      const created = await peerStore.create(body as Omit<Peer, 'id' | 'created_at'>);
      return c.json({ created }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Store-side validation errors (slug format, URL, duplicate name) are
      // the caller's fault — 400 not 500. The registry throws plain Error
      // instances with human-friendly messages; pass them through.
      return badRequest(c, msg);
    }
  });

  app.put('/peers/:name', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(c, 'body must be a partial Peer object');
    }
    // Defensive: strip read-only fields from patch.
    const patch: any = { ...body };
    delete patch.id;
    delete patch.created_at;

    try {
      const updated = await peerStore.update(name, patch);
      if (!updated) return notFound(c, `peer "${name}" not registered`);
      return c.json({ updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return badRequest(c, msg);
    }
  });

  app.delete('/peers/:name', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const ok = await peerStore.delete(name);
    if (!ok) return notFound(c, `peer "${name}" not registered`);
    return c.json({ deleted: name });
  });

  // --------------------------------------------------------------------------
  // Operational
  // --------------------------------------------------------------------------

  app.get('/peers/:name/health', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const peer = await peerStore.get(name);
    if (!peer) return notFound(c, `peer "${name}" not registered`);
    if (peer.disabled) {
      return c.json({ ok: false, error: 'peer is disabled', latency_ms: 0 }, 409);
    }

    const timeoutRaw = c.req.query('timeout_ms');
    const timeout_ms = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
    const result = await probePeer(peer, env, { timeout_ms });
    return c.json({ peer: name, ...result });
  });

  app.get('/peers/:name/fetch', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const peer = await peerStore.get(name);
    if (!peer) return notFound(c, `peer "${name}" not registered`);
    if (peer.disabled) {
      return c.json({ error: 'Gone', message: `peer "${name}" is disabled` }, 409);
    }

    const path = c.req.query('path') ?? '/';
    // B033: reject hostile path query at the HTTP boundary before any further
    // processing. CRLF, control chars, and raw spaces could smuggle headers
    // through the URL constructor's fallback path in `buildUrl`.
    if (!isValidPath(path)) {
      return badRequest(c, 'path query param contains disallowed characters');
    }
    // Forward every query param EXCEPT `path` (which we consumed) to the peer.
    const client_query: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.queries() ?? {})) {
      if (k === 'path') continue;
      // Hono's `queries()` returns string[][]; take first value per key.
      const value = Array.isArray(v) ? v[0] : (v as string);
      if (value !== undefined) client_query[k] = value;
    }

    // Forward only safe client headers. Proxy helper does another pass of
    // filtering (hop-by-hop + auth), so this is belt-and-suspenders.
    const client_headers = pickClientHeaders(c.req.raw.headers);

    const result = await proxyGet({
      peer,
      path,
      env,
      client_headers,
      client_query,
    });

    return writeProxyResponse(c, result);
  });

  app.post('/peers/:name/query', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const peer = await peerStore.get(name);
    if (!peer) return notFound(c, `peer "${name}" not registered`);
    if (peer.disabled) {
      return c.json({ error: 'Gone', message: `peer "${name}" is disabled` }, 409);
    }

    const path = c.req.query('path') ?? '/';
    // B033: same gate as the GET proxy route.
    if (!isValidPath(path)) {
      return badRequest(c, 'path query param contains disallowed characters');
    }
    const clientCT = c.req.header('content-type') ?? 'application/json';

    // Read body as text to preserve whatever the client sent.
    const rawBody = await c.req.text();
    const client_headers = pickClientHeaders(c.req.raw.headers);

    const result = await proxyPost({
      peer,
      path,
      env,
      body: rawBody,
      content_type: clientCT,
      client_headers,
    });

    return writeProxyResponse(c, result);
  });
}

// ============================================================================
// Helpers
// ============================================================================

const VALID_PEER_TYPES: ReadonlySet<string> = new Set([
  'smallstore',
  'tigerflare',
  'sheetlog',
  'rss',
  'http-json',
  'webdav',
  'generic',
]);

const VALID_AUTH_KINDS: ReadonlySet<string> = new Set([
  'none',
  'bearer',
  'header',
  'query',
  'basic',
]);

/**
 * HTTP-boundary input validation. Checks shape — the store does deeper
 * validation (slug regex, URL format, uniqueness) which surfaces as
 * thrown errors that the POST handler converts to 400s.
 */
function validatePeerInput(body: unknown): { error?: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'body must be a Peer object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== 'string' || b.name.length === 0) {
    return { error: 'name (non-empty string) required' };
  }
  if (typeof b.type !== 'string' || !VALID_PEER_TYPES.has(b.type)) {
    return { error: `type must be one of: ${[...VALID_PEER_TYPES].join(', ')}` };
  }
  if (typeof b.url !== 'string' || b.url.length === 0) {
    return { error: 'url (non-empty string) required' };
  }

  if (b.auth !== undefined) {
    const authErr = validateAuthShape(b.auth);
    if (authErr) return { error: authErr };
  }

  if (b.headers !== undefined) {
    if (!b.headers || typeof b.headers !== 'object' || Array.isArray(b.headers)) {
      return { error: 'headers must be an object' };
    }
    for (const [k, v] of Object.entries(b.headers)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        return { error: 'headers entries must be string → string' };
      }
    }
  }

  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !b.tags.every((t) => typeof t === 'string')) {
      return { error: 'tags must be an array of strings' };
    }
  }

  if (b.capabilities !== undefined) {
    if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === 'string')) {
      return { error: 'capabilities must be an array of strings' };
    }
  }

  if (b.disabled !== undefined && typeof b.disabled !== 'boolean') {
    return { error: 'disabled must be a boolean' };
  }

  if (b.metadata !== undefined) {
    if (!b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata)) {
      return { error: 'metadata must be a plain object (or omitted)' };
    }
    // Don't validate nested fields — metadata is a free-form convention
    // surface (see Peer.metadata JSDoc). Reject only obvious shape mistakes.
  }

  return {};
}

function validateAuthShape(auth: unknown): string | undefined {
  if (!auth || typeof auth !== 'object') return 'auth must be an object';
  const a = auth as Record<string, unknown>;
  if (typeof a.kind !== 'string' || !VALID_AUTH_KINDS.has(a.kind)) {
    return `auth.kind must be one of: ${[...VALID_AUTH_KINDS].join(', ')}`;
  }
  // Reject env-var names not on the allowlist up front. Same gate is enforced
  // at request time by `resolvePeerAuth`, but rejecting at create time gives
  // operators a clearer error rather than a silent dispatch failure later.
  // The reason string includes the allowlist policy summary; the env-var
  // name itself is included in the operator-facing 400 (the route is behind
  // bearer auth) so the operator can fix their config.
  const checkEnvName = (name: string, field: string): string | undefined => {
    const reason = defaultEnvAllowlist.reasonRejected(name);
    if (reason) return `auth.${field} "${name}" rejected — ${reason}`;
    return undefined;
  };
  switch (a.kind) {
    case 'none':
      return undefined;
    case 'bearer': {
      if (typeof a.token_env !== 'string' || !a.token_env) {
        return 'auth.token_env (string) required for bearer auth';
      }
      const reason = checkEnvName(a.token_env, 'token_env');
      if (reason) return reason;
      return undefined;
    }
    case 'header': {
      if (typeof a.name !== 'string' || !a.name) {
        return 'auth.name (string) required for header auth';
      }
      if (typeof a.value_env !== 'string' || !a.value_env) {
        return 'auth.value_env (string) required for header auth';
      }
      const reason = checkEnvName(a.value_env, 'value_env');
      if (reason) return reason;
      return undefined;
    }
    case 'query': {
      if (typeof a.name !== 'string' || !a.name) {
        return 'auth.name (string) required for query auth';
      }
      if (typeof a.value_env !== 'string' || !a.value_env) {
        return 'auth.value_env (string) required for query auth';
      }
      const reason = checkEnvName(a.value_env, 'value_env');
      if (reason) return reason;
      return undefined;
    }
    case 'basic': {
      if (typeof a.user_env !== 'string' || !a.user_env) {
        return 'auth.user_env (string) required for basic auth';
      }
      if (typeof a.pass_env !== 'string' || !a.pass_env) {
        return 'auth.pass_env (string) required for basic auth';
      }
      const userReason = checkEnvName(a.user_env, 'user_env');
      if (userReason) return userReason;
      const passReason = checkEnvName(a.pass_env, 'pass_env');
      if (passReason) return passReason;
      return undefined;
    }
  }
  return undefined;
}

/**
 * Pick only the client headers that are safe to forward. Same strip-list as
 * the proxy helper (belt + suspenders so we don't rely on downstream
 * filtering alone). Specifically drops `authorization` so smallstore's
 * bearer token is never forwarded to a peer.
 */
function pickClientHeaders(raw: Headers): Record<string, string> {
  const strip = new Set([
    'authorization',
    'cookie',
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
  ]);
  const out: Record<string, string> = {};
  raw.forEach((value, key) => {
    if (strip.has(key.toLowerCase())) return;
    out[key] = value;
  });
  return out;
}

/**
 * Convert a `ProxyResult` into a Hono response that preserves the peer's
 * status + body, while scrubbing hop-by-hop response headers. Adds a
 * small `X-Peer-Latency-Ms` header for observability.
 *
 * Errors from the proxy (status=0) are mapped to 502 Bad Gateway with the
 * error message in the body — this is the standard shape for "couldn't
 * reach upstream."
 */
function writeProxyResponse(c: Context, result: import('./types.ts').ProxyResult): Response {
  if (result.status === 0 && result.error) {
    return c.json(
      { error: 'BadGateway', message: result.error, latency_ms: result.latency_ms },
      502,
    );
  }

  // Preserve peer status + body; filter hop-by-hop response headers.
  const stripResp = new Set([
    'content-length',
    'content-encoding', // already decoded by fetch
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
  ]);
  const headers: HeadersInit = {};
  for (const [k, v] of Object.entries(result.headers)) {
    if (stripResp.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['x-peer-latency-ms'] = String(result.latency_ms);

  return new Response(result.body, {
    status: result.status,
    headers,
  });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function badRequest(c: Context, message: string): Response {
  return c.json({ error: 'BadRequest', message }, 400);
}

function notFound(c: Context, message: string): Response {
  return c.json({ error: 'NotFound', message }, 404);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 500);
}
