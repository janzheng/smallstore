/**
 * Peer registry — proxy tests.
 *
 * Exercises `resolvePeerAuth`, `proxyGet`, `proxyPost`, and `probePeer`
 * against a mocked `globalThis.fetch`. No real network is hit.
 *
 * Pattern:
 * - `installFetchMock` stashes the real `globalThis.fetch`, installs a
 *   recorder that returns a caller-provided response (or throws a caller-
 *   provided error), and returns a `restore` handle. Every test restores
 *   in a try/finally.
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';
import {
  probePeer,
  proxyGet,
  proxyPost,
  resolvePeerAuth,
} from '../src/peers/proxy.ts';
import type { Peer } from '../src/peers/types.ts';

// ============================================================================
// Fetch-mocking harness
// ============================================================================

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  signal?: AbortSignal;
}

interface MockOptions {
  /** Response status. Default 200. */
  status?: number;
  /** Response body. Default ''. */
  body?: string;
  /** Response headers. */
  responseHeaders?: Record<string, string>;
  /**
   * If set, the mock throws this error instead of resolving. Used for
   * network-error + timeout tests (timeout passes `AbortError`).
   */
  throwError?: Error;
  /**
   * If set, the mock never resolves — it listens on the abort signal and
   * rejects with an `AbortError` when the caller aborts. Used for timeout
   * tests so we exercise the real `AbortController` path.
   */
  neverResolve?: boolean;
}

function installFetchMock(opts: MockOptions = {}) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        Object.assign(headers, init.headers as Record<string, string>);
      }
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
      signal: init?.signal ?? undefined,
    });

    if (opts.throwError) {
      return Promise.reject(opts.throwError);
    }

    if (opts.neverResolve) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new DOMException('aborted', 'AbortError');
            reject(err);
          });
        }
      });
    }

    const status = opts.status ?? 200;
    const responseHeaders = new Headers(opts.responseHeaders ?? {});
    // Null-body statuses (204/205/304) can't have a body per fetch spec.
    const nullBody = status === 101 || status === 204 || status === 205 ||
      status === 304;
    const bodyInit = nullBody ? null : (opts.body ?? '');
    return Promise.resolve(
      new Response(bodyInit, { status, headers: responseHeaders }),
    );
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ============================================================================
// Peer fixtures
// ============================================================================

function makePeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: overrides.id ?? 'peer-1',
    name: overrides.name ?? 'test-peer',
    type: overrides.type ?? 'generic',
    url: overrides.url ?? 'https://peer.example.com',
    created_at: overrides.created_at ?? '2026-04-23T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// resolvePeerAuth
// ============================================================================

Deno.test('resolvePeerAuth: none kind returns empty headers + no query_params', () => {
  const peer = makePeer({ auth: { kind: 'none' } });
  const out = resolvePeerAuth(peer, {});
  assertEquals(out.headers, {});
  assertEquals(out.query_params, []);
  assertEquals(out.error, undefined);
});

Deno.test('resolvePeerAuth: missing auth (undefined) treated as none', () => {
  const peer = makePeer({ auth: undefined });
  const out = resolvePeerAuth(peer, {});
  assertEquals(out.headers, {});
  assertEquals(out.error, undefined);
});

Deno.test('resolvePeerAuth: bearer with env present', () => {
  const peer = makePeer({ auth: { kind: 'bearer', token_env: 'TF_TOKEN' } });
  const out = resolvePeerAuth(peer, { TF_TOKEN: 'secret123' });
  assertEquals(out.headers, { Authorization: 'Bearer secret123' });
  assertEquals(out.error, undefined);
});

Deno.test('resolvePeerAuth: bearer with env missing sets error', () => {
  const peer = makePeer({ auth: { kind: 'bearer', token_env: 'TF_TOKEN' } });
  const out = resolvePeerAuth(peer, {});
  assertEquals(out.headers, {});
  assertEquals(out.error, 'env var TF_TOKEN is not set');
});

Deno.test('resolvePeerAuth: header kind injects custom header', () => {
  const peer = makePeer({
    auth: { kind: 'header', name: 'X-API-Key', value_env: 'API_KEY' },
  });
  const out = resolvePeerAuth(peer, { API_KEY: 'k-42' });
  assertEquals(out.headers, { 'X-API-Key': 'k-42' });
  assertEquals(out.error, undefined);
});

