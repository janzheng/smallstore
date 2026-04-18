/**
 * Smallstore Data Operations HTTP Integration Tests
 *
 * Tests for the HTTP endpoints backing slice, split, deduplicate, and merge
 * data operations. Boots a Hono app in-process with a memory-backed smallstore
 * and exercises each endpoint via `app.fetch()`.
 *
 * ============================================================================
 * KNOWN BUG (documented — these tests will fail until source is fixed)
 * ============================================================================
 *
 * The router's data-op methods (slice, split, deduplicate, merge) in
 * `src/router.ts` call `this.get(path)` without `{ raw: true }`. Since
 * router.get() wraps results in a `StorageFileResponse` (`{reference,
 * content, url, adapter, dataType}`), the `Array.isArray(data)` check
 * inside each data-op always fails for array-valued collections — they
 * throw "Collection X is not an array" or simply fail to iterate.
 *
 * Other internal consumers already pass `{ raw: true }` (see `copy()`,
 * `patch()`, `moveCollection()` at router.ts:291, 628, 1234, 2485), so
 * this is an omission in the data-op implementations rather than
 * intended behaviour.
 *
 * Fix: add `{ raw: true }` to the four internal `this.get(...)` calls in
 * `slice`, `split`, `deduplicate`, `merge` in src/router.ts.
 * ============================================================================
 *
 * Routing (verified against src/http/integrations/hono.ts):
 *   POST  /:collection/slice        — slice a collection
 *   POST  /:collection/split        — split a collection by field
 *   POST  /:collection/deduplicate  — deduplicate a collection
 *   POST  /merge                    — merge multiple collections (NOT /:collection/merge)
 *
 * Body shapes (verified against src/http/handlers.ts + src/types.ts):
 *   slice       : { start, end, saveTo?, returnData? }
 *   split       : { by, destPattern, maxPerSplit? }
 *   deduplicate : { idField? | useContentHash? | compareFields?, keep? }
 *   merge       : { sources, dest, deduplicate?, idField?, onConflict?, overwrite? }
 *
 * Run with: deno test --no-check --allow-all tests/data-ops-http.test.ts
 */

import { assertEquals, assertExists, assert } from '@std/assert';
import { Hono } from 'hono';
import { createSmallstore, createMemoryAdapter } from '../mod.ts';
import { createHonoRoutes } from '../src/http/integrations/hono.ts';

// ============================================================================
// Test harness
// ============================================================================

interface Harness {
  app: Hono;
  store: ReturnType<typeof createSmallstore>;
}

function makeHarness(): Harness {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  const app = new Hono();
  createHonoRoutes(app, store);
  return { app, store };
}

async function jsonPost(app: Hono, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function rawPost(app: Hono, path: string, raw: string): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })
  );
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Read back the raw stored value (unwrapped from StorageFileResponse). */
async function readRaw(store: any, path: string): Promise<any> {
  return await store.get(path, { raw: true });
}

function tenRecords(): any[] {
  return Array.from({ length: 10 }, (_, i) => ({ id: String(i), value: `v${i}` }));
}

// ============================================================================
// Slice
// ============================================================================

Deno.test('slice: returns correct subset of records', async () => {
  const { app, store } = makeHarness();
  await store.set('items', tenRecords());

  const { status, body } = await jsonPost(app, '/items/slice', { start: 2, end: 5 });

  assertEquals(status, 200);
  assertEquals(body.success, true);
  assertEquals(body.collection, 'items');
  assertEquals(body.count, 3);
  assertEquals(body.data.map((r: any) => r.id), ['2', '3', '4']);
});

Deno.test('slice: saveTo creates new collection with sliced records', async () => {
  const { app, store } = makeHarness();
  await store.set('items', tenRecords());

  const { status } = await jsonPost(app, '/items/slice', {
    start: 0,
    end: 4,
    saveTo: 'items-head',
  });

  assertEquals(status, 200);
  const saved = await readRaw(store, 'items-head');
  assertExists(saved);
  assertEquals(Array.isArray(saved), true);
  assertEquals((saved as any[]).length, 4);
  assertEquals((saved as any[]).map((r: any) => r.id), ['0', '1', '2', '3']);
});

