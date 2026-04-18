/**
 * Query engine unit tests
 *
 * Subject: src/utils/query-engine.ts
 *
 * Covers the MongoDB-style filter matcher (matchesFilter / matchesOperator)
 * plus a few adjacent concerns (applyFilter, empty filter, sort, projection).
 *
 * The plan referenced "json_extract for SQLite adapters" — that lives in
 * src/adapters/sqlite.ts and is covered by sqlite-query.test.ts. This file
 * scopes to the pure TS engine.
 */

import { assert, assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  matchesFilter,
  matchesOperator,
  applyFilter,
  applySort,
  applyProjection,
  encodeCursor,
  decodeCursor,
  executeQuery,
} from '../src/utils/query-engine.ts';

// ============================================================================
// Equality (shorthand)
// ============================================================================

Deno.test('query-engine - equality: { field: value } matches exact value', () => {
  const item = { name: 'Alice', age: 30 };
  assertEquals(matchesFilter(item, { name: 'Alice' }), true);
  assertEquals(matchesFilter(item, { name: 'Bob' }), false);
  assertEquals(matchesFilter(item, { age: 30 }), true);
  assertEquals(matchesFilter(item, { age: 31 }), false);
});

Deno.test('query-engine - empty filter matches everything', () => {
  assertEquals(matchesFilter({ any: 'thing' }, {}), true);
  assertEquals(matchesFilter({}, {}), true);
  assertEquals(matchesFilter(null, {}), true);
});

Deno.test('query-engine - multiple top-level keys combine with AND', () => {
  const item = { name: 'Alice', age: 30, role: 'admin' };
  assertEquals(matchesFilter(item, { name: 'Alice', age: 30 }), true);
  assertEquals(matchesFilter(item, { name: 'Alice', age: 99 }), false);
  assertEquals(matchesFilter(item, { name: 'Alice', role: 'admin', age: 30 }), true);
});

// ============================================================================
// Comparison operators
// ============================================================================

Deno.test('query-engine - $eq / $ne', () => {
  assertEquals(matchesOperator(5, { $eq: 5 }), true);
  assertEquals(matchesOperator(5, { $eq: 6 }), false);
  assertEquals(matchesOperator(5, { $ne: 6 }), true);
  assertEquals(matchesOperator(5, { $ne: 5 }), false);
});

Deno.test('query-engine - $gt / $gte / $lt / $lte', () => {
  assertEquals(matchesOperator(10, { $gt: 5 }), true);
  assertEquals(matchesOperator(5, { $gt: 5 }), false);
  assertEquals(matchesOperator(5, { $gte: 5 }), true);
  assertEquals(matchesOperator(4, { $gte: 5 }), false);
  assertEquals(matchesOperator(4, { $lt: 5 }), true);
  assertEquals(matchesOperator(5, { $lt: 5 }), false);
  assertEquals(matchesOperator(5, { $lte: 5 }), true);
  assertEquals(matchesOperator(6, { $lte: 5 }), false);
});

Deno.test('query-engine - comparison works through field filter', () => {
  const items = [{ n: 1 }, { n: 5 }, { n: 10 }];
  const matched = items.filter((i) => matchesFilter(i, { n: { $gte: 5 } }));
  assertEquals(matched.length, 2);
});

// ============================================================================
// $in / $nin
// ============================================================================

Deno.test('query-engine - $in', () => {
  assertEquals(matchesOperator('a', { $in: ['a', 'b', 'c'] }), true);
  assertEquals(matchesOperator('z', { $in: ['a', 'b', 'c'] }), false);
  assertEquals(matchesFilter({ status: 'open' }, { status: { $in: ['open', 'pending'] } }), true);
});

Deno.test('query-engine - $nin', () => {
  assertEquals(matchesOperator('z', { $nin: ['a', 'b'] }), true);
  assertEquals(matchesOperator('a', { $nin: ['a', 'b'] }), false);
});

// ============================================================================
// Logical operators
// ============================================================================

Deno.test('query-engine - $and', () => {
  const item = { name: 'Alice', age: 30 };
  const filter = { $and: [{ name: 'Alice' }, { age: { $gte: 18 } }] };
  assertEquals(matchesFilter(item, filter), true);
  assertEquals(
    matchesFilter(item, { $and: [{ name: 'Alice' }, { age: { $gte: 40 } }] }),
    false,
  );
});

