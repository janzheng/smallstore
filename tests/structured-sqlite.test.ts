/**
 * Structured SQLite Adapter Tests
 *
 * Phase 4: Real SQL tables with typed columns, auto-migration, native queries.
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { createStructuredSQLiteAdapter, type StructuredSQLiteAdapter } from '../src/adapters/structured-sqlite.ts';

// ============================================================================
// Helpers
// ============================================================================

function createTestAdapter(): StructuredSQLiteAdapter {
  return createStructuredSQLiteAdapter({
    path: ':memory:',
    schema: {
      users: {
        columns: {
          id: { type: 'text', primaryKey: true },
          name: { type: 'text', notNull: true },
          email: { type: 'text', unique: true },
          age: { type: 'integer' },
          active: { type: 'integer', default: 1 },
        },
        indexes: [
          { columns: ['email'] },
          { columns: ['age'] },
        ],
      },
      posts: {
        columns: {
          id: { type: 'integer', primaryKey: true, autoIncrement: true },
          user_id: { type: 'text', notNull: true },
          title: { type: 'text', notNull: true },
          body: { type: 'text' },
          published: { type: 'integer', default: 0 },
        },
        indexes: [
          { columns: ['user_id'] },
        ],
      },
    },
  });
}

// ============================================================================
// Table creation & auto-migration
// ============================================================================

Deno.test({
  name: 'structured-sqlite - auto-creates tables on first access',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    // set should create the table automatically
    await adapter.set('users:alice', { id: 'alice', name: 'Alice', email: 'alice@test.com', age: 30 });

    const result = await adapter.get('users:alice');
    assertNotEquals(result, null);
    assertEquals(result.name, 'Alice');
    assertEquals(result.email, 'alice@test.com');
    assertEquals(result.age, 30);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - columns have proper types and defaults',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    // Set without 'active' — should get default value
    await adapter.set('users:bob', { id: 'bob', name: 'Bob', email: 'bob@test.com' });

    const result = await adapter.get('users:bob');
    assertNotEquals(result, null);
    assertEquals(result.name, 'Bob');
    assertEquals(result.active, 1); // default value

    adapter.close();
  },
});

// ============================================================================
// CRUD operations
// ============================================================================

Deno.test({
  name: 'structured-sqlite - set/get stores and retrieves real rows',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@test.com', age: 25 });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@test.com', age: 30 });

    const u1 = await adapter.get('users:u1');
    const u2 = await adapter.get('users:u2');

    assertEquals(u1.name, 'Alice');
    assertEquals(u1.age, 25);
    assertEquals(u2.name, 'Bob');
    assertEquals(u2.age, 30);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - set upserts on conflict',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@test.com', age: 25 });
    await adapter.set('users:u1', { id: 'u1', name: 'Alice Updated', email: 'a@test.com', age: 26 });

    const result = await adapter.get('users:u1');
    assertEquals(result.name, 'Alice Updated');
    assertEquals(result.age, 26);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - delete removes row',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@test.com' });
    await adapter.delete('users:u1');

    const result = await adapter.get('users:u1');
    assertEquals(result, null);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - has checks existence',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@test.com' });

    assertEquals(await adapter.has('users:u1'), true);
    assertEquals(await adapter.has('users:u99'), false);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - keys lists all keys across tables',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com' });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@t.com' });

    const allKeys = await adapter.keys();
    assertEquals(allKeys.length >= 2, true);
    assertEquals(allKeys.includes('users:u1'), true);
    assertEquals(allKeys.includes('users:u2'), true);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - clear removes all rows',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com' });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@t.com' });
    await adapter.clear();

    const keys = await adapter.keys();
    assertEquals(keys.length, 0);

    adapter.close();
  },
});

// ============================================================================
// Native query (real SQL columns)
// ============================================================================

Deno.test({
  name: 'structured-sqlite - query with equality filter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com', age: 25 });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@t.com', age: 30 });
    await adapter.set('users:u3', { id: 'u3', name: 'Charlie', email: 'c@t.com', age: 25 });

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      filter: { age: 25 },
    });

    assertEquals(result.totalCount, 2);
    assertEquals(result.data.length, 2);
    assertEquals(result.data.every((r: any) => r.age === 25), true);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - query with comparison operators',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com', age: 20 });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@t.com', age: 30 });
    await adapter.set('users:u3', { id: 'u3', name: 'Charlie', email: 'c@t.com', age: 40 });

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      filter: { age: { $gte: 30 } },
    });

    assertEquals(result.totalCount, 2);
    assertEquals(result.data.every((r: any) => r.age >= 30), true);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - query with sort',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Charlie', email: 'c@t.com', age: 40 });
    await adapter.set('users:u2', { id: 'u2', name: 'Alice', email: 'a@t.com', age: 20 });
    await adapter.set('users:u3', { id: 'u3', name: 'Bob', email: 'b@t.com', age: 30 });

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      sort: { age: 1 },
    });

    assertEquals(result.data[0].age, 20);
    assertEquals(result.data[1].age, 30);
    assertEquals(result.data[2].age, 40);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - query with limit and skip',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    for (let i = 0; i < 10; i++) {
      await adapter.set(`users:u${i}`, { id: `u${i}`, name: `User${i}`, email: `u${i}@t.com`, age: 20 + i });
    }

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      sort: { age: 1 },
      limit: 3,
      skip: 2,
    });

    assertEquals(result.data.length, 3);
    assertEquals(result.data[0].age, 22); // skipped 20, 21
    assertEquals(result.totalCount, 10); // total before limit

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - query with $in operator',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com', age: 25 });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@t.com', age: 30 });
    await adapter.set('users:u3', { id: 'u3', name: 'Charlie', email: 'c@t.com', age: 35 });

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      filter: { name: { $in: ['Alice', 'Charlie'] } },
    });

    assertEquals(result.totalCount, 2);
    const names = result.data.map((r: any) => r.name).sort();
    assertEquals(names, ['Alice', 'Charlie']);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - query with $contains operator',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice Smith', email: 'a@t.com' });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob Jones', email: 'b@t.com' });
    await adapter.set('users:u3', { id: 'u3', name: 'Alice Jones', email: 'c@t.com' });

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      filter: { name: { $contains: 'Alice' } },
    });

    assertEquals(result.totalCount, 2);

    adapter.close();
  },
});

// ============================================================================
// Multi-table support
// ============================================================================

Deno.test({
  name: 'structured-sqlite - multiple tables work independently',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com' });
    await adapter.set('posts:1', { user_id: 'u1', title: 'First Post', body: 'Hello' });

    // posts table uses autoincrement, but we pass id=1 via the key
    const user = await adapter.get('users:u1');
    assertNotEquals(user, null);
    assertEquals(user.name, 'Alice');

    // For autoincrement tables, the adapter stores with the provided id
    const post = await adapter.get('posts:1');
    assertNotEquals(post, null);
    assertEquals(post.title, 'First Post');
    assertEquals(post.user_id, 'u1');

    adapter.close();
  },
});

// ============================================================================
// insertMany (batch)
// ============================================================================

Deno.test({
  name: 'structured-sqlite - insertMany in transaction',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    adapter.insertMany('users', [
      { id: 'u1', name: 'Alice', email: 'a@t.com', age: 25 },
      { id: 'u2', name: 'Bob', email: 'b@t.com', age: 30 },
      { id: 'u3', name: 'Charlie', email: 'c@t.com', age: 35 },
    ]);

    const result = await adapter.query({ prefix: 'smallstore:users:' });
    assertEquals(result.totalCount, 3);

    adapter.close();
  },
});

// ============================================================================
// Schema introspection
// ============================================================================

Deno.test({
  name: 'structured-sqlite - listTables and getTableSchema',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const adapter = createTestAdapter();

    const tables = adapter.listTables();
    assertEquals(tables.includes('users'), true);
    assertEquals(tables.includes('posts'), true);

    const schema = adapter.getTableSchema('users');
    assertNotEquals(schema, undefined);
    assertEquals(schema!.columns.id.type, 'text');
    assertEquals(schema!.columns.id.primaryKey, true);
    assertEquals(schema!.columns.name.notNull, true);

    adapter.close();
  },
});

// ============================================================================
// Error handling
// ============================================================================

Deno.test({
  name: 'structured-sqlite - get returns null for non-existent row',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    const result = await adapter.get('users:nonexistent');
    assertEquals(result, null);

    adapter.close();
  },
});

Deno.test({
  name: 'structured-sqlite - set throws for unknown table',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adapter = createTestAdapter();

    let threw = false;
    try {
      await adapter.set('unknown_table:id1', { name: 'test' });
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes('No schema'), true);
    }
    assertEquals(threw, true);

    adapter.close();
  },
});
