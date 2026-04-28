/**
 * F2R2Adapter offline mock tests.
 *
 * The TASKS-TESTS.md gap "F2-R2 adapter — no dedicated offline test" was
 * real. This file is the dedicated offline coverage — every CRUD path
 * tested by mocking `globalThis.fetch` against the F2 + R2 surface.
 *
 * Coverage (~22 cases):
 *   - parseKey: smallstore: prefix stripping, scope/filename split,
 *     bare-filename → defaultScope
 *   - get: JSON content-type response, binary (Uint8Array) response,
 *     404 → null, 403 → null, error propagation, auth-header injection
 *   - set: JSON via cmd:data, string/number/boolean via cmd:data,
 *     binary via cmd:presign + PUT to presigned URL, error paths
 *   - delete: cmd:delete with authKey + r2Key, missing-authKey warns
 *     and skips (no fetch dispatched), 404 tolerated, 500 propagated
 *   - has: HEAD request returns 200 → true, 404 → false, error swallow
 *   - keys: cmd:list returns items mapped to smallstore: keys, empty
 *     items → [], error → []
 *   - clear: cmd:delete with prefix + authKey, missing-authKey warns +
 *     skips, error propagated
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { F2R2Adapter } from '../src/adapters/f2-r2.ts';

// ============================================================================
// Fetch mock harness — simpler URL-pattern responder
// ============================================================================

interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

interface MockArgs {
  url: string;
  method: string;
  body: string | null;
  bodyJson: any;
}

type Responder = (args: MockArgs) => {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
} | Response;

function installFetchMock(responder: Responder) {
  const original = globalThis.fetch;
  const calls: RecordedFetch[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (init?.headers) {
      Object.assign(headers, init.headers as Record<string, string>);
    }
    let body: string | Uint8Array | null = null;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body instanceof Uint8Array) body = init.body;
    calls.push({ url, method, headers, body });

    const bodyStr = typeof body === 'string' ? body : null;
    let bodyJson: any = null;
    if (bodyStr) {
      try { bodyJson = JSON.parse(bodyStr); } catch { /* not JSON */ }
    }

    const out = responder({ url, method, body: bodyStr, bodyJson });
    if (out instanceof Response) return out;
    const respHeaders = out.headers ?? { 'content-type': 'application/json' };
    const respBody = out.body === undefined
      ? ''
      : typeof out.body === 'string'
      ? out.body
      : out.body instanceof Uint8Array
      ? out.body
      : JSON.stringify(out.body);
    return new Response(respBody, {
      status: out.status ?? 200,
      headers: respHeaders,
    });
  }) as typeof globalThis.fetch;

  return { calls, restore() { globalThis.fetch = original; } };
}

function makeAdapter(opts: { token?: string; authKey?: string; defaultScope?: string } = {}) {
  return new F2R2Adapter({
    f2Url: 'https://f2-test.local',
    token: opts.token,
    authKey: opts.authKey,
    defaultScope: opts.defaultScope ?? 'test-scope',
    retry: false,
  });
}

// ============================================================================
// parseKey via observable side-effects (URLs in get/set/has)
// ============================================================================

Deno.test('f2-r2 — parseKey strips "smallstore:" prefix', async () => {
  const m = installFetchMock(() => ({
    headers: { 'content-type': 'application/json' },
    body: { ok: true },
  }));
  try {
    await makeAdapter().get('smallstore:my-scope/file.json');
    // GET URL = {f2Url}/{scope}/{filename}
    assertEquals(m.calls[0].url, 'https://f2-test.local/my-scope/file.json');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — parseKey splits on first slash', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter().get('images/sub/dir/photo.jpg');
    // First slash splits → scope=images, filename=sub/dir/photo.jpg
    assertEquals(m.calls[0].url, 'https://f2-test.local/images/sub/dir/photo.jpg');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — parseKey uses defaultScope when no slash present', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter({ defaultScope: 'fallback' }).get('lonely.json');
    assertEquals(m.calls[0].url, 'https://f2-test.local/fallback/lonely.json');
  } finally { m.restore(); }
});

// ============================================================================
// get
// ============================================================================