Deno.test('slice: out-of-range indices produce empty data, not error', async () => {
  const { app, store } = makeHarness();
  await store.set('items', tenRecords());

  const { status, body } = await jsonPost(app, '/items/slice', { start: 100, end: 200 });

  assertEquals(status, 200);
  assertEquals(body.count, 0);
  assertEquals(body.data, []);
});

Deno.test('slice: negative indices fall through to Array.prototype.slice semantics', async () => {
  const { app, store } = makeHarness();
  await store.set('items', tenRecords());

  const { status, body } = await jsonPost(app, '/items/slice', { start: -3, end: -1 });

  assertEquals(status, 200);
  assertEquals(body.count, 2);
  assertEquals(body.data.map((r: any) => r.id), ['7', '8']);
});

Deno.test('slice: empty collection yields empty response, not error', async () => {
  const { app, store } = makeHarness();
  await store.set('items', []);
  const { status, body } = await jsonPost(app, '/items/slice', { start: 0, end: 3 });
  // Empty arrays may hit the "skipped storage" path in set() — in that case slice should 404.
  // Either a 200 with empty data OR a 404 is acceptable; error-with-stack-trace is not.
  assert(status === 200 || status === 404, `expected 200 or 404, got ${status}`);
  if (status === 200) assertEquals(body.count, 0);
});

Deno.test('slice: non-existent collection returns 404', async () => {
  const { app } = makeHarness();
  const { status, body } = await jsonPost(app, '/missing/slice', { start: 0, end: 1 });
  assertEquals(status, 404);
  assertEquals(body.error, 'NotFound');
});

Deno.test('slice: non-array collection returns 400', async () => {
  const { app, store } = makeHarness();
  await store.set('single', { name: 'not-an-array', value: 42 });
  const { status, body } = await jsonPost(app, '/single/slice', { start: 0, end: 1 });
  assertEquals(status, 400);
  assertEquals(body.error, 'BadRequest');
  assert(String(body.message).includes('not an array'));
});

// ============================================================================
// Split
// ============================================================================

Deno.test('split: partitions records by field value into destination collections', async () => {
  const { app, store } = makeHarness();
  await store.set('papers', [
    { id: '1', category: 'a' },
    { id: '2', category: 'b' },
    { id: '3', category: 'a' },
    { id: '4', category: 'c' },
    { id: '5', category: 'b' },
  ]);

  const { status, body } = await jsonPost(app, '/papers/split', {
    by: 'category',
    destPattern: 'papers-{value}',
  });

  assertEquals(status, 200);
  assertEquals(body.success, true);
  assertEquals(body.by, 'category');

  const catA = await readRaw(store, 'papers-a') as any[];
  const catB = await readRaw(store, 'papers-b') as any[];
  const catC = await readRaw(store, 'papers-c') as any[];
  assertEquals(catA.length, 2);
  assertEquals(catB.length, 2);
  assertEquals(catC.length, 1);
  assert(catA.every((r: any) => r.category === 'a'));
  assert(catB.every((r: any) => r.category === 'b'));
});

Deno.test('split: missing "by" field returns 400', async () => {
  const { app, store } = makeHarness();
  await store.set('papers', [{ id: '1', category: 'a' }]);
  const { status, body } = await jsonPost(app, '/papers/split', { destPattern: 'papers-{value}' });
  assertEquals(status, 400);
  assert(String(body.message).includes('by'));
});

Deno.test('split: missing "destPattern" returns 400', async () => {
  const { app, store } = makeHarness();
  await store.set('papers', [{ id: '1', category: 'a' }]);
  const { status, body } = await jsonPost(app, '/papers/split', { by: 'category' });
  assertEquals(status, 400);
  assert(String(body.message).includes('destPattern'));
});

