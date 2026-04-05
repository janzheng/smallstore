/**
 * SQLite Adapter Tests
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { createSQLiteAdapter } from '../src/adapters/sqlite.ts';

// ============================================================================
// Basic CRUD
// ============================================================================

Deno.test('SQLiteAdapter - set and get', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('test-key', { foo: 'bar', num: 42 });
  const value = await adapter.get('test-key');

  assertEquals(value, { foo: 'bar', num: 42 });
  adapter.close();
});

Deno.test('SQLiteAdapter - get nonexistent key returns null', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  const value = await adapter.get('nonexistent');
  assertEquals(value, null);
  adapter.close();
});

Deno.test('SQLiteAdapter - set overwrites existing key', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('key', { v: 1 });
  await adapter.set('key', { v: 2 });

  const value = await adapter.get('key');
  assertEquals(value, { v: 2 });
  adapter.close();
});

Deno.test('SQLiteAdapter - set and get string value', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('str-key', 'hello world');
  const value = await adapter.get('str-key');
  assertEquals(value, 'hello world');
  adapter.close();
});

Deno.test('SQLiteAdapter - set and get array value', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('arr-key', [1, 2, 3]);
  const value = await adapter.get('arr-key');
  assertEquals(value, [1, 2, 3]);
  adapter.close();
});

Deno.test('SQLiteAdapter - set and get nested object', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  const data = { user: { name: 'Jan', settings: { theme: 'dark' } } };
  await adapter.set('nested', data);
  const value = await adapter.get('nested');
  assertEquals(value, data);
  adapter.close();
});

// ============================================================================
// Delete
// ============================================================================

Deno.test('SQLiteAdapter - delete key', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('to-delete', { x: 1 });
  assertEquals(await adapter.has('to-delete'), true);

  await adapter.delete('to-delete');
  assertEquals(await adapter.has('to-delete'), false);
  assertEquals(await adapter.get('to-delete'), null);
  adapter.close();
});

// ============================================================================
// Has
// ============================================================================

Deno.test('SQLiteAdapter - has returns true for existing keys', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('exists', 'yes');
  assertEquals(await adapter.has('exists'), true);
  adapter.close();
});

Deno.test('SQLiteAdapter - has returns false for missing keys', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  assertEquals(await adapter.has('nope'), false);
  adapter.close();
});

// ============================================================================
// Keys
// ============================================================================

Deno.test('SQLiteAdapter - keys with prefix', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('prefix:a', 1);
  await adapter.set('prefix:b', 2);
  await adapter.set('other:c', 3);

  const keys = await adapter.keys('prefix:');
  assertEquals(keys.length, 2);
  assertEquals(keys.includes('prefix:a'), true);
  assertEquals(keys.includes('prefix:b'), true);
  adapter.close();
});

Deno.test('SQLiteAdapter - keys without prefix returns all', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('a', 1);
  await adapter.set('b', 2);
  await adapter.set('c', 3);

  const keys = await adapter.keys();
  assertEquals(keys.length, 3);
  adapter.close();
});

Deno.test('SQLiteAdapter - keys returns sorted', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('c', 1);
  await adapter.set('a', 2);
  await adapter.set('b', 3);

  const keys = await adapter.keys();
  assertEquals(keys, ['a', 'b', 'c']);
  adapter.close();
});

// ============================================================================
// Clear
// ============================================================================

Deno.test('SQLiteAdapter - clear all', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('a', 1);
  await adapter.set('b', 2);

  await adapter.clear();

  const keys = await adapter.keys();
  assertEquals(keys.length, 0);
  adapter.close();
});

Deno.test('SQLiteAdapter - clear with prefix', async () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  await adapter.set('keep:a', 1);
  await adapter.set('remove:b', 2);
  await adapter.set('remove:c', 3);

  await adapter.clear('remove:');

  const keys = await adapter.keys();
  assertEquals(keys, ['keep:a']);
  adapter.close();
});

// ============================================================================
// Capabilities
// ============================================================================

Deno.test('SQLiteAdapter - capabilities', () => {
  const adapter = createSQLiteAdapter({ url: ':memory:' });

  assertEquals(adapter.capabilities.name, 'sqlite');
  assertEquals(adapter.capabilities.supportedTypes.includes('kv'), true);
  assertEquals(adapter.capabilities.supportedTypes.includes('object'), true);
  assertEquals(adapter.capabilities.features?.query, true);
  assertEquals(adapter.capabilities.features?.transactions, true);
  assertEquals(adapter.capabilities.cost?.tier, 'free');
  adapter.close();
});

// ============================================================================
// Multiple Instances (simulating multi-DB)
// ============================================================================

Deno.test('SQLiteAdapter - multiple instances are independent', async () => {
  const db1 = createSQLiteAdapter({ url: ':memory:' });
  const db2 = createSQLiteAdapter({ url: ':memory:' });

  await db1.set('shared-key', { from: 'db1' });
  await db2.set('shared-key', { from: 'db2' });

  assertEquals(await db1.get('shared-key'), { from: 'db1' });
  assertEquals(await db2.get('shared-key'), { from: 'db2' });

  db1.close();
  db2.close();
});

// ============================================================================
// URL Normalization
// ============================================================================

Deno.test('SQLiteAdapter - default config uses :memory:', async () => {
  const adapter = createSQLiteAdapter();

  await adapter.set('test', 'works');
  assertEquals(await adapter.get('test'), 'works');
  adapter.close();
});

// ============================================================================
// Integration: Works with Smallstore router
// ============================================================================

Deno.test('SQLiteAdapter - works with createSmallstore', async () => {
  // Import here to avoid circular dependency issues at module level
  const { createSmallstore, createMemoryAdapter } = await import('../mod.ts');

  const store = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      sqlite: createSQLiteAdapter({ url: ':memory:' }),
    },
    defaultAdapter: 'sqlite',
  });

  await store.set('test-collection', { hello: 'sqlite' });
  const result = await store.get('test-collection');
  assertNotEquals(result, null);
});
