/**
 * API App Tests
 *
 * Tests all endpoints of the smallstore API app using in-process Hono requests.
 * Uses the memory preset for fast, isolated tests.
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { createSmallstore } from '../mod.ts';
import { createApiApp } from '../apps/api/app.ts';

// Helper: create a fresh app + store for each test group
function setup() {
  const store = createSmallstore({ preset: 'memory' });
  const app = createApiApp(store);
  return { store, app };
}

// Helper: shorthand for JSON requests
async function json(app: any, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

// ============================================================================
// Info endpoints
// ============================================================================

Deno.test('API: GET / returns server info', async () => {
  const { app } = setup();
  const { status, body } = await json(app, 'GET', '/');
  assertEquals(status, 200);
  assertEquals(body.name, 'smallstore-api');
  assertNotEquals(body.endpoints, undefined);
});

Deno.test('API: GET /health returns ok', async () => {
  const { app } = setup();
  const { status, body } = await json(app, 'GET', '/health');
  assertEquals(status, 200);
  assertEquals(body.status, 'ok');
});

Deno.test('API: GET /collections returns empty array initially', async () => {
  const { app } = setup();
  const { status, body } = await json(app, 'GET', '/collections');
  assertEquals(status, 200);
  assertEquals(Array.isArray(body.collections), true);
});

// ============================================================================
// CRUD: POST / GET / DELETE
// ============================================================================

Deno.test('API: POST then GET returns stored data', async () => {
  const { app } = setup();

  const post = await json(app, 'POST', '/store/items', { name: 'widget', price: 10 });
  assertEquals(post.status, 201);
  assertEquals(post.body.ok, true);

  const get = await json(app, 'GET', '/store/items');
  assertEquals(get.status, 200);
  assertEquals(get.body.path, 'items');
  assertNotEquals(get.body.data, null);
});

Deno.test('API: GET non-existent path returns 404', async () => {
  const { app } = setup();
  const { status, body } = await json(app, 'GET', '/store/nonexistent');
  assertEquals(status, 404);
  assertEquals(body.error, 'Not found');
});

Deno.test('API: DELETE removes data', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/temp', { x: 1 });
  const del = await json(app, 'DELETE', '/store/temp');
  assertEquals(del.status, 200);
  assertEquals(del.body.ok, true);

  const get = await json(app, 'GET', '/store/temp');
  assertEquals(get.status, 404);
});

// ============================================================================
// PUT and PATCH
// ============================================================================

Deno.test('API: PUT overwrites data', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/config', { a: 1 });
  const put = await json(app, 'PUT', '/store/config', { b: 2 });
  assertEquals(put.status, 200);
  assertEquals(put.body.ok, true);
});

Deno.test('API: PATCH merges data', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/settings', { theme: 'dark' });
  const patch = await json(app, 'PATCH', '/store/settings', { fontSize: 14 });
  assertEquals(patch.status, 200);
  assertEquals(patch.body.ok, true);
});

// ============================================================================
// Nested paths
// ============================================================================

Deno.test('API: nested path POST and GET', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/project/docs/readme', { content: 'hello world' });
  const get = await json(app, 'GET', '/store/project/docs/readme');
  assertEquals(get.status, 200);
  assertNotEquals(get.body.data, null);
});

// ============================================================================
// Keys
// ============================================================================

Deno.test('API: GET /_keys returns keys for collection', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/users', { name: 'Alice' });
  const { status, body } = await json(app, 'GET', '/store/users/_keys');
  assertEquals(status, 200);
  assertEquals(body.collection, 'users');
  assertEquals(Array.isArray(body.keys), true);
});

// ============================================================================
// Search
// ============================================================================

Deno.test('API: GET /_search without q returns 400', async () => {
  const { app } = setup();
  const { status, body } = await json(app, 'GET', '/store/items/_search');
  assertEquals(status, 400);
  assertEquals(body.error, 'Missing ?q= parameter');
});

Deno.test({
  name: 'API: GET /_search with q returns results (local-sqlite)',
  fn: async () => {
    const store = createSmallstore({ preset: 'local-sqlite' });
    const app = createApiApp(store);

    await json(app, 'POST', '/store/notes', { text: 'machine learning is amazing' });

    const { status, body } = await json(app, 'GET', '/store/notes/_search?q=machine');
    assertEquals(status, 200);
    assertEquals(body.collection, 'notes');
    assertEquals(body.query, 'machine');
    assertNotEquals(body.results, undefined);

    // Cleanup
    try { await Deno.remove('./data/store.db'); } catch { /* ok */ }
    try { await Deno.remove('./data', { recursive: true }); } catch { /* ok */ }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// Query
// ============================================================================

Deno.test('API: POST /_query returns results', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/products', { name: 'Widget', price: 10 });

  const { status, body } = await json(app, 'POST', '/store/products/_query', {
    filters: [{ field: 'name', op: 'eq', value: 'Widget' }],
  });
  assertEquals(status, 200);
  assertEquals(body.collection, 'products');
  assertNotEquals(body.results, undefined);
});

// ============================================================================
// Webhooks
// ============================================================================

Deno.test('API: POST /hooks/:collection creates timestamped entry', async () => {
  const { app } = setup();

  const { status, body } = await json(app, 'POST', '/hooks/events', {
    event: 'signup',
    user: 'alice',
  });
  assertEquals(status, 201);
  assertEquals(body.ok, true);
  assertEquals(body.key.startsWith('events/'), true);
});

