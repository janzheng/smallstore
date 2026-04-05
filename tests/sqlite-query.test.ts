/**
 * SQLite Native Query Tests
 *
 * Tests for the SQLite adapter's native query() method that
 * translates MongoDB-style filters to SQL WHERE clauses via json_extract().
 */

import { assertEquals } from 'jsr:@std/assert';
import { createSQLiteAdapter } from '../src/adapters/sqlite.ts';

// ============================================================================
// Setup: seed test data
// ============================================================================

function createSeededAdapter() {
  const adapter = createSQLiteAdapter({ path: ':memory:' });
  return adapter;
}

async function seedUsers(adapter: ReturnType<typeof createSQLiteAdapter>) {
  await adapter.set('user:1', { name: 'Alice', age: 30, role: 'admin', active: true });
  await adapter.set('user:2', { name: 'Bob', age: 25, role: 'user', active: true });
  await adapter.set('user:3', { name: 'Charlie', age: 35, role: 'user', active: false });
  await adapter.set('user:4', { name: 'Diana', age: 28, role: 'admin', active: true });
  await adapter.set('user:5', { name: 'Eve', age: 22, role: 'user', active: true });
}

// ============================================================================
// Basic query tests
// ============================================================================

Deno.test('SQLite query - no filter returns all rows', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({});
  assertEquals(result.totalCount, 5);
  assertEquals(result.data.length, 5);
});

Deno.test('SQLite query - prefix filter', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);
  await adapter.set('other:1', { name: 'Other' });

  const result = await adapter.query({ prefix: 'user:' });
  assertEquals(result.totalCount, 5);
  assertEquals(result.data.length, 5);
});

Deno.test('SQLite query - equality filter', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({ filter: { role: 'admin' } });
  assertEquals(result.totalCount, 2);
  assertEquals(result.data.length, 2);
  assertEquals(result.data.every((d: any) => d.role === 'admin'), true);
});

Deno.test('SQLite query - $gt operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({ filter: { age: { $gt: 28 } } });
  assertEquals(result.totalCount, 2); // Alice (30), Charlie (35)
  assertEquals(result.data.every((d: any) => d.age > 28), true);
});

Deno.test('SQLite query - $gte operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({ filter: { age: { $gte: 28 } } });
  assertEquals(result.totalCount, 3); // Alice (30), Charlie (35), Diana (28)
});

Deno.test('SQLite query - $lt and $lte operators', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const lt = await adapter.query({ filter: { age: { $lt: 28 } } });
  assertEquals(lt.totalCount, 2); // Bob (25), Eve (22)

  const lte = await adapter.query({ filter: { age: { $lte: 28 } } });
  assertEquals(lte.totalCount, 3); // Bob (25), Eve (22), Diana (28)
});

Deno.test('SQLite query - $ne operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({ filter: { role: { $ne: 'admin' } } });
  assertEquals(result.totalCount, 3);
  assertEquals(result.data.every((d: any) => d.role !== 'admin'), true);
});

Deno.test('SQLite query - $in operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { name: { $in: ['Alice', 'Charlie', 'Eve'] } },
  });
  assertEquals(result.totalCount, 3);
});

Deno.test('SQLite query - $nin operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { name: { $nin: ['Alice', 'Bob'] } },
  });
  assertEquals(result.totalCount, 3); // Charlie, Diana, Eve
});

Deno.test('SQLite query - $exists operator', async () => {
  const adapter = createSeededAdapter();
  await adapter.set('k1', { name: 'Has role', role: 'admin' });
  await adapter.set('k2', { name: 'No role' });

  const exists = await adapter.query({ filter: { role: { $exists: true } } });
  assertEquals(exists.totalCount, 1);
  assertEquals(exists.data[0].name, 'Has role');
});

Deno.test('SQLite query - $contains operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { name: { $contains: 'li' } },
  });
  // Alice and Charlie both contain "li"
  assertEquals(result.totalCount, 2);
});

Deno.test('SQLite query - $startsWith operator', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { name: { $startsWith: 'A' } },
  });
  assertEquals(result.totalCount, 1);
  assertEquals(result.data[0].name, 'Alice');
});

// ============================================================================
// Combined filters
// ============================================================================

Deno.test('SQLite query - multiple filter conditions (AND)', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { role: 'admin', active: true },
  });
  assertEquals(result.totalCount, 2); // Alice and Diana
});

Deno.test('SQLite query - range filter (age between 25 and 30)', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { age: { $gte: 25, $lte: 30 } },
  });
  assertEquals(result.totalCount, 3); // Bob (25), Alice (30), Diana (28)
});

// ============================================================================
// Sorting
// ============================================================================

Deno.test('SQLite query - sort ascending', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    sort: { age: 1 },
  });
  assertEquals(result.data[0].name, 'Eve');   // 22
  assertEquals(result.data[4].name, 'Charlie'); // 35
});

Deno.test('SQLite query - sort descending', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    sort: { age: -1 },
  });
  assertEquals(result.data[0].name, 'Charlie'); // 35
  assertEquals(result.data[4].name, 'Eve');     // 22
});

// ============================================================================
// Pagination
// ============================================================================

Deno.test('SQLite query - limit', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({ limit: 2 });
  assertEquals(result.data.length, 2);
  assertEquals(result.totalCount, 5); // Total still 5
});

Deno.test('SQLite query - limit + skip (pagination)', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    sort: { age: 1 },
    limit: 2,
    skip: 2,
  });
  assertEquals(result.data.length, 2);
  assertEquals(result.totalCount, 5);
  // Sorted by age: Eve(22), Bob(25), Diana(28), Alice(30), Charlie(35)
  // Skip 2, take 2 = Diana, Alice
  assertEquals(result.data[0].name, 'Diana');
  assertEquals(result.data[1].name, 'Alice');
});

Deno.test('SQLite query - skip without limit', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    sort: { age: 1 },
    skip: 3,
  });
  assertEquals(result.data.length, 2); // Skip 3, remaining 2
  assertEquals(result.data[0].name, 'Alice');   // 30
  assertEquals(result.data[1].name, 'Charlie'); // 35
});

// ============================================================================
// Combined: filter + sort + pagination
// ============================================================================

Deno.test('SQLite query - filter + sort + limit', async () => {
  const adapter = createSeededAdapter();
  await seedUsers(adapter);

  const result = await adapter.query({
    filter: { active: true },
    sort: { age: 1 },
    limit: 2,
  });
  // Active users sorted by age: Eve(22), Bob(25), Diana(28), Alice(30)
  assertEquals(result.totalCount, 4);
  assertEquals(result.data.length, 2);
  assertEquals(result.data[0].name, 'Eve');
  assertEquals(result.data[1].name, 'Bob');
});

// ============================================================================
// Edge cases
// ============================================================================

Deno.test('SQLite query - empty table', async () => {
  const adapter = createSeededAdapter();

  const result = await adapter.query({ filter: { name: 'nobody' } });
  assertEquals(result.totalCount, 0);
  assertEquals(result.data.length, 0);
});

Deno.test('SQLite query - null equality', async () => {
  const adapter = createSeededAdapter();
  await adapter.set('k1', { name: 'Has value', field: 'yes' });
  await adapter.set('k2', { name: 'Null field', field: null });

  const result = await adapter.query({ filter: { field: null } });
  assertEquals(result.totalCount, 1);
  assertEquals(result.data[0].name, 'Null field');
});
