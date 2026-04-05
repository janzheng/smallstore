/**
 * Patch Method Tests
 *
 * Tests for the shallow-merge patch() operation.
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';

// ============================================================================
// Basic patch behavior
// ============================================================================

Deno.test({
  name: 'patch - merges into existing object',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('users/alice', { name: 'Alice', age: 30, role: 'user' });
    await store.patch('users/alice', { role: 'admin', active: true });

    const result = await store.get('users/alice', { raw: true });
    assertEquals(result.name, 'Alice');      // unchanged
    assertEquals(result.age, 30);            // unchanged
    assertEquals(result.role, 'admin');       // updated
    assertEquals(result.active, true);       // added
  },
});

Deno.test({
  name: 'patch - creates new entry if none exists',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.patch('settings/app', { theme: 'dark', lang: 'en' });

    const result = await store.get('settings/app', { raw: true });
    assertNotEquals(result, null);
    assertEquals(result.theme, 'dark');
    assertEquals(result.lang, 'en');
  },
});

Deno.test({
  name: 'patch - overwrites fields with new values',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('config/db', { host: 'localhost', port: 5432 });
    await store.patch('config/db', { port: 3306 });

    const result = await store.get('config/db', { raw: true });
    assertEquals(result.host, 'localhost');  // unchanged
    assertEquals(result.port, 3306);          // overwritten
  },
});

Deno.test({
  name: 'patch - can set field to null',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('users/bob', { name: 'Bob', email: 'bob@test.com' });
    await store.patch('users/bob', { email: null });

    const result = await store.get('users/bob', { raw: true });
    assertEquals(result.name, 'Bob');
    assertEquals(result.email, null);
  },
});

// ============================================================================
// Edge cases
// ============================================================================

Deno.test({
  name: 'patch - replaces non-object existing data',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    // Store a string value
    await store.set('data/raw', 'just a string');
    // Patch should replace since existing is not an object
    await store.patch('data/raw', { converted: true });

    const result = await store.get('data/raw', { raw: true });
    assertEquals(result.converted, true);
  },
});

Deno.test({
  name: 'patch - replaces array existing data',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('data/list', [1, 2, 3]);
    // Patch should replace since existing is an array, not a plain object
    await store.patch('data/list', { items: [1, 2, 3], count: 3 });

    const result = await store.get('data/list', { raw: true });
    assertEquals(result.count, 3);
    assertEquals(Array.isArray(result.items), true);
  },
});

Deno.test({
  name: 'patch - shallow merge (nested objects are replaced, not deep-merged)',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('config/app', {
      db: { host: 'localhost', port: 5432 },
      cache: { ttl: 60 },
    });
    await store.patch('config/app', {
      db: { host: 'remote.db.com' }, // replaces entire db object
    });

    const result = await store.get('config/app', { raw: true });
    assertEquals(result.db.host, 'remote.db.com');
    assertEquals(result.db.port, undefined);  // lost — shallow merge
    assertEquals(result.cache.ttl, 60);        // unchanged
  },
});

Deno.test({
  name: 'patch - works with SQLite adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.set('patchtest/item1', { title: 'Original', status: 'draft' });
    await store.patch('patchtest/item1', { status: 'published', views: 0 });

    const result = await store.get('patchtest/item1', { raw: true });
    assertEquals(result.title, 'Original');
    assertEquals(result.status, 'published');
    assertEquals(result.views, 0);
  },
});
