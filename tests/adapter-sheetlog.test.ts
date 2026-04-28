/**
 * SheetlogAdapter offline mock tests.
 *
 * Companion to `tests/adapter-sheetlog-guard.test.ts` (which covers the
 * destructive-set / destructive-delete guards + the explicit replace +
 * clear paths). This file fills the remaining offline coverage:
 * constructor validation, capabilities, get/has/keys, upsert (all 4
 * shapes), insert, merge (id / hash / fields strategies), query, list.
 *
 * Mocking pattern: stub the underlying `client` directly (matches
 * adapter-sheetlog-guard.test.ts), avoiding any real fetch dispatch.
 * Recorded calls let us assert request shape per method.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { SheetlogAdapter, createSheetlogAdapter } from '../src/adapters/sheetlog.ts';

// ============================================================================
// Stub client harness
// ============================================================================

interface StubCall {
  method: 'get' | 'bulkDelete' | 'dynamicPost' | 'batchUpsert';
  args: unknown[];
}

interface StubOptions {
  /** Initial rows the stubbed `client.get` returns. */
  initialRows?: any[];
  /** When set, `client.get` resolves to this value (overrides initialRows). */
  getResponse?: unknown;
  /** When set, `client.get` rejects with this error. */
  getError?: Error;
}

function buildAdapter(opts: StubOptions = {}) {
  const adapter = new SheetlogAdapter({
    sheetUrl: 'https://script.google.com/macros/s/TEST/exec',
    sheet: 'TestTab',
  });
  const calls: StubCall[] = [];
  const stub = {
    get: async (key: unknown, getOpts: unknown) => {
      calls.push({ method: 'get', args: [key, getOpts] });
      if (opts.getError) throw opts.getError;
      if (opts.getResponse !== undefined) return opts.getResponse;
      return { data: [...(opts.initialRows ?? [])] };
    },
    bulkDelete: async (ids: unknown[]) => {
      calls.push({ method: 'bulkDelete', args: [ids] });
      return { status: 200 };
    },
    dynamicPost: async (items: unknown[]) => {
      calls.push({ method: 'dynamicPost', args: [items] });
      return { status: 201 };
    },
    batchUpsert: async (idField: unknown, items: unknown[]) => {
      calls.push({ method: 'batchUpsert', args: [idField, items] });
      return { data: { inserted: (items as any[]).length, updated: 0 } };
    },
  };
  // deno-lint-ignore no-explicit-any
  (adapter as any).client = stub;
  return { adapter, calls };
}

// ============================================================================
// Constructor + factory + capabilities
// ============================================================================

Deno.test('sheetlog — constructor throws on missing sheetUrl', () => {
  // deno-lint-ignore no-explicit-any
  assertRejects(async () => new SheetlogAdapter({ sheet: 'Tab' } as any), Error, 'sheetUrl');
});

Deno.test('sheetlog — constructor throws on missing sheet', () => {
  assertRejects(
    // deno-lint-ignore no-explicit-any
    async () => new SheetlogAdapter({ sheetUrl: 'https://example.com' } as any),
    Error,
    'sheet',
  );
});

Deno.test('sheetlog — createSheetlogAdapter factory returns SheetlogAdapter', () => {
  const a = createSheetlogAdapter({
    sheetUrl: 'https://script.google.com/macros/s/X/exec',
    sheet: 'Tab',
  });
  assert(a instanceof SheetlogAdapter);
});

Deno.test('sheetlog — capabilities reports object support + Sheetlog quirks', () => {
  const { adapter } = buildAdapter();
  const caps = adapter.capabilities;
  assertEquals(caps.name, 'sheetlog');
  // Sheet-as-collection model — supports object / array, not raw blobs.
  assert(caps.supportedTypes.includes('object'));
});

// ============================================================================
// get / has / keys
// ============================================================================

Deno.test('sheetlog — get() returns array of rows from client.data', async () => {
  const rows = [{ _id: '1', name: 'Alice' }, { _id: '2', name: 'Bob' }];
  const { adapter, calls } = buildAdapter({ initialRows: rows });
  const result = await adapter.get('ignored-key');
  assertEquals(result, rows);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'get');
  // First arg is null per the adapter (sheet-as-array), opts include limit.
  assertEquals(calls[0].args[0], null);
});

Deno.test('sheetlog — get() returns null when sheet is empty', async () => {
  const { adapter } = buildAdapter({ initialRows: [] });
  const result = await adapter.get('any-key');
  assertEquals(result, null);
});

Deno.test('sheetlog — get() swallows client errors and returns null', async () => {
  const { adapter } = buildAdapter({ getError: new Error('upstream blew up') });
  const result = await adapter.get('any-key');
  // Logged but not thrown — caller treats this as "no data".
  assertEquals(result, null);
});

