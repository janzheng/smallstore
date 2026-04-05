/**
 * Preset x Data Mode Integration Test Matrix
 *
 * End-to-end tests verifying that every combination of preset and data type
 * routes data through the correct adapter. Uses the StorageFileResponse
 * wrapper's `adapter` field to verify routing.
 *
 * Matrix (15 cells):
 *
 * | Preset       | object →  | blob →    | kv →      |
 * |------------- |-----------|-----------|-----------|
 * | memory       | memory    | memory    | memory    |
 * | local        | local     | files     | local     |
 * | local-sqlite | sqlite    | files     | sqlite    |
 * | cloud        | memory*   | memory*   | memory*   |
 * | hybrid       | sqlite    | files     | sqlite    |
 *
 * (* cloud falls back to memory without Upstash credentials)
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';

// Helper: create blob data
function makeBlob(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

// ============================================================================
// Preset: memory — all types → memory adapter
// ============================================================================

Deno.test({
  name: 'matrix: memory preset — object → memory adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('mx-mem/obj', { name: 'test', value: 42 }, { mode: 'overwrite' });
    const result = await store.get('mx-mem/obj');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'memory');
    assertEquals(result.dataType, 'object');
    assertEquals(result.content.name, 'test');
  },
});

Deno.test({
  name: 'matrix: memory preset — blob → memory adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('mx-mem/img.png', makeBlob('fake png data'), { mode: 'overwrite' });
    const result = await store.get('mx-mem/img.png');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'memory');
    assertEquals(result.dataType, 'blob');
  },
});

Deno.test({
  name: 'matrix: memory preset — kv string → memory adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('mx-mem/flag', 'enabled', { mode: 'overwrite' });
    const result = await store.get('mx-mem/flag');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'memory');
  },
});

// ============================================================================
// Preset: local — object→local, blob→files, kv→local
// ============================================================================

Deno.test({
  name: 'matrix: local preset — object → local (json) adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local' });

    await store.set('mx-loc/user', { name: 'Alice', role: 'admin' }, { mode: 'overwrite' });
    const result = await store.get('mx-loc/user');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'local');
    assertEquals(result.dataType, 'object');
    assertEquals(result.content.name, 'Alice');
  },
});

Deno.test({
  name: 'matrix: local preset — blob → files adapter via typeRouting',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local' });

    await store.set('mx-loc/photo.jpg', makeBlob('jpeg bytes'), { mode: 'overwrite' });
    const result = await store.get('mx-loc/photo.jpg');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'files');
    assertEquals(result.dataType, 'blob');
  },
});

Deno.test({
  name: 'matrix: local preset — kv string → local adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local' });

    await store.set('mx-loc/setting', 'dark-mode', { mode: 'overwrite' });
    const result = await store.get('mx-loc/setting');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'local');
  },
});

// ============================================================================
// Preset: local-sqlite — object→sqlite, blob→files, kv→sqlite
// ============================================================================

Deno.test({
  name: 'matrix: local-sqlite preset — object → sqlite adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.set('mx-sql/record', { title: 'Report', year: 2024 }, { mode: 'overwrite' });
    const result = await store.get('mx-sql/record');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'sqlite');
    assertEquals(result.dataType, 'object');
    assertEquals(result.content.title, 'Report');
  },
});

Deno.test({
  name: 'matrix: local-sqlite preset — blob → files adapter via typeRouting',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.set('mx-sql/doc.pdf', makeBlob('pdf bytes'), { mode: 'overwrite' });
    const result = await store.get('mx-sql/doc.pdf');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'files');
    assertEquals(result.dataType, 'blob');
  },
});

Deno.test({
  name: 'matrix: local-sqlite preset — kv number → sqlite adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.set('mx-sql/counter', 42, { mode: 'overwrite' });
    const result = await store.get('mx-sql/counter');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'sqlite');
  },
});

// ============================================================================
// Preset: cloud (fallback) — all → memory without Upstash env
// ============================================================================

Deno.test({
  name: 'matrix: cloud preset — object → fallback adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'cloud' });

    await store.set('mx-cld/item', { status: 'active' }, { mode: 'overwrite' });
    const result = await store.get('mx-cld/item');

    assertNotEquals(result, null);
    // Adapter depends on whether Upstash env vars are set
    const hasUpstash = !!(
      (Deno.env.get('UPSTASH_REDIS_REST_URL') || Deno.env.get('SM_UPSTASH_URL')) &&
      (Deno.env.get('UPSTASH_REDIS_REST_TOKEN') || Deno.env.get('SM_UPSTASH_TOKEN'))
    );
    assertEquals(result.adapter, hasUpstash ? 'upstash' : 'memory');
  },
});

Deno.test({
  name: 'matrix: cloud preset — blob → r2 or memory fallback',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const hasR2 = !!(
      (Deno.env.get('SM_R2_ACCOUNT_ID') || Deno.env.get('R2_ACCOUNT_ID')) &&
      (Deno.env.get('SM_R2_ACCESS_KEY_ID') || Deno.env.get('R2_ACCESS_KEY_ID')) &&
      (Deno.env.get('SM_R2_SECRET_ACCESS_KEY') || Deno.env.get('R2_SECRET_ACCESS_KEY')) &&
      (Deno.env.get('SM_R2_BUCKET_NAME') || Deno.env.get('R2_BUCKET_NAME'))
    );

    if (hasR2) {
      // Verify R2 adapter is wired into preset (skip actual R2 write)
      const { getPreset } = await import('../presets.ts');
      const preset = getPreset('cloud');
      assertEquals('r2' in preset.adapters!, true);
      assertEquals(preset.typeRouting?.blob, 'r2');
    } else {
      const { createSmallstore } = await import('../mod.ts');
      const store = createSmallstore({ preset: 'cloud' });
      await store.set('mx-cld/file.bin', makeBlob('binary'), { mode: 'overwrite' });
      const result = await store.get('mx-cld/file.bin');
      assertNotEquals(result, null);
      assertEquals(result.adapter, 'memory');
    }
  },
});

// ============================================================================
// Preset: hybrid — object→sqlite, blob→files, kv→sqlite
// ============================================================================

Deno.test({
  name: 'matrix: hybrid preset — object → sqlite adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'hybrid' });

    await store.set('mx-hyb/config', { theme: 'dark', lang: 'en' }, { mode: 'overwrite' });
    const result = await store.get('mx-hyb/config');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'sqlite');
    assertEquals(result.dataType, 'object');
    assertEquals(result.content.theme, 'dark');
  },
});

Deno.test({
  name: 'matrix: hybrid preset — blob → files adapter via typeRouting',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'hybrid' });

    await store.set('mx-hyb/track.mp3', makeBlob('audio data'), { mode: 'overwrite' });
    const result = await store.get('mx-hyb/track.mp3');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'files');
    assertEquals(result.dataType, 'blob');
  },
});

Deno.test({
  name: 'matrix: hybrid preset — kv boolean → sqlite adapter',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'hybrid' });

    await store.set('mx-hyb/enabled', true, { mode: 'overwrite' });
    const result = await store.get('mx-hyb/enabled');

    assertNotEquals(result, null);
    assertEquals(result.adapter, 'sqlite');
  },
});

// ============================================================================
// Cross-cutting: Native query delegation
// ============================================================================

Deno.test({
  name: 'matrix: local-sqlite query() delegates to native SQL',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.set('mx-qry/users/alice', { name: 'Alice', age: 30 }, { mode: 'overwrite' });
    await store.set('mx-qry/users/bob', { name: 'Bob', age: 25 }, { mode: 'overwrite' });
    await store.set('mx-qry/users/carol', { name: 'Carol', age: 35 }, { mode: 'overwrite' });

    const result = await store.query('mx-qry/users', {
      filter: { age: { $gte: 28 } },
    });

    assertEquals(result.meta?.nativeQuery, true);
    assertEquals(result.data.length, 2); // Alice (30) and Carol (35)
  },
});

Deno.test({
  name: 'matrix: hybrid query() delegates to native SQL',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'hybrid' });

    await store.set('mx-qry2/items/a', { type: 'book', price: 10 }, { mode: 'overwrite' });
    await store.set('mx-qry2/items/b', { type: 'dvd', price: 20 }, { mode: 'overwrite' });

    const result = await store.query('mx-qry2/items', {
      filter: { type: 'book' },
    });

    assertEquals(result.meta?.nativeQuery, true);
    assertEquals(result.data.length, 1);
  },
});

Deno.test({
  name: 'matrix: memory query() works with in-memory engine',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'memory' });

    await store.set('mx-qry3/items', { val: 1, name: 'a' }, { mode: 'overwrite' });

    // Basic query on memory preset — just verify it returns something
    const result = await store.query('mx-qry3/items');

    assertNotEquals(result, null);
    assertNotEquals(result.data, undefined);
  },
});

// ============================================================================
// Cross-cutting: patch() across presets
// ============================================================================

Deno.test({
  name: 'matrix: patch() works on local preset',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local' });

    await store.set('mx-patch/config', { host: 'localhost', port: 3000 }, { mode: 'overwrite' });
    await store.patch('mx-patch/config', { port: 8080, ssl: true });

    const result = await store.get('mx-patch/config', { raw: true });
    assertEquals(result.host, 'localhost');
    assertEquals(result.port, 8080);
    assertEquals(result.ssl, true);
  },
});

Deno.test({
  name: 'matrix: patch() works on hybrid preset',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'hybrid' });

    await store.set('mx-patch2/user', { name: 'Eve', level: 1 }, { mode: 'overwrite' });
    await store.patch('mx-patch2/user', { level: 5, badge: 'gold' });

    const result = await store.get('mx-patch2/user', { raw: true });
    assertEquals(result.name, 'Eve');
    assertEquals(result.level, 5);
    assertEquals(result.badge, 'gold');
  },
});

// ============================================================================
// Cross-cutting: mount routing still works alongside typeRouting
// ============================================================================

Deno.test({
  name: 'matrix: local preset cache/* mount stores and retrieves data',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const store = createSmallstore({ preset: 'local' });

    await store.set('cache/temp', { ttl: 60 }, { mode: 'overwrite' });
    const result = await store.get('cache/temp');

    // Verify data round-trips through the cache mount
    assertNotEquals(result, null);
    assertEquals(result.content.ttl, 60);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

Deno.test({
  name: 'matrix: cleanup test artifacts',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try { await Deno.remove('./data/store.db'); } catch { /* ok */ }
    try { await Deno.remove('./data', { recursive: true }); } catch { /* ok */ }
  },
});