Deno.test('split: items missing the field go into "_unclassified" bucket', async () => {
  const { app, store } = makeHarness();
  await store.set('papers', [
    { id: '1', category: 'a' },
    { id: '2' },
    { id: '3', category: null },
  ]);

  const { status } = await jsonPost(app, '/papers/split', {
    by: 'category',
    destPattern: 'p-{value}',
  });
  assertEquals(status, 200);

  const catA = await readRaw(store, 'p-a') as any[];
  const unclassified = await readRaw(store, 'p-_unclassified') as any[];
  assertEquals(catA.length, 1);
  assertEquals(unclassified.length, 2);
});

Deno.test('split: non-existent collection returns 404', async () => {
  const { app } = makeHarness();
  const { status, body } = await jsonPost(app, '/missing/split', {
    by: 'x',
    destPattern: 'y-{value}',
  });
  assertEquals(status, 404);
  assertEquals(body.error, 'NotFound');
});

Deno.test('split: maxPerSplit caps each destination bucket', async () => {
  const { app, store } = makeHarness();
  await store.set('papers', [
    { id: '1', category: 'a' },
    { id: '2', category: 'a' },
    { id: '3', category: 'a' },
    { id: '4', category: 'a' },
  ]);
  const { status } = await jsonPost(app, '/papers/split', {
    by: 'category',
    destPattern: 'p-{value}',
    maxPerSplit: 2,
  });
  assertEquals(status, 200);
  const catA = await readRaw(store, 'p-a') as any[];
  assertEquals(catA.length, 2);
});

// ============================================================================
// Deduplicate
// ============================================================================

Deno.test('deduplicate: by idField removes duplicates, keeps first', async () => {
  const { app, store } = makeHarness();
  await store.set('items', [
    { id: '1', v: 'a' },
    { id: '2', v: 'b' },
    { id: '1', v: 'c' },
    { id: '3', v: 'd' },
  ]);

  const { status } = await jsonPost(app, '/items/deduplicate', { idField: 'id' });
  assertEquals(status, 200);

  const remaining = await readRaw(store, 'items') as any[];
  assertEquals(remaining.length, 3);
  assertEquals(remaining.find((r: any) => r.id === '1').v, 'a');
});

Deno.test('deduplicate: keep=last picks the later occurrence', async () => {
  const { app, store } = makeHarness();
  await store.set('items', [
    { id: '1', v: 'first' },
    { id: '1', v: 'last' },
  ]);
  const { status } = await jsonPost(app, '/items/deduplicate', { idField: 'id', keep: 'last' });
  assertEquals(status, 200);
  const remaining = await readRaw(store, 'items') as any[];
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0].v, 'last');
});

Deno.test('deduplicate: by contentHash removes exact-JSON duplicates', async () => {
  const { app, store } = makeHarness();
  await store.set('items', [
    { a: 1, b: 2 },
    { a: 1, b: 2 },
    { a: 1, b: 3 },
    { a: 1, b: 2 },
  ]);
  const { status } = await jsonPost(app, '/items/deduplicate', { useContentHash: true });
  assertEquals(status, 200);
  const remaining = await readRaw(store, 'items') as any[];
  assertEquals(remaining.length, 2);
});

Deno.test('deduplicate: by compareFields uses specified fields only', async () => {
  const { app, store } = makeHarness();
  await store.set('items', [
    { email: 'a@x.com', extra: 1 },
    { email: 'b@x.com', extra: 2 },
    { email: 'a@x.com', extra: 3 },
  ]);
  const { status } = await jsonPost(app, '/items/deduplicate', { compareFields: ['email'] });
  assertEquals(status, 200);
  const remaining = await readRaw(store, 'items') as any[];
  assertEquals(remaining.length, 2);
  const emails = remaining.map((r: any) => r.email).sort();
  assertEquals(emails, ['a@x.com', 'b@x.com']);
});

