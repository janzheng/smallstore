/**
 * Peer registry HTTP CRUD integration tests.
 *
 * Mounts `registerPeersRoutes` onto an in-process Hono app + a
 * `MemoryAdapter`-backed `createPeerStore` and exercises every CRUD +
 * health-probe route with realistic request shapes. Auth middleware is
 * stubbed open for these tests — the routes themselves are what we're
 * checking, not the gating.
 *
 * Coverage:
 *   - POST   /peers — create (happy + 4 validation paths + 409 conflict + B002 allowlist)
 *   - GET    /peers — list (happy + filter by type/tags/include_disabled)
 *   - GET    /peers/:name — read (happy + 404)
 *   - PUT    /peers/:name — update (happy + 404 + read-only fields stripped)
 *   - DELETE /peers/:name — remove (happy + 404)
 *   - GET    /peers/:name/health — probe (happy + 409 disabled + 404)
 *
 * Companion to `tests/peers-proxy.test.ts` (which covers proxyGet/proxyPost +
 * the path-validation boundary at /fetch + /query) and
 * `tests/peers-registry.test.ts` (which covers the CRUD store directly,
 * not over HTTP).
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1';
import { Hono } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createPeerStore } from '../src/peers/peer-registry.ts';
import { registerPeersRoutes } from '../src/peers/http-routes.ts';

// ============================================================================
// Harness
// ============================================================================

interface Harness {
  app: Hono;
  /** Direct access to the underlying store for fixture seeding + assertions. */
  store: ReturnType<typeof createPeerStore>;
  /** Drop-in `fetch` against the in-process app. */
  call: (path: string, init?: RequestInit) => Promise<Response>;
}

function makeHarness(env: Record<string, string | undefined> = {}): Harness {
  const adapter = new MemoryAdapter();
  const store = createPeerStore(adapter);
  const app = new Hono();
  registerPeersRoutes(app, {
    peerStore: store,
    requireAuth: (_c, next) => next(), // open for the test
    env,
  });
  return {
    app,
    store,
    call: (path, init) => app.fetch(new Request(`http://localhost${path}`, init)),
  };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ============================================================================
// POST /peers — create
// ============================================================================

Deno.test('POST /peers — happy: creates + returns 201 with full peer', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    name: 'my-tigerflare',
    type: 'tigerflare',
    url: 'https://tf.example.com',
    description: 'shared notes',
    tags: ['us', 'shared'],
  }));
  assertEquals(res.status, 201);
  const body = await res.json();
  assertExists(body.created);
  assertEquals(body.created.name, 'my-tigerflare');
  assertEquals(body.created.type, 'tigerflare');
  assertEquals(body.created.url, 'https://tf.example.com');
  assertEquals(body.created.tags, ['us', 'shared']);
  assert(typeof body.created.id === 'string' && body.created.id.length > 0);
  assert(typeof body.created.created_at === 'string');
  // Round-trip via the store directly.
  const fromStore = await h.store.get('my-tigerflare');
  assertEquals(fromStore?.id, body.created.id);
});

Deno.test('POST /peers — missing name returns 400', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    type: 'generic',
    url: 'https://example.com',
  }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(typeof body.message === 'string' && body.message.includes('name'));
});

Deno.test('POST /peers — invalid type returns 400', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    name: 'bad-type',
    type: 'banana',
    url: 'https://example.com',
  }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(typeof body.message === 'string' && body.message.includes('type'));
});

Deno.test('POST /peers — invalid URL returns 400', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    name: 'bad-url',
    type: 'generic',
    url: 'not-a-url',
  }));
  assertEquals(res.status, 400);
});

Deno.test('POST /peers — duplicate name returns 400 (registry-side validation)', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'twin', type: 'generic', url: 'https://a.example.com' });
  const res = await h.call('/peers', json({
    name: 'twin',
    type: 'generic',
    url: 'https://b.example.com',
  }));
  // The registry throws 'peer name "twin" already exists' which the route
  // surfaces as 400. (409 might be more semantically right but the current
  // route flattens registry errors to 400 — verify the contract holds.)
  assertEquals(res.status, 400);
});