Deno.test('query-engine - $or', () => {
  const item = { role: 'editor' };
  const filter = { $or: [{ role: 'admin' }, { role: 'editor' }] };
  assertEquals(matchesFilter(item, filter), true);
  assertEquals(matchesFilter({ role: 'guest' }, filter), false);
});

Deno.test('query-engine - $not', () => {
  const item = { status: 'archived' };
  assertEquals(matchesFilter(item, { $not: { status: 'open' } }), true);
  assertEquals(matchesFilter(item, { $not: { status: 'archived' } }), false);
});

Deno.test('query-engine - nested logical operators', () => {
  const item = { type: 'paper', year: 2024, tag: 'ml' };
  const filter = {
    $and: [
      { type: 'paper' },
      { $or: [{ year: 2024 }, { year: 2025 }] },
    ],
  };
  assertEquals(matchesFilter(item, filter), true);
});

// ============================================================================
// Nested field access (dot notation)
// ============================================================================

Deno.test('query-engine - nested field access via dot notation', () => {
  const item = { user: { name: 'Alice', address: { city: 'Oakland' } } };
  assertEquals(matchesFilter(item, { 'user.name': 'Alice' }), true);
  assertEquals(matchesFilter(item, { 'user.name': 'Bob' }), false);
  assertEquals(matchesFilter(item, { 'user.address.city': 'Oakland' }), true);
});

Deno.test('query-engine - nested field missing parent yields undefined', () => {
  const item = { foo: 1 };
  // 'user.name' on item without user — value is undefined, equality with 'Alice' fails
  assertEquals(matchesFilter(item, { 'user.name': 'Alice' }), false);
});

// ============================================================================
// Array predicates
// ============================================================================

Deno.test('query-engine - $size matches array length', () => {
  assertEquals(matchesOperator([1, 2, 3], { $size: 3 }), true);
  assertEquals(matchesOperator([1, 2], { $size: 3 }), false);
  assertEquals(matchesOperator('not array', { $size: 0 }), false);
});

Deno.test('query-engine - $all requires all elements present', () => {
  assertEquals(matchesOperator(['a', 'b', 'c'], { $all: ['a', 'b'] }), true);
  assertEquals(matchesOperator(['a', 'c'], { $all: ['a', 'b'] }), false);
});

Deno.test('query-engine - $elemMatch', () => {
  const tags = [{ name: 'x', priority: 1 }, { name: 'y', priority: 5 }];
  assertEquals(
    matchesOperator(tags, { $elemMatch: { priority: { $gte: 3 } } }),
    true,
  );
  assertEquals(
    matchesOperator(tags, { $elemMatch: { priority: { $gte: 100 } } }),
    false,
  );
});

// ============================================================================
// $exists
// ============================================================================

Deno.test('query-engine - $exists: true', () => {
  const withField = { name: 'Alice' };
  const withoutField = {};
  assertEquals(matchesFilter(withField, { name: { $exists: true } }), true);
  assertEquals(matchesFilter(withoutField, { name: { $exists: true } }), false);
});

Deno.test('query-engine - $exists: false', () => {
  assertEquals(matchesFilter({ name: 'Alice' }, { age: { $exists: false } }), true);
  assertEquals(matchesFilter({ name: 'Alice' }, { name: { $exists: false } }), false);
});

Deno.test('query-engine - $exists treats null as not-existing', () => {
  // matchesOperator: exists = value !== undefined && value !== null
  assertEquals(matchesFilter({ name: null }, { name: { $exists: false } }), true);
  assertEquals(matchesFilter({ name: null }, { name: { $exists: true } }), false);
});

// ============================================================================
// String operators
// ============================================================================

Deno.test('query-engine - $contains / $startsWith / $endsWith', () => {
  assertEquals(matchesOperator('hello world', { $contains: 'lo wo' }), true);
  assertEquals(matchesOperator('hello', { $contains: 'xyz' }), false);
  assertEquals(matchesOperator('hello world', { $startsWith: 'hello' }), true);
  assertEquals(matchesOperator('hello world', { $startsWith: 'world' }), false);
  assertEquals(matchesOperator('hello world', { $endsWith: 'world' }), true);
});

Deno.test('query-engine - $regex', () => {
  assertEquals(matchesOperator('abc123', { $regex: '^abc' }), true);
  assertEquals(matchesOperator('xyz', { $regex: '^abc' }), false);
  assertEquals(matchesOperator('Alice Smith', { $regex: 'Smi' }), true);
});