Deno.test('sheetlog — has() true when sheet has data', async () => {
  const { adapter } = buildAdapter({ initialRows: [{ _id: '1' }] });
  assertEquals(await adapter.has('any-key'), true);
});

Deno.test('sheetlog — has() false on empty sheet', async () => {
  const { adapter } = buildAdapter({ initialRows: [] });
  assertEquals(await adapter.has('any-key'), false);
});

Deno.test('sheetlog — keys() always returns [] (sheet = single collection)', async () => {
  const { adapter } = buildAdapter({ initialRows: [{ _id: '1' }, { _id: '2' }] });
  assertEquals(await adapter.keys(), []);
  assertEquals(await adapter.keys('any-prefix'), []);
});

// ============================================================================
// upsert
// ============================================================================

Deno.test('sheetlog — upsert(single object) wraps + auto-detects idField from first key', async () => {
  const { adapter, calls } = buildAdapter();
  const result = await adapter.upsert({ id: 'a', name: 'Alice' });
  assertEquals(result.count, 1);
  assertEquals(result.keys, ['a']);
  const upsertCall = calls.find((c) => c.method === 'batchUpsert');
  assert(upsertCall, 'expected batchUpsert call');
  assertEquals(upsertCall!.args[0], 'id'); // first key wins as idField
  assertEquals((upsertCall!.args[1] as any[]).length, 1);
});

Deno.test('sheetlog — upsert(array) batches all items', async () => {
  const { adapter, calls } = buildAdapter();
  const result = await adapter.upsert([
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
  ]);
  assertEquals(result.count, 2);
  assertEquals(result.keys, ['a', 'b']);
  const upsertCall = calls.find((c) => c.method === 'batchUpsert');
  assertEquals((upsertCall!.args[1] as any[]).length, 2);
});

Deno.test('sheetlog — upsert with explicit idField uses it instead of auto-detect', async () => {
  const { adapter, calls } = buildAdapter();
  await adapter.upsert([{ pmid: 'X1', score: 9 }, { pmid: 'X2', score: 7 }], { idField: 'pmid' });
  const upsertCall = calls.find((c) => c.method === 'batchUpsert');
  assertEquals(upsertCall!.args[0], 'pmid');
});

Deno.test('sheetlog — upsert with keyGenerator injects __generatedKey', async () => {
  const { adapter, calls } = buildAdapter();
  await adapter.upsert(
    [{ name: 'Alice' }, { name: 'Bob' }],
    { keyGenerator: (obj: any) => `gen-${obj.name}` },
  );
  const upsertCall = calls.find((c) => c.method === 'batchUpsert');
  assertEquals(upsertCall!.args[0], '__generatedKey');
  const items = upsertCall!.args[1] as any[];
  assertEquals(items[0].__generatedKey, 'gen-Alice');
  assertEquals(items[1].__generatedKey, 'gen-Bob');
});

Deno.test('sheetlog — upsert non-object throws', async () => {
  const { adapter } = buildAdapter();
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    async () => await adapter.upsert(['not', 'objects'] as any),
    Error,
    'requires object',
  );
});

Deno.test('sheetlog — upsert empty array short-circuits with count: 0', async () => {
  const { adapter, calls } = buildAdapter();
  const result = await adapter.upsert([]);
  assertEquals(result, { count: 0, keys: [] });
  // No batchUpsert call dispatched.
  assertEquals(calls.filter((c) => c.method === 'batchUpsert').length, 0);
});

Deno.test('sheetlog — upsert without explicit idField + non-unique first key throws', async () => {
  const { adapter } = buildAdapter();
  // First key is `category` and the same value repeats — auto-detect fails;
  // none of the common-id-field fallbacks (id, _id, pmid, ...) are present
  // either, so the function throws.
  await assertRejects(
    async () => await adapter.upsert([
      { category: 'tech' }, { category: 'tech' }, { category: 'tech' },
    ]),
    Error,
    'auto-detect',
  );
});

// ============================================================================
// insert
// ============================================================================

Deno.test('sheetlog — insert() delegates to upsert + returns idField', async () => {
  const { adapter, calls } = buildAdapter();
  const result = await adapter.insert({ id: 'x', label: 'X' });
  assertEquals(result.count, 1);
  assertEquals(result.keys, ['x']);
  assertEquals(result.idField, 'id');
  // Underlying batchUpsert fired exactly once.
  assertEquals(calls.filter((c) => c.method === 'batchUpsert').length, 1);
});

