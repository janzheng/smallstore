/**
 * Batch Operations Tests
 *
 * Tests for batchGet, batchSet, batchDelete.
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';

// ============================================================================
// batchSet + batchGet
// ============================================================================

Deno.test({
  name: 'batchSet - stores multiple keys in parallel',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.batchSet([
      { path: 'batch/a', data: { name: 'Alpha' }, options: { mode: 'overwrite' } },
      { path: 'batch/b', data: { name: 'Beta' }, options: { mode: 'overwrite' } },
      { path: 'batch/c', data: { name: 'Gamma' }, options: { mode: 'overwrite' } },
    ]);

    const a = await store.get('batch/a', { raw: true });
    const b = await store.get('batch/b', { raw: true });
    const c = await store.get('batch/c', { raw: true });
    assertEquals(a.name, 'Alpha');
    assertEquals(b.name, 'Beta');
    assertEquals(c.name, 'Gamma');
  },
});

Deno.test({
  name: 'batchGet - retrieves multiple keys in parallel',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.batchSet([
      { path: 'bg/x', data: { v: 1 }, options: { mode: 'overwrite' } },
      { path: 'bg/y', data: { v: 2 }, options: { mode: 'overwrite' } },
      { path: 'bg/z', data: { v: 3 }, options: { mode: 'overwrite' } },
    ]);

    const results = await store.batchGet(['bg/x', 'bg/y', 'bg/z']);

    assertEquals(results.size, 3);
    assertNotEquals(results.get('bg/x'), null);
    assertNotEquals(results.get('bg/y'), null);
    assertNotEquals(results.get('bg/z'), null);
    assertEquals(results.get('bg/x').content.v, 1);
    assertEquals(results.get('bg/y').content.v, 2);
    assertEquals(results.get('bg/z').content.v, 3);
  },
});

Deno.test({
  name: 'batchGet - returns null for missing keys',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('bgm/exists', { v: 1 }, { mode: 'overwrite' });

    const results = await store.batchGet(['bgm/exists', 'bgm/missing']);

    assertEquals(results.size, 2);
    assertNotEquals(results.get('bgm/exists'), null);
    assertEquals(results.get('bgm/missing'), null);
  },
});

Deno.test({
  name: 'batchGet - raw mode returns unwrapped data',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.batchSet([
      { path: 'bgr/one', data: { val: 'hello' }, options: { mode: 'overwrite' } },
    ]);

    const results = await store.batchGet(['bgr/one'], { raw: true });

    assertEquals(results.size, 1);
    assertEquals(results.get('bgr/one').val, 'hello');
  },
});

// ============================================================================
// batchDelete
// ============================================================================

Deno.test({
  name: 'batchDelete - removes multiple keys in parallel',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.batchSet([
      { path: 'bd/a', data: 'A', options: { mode: 'overwrite' } },
      { path: 'bd/b', data: 'B', options: { mode: 'overwrite' } },
      { path: 'bd/c', data: 'C', options: { mode: 'overwrite' } },
    ]);

    await store.batchDelete(['bd/a', 'bd/b']);

    const results = await store.batchGet(['bd/a', 'bd/b', 'bd/c']);
    assertEquals(results.get('bd/a'), null);
    assertEquals(results.get('bd/b'), null);
    assertNotEquals(results.get('bd/c'), null);
  },
});

Deno.test({
  name: 'batchDelete - silently ignores missing keys',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    // Should not throw even for non-existent keys
    await store.batchDelete(['nonexistent/a', 'nonexistent/b']);
  },
});

// ============================================================================
// Cross-adapter batch ops
// ============================================================================

Deno.test({
  name: 'batchSet + batchGet - works with SQLite preset',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.batchSet([
      { path: 'bsql/a', data: { name: 'SqlA' }, options: { mode: 'overwrite' } },
      { path: 'bsql/b', data: { name: 'SqlB' }, options: { mode: 'overwrite' } },
    ]);

    const results = await store.batchGet(['bsql/a', 'bsql/b']);
    assertEquals(results.size, 2);
    assertEquals(results.get('bsql/a').content.name, 'SqlA');
    assertEquals(results.get('bsql/b').content.name, 'SqlB');

    await store.batchDelete(['bsql/a', 'bsql/b']);

    const after = await store.batchGet(['bsql/a', 'bsql/b']);
    assertEquals(after.get('bsql/a'), null);
    assertEquals(after.get('bsql/b'), null);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

Deno.test({
  name: 'cleanup - remove batch test artifacts',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try { await Deno.remove('./data/store.db'); } catch { /* ok */ }
    try { await Deno.remove('./data', { recursive: true }); } catch { /* ok */ }
  },
});