Deno.test('f2-r2 — get() returns parsed JSON when content-type is application/json', async () => {
  const m = installFetchMock(() => ({
    body: { value: 42, name: 'Alice' },
  }));
  try {
    const result = await makeAdapter().get('foo/bar.json');
    assertEquals(result, { value: 42, name: 'Alice' });
    assertEquals(m.calls[0].method, 'GET');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — get() returns Uint8Array for non-JSON responses', async () => {
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
  const m = installFetchMock(() =>
    new Response(binary, { status: 200, headers: { 'content-type': 'image/png' } })
  );
  try {
    const result = await makeAdapter().get('img/photo.png');
    assert(result instanceof Uint8Array);
    assertEquals(result, binary);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — get() returns null on 404 (key not found)', async () => {
  const m = installFetchMock(() => ({ status: 404, body: 'Not Found' }));
  try {
    assertEquals(await makeAdapter().get('missing/file.json'), null);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — get() returns null on 403 (no permission, treated as not-found)', async () => {
  const m = installFetchMock(() => ({ status: 403, body: 'Forbidden' }));
  try {
    assertEquals(await makeAdapter().get('locked/file.json'), null);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — get() throws on 500', async () => {
  const m = installFetchMock(() => ({ status: 500, body: 'kaboom' }));
  try {
    await assertRejects(async () => await makeAdapter().get('any/key'), Error, '500');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — get() injects bearer auth when token configured', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter({ token: 'TF-token-xyz' }).get('foo/bar.json');
    assertEquals(m.calls[0].headers['Authorization'], 'Bearer TF-token-xyz');
  } finally { m.restore(); }
});

// ============================================================================
// set
// ============================================================================

Deno.test('f2-r2 — set(object) POSTs cmd:data with JSON body', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter().set('docs/note.json', { title: 'Hello', count: 1 });
    assertEquals(m.calls.length, 1);
    assertEquals(m.calls[0].method, 'POST');
    assertEquals(m.calls[0].url, 'https://f2-test.local');
    const sent = JSON.parse(m.calls[0].body as string);
    assertEquals(sent.cmd, 'data');
    assertEquals(sent.scope, 'docs');
    assertEquals(sent.key, 'note.json');
    assertEquals(sent.data, { title: 'Hello', count: 1 });
    assertEquals(sent.nanoid, ''); // deterministic mode
    assertEquals(sent.useVersioning, false);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — set(string) coerces via String() and uses cmd:data', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter().set('logs/line.txt', 'hello world');
    const sent = JSON.parse(m.calls[0].body as string);
    assertEquals(sent.cmd, 'data');
    assertEquals(sent.data, 'hello world');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — set(number) and set(boolean) stringify the value', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter().set('counters/n', 42);
    await makeAdapter().set('flags/b', true);
    const first = JSON.parse(m.calls[0].body as string);
    const second = JSON.parse(m.calls[1].body as string);
    assertEquals(first.data, '42');
    assertEquals(second.data, 'true');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — set(Uint8Array) follows cmd:presign + PUT to presigned URL', async () => {
  let phase: 'presign' | 'upload' = 'presign';
  const presignedUrl = 'https://r2.example.com/upload?signature=xyz';
  const m = installFetchMock(({ url, bodyJson }) => {
    if (phase === 'presign') {
      assertEquals(url, 'https://f2-test.local');
      assertEquals(bodyJson?.cmd, 'presign');
      phase = 'upload';
      return { body: { url: presignedUrl } };
    }
    // Second call = PUT to presigned URL
    assertEquals(url, presignedUrl);
    return { body: { ok: true } };
  });
  try {
    const binary = new Uint8Array([1, 2, 3, 4, 5]);
    await makeAdapter().set('images/test.png', binary);
    assertEquals(m.calls.length, 2);
    assertEquals(m.calls[1].method, 'PUT');
    assertEquals(m.calls[1].body, binary);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — set throws on data-upload failure', async () => {
  const m = installFetchMock(() => ({ status: 500, body: 'down' }));
  try {
    await assertRejects(
      async () => await makeAdapter().set('foo/bar.json', { x: 1 }),
      Error,
      '500',
    );
  } finally { m.restore(); }
});

Deno.test('f2-r2 — set throws when presign returns no URL', async () => {
  const m = installFetchMock(() => ({ body: {} })); // no `url` key
  try {
    await assertRejects(
      async () => await makeAdapter().set('img/photo.png', new Uint8Array([1, 2, 3])),
      Error,
      'No presigned URL',
    );
  } finally { m.restore(); }
});

// ============================================================================
// delete
// ============================================================================

Deno.test('f2-r2 — delete POSTs cmd:delete with authKey + r2Key', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter({ authKey: 'F2-AUTH-KEY' }).delete('docs/note.json');
    const sent = JSON.parse(m.calls[0].body as string);
    assertEquals(sent.cmd, 'delete');
    assertEquals(sent.authKey, 'F2-AUTH-KEY');
    assertEquals(sent.key, 'docs/note.json');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — delete without authKey logs and skips (no fetch)', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter().delete('docs/note.json'); // no authKey
    assertEquals(m.calls.length, 0);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — delete tolerates 404 (already gone)', async () => {
  const m = installFetchMock(() => ({ status: 404, body: 'Not Found' }));
  try {
    // Doesn't throw — 404 is a deliberate no-op for idempotency.
    await makeAdapter({ authKey: 'auth' }).delete('docs/note.json');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — delete throws on 500', async () => {
  const m = installFetchMock(() => ({ status: 500, body: 'down' }));
  try {
    await assertRejects(
      async () => await makeAdapter({ authKey: 'auth' }).delete('docs/note.json'),
      Error,
      '500',
    );
  } finally { m.restore(); }
});

// ============================================================================
// has
// ============================================================================

Deno.test('f2-r2 — has() does HEAD request, returns true on 200', async () => {
  const m = installFetchMock(() => ({ status: 200, body: '' }));
  try {
    assertEquals(await makeAdapter().has('docs/note.json'), true);
    assertEquals(m.calls[0].method, 'HEAD');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — has() returns false on 404', async () => {
  const m = installFetchMock(() => ({ status: 404, body: '' }));
  try {
    assertEquals(await makeAdapter().has('missing/file.json'), false);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — has() swallows network errors and returns false', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network down'); }) as typeof fetch;
  try {
    assertEquals(await makeAdapter().has('foo/bar.json'), false);
  } finally { globalThis.fetch = original; }
});

// ============================================================================
// keys
// ============================================================================

Deno.test('f2-r2 — keys() POSTs cmd:list, maps items to smallstore: prefixed keys', async () => {
  const m = installFetchMock(() => ({
    body: { items: [{ key: 'test-scope/a.json' }, { key: 'test-scope/b.json' }] },
  }));
  try {
    const keys = await makeAdapter().keys();
    assertEquals(keys, ['smallstore:test-scope/a.json', 'smallstore:test-scope/b.json']);
    const sent = JSON.parse(m.calls[0].body as string);
    assertEquals(sent.cmd, 'list');
    assertEquals(sent.scope, 'test-scope');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — keys() with prefix overrides defaultScope', async () => {
  const m = installFetchMock(() => ({ body: { items: [] } }));
  try {
    await makeAdapter().keys('photos/');
    const sent = JSON.parse(m.calls[0].body as string);
    assertEquals(sent.scope, 'photos');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — keys() returns [] on list failure', async () => {
  const m = installFetchMock(() => ({ status: 500, body: 'down' }));
  try {
    assertEquals(await makeAdapter().keys(), []);
  } finally { m.restore(); }
});

// ============================================================================
// clear
// ============================================================================

Deno.test('f2-r2 — clear POSTs cmd:delete with prefix + authKey', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter({ authKey: 'F2-AUTH-KEY' }).clear();
    const sent = JSON.parse(m.calls[0].body as string);
    assertEquals(sent.cmd, 'delete');
    assertEquals(sent.authKey, 'F2-AUTH-KEY');
    assertEquals(sent.prefix, 'test-scope');
  } finally { m.restore(); }
});

Deno.test('f2-r2 — clear without authKey logs and skips', async () => {
  const m = installFetchMock(() => ({ body: { ok: true } }));
  try {
    await makeAdapter().clear(); // no authKey
    assertEquals(m.calls.length, 0);
  } finally { m.restore(); }
});

Deno.test('f2-r2 — clear throws on 500', async () => {
  const m = installFetchMock(() => ({ status: 500, body: 'down' }));
  try {
    await assertRejects(
      async () => await makeAdapter({ authKey: 'auth' }).clear(),
      Error,
      '500',
    );
  } finally { m.restore(); }
});
