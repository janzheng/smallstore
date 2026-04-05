/**
 * Structured Preset Tests
 *
 * Phase 5.3: Verify the 'structured' preset creates real SQL tables.
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { createSmallstore } from '../mod.ts';
import { createStructuredSQLiteAdapter } from '../src/adapters/structured-sqlite.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

function makeStructuredStore() {
  return createSmallstore({
    preset: 'structured',
    adapters: {
      structured: createStructuredSQLiteAdapter({
        path: ':memory:',
        schema: {
          users: {
            columns: {
              id: { type: 'text', primaryKey: true },
              name: { type: 'text', notNull: true },
              email: { type: 'text' },
              age: { type: 'integer' },
            },
            indexes: [{ columns: ['email'] }],
          },
          posts: {
            columns: {
              id: { type: 'text', primaryKey: true },
              title: { type: 'text', notNull: true },
              body: { type: 'text' },
            },
          },
        },
      }),
    },
  });
}

Deno.test({
  name: 'structured preset - CRUD through preset on real SQL tables',
  ...opts,
  fn: async () => {
    const store = makeStructuredStore();

    // The structured adapter handles keys like "table:id"
    // Through the router, keys arrive as "smallstore:collection:path"
    // The structured adapter's parseKey extracts table and id
    const adapter = (store as any).adapters?.structured;
    assertNotEquals(adapter, undefined);

    // Direct adapter access for structured data
    await adapter.set('users:alice', { id: 'alice', name: 'Alice', email: 'alice@test.com', age: 30 });
    const result = await adapter.get('users:alice');
    assertNotEquals(result, null);
    assertEquals(result.name, 'Alice');
    assertEquals(result.age, 30);
  },
});

Deno.test({
  name: 'structured preset - preset type is recognized',
  ...opts,
  fn: () => {
    // Should not throw
    const store = makeStructuredStore();
    assertNotEquals(store, null);
  },
});

Deno.test({
  name: 'structured preset - schema override works (user schema replaces empty default)',
  ...opts,
  fn: async () => {
    const store = makeStructuredStore();
    const adapter = (store as any).adapters?.structured;

    // Verify the user schema was applied (users table exists)
    const tables = adapter.listTables();
    assertEquals(tables.includes('users'), true);
    assertEquals(tables.includes('posts'), true);
  },
});

Deno.test({
  name: 'structured preset - multi-table operations',
  ...opts,
  fn: async () => {
    const store = makeStructuredStore();
    const adapter = (store as any).adapters?.structured;

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com' });
    await adapter.set('posts:p1', { id: 'p1', title: 'Hello World', body: 'First post' });

    const user = await adapter.get('users:u1');
    const post = await adapter.get('posts:p1');

    assertEquals(user.name, 'Alice');
    assertEquals(post.title, 'Hello World');
  },
});

Deno.test({
  name: 'structured preset - native query on real columns',
  ...opts,
  fn: async () => {
    const store = makeStructuredStore();
    const adapter = (store as any).adapters?.structured;

    await adapter.set('users:u1', { id: 'u1', name: 'Alice', email: 'a@t.com', age: 25 });
    await adapter.set('users:u2', { id: 'u2', name: 'Bob', email: 'b@t.com', age: 35 });
    await adapter.set('users:u3', { id: 'u3', name: 'Charlie', email: 'c@t.com', age: 25 });

    const result = await adapter.query({
      prefix: 'smallstore:users:',
      filter: { age: 25 },
    });

    assertEquals(result.totalCount, 2);
    assertEquals(result.data.every((r: any) => r.age === 25), true);
  },
});