Deno.test('sheetlog — insert with explicit idField bypasses auto-detect entirely', async () => {
  // Note: `autoDetect: false` at insert level only skips the insert-level
  // auto-detect; the underlying upsert still auto-detects on its own. So the
  // useful surface is "pass an explicit idField and we use it." Tested here.
  const { adapter, calls } = buildAdapter();
  const result = await adapter.insert(
    [{ pmid: 'P1', t: 'a' }, { pmid: 'P2', t: 'b' }],
    { idField: 'pmid', autoDetect: false },
  );
  assertEquals(result.idField, 'pmid');
  const upsertCall = calls.find((c) => c.method === 'batchUpsert');
  assertEquals(upsertCall!.args[0], 'pmid');
});

// ============================================================================
// merge — three dedup strategies
// ============================================================================

Deno.test('sheetlog — merge(id strategy) dedups against existing rows + adds new', async () => {
  const existing = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
  const { adapter, calls } = buildAdapter({ initialRows: existing });
  const result = await adapter.merge(
    'ignored',
    [
      { id: 'b', v: 99 }, // dup of existing → skipped
      { id: 'c', v: 3 },  // new → added
    ],
    { strategy: 'id', idField: 'id' },
  );
  assertEquals(result.added, 1);
  assertEquals(result.skipped, 1);
  assertEquals(result.totalItems, 3);
  // Only the new item gets posted.
  const post = calls.find((c) => c.method === 'dynamicPost');
  assert(post);
  assertEquals((post!.args[0] as any[]).length, 1);
  assertEquals((post!.args[0] as any[])[0].id, 'c');
});

Deno.test('sheetlog — merge(hash strategy) dedups by content hash', async () => {
  const existing = [{ name: 'A', val: 1 }];
  const { adapter, calls } = buildAdapter({ initialRows: existing });
  const result = await adapter.merge(
    'ignored',
    [
      { name: 'A', val: 1 },  // identical content → skipped
      { name: 'B', val: 2 },  // new → added
    ],
    { strategy: 'hash' },
  );
  assertEquals(result.added, 1);
  assertEquals(result.skipped, 1);
  // Only the unique item gets posted.
  const post = calls.find((c) => c.method === 'dynamicPost');
  assertEquals((post!.args[0] as any[]).length, 1);
  assertEquals((post!.args[0] as any[])[0].name, 'B');
});

Deno.test('sheetlog — merge(fields strategy) dedups by compareFields subset', async () => {
  const existing = [{ name: 'Alice', email: 'a@example.com', score: 100 }];
  const { adapter } = buildAdapter({ initialRows: existing });
  const result = await adapter.merge(
    'ignored',
    [
      // Same email → dup (compareFields includes 'email' only)
      { name: 'Different Alice', email: 'a@example.com', score: 0 },
      { name: 'Bob', email: 'b@example.com', score: 50 },
    ],
    { strategy: 'fields', compareFields: ['email'] },
  );
  assertEquals(result.added, 1);
  assertEquals(result.skipped, 1);
});

Deno.test('sheetlog — merge non-array newItems throws', async () => {
  const { adapter } = buildAdapter();
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    async () => await adapter.merge('ignored', 'not an array' as any),
    Error,
    'requires an array',
  );
});

// ============================================================================
// query + list
// ============================================================================

Deno.test('sheetlog — query applies filter + returns totalCount', async () => {
  const rows = [
    { id: '1', age: 20 },
    { id: '2', age: 30 },
    { id: '3', age: 25 },
    { id: '4', age: 40 },
  ];
  const { adapter } = buildAdapter({ initialRows: rows });
  const result = await adapter.query({ filter: (r: any) => r.age >= 25 });
  assertEquals(result.totalCount, 3);
  assertEquals(result.data.length, 3);
});

Deno.test('sheetlog — query with limit truncates but reports full totalCount', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  const { adapter } = buildAdapter({ initialRows: rows });
  const result = await adapter.query({ limit: 3 });
  assertEquals(result.data.length, 3);
  assertEquals(result.totalCount, 10);
});

Deno.test('sheetlog — query empty sheet returns { data: [], totalCount: 0 }', async () => {
  const { adapter } = buildAdapter({ initialRows: [] });
  assertEquals(await adapter.query({}), { data: [], totalCount: 0 });
});

Deno.test('sheetlog — list slices by offset + limit', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  const { adapter } = buildAdapter({ initialRows: rows });
  const slice = await adapter.list({ offset: 3, limit: 4 });
  assertEquals(slice.length, 4);
  assertEquals(slice.map((r: any) => r.id), ['3', '4', '5', '6']);
});

Deno.test('sheetlog — list empty sheet returns []', async () => {
  const { adapter } = buildAdapter({ initialRows: [] });
  assertEquals(await adapter.list(), []);
});
