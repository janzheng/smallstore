/**
 * SheetlogAdapter guard tests.
 *
 * Covers the fix for the silent-wipe footgun:
 * `set(key, value)` and `delete(key)` both used to blow away every row
 * on the tab because the `key` arg was ignored. They now throw with
 * actionable messages. `clear()` keeps the explicit wipe behavior;
 * `replace()` is the new explicit replace-whole-sheet path.
 *
 * We don't need real network — `set()` and `delete()` throw before
 * hitting the client, and for `replace()` / `clear()` we swap in a
 * stub client that records calls.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { SheetlogAdapter } from '../src/adapters/sheetlog.ts';

interface StubCall {
  method: 'get' | 'bulkDelete' | 'dynamicPost' | 'batchUpsert';
  args: unknown[];
}

function buildAdapter(initialRows: any[] = []) {
  const adapter = new SheetlogAdapter({
    sheetUrl: 'https://script.google.com/macros/s/TEST/exec',
    sheet: 'TestTab',
  });

  const calls: StubCall[] = [];
  const stub = {
    get: async (_key: unknown, _opts: unknown) => {
      calls.push({ method: 'get', args: [_key, _opts] });
      return { data: [...initialRows] };
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
      return { data: { inserted: items.length, updated: 0 } };
    },
  };
  // deno-lint-ignore no-explicit-any
  (adapter as any).client = stub;
  return { adapter, calls };
}

// ============================================================================
// set(): the main footgun — must throw, must not touch the client
// ============================================================================

Deno.test('sheetlog — set() throws with actionable message', async () => {
  const { adapter, calls } = buildAdapter();
  const err = await assertRejects(
    () => adapter.set('anything', { foo: 1 }),
    Error,
  );
  assert(err.message.includes('set() is disabled'));
  assert(err.message.includes('sm_append'));
  assertEquals(calls.length, 0); // never touched the client
});

Deno.test('sheetlog — set() with array also throws (no accidental replace)', async () => {
  const { adapter, calls } = buildAdapter([{ _id: 1, foo: 1 }]);
  await assertRejects(
    () => adapter.set('k', [{ foo: 2 }]),
    Error,
    'set() is disabled',
  );
  assertEquals(calls.length, 0);
});

Deno.test('sheetlog — set() with ttl arg still throws (no side channel)', async () => {
  const { adapter } = buildAdapter();
  await assertRejects(() => adapter.set('k', { foo: 1 }, 3600), Error);
});

// ============================================================================
// delete(key): same footgun — throws
// ============================================================================

Deno.test('sheetlog — delete(key) throws with actionable message', async () => {
  const { adapter, calls } = buildAdapter([{ _id: 1 }, { _id: 2 }]);
  const err = await assertRejects(() => adapter.delete('some-key'), Error);
  assert(err.message.includes('delete(key) is disabled'));
  assert(err.message.includes('clear()'));
  assertEquals(calls.length, 0); // nothing was wiped
});

// ============================================================================
// replace(): the explicit wipe-and-reseed — does what old set() did
// ============================================================================

Deno.test('sheetlog — replace() wipes existing rows then inserts', async () => {
  const { adapter, calls } = buildAdapter([
    { _id: 10, foo: 'old-a' },
    { _id: 11, foo: 'old-b' },
  ]);
  await adapter.replace([{ foo: 'new-a' }, { foo: 'new-b' }]);

  // Expect: get → bulkDelete → dynamicPost
  assertEquals(calls[0].method, 'get');
  assertEquals(calls[1].method, 'bulkDelete');
  assertEquals(calls[1].args[0], [10, 11]);
  assertEquals(calls[2].method, 'dynamicPost');
  assertEquals(calls[2].args[0], [{ foo: 'new-a' }, { foo: 'new-b' }]);
});

Deno.test('sheetlog — replace() wraps a single object into an array', async () => {
  const { adapter, calls } = buildAdapter([]);
  await adapter.replace({ foo: 'only' });
  const post = calls.find((c) => c.method === 'dynamicPost');
  assertEquals(post?.args[0], [{ foo: 'only' }]);
});

Deno.test('sheetlog — replace() with empty array still wipes (no insert)', async () => {
  const { adapter, calls } = buildAdapter([{ _id: 1 }]);
  await adapter.replace([]);
  assert(calls.some((c) => c.method === 'bulkDelete'));
  assert(!calls.some((c) => c.method === 'dynamicPost'));
});

// ============================================================================
// clear(): explicit whole-sheet wipe — still works
// ============================================================================

Deno.test('sheetlog — clear() wipes existing rows, no re-insert', async () => {
  const { adapter, calls } = buildAdapter([
    { _id: 1 },
    { _id: 2 },
    { _id: 3 },
  ]);
  await adapter.clear();
  assertEquals(calls[0].method, 'get');
  assertEquals(calls[1].method, 'bulkDelete');
  assertEquals(calls[1].args[0], [1, 2, 3]);
  assert(!calls.some((c) => c.method === 'dynamicPost'));
});

Deno.test('sheetlog — clear() on empty sheet is a no-op (no bulkDelete)', async () => {
  const { adapter, calls } = buildAdapter([]);
  await adapter.clear();
  assertEquals(calls.filter((c) => c.method === 'bulkDelete').length, 0);
});

// ============================================================================
// append(): non-destructive — still the recommended write path
// ============================================================================

Deno.test('sheetlog — append() posts rows without any delete', async () => {
  const { adapter, calls } = buildAdapter([{ _id: 1, foo: 'keep-me' }]);
  await adapter.append([{ foo: 'new-row' }]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'dynamicPost');
  assertEquals(calls[0].args[0], [{ foo: 'new-row' }]);
});

Deno.test('sheetlog — append() wraps single object', async () => {
  const { adapter, calls } = buildAdapter([]);
  await adapter.append({ foo: 'one' });
  assertEquals(calls[0].args[0], [{ foo: 'one' }]);
});

Deno.test('sheetlog — append() empty array is a no-op', async () => {
  const { adapter, calls } = buildAdapter([]);
  await adapter.append([]);
  assertEquals(calls.length, 0);
});

// ============================================================================
// Capabilities unchanged — sanity check
// ============================================================================

Deno.test('sheetlog — capabilities still report append-friendly shape', () => {
  const { adapter } = buildAdapter();
  assertEquals(adapter.capabilities.name, 'sheetlog');
  assert(adapter.capabilities.supportedTypes.includes('object'));
});