Deno.test('query-engine - $regex against non-string returns false', () => {
  assertEquals(matchesOperator(42, { $regex: '^4' }), false);
  assertEquals(matchesOperator(null, { $regex: '.' }), false);
});

// ============================================================================
// $type
// ============================================================================

Deno.test('query-engine - $type matches typeof', () => {
  assertEquals(matchesOperator('hi', { $type: 'string' }), true);
  assertEquals(matchesOperator(42, { $type: 'number' }), true);
  assertEquals(matchesOperator({}, { $type: 'object' }), true);
  assertEquals(matchesOperator(42, { $type: 'string' }), false);
});

// ============================================================================
// Logical operator at matchesOperator level throws
// ============================================================================

Deno.test('query-engine - logical operators at operator level throw', () => {
  assertThrows(
    () => matchesOperator(1, { $and: [] } as any),
    Error,
    'Logical operators must be handled at the object level',
  );
});

// ============================================================================
// applyFilter
// ============================================================================

Deno.test('query-engine - applyFilter with MongoDB-style filter', () => {
  const items = [
    { id: 1, status: 'open' },
    { id: 2, status: 'closed' },
    { id: 3, status: 'open' },
  ];
  const out = applyFilter(items, { filter: { status: 'open' } });
  assertEquals(out.length, 2);
  assertEquals(out.map((i) => i.id), [1, 3]);
});

Deno.test('query-engine - applyFilter with where function takes precedence', () => {
  const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const out = applyFilter(items, {
    where: (i) => i.n > 1,
    filter: { n: 1 }, // should be ignored
  });
  assertEquals(out.map((i) => i.n), [2, 3]);
});

Deno.test('query-engine - applyFilter with no filter returns all items', () => {
  const items = [{ a: 1 }, { a: 2 }];
  assertEquals(applyFilter(items, {}), items);
});

// ============================================================================
// Sort
// ============================================================================

Deno.test('query-engine - applySort ascending', () => {
  const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
  const out = applySort(items, { sort: { n: 1 } });
  assertEquals(out.map((i) => i.n), [1, 2, 3]);
});

Deno.test('query-engine - applySort descending via string', () => {
  const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
  const out = applySort(items, { sort: 'n DESC' });
  assertEquals(out.map((i) => i.n), [3, 2, 1]);
});

// ============================================================================
// Projection
// ============================================================================

Deno.test('query-engine - applyProjection select keeps only listed fields', () => {
  const item = { a: 1, b: 2, c: 3 };
  assertEquals(applyProjection(item, { select: ['a', 'c'] }), { a: 1, c: 3 });
});

Deno.test('query-engine - applyProjection omit drops listed fields', () => {
  const item = { a: 1, b: 2, c: 3 };
  assertEquals(applyProjection(item, { omit: ['b'] }), { a: 1, c: 3 });
});

// ============================================================================
// Cursors
// ============================================================================

Deno.test('query-engine - encode/decode cursor roundtrips', () => {
  const cursor = { lastId: '10', lastValue: 10, direction: 'forward' as const };
  const encoded = encodeCursor(cursor);
  assertEquals(decodeCursor(encoded), cursor);
});

Deno.test('query-engine - decodeCursor returns null for malformed input', () => {
  assertEquals(decodeCursor('!!!not-base64!!!'), null);
});

// ============================================================================
// executeQuery integration
// ============================================================================

Deno.test('query-engine - executeQuery filter + sort + pagination', () => {
  const items = [
    { id: 1, status: 'open', priority: 2 },
    { id: 2, status: 'closed', priority: 1 },
    { id: 3, status: 'open', priority: 5 },
    { id: 4, status: 'open', priority: 1 },
  ];

  const result = executeQuery(items, {
    filter: { status: 'open' },
    sort: { priority: -1 },
    page: 1,
    pageSize: 2,
  });

  assertEquals(result.data.length, 2);
  assertEquals(result.data[0].id, 3);
  assertEquals(result.data[1].id, 1);
  assert(result.pagination);
  assertEquals(result.pagination!.totalItems, 3);
  assertEquals(result.pagination!.hasNext, true);
});

Deno.test('query-engine - executeQuery with includeMeta returns timing', () => {
  const items = [{ id: 1 }, { id: 2 }];
  const result = executeQuery(items, { includeMeta: true });
  assert(result.meta);
  assertEquals(result.meta!.itemsScanned, 2);
  assertEquals(result.meta!.itemsReturned, 2);
});