Deno.test('deduplicate: is idempotent — second call is a no-op', async () => {
  const { app, store } = makeHarness();
  await store.set('items', [
    { id: '1' }, { id: '1' }, { id: '2' },
  ]);
  await jsonPost(app, '/items/deduplicate', { idField: 'id' });
  const afterFirst = ((await readRaw(store, 'items')) as any[]).length;
  await jsonPost(app, '/items/deduplicate', { idField: 'id' });
  const afterSecond = ((await readRaw(store, 'items')) as any[]).length;
  assertEquals(afterFirst, afterSecond);
  assertEquals(afterSecond, 2);
});

Deno.test('deduplicate: non-existent collection returns 404', async () => {
  const { app } = makeHarness();
  const { status, body } = await jsonPost(app, '/missing/deduplicate', { idField: 'id' });
  assertEquals(status, 404);
  assertEquals(body.error, 'NotFound');
});

// ============================================================================
// Merge
//
// NOTE: merge is mounted at POST /merge (NOT /:collection/merge).
// Body: { sources: string[], dest: string, deduplicate?, idField?, onConflict?, overwrite? }
// ============================================================================

Deno.test('merge: combines two collections into target', async () => {
  const { app, store } = makeHarness();
  await store.set('col-a', [{ id: '1' }, { id: '2' }]);
  await store.set('col-b', [{ id: '3' }, { id: '4' }]);

  const { status, body } = await jsonPost(app, '/merge', {
    sources: ['col-a', 'col-b'],
    dest: 'merged',
    overwrite: true,
  });

  assertEquals(status, 201);
  assertEquals(body.success, true);
  assertEquals(body.dest, 'merged');

  const merged = await readRaw(store, 'merged') as any[];
  assertEquals(merged.length, 4);
  const ids = merged.map((r: any) => r.id).sort();
  assertEquals(ids, ['1', '2', '3', '4']);
});

Deno.test('merge: with deduplicate+idField collapses duplicate ids', async () => {
  const { app, store } = makeHarness();
  await store.set('col-a', [{ id: '1', from: 'a' }, { id: '2', from: 'a' }]);
  await store.set('col-b', [{ id: '2', from: 'b' }, { id: '3', from: 'b' }]);

  const { status } = await jsonPost(app, '/merge', {
    sources: ['col-a', 'col-b'],
    dest: 'merged',
    deduplicate: true,
    idField: 'id',
    overwrite: true,
  });

  assertEquals(status, 201);
  const merged = await readRaw(store, 'merged') as any[];
  assertEquals(merged.length, 3);
  const ids = merged.map((r: any) => r.id).sort();
  assertEquals(ids, ['1', '2', '3']);
});

Deno.test('merge: merges three collections correctly', async () => {
  const { app, store } = makeHarness();
  await store.set('a', [{ id: '1' }]);
  await store.set('b', [{ id: '2' }, { id: '3' }]);
  await store.set('c', [{ id: '4' }, { id: '5' }, { id: '6' }]);

  const { status } = await jsonPost(app, '/merge', {
    sources: ['a', 'b', 'c'],
    dest: 'all',
    overwrite: true,
  });
  assertEquals(status, 201);

  const merged = await readRaw(store, 'all') as any[];
  assertEquals(merged.length, 6);
});

Deno.test('merge: empty source passes other records through', async () => {
  const { app, store } = makeHarness();
  await store.set('full', [{ id: '1' }, { id: '2' }]);
  // Note: setting an empty array is a no-op in the router (skipped storage).
  // So an "empty source" here is effectively a non-existent one.
  const { status } = await jsonPost(app, '/merge', {
    sources: ['empty', 'full'],
    dest: 'merged',
    overwrite: true,
  });
  assertEquals(status, 201);
  const merged = await readRaw(store, 'merged') as any[];
  assertEquals(merged.length, 2);
});