Deno.test('POST /peers — auth.token_env on the allowlist creates (B002 happy)', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    name: 'tf-with-auth',
    type: 'tigerflare',
    url: 'https://tf.example.com',
    auth: { kind: 'bearer', token_env: 'TF_TOKEN' },
  }));
  assertEquals(res.status, 201);
});

Deno.test('POST /peers — auth.token_env "SMALLSTORE_TOKEN" rejected by allowlist (B002)', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    name: 'exfil-attempt',
    type: 'generic',
    url: 'https://attacker.example.com',
    auth: { kind: 'bearer', token_env: 'SMALLSTORE_TOKEN' },
  }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(
    typeof body.message === 'string' && body.message.includes('SMALLSTORE_TOKEN'),
    `expected allowlist-violation message naming the rejected env-var, got ${JSON.stringify(body)}`,
  );
  // Critical: not stored.
  assertEquals(await h.store.get('exfil-attempt'), null);
});

Deno.test('POST /peers — auth.user_env disallowed name rejected (B002 basic-auth path)', async () => {
  const h = makeHarness();
  const res = await h.call('/peers', json({
    name: 'aws-attempt',
    type: 'generic',
    url: 'https://example.com',
    auth: { kind: 'basic', user_env: 'AWS_ACCESS_KEY_ID', pass_env: 'TF_PASS' },
  }));
  assertEquals(res.status, 400);
});

// ============================================================================
// GET /peers — list
// ============================================================================

Deno.test('GET /peers — empty list returns { peers: [] }', async () => {
  const h = makeHarness();
  const res = await h.call('/peers');
  assertEquals(res.status, 200);
  const body = await res.json();
  // PeerStore.list returns { peers, next_cursor? } — not { items }.
  assertEquals(Array.isArray(body.peers) ? body.peers : body.items, []);
});

Deno.test('GET /peers — lists multiple peers', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'a', type: 'generic', url: 'https://a.example.com' });
  await h.store.create({ name: 'b', type: 'tigerflare', url: 'https://b.example.com' });
  const res = await h.call('/peers');
  assertEquals(res.status, 200);
  const body = await res.json();
  const list = body.peers ?? body.items;
  assertEquals(list.length, 2);
  const names = list.map((p: { name: string }) => p.name).sort();
  assertEquals(names, ['a', 'b']);
});

Deno.test('GET /peers?type=tigerflare — filters by type', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'a', type: 'generic', url: 'https://a.example.com' });
  await h.store.create({ name: 'b', type: 'tigerflare', url: 'https://b.example.com' });
  await h.store.create({ name: 'c', type: 'tigerflare', url: 'https://c.example.com' });
  const res = await h.call('/peers?type=tigerflare');
  assertEquals(res.status, 200);
  const body = await res.json();
  const list = body.peers ?? body.items;
  assertEquals(list.length, 2);
  for (const p of list) assertEquals(p.type, 'tigerflare');
});

Deno.test('GET /peers — disabled peers hidden by default, surfaced with include_disabled', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'live', type: 'generic', url: 'https://live.example.com' });
  await h.store.create({
    name: 'paused',
    type: 'generic',
    url: 'https://paused.example.com',
    disabled: true,
  });

  const without = await (await h.call('/peers')).json();
  const withoutList = without.peers ?? without.items;
  assertEquals(withoutList.length, 1);
  assertEquals(withoutList[0].name, 'live');

  const all = await (await h.call('/peers?include_disabled=true')).json();
  const allList = all.peers ?? all.items;
  assertEquals(allList.length, 2);
});

// ============================================================================
// GET /peers/:name — read
// ============================================================================

Deno.test('GET /peers/:name — happy: returns the registered peer', async () => {
  const h = makeHarness();
  await h.store.create({
    name: 'tf',
    type: 'tigerflare',
    url: 'https://tf.example.com',
    description: 'notes',
  });
  const res = await h.call('/peers/tf');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.peer.name, 'tf');
  assertEquals(body.peer.type, 'tigerflare');
  assertEquals(body.peer.description, 'notes');
});

