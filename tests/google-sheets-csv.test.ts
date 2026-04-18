/**
 * Google Sheets CSV Adapter Tests
 *
 * No network — the adapter accepts a `fetchImpl` option for stubbing.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import {
  createGoogleSheetsCsvAdapter,
  GoogleSheetsCsvAdapter,
} from '../src/adapters/google-sheets-csv.ts';
import { UnsupportedOperationError } from '../src/adapters/errors.ts';

const FAKE_URL = 'https://docs.google.com/spreadsheets/d/FAKE_SHEET_ID/export?format=csv';

// ----------------------------------------------------------------------------
// Stub helpers
// ----------------------------------------------------------------------------

function makeFetchStub(csvByUrl: Map<string, string> | string, opts?: {
  countRef?: { n: number };
  status?: number;
}) {
  const stub: typeof fetch = (input: string | URL | Request): Promise<Response> => {
    if (opts?.countRef) opts.countRef.n += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof csvByUrl === 'string'
      ? csvByUrl
      : (csvByUrl.get(url) ?? '');
    const status = opts?.status ?? 200;
    return Promise.resolve(new Response(body, {
      status,
      headers: { 'content-type': 'text/csv' },
    }));
  };
  return stub;
}

// ----------------------------------------------------------------------------
// Basic parse + get
// ----------------------------------------------------------------------------

Deno.test('GoogleSheetsCsvAdapter - get returns row by index when no keyColumn', async () => {
  const csv = 'name,age\nAlice,30\nBob,25\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub(csv),
  });

  const first = await adapter.get('0');
  assertEquals(first, { name: 'Alice', age: '30' });

  const second = await adapter.get('1');
  assertEquals(second, { name: 'Bob', age: '25' });

  const missing = await adapter.get('99');
  assertEquals(missing, null);
});

Deno.test('GoogleSheetsCsvAdapter - custom keyColumn', async () => {
  const csv = 'id,name,email\nu1,Alice,a@x.com\nu2,Bob,b@x.com\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const alice = await adapter.get('u1');
  assertEquals(alice, { id: 'u1', name: 'Alice', email: 'a@x.com' });

  // Row index should NOT be usable when keyColumn is set
  const byIndex = await adapter.get('0');
  assertEquals(byIndex, null);
});

Deno.test('GoogleSheetsCsvAdapter - has() / keys() / list()', async () => {
  const csv = 'id,name\na,Alpha\nb,Beta\nc,Gamma\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  assertEquals(await adapter.has('a'), true);
  assertEquals(await adapter.has('zzz'), false);

  const keys = await adapter.keys();
  assertEquals(keys.sort(), ['a', 'b', 'c']);

  const list = await adapter.list();
  assertEquals(list.length, 3);
  assertEquals(list[0], { id: 'a', name: 'Alpha' });
  assertEquals(list[2], { id: 'c', name: 'Gamma' });
});

Deno.test('GoogleSheetsCsvAdapter - keys() with prefix filters', async () => {
  const csv = 'id,name\nuser-1,Alice\nuser-2,Bob\nadmin-1,Carol\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const userKeys = await adapter.keys('user-');
  assertEquals(userKeys.sort(), ['user-1', 'user-2']);
});

Deno.test('GoogleSheetsCsvAdapter - list() respects limit/offset', async () => {
  const csv = 'id,n\na,1\nb,2\nc,3\nd,4\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const slice = await adapter.list({ offset: 1, limit: 2 });
  assertEquals(slice.length, 2);
  assertEquals(slice[0].id, 'b');
  assertEquals(slice[1].id, 'c');
});

// ----------------------------------------------------------------------------
// Write operations throw
// ----------------------------------------------------------------------------

Deno.test('GoogleSheetsCsvAdapter - set() throws UnsupportedOperationError', async () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub('id,name\na,Alpha\n'),
  });

  await assertRejects(
    () => adapter.set('x', { foo: 'bar' }),
    UnsupportedOperationError,
    'read-only',
  );
});

Deno.test('GoogleSheetsCsvAdapter - delete() throws UnsupportedOperationError', async () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub('id,name\na,Alpha\n'),
  });

  await assertRejects(
    () => adapter.delete('x'),
    UnsupportedOperationError,
    'read-only',
  );
});

Deno.test('GoogleSheetsCsvAdapter - patch() throws UnsupportedOperationError', async () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub('id,name\na,Alpha\n'),
  });

  await assertRejects(
    () => adapter.patch('x', { foo: 'bar' }),
    UnsupportedOperationError,
    'read-only',
  );
});

// ----------------------------------------------------------------------------
// Cache behavior
// ----------------------------------------------------------------------------

Deno.test('GoogleSheetsCsvAdapter - caches fetched CSV within refreshMs', async () => {
  const csv = 'id,name\na,Alpha\n';
  const count = { n: 0 };
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    refreshMs: 60_000,
    fetchImpl: makeFetchStub(csv, { countRef: count }),
  });

  await adapter.get('a');
  await adapter.get('a');
  await adapter.keys();
  await adapter.list();

  assertEquals(count.n, 1, 'should only fetch once within TTL');
});

Deno.test('GoogleSheetsCsvAdapter - refetches after refreshMs elapses', async () => {
  const csv = 'id,name\na,Alpha\n';
  const count = { n: 0 };
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    refreshMs: 100,
    fetchImpl: makeFetchStub(csv, { countRef: count }),
  });

  // First fetch
  await adapter.get('a');
  assertEquals(count.n, 1);

  // Monkey-patch Date.now to move time forward past the TTL
  const realNow = Date.now;
  try {
    const base = realNow();
    Date.now = () => base + 500;
    await adapter.get('a');
    assertEquals(count.n, 2, 'should refetch after TTL expiry');
  } finally {
    Date.now = realNow;
  }
});

Deno.test('GoogleSheetsCsvAdapter - refreshMs=0 disables cache', async () => {
  const csv = 'id,name\na,Alpha\n';
  const count = { n: 0 };
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    refreshMs: 0,
    fetchImpl: makeFetchStub(csv, { countRef: count }),
  });

  await adapter.get('a');
  await adapter.get('a');
  await adapter.get('a');

  assertEquals(count.n, 3, 'every call fetches when refreshMs=0');
});

Deno.test('GoogleSheetsCsvAdapter - clear() drops cache without mutating remote', async () => {
  const csv = 'id,name\na,Alpha\n';
  const count = { n: 0 };
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    refreshMs: 60_000,
    fetchImpl: makeFetchStub(csv, { countRef: count }),
  });

  await adapter.get('a');
  assertEquals(count.n, 1);

  await adapter.clear();

  await adapter.get('a');
  assertEquals(count.n, 2, 'clear() should force the next read to refetch');
});

// ----------------------------------------------------------------------------
// CSV edge cases
// ----------------------------------------------------------------------------

Deno.test('GoogleSheetsCsvAdapter - handles quoted fields with commas', async () => {
  const csv = 'id,title,note\n1,"Hello, world","simple"\n2,"plain","has, comma"\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const first = await adapter.get('1');
  assertEquals(first, { id: '1', title: 'Hello, world', note: 'simple' });

  const second = await adapter.get('2');
  assertEquals(second, { id: '2', title: 'plain', note: 'has, comma' });
});

Deno.test('GoogleSheetsCsvAdapter - handles quoted fields with newlines', async () => {
  const csv = 'id,body\n1,"line one\nline two"\n2,"plain"\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const first = await adapter.get('1');
  assertEquals(first?.body, 'line one\nline two');

  const second = await adapter.get('2');
  assertEquals(second?.body, 'plain');
});

Deno.test('GoogleSheetsCsvAdapter - handles escaped quotes ("")', async () => {
  const csv = 'id,quote\n1,"she said ""hi"""\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const row = await adapter.get('1');
  assertEquals(row?.quote, 'she said "hi"');
});

Deno.test('GoogleSheetsCsvAdapter - empty CSV returns no rows', async () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub(''),
  });

  const keys = await adapter.keys();
  assertEquals(keys.length, 0);
});

Deno.test('GoogleSheetsCsvAdapter - header-only CSV returns no rows', async () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub('id,name\n'),
  });

  assertEquals((await adapter.keys()).length, 0);
  assertEquals((await adapter.list()).length, 0);
});

Deno.test('GoogleSheetsCsvAdapter - skips rows with empty keyColumn value', async () => {
  const csv = 'id,name\na,Alpha\n,Orphan\nb,Beta\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const keys = await adapter.keys();
  assertEquals(keys.sort(), ['a', 'b']);
});

// ----------------------------------------------------------------------------
// Error handling
// ----------------------------------------------------------------------------

Deno.test('GoogleSheetsCsvAdapter - fetch failure surfaces as error', async () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub('', { status: 404 }),
  });

  await assertRejects(
    () => adapter.get('0'),
    Error,
    'Fetch failed',
  );
});

Deno.test('GoogleSheetsCsvAdapter - constructor rejects missing url', () => {
  try {
    // deno-lint-ignore no-explicit-any
    new GoogleSheetsCsvAdapter({} as any);
    throw new Error('should have thrown');
  } catch (err) {
    assert(err instanceof Error);
    assert(err.message.includes('url'));
  }
});

// ----------------------------------------------------------------------------
// Capabilities
// ----------------------------------------------------------------------------

Deno.test('GoogleSheetsCsvAdapter - capabilities', () => {
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub(''),
  });

  assertEquals(adapter.capabilities.name, 'google-sheets-csv');
  assertEquals(adapter.capabilities.supportedTypes, ['object']);
  assertEquals(adapter.capabilities.cost?.tier, 'free');
  assertEquals(adapter.capabilities.features?.ttl, false);
});

Deno.test('GoogleSheetsCsvAdapter - strips UTF-8 BOM from CSV payload', async () => {
  // Google Sheets exports commonly include a BOM; without stripping, first
  // header becomes "\uFEFFid" and every row is silently dropped.
  const csv = '\uFEFFid,name\n1,Alice\n2,Bob\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id',
    fetchImpl: makeFetchStub(csv),
  });

  const alice = await adapter.get('1');
  assertEquals((alice as any)?.name, 'Alice');
  const keys = await adapter.keys();
  assertEquals(keys.sort(), ['1', '2']);
});

Deno.test('GoogleSheetsCsvAdapter - throws clearly when keyColumn missing from header', async () => {
  const csv = 'name,age\nAlice,30\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    keyColumn: 'id', // not present — should fail loud, not return []
    fetchImpl: makeFetchStub(csv),
  });

  await assertRejects(
    () => adapter.keys(),
    Error,
    'keyColumn "id" not found',
  );
});

Deno.test('GoogleSheetsCsvAdapter - rejects non-http(s) url at construction', () => {
  assertEquals(
    (() => { try { createGoogleSheetsCsvAdapter({ url: 'file:///etc/passwd' }); return null; } catch (e) { return (e as Error).message; } })()?.includes('http(s)'),
    true,
  );
  assertEquals(
    (() => { try { createGoogleSheetsCsvAdapter({ url: 'not-a-url' }); return null; } catch (e) { return (e as Error).message; } })()?.includes('invalid url'),
    true,
  );
});

Deno.test('GoogleSheetsCsvAdapter - detects duplicate header columns and throws', async () => {
  const csv = 'id,name,id\n1,Alice,2\n';
  const adapter = createGoogleSheetsCsvAdapter({
    url: FAKE_URL,
    fetchImpl: makeFetchStub(csv),
  });

  await assertRejects(
    () => adapter.keys(),
    Error,
    'duplicate column names',
  );
});

Deno.test('GoogleSheetsCsvAdapter - fetch error redacts query string', async () => {
  const url = 'https://docs.google.com/export?secret=TOKEN_XYZ&gid=0';
  const adapter = createGoogleSheetsCsvAdapter({
    url,
    fetchImpl: makeFetchStub('', { status: 500 }),
  });

  try {
    await adapter.get('0');
    throw new Error('expected fetch to fail');
  } catch (err) {
    const msg = (err as Error).message;
    assert(!msg.includes('TOKEN_XYZ'), `error should redact query string, got: ${msg}`);
    assert(msg.includes('500'), `error should still contain status, got: ${msg}`);
  }
});