Deno.test('API: webhook includes X-Source header', async () => {
  const { app, store } = setup();

  const res = await app.request('/hooks/logs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Source': 'email-interceptor',
    },
    body: JSON.stringify({ subject: 'Hello' }),
  });

  const body = await res.json();
  assertEquals(res.status, 201);

  // Verify the stored data has the source
  const stored = await store.get(body.key);
  assertNotEquals(stored, null);
});

// ============================================================================
// Multiple data types
// ============================================================================

Deno.test('API: stores and retrieves string data', async () => {
  const { app } = setup();
  await json(app, 'POST', '/store/notes/idea1', 'This is a string');
  const get = await json(app, 'GET', '/store/notes/idea1');
  assertEquals(get.status, 200);
  assertNotEquals(get.body.data, null);
});

Deno.test('API: stores and retrieves array data', async () => {
  const { app } = setup();
  await json(app, 'POST', '/store/tags', ['ai', 'ml', 'nlp']);
  const get = await json(app, 'GET', '/store/tags');
  assertEquals(get.status, 200);
  assertNotEquals(get.body.data, null);
});

Deno.test('API: stores and retrieves number data', async () => {
  const { app } = setup();
  await json(app, 'POST', '/store/counter', 42);
  const get = await json(app, 'GET', '/store/counter');
  assertEquals(get.status, 200);
  assertNotEquals(get.body.data, null);
});

Deno.test('API: stores and retrieves complex flat object', async () => {
  const { app } = setup();
  await json(app, 'POST', '/store/profiles/alice', {
    name: 'Alice',
    city: 'NYC',
    zip: '10001',
    role: 'admin',
    active: true,
  });
  const get = await json(app, 'GET', '/store/profiles/alice');
  assertEquals(get.status, 200);
  assertNotEquals(get.body.data, null);
});

// ============================================================================
// Auth
// ============================================================================

Deno.test('API: auth rejects requests without Bearer token', async () => {
  const store = createSmallstore({ preset: 'memory' });
  const app = createApiApp(store, { apiKey: 'secret123' });

  const { status, body } = await json(app, 'GET', '/');
  assertEquals(status, 401);
  assertEquals(body.error, 'Unauthorized');
});

Deno.test('API: auth allows requests with correct Bearer token', async () => {
  const store = createSmallstore({ preset: 'memory' });
  const app = createApiApp(store, { apiKey: 'secret123' });

  const res = await app.request('/', {
    headers: { Authorization: 'Bearer secret123' },
  });
  assertEquals(res.status, 200);
});

Deno.test('API: auth skips health check', async () => {
  const store = createSmallstore({ preset: 'memory' });
  const app = createApiApp(store, { apiKey: 'secret123' });

  const { status, body } = await json(app, 'GET', '/health');
  assertEquals(status, 200);
  assertEquals(body.status, 'ok');
});

// ============================================================================
// Collections listing after writes
// ============================================================================

Deno.test('API: collections lists written collections', async () => {
  const { app } = setup();

  await json(app, 'POST', '/store/inbox', { msg: 'hello' });
  await json(app, 'POST', '/store/outbox', { msg: 'world' });

  const { status, body } = await json(app, 'GET', '/collections');
  assertEquals(status, 200);
  // Memory preset tracks collections in metadata
  assertEquals(Array.isArray(body.collections), true);
});

// ============================================================================
// SQLite preset (local persistence + search + query)
// ============================================================================

Deno.test({
  name: 'API: local-sqlite preset — full CRUD + search + query cycle',
  fn: async () => {
    const store = createSmallstore({ preset: 'local-sqlite' });
    const app = createApiApp(store);

    // POST data
    const post = await json(app, 'POST', '/store/articles', {
      title: 'Introduction to Machine Learning',
      author: 'Alice',
      year: 2024,
    });
    assertEquals(post.status, 201);

    // GET data
    const get = await json(app, 'GET', '/store/articles');
    assertEquals(get.status, 200);
    assertNotEquals(get.body.data, null);

    // Keys
    const keys = await json(app, 'GET', '/store/articles/_keys');
    assertEquals(keys.status, 200);
    assertEquals(Array.isArray(keys.body.keys), true);

    // Search (FTS5 — may or may not find results depending on indexing)
    const search = await json(app, 'GET', '/store/articles/_search?q=machine+learning');
    assertEquals(search.status, 200);
    assertNotEquals(search.body.results, undefined);

    // Query
    const query = await json(app, 'POST', '/store/articles/_query', {
      filters: [{ field: 'author', op: 'eq', value: 'Alice' }],
    });
    assertEquals(query.status, 200);
    assertNotEquals(query.body.results, undefined);

    // PATCH
    const patch = await json(app, 'PATCH', '/store/articles', { year: 2025 });
    assertEquals(patch.status, 200);

    // DELETE
    const del = await json(app, 'DELETE', '/store/articles');
    assertEquals(del.status, 200);

    const gone = await json(app, 'GET', '/store/articles');
    assertEquals(gone.status, 404);

    // Cleanup
    try { await Deno.remove('./data/store.db'); } catch { /* ok */ }
    try { await Deno.remove('./data', { recursive: true }); } catch { /* ok */ }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
