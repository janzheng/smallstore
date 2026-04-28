/**
 * Peer registry — proxy + auth resolution.
 *
 * This module is the per-request side of the peer registry. `createPeerStore`
 * (in `peer-registry.ts`) owns the CRUD surface; this file owns the wire.
 *
 * Three public helpers:
 *
 * - `resolvePeerAuth(peer, env)` — pure function mapping `peer.auth` + an env
 *   bag to the concrete `{ headers, query_params }` to inject on the outbound
 *   request. Flags missing env vars via `.error` rather than silently
 *   proceeding with partial auth.
 * - `proxyGet(args)` / `proxyPost(args)` — authenticated `fetch` wrappers with
 *   timeout, hop-by-hop header filtering, client-header forwarding, and
 *   result shape that never throws on non-2xx (caller inspects `.ok`).
 * - `probePeer(peer, env, opts?)` — per-type reachability check. Returns
 *   `HealthResult`. Never throws.
 *
 * Design notes captured here:
 *
 * - **Auth wins merge precedence.** Static `peer.headers`, then client
 *   headers, then resolved auth headers on top. Auth is non-negotiable; the
 *   caller should never be able to spoof it away.
 * - **Strip smallstore's own Authorization before forwarding.** A client
 *   authed with smallstore's bearer token must not have that token leaked to
 *   a peer — the peer has its own auth model.
 * - **Hop-by-hop headers stripped.** Standard HTTP hygiene — `Connection`,
 *   `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, plus `Host` / `Content-Length`
 *   which `fetch` owns.
 * - **No retries in MVP.** Callers that want retry should wrap these. Adding
 *   a retry policy here would hide flakiness in tests and fight the
 *   "return-not-throw" contract.
 */

import type {
  HealthResult,
  Peer,
  PeerAuth,
  ProxyGetArgs,
  ProxyPostArgs,
  ProxyResult,
  ResolvedAuth,
} from './types.ts';
import { defaultEnvAllowlist, type EnvAllowlist } from './env-allowlist.ts';

// ============================================================================
// Constants
// ============================================================================

/** Default proxy timeout for GET/POST. */
const DEFAULT_PROXY_TIMEOUT_MS = 10_000;

/** Default health-probe timeout. Shorter than proxy since probes are interactive. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Client headers that must not be forwarded to the peer. All matched
 * case-insensitively.
 *
 * - `authorization` — that's smallstore's own auth; the peer has its own.
 * - `cookie` — session state for smallstore, not the peer.
 * - `host` — fetch sets this from the target URL.
 * - `content-length` — fetch computes this from the body.
 * - hop-by-hop (per RFC 7230 §6.1): `connection`, `keep-alive`,
 *   `transfer-encoding`, `upgrade`.
 */
const STRIPPED_CLIENT_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

// ============================================================================
// Auth resolution
// ============================================================================

/**
 * Resolve a peer's `auth` config against an env bag. Pure function — no I/O.
 *
 * Returns a `ResolvedAuth` with `headers` + optional `query_params` to
 * inject on the outbound request. When an env var referenced by the auth
 * config is missing, sets `error` with a clear "env var X is not set"
 * message and returns empty headers/params — the proxy helpers short-circuit
 * on this without ever dispatching the request.
 *
 * Defense-in-depth: every env-var name (`token_env`, `value_env`, `user_env`,
 * `pass_env`) is run through the allowlist before lookup. A peer registered
 * with `token_env: "SMALLSTORE_TOKEN"` (or any other reserved name) returns
 * an `error` instead of resolving the value — the master bearer token
 * cannot be exfiltrated via a hostile peer URL. The HTTP route validator
 * also gates this at peer-create time; this is the second line.
 */
export function resolvePeerAuth(
  peer: Peer,
  env: Record<string, string | undefined>,
  allowlist: EnvAllowlist = defaultEnvAllowlist,
): ResolvedAuth {
  const auth: PeerAuth = peer.auth ?? { kind: 'none' };

  // Reject disallowed env var names without leaking which name was bad. The
  // server-side log surfaces the name for operator debugging; the returned
  // `error` is generic so we don't echo it back to a request handler that
  // may reflect it to a client.
  const rejectName = (name: string): ResolvedAuth | null => {
    if (allowlist.isAllowed(name)) return null;
    console.warn(`[peer-auth] rejected env var name "${name}" for peer "${peer.name}" — not on allowlist`);
    return {
      headers: {},
      query_params: [],
      error: 'auth env var name not on allowlist',
    };
  };

  switch (auth.kind) {
    case 'none':
      return { headers: {}, query_params: [] };

    case 'bearer': {
      const rejected = rejectName(auth.token_env);
      if (rejected) return rejected;
      const token = env[auth.token_env];
      if (!token) {
        return {
          headers: {},
          query_params: [],
          error: `env var ${auth.token_env} is not set`,
        };
      }
      return { headers: { Authorization: `Bearer ${token}` }, query_params: [] };
    }

    case 'header': {
      const rejected = rejectName(auth.value_env);
      if (rejected) return rejected;
      const value = env[auth.value_env];
      if (!value) {
        return {
          headers: {},
          query_params: [],
          error: `env var ${auth.value_env} is not set`,
        };
      }
      return { headers: { [auth.name]: value }, query_params: [] };
    }

    case 'query': {
      const rejected = rejectName(auth.value_env);
      if (rejected) return rejected;
      const value = env[auth.value_env];
      if (!value) {
        return {
          headers: {},
          query_params: [],
          error: `env var ${auth.value_env} is not set`,
        };
      }
      return { headers: {}, query_params: [[auth.name, value]] };
    }

    case 'basic': {
      const userRejected = rejectName(auth.user_env);
      if (userRejected) return userRejected;
      const passRejected = rejectName(auth.pass_env);
      if (passRejected) return passRejected;
      const user = env[auth.user_env];
      const pass = env[auth.pass_env];
      if (!user) {
        return {
          headers: {},
          query_params: [],
          error: `env var ${auth.user_env} is not set`,
        };
      }
      if (!pass) {
        return {
          headers: {},
          query_params: [],
          error: `env var ${auth.pass_env} is not set`,
        };
      }
      const encoded = btoa(`${user}:${pass}`);
      return { headers: { Authorization: `Basic ${encoded}` }, query_params: [] };
    }
  }
}