Deno.test('GET /peers/:name — unknown name returns 404', async () => {
  const h = makeHarness();
  const res = await h.call('/peers/nope');
  assertEquals(res.status, 404);
  const body = await res.json();
  assert(typeof body.message === 'string' && body.message.includes('nope'));
});

// ============================================================================
// PUT /peers/:name — update
// ============================================================================

Deno.test('PUT /peers/:name — happy: patches description + tags', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'tf', type: 'tigerflare', url: 'https://tf.example.com' });
  const res = await h.call('/peers/tf', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'now annotated', tags: ['shared'] }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.updated.description, 'now annotated');
  assertEquals(body.updated.tags, ['shared']);
  // Untouched fields preserved.
  assertEquals(body.updated.url, 'https://tf.example.com');
});

Deno.test('PUT /peers/:name — read-only fields (id, created_at) stripped from patch', async () => {
  const h = makeHarness();
  const created = await h.store.create({
    name: 'tf',
    type: 'tigerflare',
    url: 'https://tf.example.com',
  });
  const originalId = created.id;
  const originalCreatedAt = created.created_at;
  const res = await h.call('/peers/tf', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'malicious-id-overwrite',
      created_at: '1970-01-01T00:00:00Z',
      description: 'legit field',
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.updated.id, originalId);
  assertEquals(body.updated.created_at, originalCreatedAt);
  assertEquals(body.updated.description, 'legit field');
});

Deno.test('PUT /peers/:name — unknown name returns 404', async () => {
  const h = makeHarness();
  const res = await h.call('/peers/nope', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'whatever' }),
  });
  assertEquals(res.status, 404);
});

Deno.test('PUT /peers/:name — non-object body returns 400', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'tf', type: 'tigerflare', url: 'https://tf.example.com' });
  const res = await h.call('/peers/tf', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '"not-an-object"',
  });
  assertEquals(res.status, 400);
});

// ============================================================================
// DELETE /peers/:name — remove
// ============================================================================

Deno.test('DELETE /peers/:name — happy: returns { deleted: name }', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'tf', type: 'tigerflare', url: 'https://tf.example.com' });
  const res = await h.call('/peers/tf', { method: 'DELETE' });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.deleted, 'tf');
  // Round-trip: store-side gone.
  assertEquals(await h.store.get('tf'), null);
});

Deno.test('DELETE /peers/:name — unknown name returns 404', async () => {
  const h = makeHarness();
  const res = await h.call('/peers/nope', { method: 'DELETE' });
  assertEquals(res.status, 404);
});

// ============================================================================
// GET /peers/:name/health — probe
// ============================================================================

Deno.test('GET /peers/:name/health — disabled peer returns 409 without probing', async () => {
  const h = makeHarness();
  await h.store.create({
    name: 'paused',
    type: 'generic',
    url: 'https://paused.example.com',
    disabled: true,
  });
  // Stub fetch so we can confirm no probe was dispatched (409 should
  // short-circuit before probePeer hits the wire).
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response('', { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await h.call('/peers/paused/health');
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertEquals(body.error, 'peer is disabled');
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('GET /peers/:name/health — unknown peer returns 404', async () => {
  const h = makeHarness();
  const res = await h.call('/peers/nope/health');
  assertEquals(res.status, 404);
});

Deno.test('GET /peers/:name/health — happy: probes upstream and returns ok', async () => {
  const h = makeHarness();
  await h.store.create({ name: 'live', type: 'generic', url: 'https://live.example.com' });
  // Stub fetch so probePeer's HEAD lands on a 200.
  const realFetch = globalThis.fetch;
  let probedUrl = '';
  globalThis.fetch = ((input: string | URL | Request) => {
    probedUrl = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(new Response('', { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await h.call('/peers/live/health');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.peer, 'live');
    assertEquals(body.ok, true);
    assert(typeof body.latency_ms === 'number' && body.latency_ms >= 0);
    assert(probedUrl.startsWith('https://live.example.com'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