Deno.test('resolvePeerAuth: header kind with missing env sets error', () => {
  const peer = makePeer({
    auth: { kind: 'header', name: 'X-API-Key', value_env: 'API_KEY' },
  });
  const out = resolvePeerAuth(peer, {});
  assertEquals(out.headers, {});
  assertEquals(out.error, 'env var API_KEY is not set');
});

Deno.test('resolvePeerAuth: query kind populates query_params', () => {
  const peer = makePeer({
    auth: { kind: 'query', name: 'key', value_env: 'SHEETLOG_KEY' },
  });
  const out = resolvePeerAuth(peer, { SHEETLOG_KEY: 'abc' });
  assertEquals(out.headers, {});
  assertEquals(out.query_params, [['key', 'abc']]);
});

Deno.test('resolvePeerAuth: query kind with missing env sets error', () => {
  const peer = makePeer({
    auth: { kind: 'query', name: 'key', value_env: 'SHEETLOG_KEY' },
  });
  const out = resolvePeerAuth(peer, {});
  assertEquals(out.error, 'env var SHEETLOG_KEY is not set');
});

Deno.test('resolvePeerAuth: basic kind builds base64 Authorization', () => {
  const peer = makePeer({
    auth: { kind: 'basic', user_env: 'USER', pass_env: 'PASS' },
  });
  const out = resolvePeerAuth(peer, { USER: 'alice', PASS: 'hunter2' });
  // base64 of "alice:hunter2"
  assertEquals(out.headers, { Authorization: `Basic ${btoa('alice:hunter2')}` });
  assertEquals(out.error, undefined);
});

Deno.test('resolvePeerAuth: basic kind with missing user sets error', () => {
  const peer = makePeer({
    auth: { kind: 'basic', user_env: 'USER', pass_env: 'PASS' },
  });
  const out = resolvePeerAuth(peer, { PASS: 'x' });
  assertEquals(out.error, 'env var USER is not set');
});

Deno.test('resolvePeerAuth: basic kind with missing pass sets error', () => {
  const peer = makePeer({
    auth: { kind: 'basic', user_env: 'USER', pass_env: 'PASS' },
  });
  const out = resolvePeerAuth(peer, { USER: 'alice' });
  assertEquals(out.error, 'env var PASS is not set');
});

// ============================================================================
// proxyGet
// ============================================================================