// ============================================================================
// Header + URL plumbing
// ============================================================================

/**
 * Filter client headers — drop auth/cookie/hop-by-hop entries before
 * forwarding. Case-insensitive.
 */
function filterClientHeaders(
  client: Record<string, string> | undefined,
): Record<string, string> {
  if (!client) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(client)) {
    if (STRIPPED_CLIENT_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Merge static peer headers, filtered client headers, and resolved auth
 * headers into a single outbound header record. Precedence (highest wins):
 *
 *   auth > static peer > client
 */
function mergeHeaders(
  peerHeaders: Record<string, string> | undefined,
  clientHeaders: Record<string, string> | undefined,
  authHeaders: Record<string, string>,
): Record<string, string> {
  return {
    ...filterClientHeaders(clientHeaders),
    ...(peerHeaders ?? {}),
    ...authHeaders,
  };
}

/**
 * Build the outbound URL. Concatenates `peer.url + path`, then appends
 * `client_query` followed by auth `query_params`. Uses `URL` + manual
 * search-param manipulation so any pre-existing query string on `peer.url`
 * or `path` is preserved.
 */
function buildUrl(
  peer: Peer,
  path: string,
  clientQuery: Record<string, string> | undefined,
  authQuery: Array<[string, string]> | undefined,
): string {
  const combined = `${peer.url}${path}`;
  // Use URL to parse; it handles existing query strings on peer.url / path.
  let url: URL;
  try {
    url = new URL(combined);
  } catch {
    // Bail back to raw string if not a valid absolute URL — caller will get
    // the fetch error. We don't validate peer.url here (the registry does).
    return combined;
  }
  if (clientQuery) {
    for (const [k, v] of Object.entries(clientQuery)) {
      url.searchParams.append(k, v);
    }
  }
  if (authQuery) {
    for (const [k, v] of authQuery) {
      url.searchParams.append(k, v);
    }
  }
  return url.toString();
}

/**
 * Convert a `Headers` object (from a `Response`) to a lowercase-keyed
 * plain record. Callers expect stable lookup regardless of casing.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

// ============================================================================
// Proxy — GET
// ============================================================================

/**
 * Proxy a GET request to `peer.url + args.path`.
 *
 * - Resolves auth up front; short-circuits without a fetch call if any
 *   referenced env var is missing.
 * - Merges headers with auth-wins precedence.
 * - Appends client + auth query params to the outbound URL.
 * - Timeout via `AbortController`; default 10 seconds.
 * - Never throws — returns a `ProxyResult` with `.error` populated on
 *   network/timeout/resolution failure.
 */
export async function proxyGet(args: ProxyGetArgs): Promise<ProxyResult> {
  const timeoutMs = args.timeout_ms ?? DEFAULT_PROXY_TIMEOUT_MS;
  const resolved = resolvePeerAuth(args.peer, args.env);

  if (resolved.error) {
    return {
      status: 0,
      ok: false,
      headers: {},
      body: '',
      error: resolved.error,
      latency_ms: 0,
    };
  }

  const url = buildUrl(args.peer, args.path, args.client_query, resolved.query_params);
  const headers = mergeHeaders(args.peer.headers, args.client_headers, resolved.headers);

  return await dispatch({
    url,
    method: 'GET',
    headers,
    body: undefined,
    timeoutMs,
  });
}

// ============================================================================
// Proxy — POST
// ============================================================================

/**
 * Proxy a POST request to `peer.url + (args.path ?? '/')`.
 *
 * Body serialization:
 * - `string` → sent as-is.
 * - `Uint8Array` → sent as-is.
 * - anything else → `JSON.stringify(body)`.
 *
 * `Content-Type` defaults to `application/json` when a body is present and
 * the caller didn't set one via `client_headers`. Explicit
 * `args.content_type` always wins.
 */
export async function proxyPost(args: ProxyPostArgs): Promise<ProxyResult> {
  const timeoutMs = args.timeout_ms ?? DEFAULT_PROXY_TIMEOUT_MS;
  const resolved = resolvePeerAuth(args.peer, args.env);

  if (resolved.error) {
    return {
      status: 0,
      ok: false,
      headers: {},
      body: '',
      error: resolved.error,
      latency_ms: 0,
    };
  }

  const path = args.path ?? '/';
  const url = buildUrl(args.peer, path, args.client_query, resolved.query_params);
  const headers = mergeHeaders(args.peer.headers, args.client_headers, resolved.headers);

  // Body serialization.
  let body: string | Uint8Array | undefined;
  if (args.body === undefined || args.body === null) {
    body = undefined;
  } else if (typeof args.body === 'string') {
    body = args.body;
  } else if (args.body instanceof Uint8Array) {
    body = args.body;
  } else {
    body = JSON.stringify(args.body);
  }

  // Content-Type handling: explicit > client-provided > default.
  if (body !== undefined) {
    const hasClientCT = hasHeaderCI(headers, 'content-type');
    if (args.content_type) {
      // Drop any pre-existing content-type casing, then set the explicit one.
      deleteHeaderCI(headers, 'content-type');
      headers['Content-Type'] = args.content_type;
    } else if (!hasClientCT) {
      headers['Content-Type'] = 'application/json';
    }
  }

  return await dispatch({
    url,
    method: 'POST',
    headers,
    body,
    timeoutMs,
  });
}

// ============================================================================
// Health probe
// ============================================================================

/**
 * Best-effort reachability probe. Type-specific:
 *
 * - `smallstore` → `GET ${peer.url}/health` (smallstore Workers ship a health route)
 * - `tigerflare` → `GET ${peer.url}/` (tigerflare Workers respond to root with a
 *   directory listing; no dedicated /health route as of 2026-04-25)
 * - `webdav` → `OPTIONS ${peer.url}`
 * - everything else → `HEAD ${peer.url}`
 *
 * Applies the same auth resolution as the proxy helpers. `ok` is true on
 * 2xx **or 3xx** — some peers redirect to an auth page on HEAD and that
 * still counts as "reachable." Never throws.
 */
export async function probePeer(
  peer: Peer,
  env: Record<string, string | undefined>,
  opts?: { timeout_ms?: number },
): Promise<HealthResult> {
  const timeoutMs = opts?.timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS;
  const started = performance.now();
  const resolved = resolvePeerAuth(peer, env);

  if (resolved.error) {
    return {
      ok: false,
      status: 0,
      latency_ms: 0,
      error: resolved.error,
    };
  }

  // Pick method + path per peer.type.
  let method: string;
  let path: string;
  switch (peer.type) {
    case 'smallstore':
      method = 'GET';
      path = '/health';
      break;
    case 'tigerflare':
      // Tigerflare doesn't expose /health; root returns a directory listing.
      method = 'GET';
      path = '/';
      break;
    case 'webdav':
      method = 'OPTIONS';
      path = '';
      break;
    default:
      method = 'HEAD';
      path = '';
  }

  const url = buildUrl(peer, path, undefined, resolved.query_params);
  const headers = mergeHeaders(peer.headers, undefined, resolved.headers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    const ok = res.status >= 200 && res.status < 400;
    return { ok, status: res.status, latency_ms: latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const isAbort = err instanceof DOMException && err.name === 'AbortError' ||
      (err as Error)?.name === 'AbortError';
    if (isAbort) {
      return {
        ok: false,
        status: 0,
        latency_ms: latencyMs,
        error: `timeout after ${timeoutMs}ms`,
      };
    }
    return {
      ok: false,
      status: 0,
      latency_ms: latencyMs,
      error: (err as Error)?.message ?? 'probe failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Internal: shared fetch dispatch
// ============================================================================

interface DispatchArgs {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  timeoutMs: number;
}

/**
 * The single fetch-with-timeout-and-result-shape routine used by both
 * `proxyGet` and `proxyPost`. Kept private so the public helpers stay the
 * stable surface.
 */
async function dispatch(args: DispatchArgs): Promise<ProxyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const started = performance.now();

  try {
    const res = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      // Cast: our internal `body` union is `string | Uint8Array | undefined`,
      // both are valid `BodyInit`. Deno's lib.dom lib parametrizes Uint8Array
      // differently (`Uint8Array<ArrayBufferLike>`) which narrows incorrectly.
      body: args.body as BodyInit | undefined,
      signal: controller.signal,
    });
    const body = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: headersToRecord(res.headers),
      body,
      latency_ms: latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const isAbort = err instanceof DOMException && err.name === 'AbortError' ||
      (err as Error)?.name === 'AbortError';
    if (isAbort) {
      return {
        status: 0,
        ok: false,
        headers: {},
        body: '',
        error: `timeout after ${args.timeoutMs}ms`,
        latency_ms: latencyMs,
      };
    }
    return {
      status: 0,
      ok: false,
      headers: {},
      body: '',
      error: (err as Error)?.message ?? 'fetch failed',
      latency_ms: latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Small header utilities
// ============================================================================

function hasHeaderCI(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return true;
  }
  return false;
}

function deleteHeaderCI(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}