Deno.test('merge: onConflict=replace overwrites earlier duplicates', async () => {
  const { app, store } = makeHarness();
  await store.set('a', [{ id: '1', v: 'a' }]);
  await store.set('b', [{ id: '1', v: 'b' }]);

  const { status } = await jsonPost(app, '/merge', {
    sources: ['a', 'b'],
    dest: 'merged',
    deduplicate: true,
    idField: 'id',
    onConflict: 'replace',
    overwrite: true,
  });
  assertEquals(status, 201);
  const merged = await readRaw(store, 'merged') as any[];
  assertEquals(merged.length, 1);
  assertEquals(merged[0].v, 'b');
});

Deno.test('merge: onConflict=merge shallow-merges duplicates', async () => {
  const { app, store } = makeHarness();
  await store.set('a', [{ id: '1', x: 1 }]);
  await store.set('b', [{ id: '1', y: 2 }]);

  const { status } = await jsonPost(app, '/merge', {
    sources: ['a', 'b'],
    dest: 'merged',
    deduplicate: true,
    idField: 'id',
    onConflict: 'merge',
    overwrite: true,
  });
  assertEquals(status, 201);
  const merged = await readRaw(store, 'merged') as any[];
  assertEquals(merged.length, 1);
  assertEquals(merged[0].x, 1);
  assertEquals(merged[0].y, 2);
});

Deno.test('merge: missing "sources" returns 400', async () => {
  const { app } = makeHarness();
  const { status, body } = await jsonPost(app, '/merge', { dest: 'merged' });
  assertEquals(status, 400);
  assert(String(body.message).includes('sources'));
});

Deno.test('merge: missing "dest" returns 400', async () => {
  const { app, store } = makeHarness();
  await store.set('a', [{ id: '1' }]);
  const { status, body } = await jsonPost(app, '/merge', { sources: ['a'] });
  assertEquals(status, 400);
  assert(String(body.message).includes('dest'));
});

Deno.test('merge: empty sources array returns 400', async () => {
  const { app } = makeHarness();
  const { status, body } = await jsonPost(app, '/merge', { sources: [], dest: 'x' });
  assertEquals(status, 400);
  assert(String(body.message).includes('sources'));
});

// ============================================================================
// Error shapes: malformed bodies, missing fields
// ============================================================================

Deno.test('error shape: malformed JSON body → handler tolerates null body, returns 400 for missing required fields', async () => {
  // Hono wrap() silently swallows JSON parse errors and leaves request.body = null.
  // For split/merge this means required-field validation trips and returns 400.
  const { app, store } = makeHarness();
  await store.set('items', tenRecords());

  const { status: splitStatus, body: splitBody } = await rawPost(app, '/items/split', '{not-valid-json');
  assertEquals(splitStatus, 400);
  assertEquals(splitBody.error, 'BadRequest');

  const { status: mergeStatus, body: mergeBody } = await rawPost(app, '/merge', '{not-valid-json');
  assertEquals(mergeStatus, 400);
  assertEquals(mergeBody.error, 'BadRequest');
});

Deno.test('error shape: split with empty body surfaces missing-field error', async () => {
  const { app, store } = makeHarness();
  await store.set('items', tenRecords());
  const { status, body } = await jsonPost(app, '/items/split', {});
  assertEquals(status, 400);
  assertEquals(body.error, 'BadRequest');
  assert(typeof body.message === 'string' && body.message.length > 0);
});

Deno.test('error shape: merge on non-existent source returns 201 (no throw)', async () => {
  // Current router behavior: get() of unknown source returns null and is skipped.
  // The merge completes successfully even with zero loaded items.
  const { app } = makeHarness();
  const { status } = await jsonPost(app, '/merge', {
    sources: ['does-not-exist'],
    dest: 'merged',
  });
  assertEquals(status, 201);
});