Deno.test('proxyGet: builds URL from peer.url + path + client_query + auth query', async () => {
  const mock = installFetchMock({ status: 200, body: 'hello' });
  try {
    const peer = makePeer({
      url: 'https://sheet.example.com',
      auth: { kind: 'query', name: 'key', value_env: 'K' },
    });
    const result = await proxyGet({
      peer,
      path: '/data',
      env: { K: 'secret' },
      client_query: { filter: 'foo' },
    });
    assertEquals(result.ok, true);
    assertEquals(mock.calls.length, 1);
    const u = new URL(mock.calls[0].url);
    assertEquals(u.origin + u.pathname, 'https://sheet.example.com/data');
    assertEquals(u.searchParams.get('filter'), 'foo');
    assertEquals(u.searchParams.get('key'), 'secret');
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: injects bearer Authorization header', async () => {
  const mock = installFetchMock({ status: 200, body: '{}' });
  try {
    const peer = makePeer({
      auth: { kind: 'bearer', token_env: 'TOK' },
    });
    const result = await proxyGet({
      peer,
      path: '/a',
      env: { TOK: 'T-123' },
    });
    assertEquals(result.ok, true);
    assertEquals(mock.calls[0].headers['Authorization'], 'Bearer T-123');
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: merges peer.headers + client_headers, auth wins', async () => {
  const mock = installFetchMock({ status: 200 });
  try {
    const peer = makePeer({
      headers: { 'X-Peer': 'static', 'X-Shared': 'peer-wins-over-client' },
      auth: { kind: 'header', name: 'X-Shared', value_env: 'V' },
    });
    const result = await proxyGet({
      peer,
      path: '/',
      env: { V: 'auth-wins' },
      client_headers: {
        'X-Client': 'c',
        'X-Shared': 'from-client',
        'X-Peer': 'client-tried',
      },
    });
    assertEquals(result.ok, true);
    const sent = mock.calls[0].headers;
    // Auth wins
    assertEquals(sent['X-Shared'], 'auth-wins');
    // Peer static wins over client
    assertEquals(sent['X-Peer'], 'static');
    // Client passthrough where no conflict
    assertEquals(sent['X-Client'], 'c');
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: strips unsafe client headers (auth/cookie/hop-by-hop)', async () => {
  const mock = installFetchMock({ status: 200 });
  try {
    const peer = makePeer();
    await proxyGet({
      peer,
      path: '/',
      env: {},
      client_headers: {
        Authorization: 'Bearer SMALLSTORE-TOKEN',
        Cookie: 'session=abc',
        Host: 'smallstore.local',
        'Content-Length': '42',
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=5',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'websocket',
        'X-Safe': 'passthrough',
      },
    });
    const sent = mock.calls[0].headers;
    // All unsafe headers dropped (case-insensitive match)
    const sentKeysLower = Object.keys(sent).map((k) => k.toLowerCase());
    for (
      const bad of [
        'authorization',
        'cookie',
        'host',
        'content-length',
        'connection',
        'keep-alive',
        'transfer-encoding',
        'upgrade',
      ]
    ) {
      assert(
        !sentKeysLower.includes(bad),
        `unsafe header ${bad} should have been stripped, got ${JSON.stringify(sent)}`,
      );
    }
    assertEquals(sent['X-Safe'], 'passthrough');
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: success path populates body + status + lowercase headers + latency_ms', async () => {
  const mock = installFetchMock({
    status: 200,
    body: '{"ok":true}',
    responseHeaders: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
  });
  try {
    const peer = makePeer();
    const result = await proxyGet({ peer, path: '/x', env: {} });
    assertEquals(result.status, 200);
    assertEquals(result.ok, true);
    assertEquals(result.body, '{"ok":true}');
    // Response headers lowercased
    assertEquals(result.headers['content-type'], 'application/json');
    assertEquals(result.headers['x-trace'], 'abc');
    assert(typeof result.latency_ms === 'number');
    assert(result.latency_ms >= 0);
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: non-2xx returns ok=false with body + status', async () => {
  const mock = installFetchMock({ status: 404, body: 'not found' });
  try {
    const peer = makePeer();
    const result = await proxyGet({ peer, path: '/missing', env: {} });
    assertEquals(result.status, 404);
    assertEquals(result.ok, false);
    assertEquals(result.body, 'not found');
    assertEquals(result.error, undefined);
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: timeout surfaces "timeout after Nms"', async () => {
  const mock = installFetchMock({ neverResolve: true });
  try {
    const peer = makePeer();
    const result = await proxyGet({
      peer,
      path: '/',
      env: {},
      timeout_ms: 20,
    });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertExists(result.error);
    assert(
      result.error!.startsWith('timeout after '),
      `expected timeout error, got: ${result.error}`,
    );
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: network error surfaces err.message', async () => {
  const mock = installFetchMock({ throwError: new Error('econnrefused') });
  try {
    const peer = makePeer();
    const result = await proxyGet({ peer, path: '/', env: {} });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertEquals(result.error, 'econnrefused');
  } finally {
    mock.restore();
  }
});

Deno.test('proxyGet: missing auth env short-circuits without fetch', async () => {
  const mock = installFetchMock({ status: 200 });
  try {
    const peer = makePeer({
      auth: { kind: 'bearer', token_env: 'MISSING_TOKEN' },
    });
    const result = await proxyGet({ peer, path: '/', env: {} });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertEquals(result.error, 'env var MISSING_TOKEN is not set');
    assertEquals(result.latency_ms, 0);
    // Critical: no fetch was dispatched
    assertEquals(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// ============================================================================
// proxyPost
// ============================================================================

Deno.test('proxyPost: JSON body serialization + default content-type', async () => {
  const mock = installFetchMock({ status: 201, body: '{"id":"x"}' });
  try {
    const peer = makePeer();
    const result = await proxyPost({
      peer,
      path: '/items',
      env: {},
      body: { foo: 'bar', n: 1 },
    });
    assertEquals(result.status, 201);
    assertEquals(mock.calls[0].method, 'POST');
    assertEquals(mock.calls[0].body, JSON.stringify({ foo: 'bar', n: 1 }));
    assertEquals(mock.calls[0].headers['Content-Type'], 'application/json');
  } finally {
    mock.restore();
  }
});

Deno.test('proxyPost: string body passes through unchanged; override content-type', async () => {
  const mock = installFetchMock({ status: 200 });
  try {
    const peer = makePeer();
    const result = await proxyPost({
      peer,
      path: '/raw',
      env: {},
      body: 'raw=payload&x=1',
      content_type: 'application/x-www-form-urlencoded',
    });
    assertEquals(result.ok, true);
    assertEquals(mock.calls[0].body, 'raw=payload&x=1');
    assertEquals(
      mock.calls[0].headers['Content-Type'],
      'application/x-www-form-urlencoded',
    );
  } finally {
    mock.restore();
  }
});

// ============================================================================
// probePeer
// ============================================================================

Deno.test('probePeer: smallstore type → GET /health', async () => {
  const mock = installFetchMock({ status: 200, body: 'ok' });
  try {
    const peer = makePeer({ type: 'smallstore', url: 'https://s.example.com' });
    const res = await probePeer(peer, {});
    assertEquals(res.ok, true);
    assertEquals(res.status, 200);
    assertEquals(mock.calls[0].method, 'GET');
    assertEquals(mock.calls[0].url, 'https://s.example.com/health');
  } finally {
    mock.restore();
  }
});

Deno.test('probePeer: webdav type → OPTIONS peer.url', async () => {
  const mock = installFetchMock({ status: 200 });
  try {
    const peer = makePeer({ type: 'webdav', url: 'https://dav.example.com' });
    const res = await probePeer(peer, {});
    assertEquals(res.ok, true);
    assertEquals(mock.calls[0].method, 'OPTIONS');
    // No /health suffix for webdav
    assertEquals(mock.calls[0].url, 'https://dav.example.com/');
  } finally {
    mock.restore();
  }
});

Deno.test('probePeer: generic/sheetlog/http-json type → HEAD peer.url', async () => {
  const mock = installFetchMock({ status: 200 });
  try {
    for (const type of ['generic', 'sheetlog', 'http-json'] as const) {
      mock.calls.length = 0;
      const peer = makePeer({ type, url: 'https://x.example.com' });
      const res = await probePeer(peer, {});
      assertEquals(res.ok, true, `type=${type} should be reachable`);
      assertEquals(mock.calls[0].method, 'HEAD', `type=${type} should HEAD`);
    }
  } finally {
    mock.restore();
  }
});

Deno.test('probePeer: timeout → ok=false with timeout error', async () => {
  const mock = installFetchMock({ neverResolve: true });
  try {
    const peer = makePeer({ type: 'generic' });
    const res = await probePeer(peer, {}, { timeout_ms: 20 });
    assertEquals(res.ok, false);
    assertEquals(res.status, 0);
    assertExists(res.error);
    assert(res.error!.startsWith('timeout after '));
  } finally {
    mock.restore();
  }
});

Deno.test('probePeer: 2xx and 3xx both count as ok=true', async () => {
  // 2xx
  {
    const mock = installFetchMock({ status: 204 });
    try {
      const res = await probePeer(makePeer({ type: 'generic' }), {});
      assertEquals(res.ok, true);
      assertEquals(res.status, 204);
    } finally {
      mock.restore();
    }
  }
  // 3xx
  {
    const mock = installFetchMock({
      status: 302,
      // Location required so Response construction doesn't choke on some runtimes.
      responseHeaders: { Location: 'https://x.example.com/new' },
    });
    try {
      const res = await probePeer(makePeer({ type: 'generic' }), {});
      assertEquals(res.ok, true);
      assertEquals(res.status, 302);
    } finally {
      mock.restore();
    }
  }
  // 4xx should NOT be ok
  {
    const mock = installFetchMock({ status: 401 });
    try {
      const res = await probePeer(makePeer({ type: 'generic' }), {});
      assertEquals(res.ok, false);
      assertEquals(res.status, 401);
    } finally {
      mock.restore();
    }
  }
});
