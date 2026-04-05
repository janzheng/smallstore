/**
 * Preset Profile Tests
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { getPreset, resolvePreset } from '../presets.ts';
import type { PresetName } from '../presets.ts';

// ============================================================================
// getPreset() — individual presets
// ============================================================================

Deno.test('getPreset - memory preset returns memory adapter', () => {
  const preset = getPreset('memory');

  assertEquals(preset.defaultAdapter, 'memory');
  assertNotEquals(preset.adapters, undefined);
  assertEquals('memory' in preset.adapters!, true);
  assertEquals(Object.keys(preset.adapters!).length, 1);
});

Deno.test('getPreset - local preset returns local-json + files + memory', () => {
  const preset = getPreset('local');

  assertEquals(preset.defaultAdapter, 'local');
  assertNotEquals(preset.adapters, undefined);
  assertEquals('memory' in preset.adapters!, true);
  assertEquals('local' in preset.adapters!, true);
  assertEquals('files' in preset.adapters!, true);
  assertEquals(Object.keys(preset.adapters!).length, 3);
  assertEquals(preset.mounts?.['cache/*'], 'memory');
  assertEquals(preset.mounts?.['files/*'], 'files');
});

Deno.test('getPreset - local-sqlite preset returns sqlite + files + memory', () => {
  const preset = getPreset('local-sqlite');

  assertEquals(preset.defaultAdapter, 'sqlite');
  assertNotEquals(preset.adapters, undefined);
  assertEquals('memory' in preset.adapters!, true);
  assertEquals('sqlite' in preset.adapters!, true);
  assertEquals('files' in preset.adapters!, true);
  assertEquals(Object.keys(preset.adapters!).length, 3);
  assertEquals(preset.mounts?.['cache/*'], 'memory');
  assertEquals(preset.mounts?.['files/*'], 'files');
});

Deno.test('getPreset - cloud preset falls back to memory without env vars', () => {
  const preset = getPreset('cloud');

  // Without UPSTASH env vars, should fall back to memory
  assertNotEquals(preset.adapters, undefined);
  assertEquals('memory' in preset.adapters!, true);
});

Deno.test('getPreset - hybrid preset returns sqlite + memory + files', () => {
  const preset = getPreset('hybrid');

  assertEquals(preset.defaultAdapter, 'sqlite');
  assertNotEquals(preset.adapters, undefined);
  assertEquals('memory' in preset.adapters!, true);
  assertEquals('sqlite' in preset.adapters!, true);
  assertEquals('files' in preset.adapters!, true);
  assertEquals(preset.mounts?.['cache/*'], 'memory');
  assertEquals(preset.mounts?.['files/*'], 'files');
});

Deno.test('getPreset - unknown preset throws', () => {
  let threw = false;
  try {
    getPreset('nonexistent' as PresetName);
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, 'Unknown preset: nonexistent');
  }
  assertEquals(threw, true);
});

// ============================================================================
// resolvePreset() — merging
// ============================================================================

Deno.test('resolvePreset - no preset passes through as SmallstoreConfig', () => {
  const config = {
    adapters: { mem: {} as any },
    defaultAdapter: 'mem',
  };

  const resolved = resolvePreset(config);

  assertEquals(resolved.defaultAdapter, 'mem');
  assertEquals('mem' in resolved.adapters, true);
});

Deno.test('resolvePreset - preset provides base config', () => {
  const resolved = resolvePreset({ preset: 'memory' });

  assertEquals(resolved.defaultAdapter, 'memory');
  assertEquals('memory' in resolved.adapters, true);
});

Deno.test('resolvePreset - explicit adapters merge with preset adapters', () => {
  const extraAdapter = { get: () => null } as any;

  const resolved = resolvePreset({
    preset: 'local',
    adapters: { custom: extraAdapter },
  });

  // Should have preset adapters + custom
  assertEquals('memory' in resolved.adapters, true);
  assertEquals('local' in resolved.adapters, true);
  assertEquals('files' in resolved.adapters, true);
  assertEquals('custom' in resolved.adapters, true);
});

Deno.test('resolvePreset - explicit adapters override preset adapters on conflict', () => {
  const customMemory = { _custom: true } as any;

  const resolved = resolvePreset({
    preset: 'local',
    adapters: { memory: customMemory },
  });

  // Explicit memory should override preset memory
  assertEquals((resolved.adapters.memory as any)._custom, true);
  // local should still come from preset
  assertEquals('local' in resolved.adapters, true);
});

Deno.test('resolvePreset - explicit mounts merge with preset mounts', () => {
  const resolved = resolvePreset({
    preset: 'local',
    mounts: { 'archive/*': 'local' },
  });

  // Should have both preset mount and explicit mount
  assertEquals(resolved.mounts?.['cache/*'], 'memory');
  assertEquals(resolved.mounts?.['archive/*'], 'local');
});

Deno.test('resolvePreset - explicit defaultAdapter overrides preset', () => {
  const resolved = resolvePreset({
    preset: 'local',
    defaultAdapter: 'memory',
  });

  assertEquals(resolved.defaultAdapter, 'memory');
});

// ============================================================================
// createSmallstore() with presets
// ============================================================================

Deno.test('createSmallstore - preset: memory creates working instance', async () => {
  const { createSmallstore } = await import('../mod.ts');

  const store = createSmallstore({ preset: 'memory' });

  await store.set('test-key', { hello: 'preset' });
  const result = await store.get('test-key');
  assertNotEquals(result, null);
});

Deno.test({
  name: 'createSmallstore - preset: local creates working instance',
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');

    const store = createSmallstore({ preset: 'local' });

    await store.set('data/item', { from: 'local-preset' });
    const result = await store.get('data/item');
    assertNotEquals(result, null);

    // Cache mount should work via memory
    await store.set('cache/temp', { ttl: 60 });
    const cached = await store.get('cache/temp');
    assertNotEquals(cached, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test('createSmallstore - preset: local-sqlite creates working instance', async () => {
  const { createSmallstore } = await import('../mod.ts');

  const store = createSmallstore({ preset: 'local-sqlite' });

  await store.set('data/item', { from: 'sqlite-preset' });
  const result = await store.get('data/item');
  assertNotEquals(result, null);
});

Deno.test({
  name: 'createSmallstore - preset with adapter overrides',
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');
    const { createSQLiteAdapter } = await import('../src/adapters/sqlite.ts');

    const store = createSmallstore({
      preset: 'local',
      adapters: {
        'extra-db': createSQLiteAdapter({ path: ':memory:' }),
      },
      mounts: {
        'extra/*': 'extra-db',
      },
    });

    // Default local-json should still work
    await store.set('main/item', { v: 1 });
    const mainResult = await store.get('main/item');
    assertNotEquals(mainResult, null);

    // Extra adapter should work via mount
    await store.set('extra/item', { v: 2 });
    const extraResult = await store.get('extra/item');
    assertNotEquals(extraResult, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'createSmallstore - preset: local routes files/* to local-file adapter',
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');

    const store = createSmallstore({ preset: 'local' });

    // Store a "file" through the files mount
    const fileData = new TextEncoder().encode('raw file content');
    await store.set('files/docs/readme.txt', fileData);

    const result = await store.get('files/docs/readme.txt');
    assertNotEquals(result, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// typeRouting — every preset routes data types to correct adapters
// ============================================================================

Deno.test('getPreset - memory preset has typeRouting for all data types', () => {
  const preset = getPreset('memory');

  assertNotEquals(preset.typeRouting, undefined);
  assertEquals(preset.typeRouting?.blob, 'memory');
  assertEquals(preset.typeRouting?.object, 'memory');
  assertEquals(preset.typeRouting?.kv, 'memory');
});

Deno.test('getPreset - local preset has typeRouting: blob→files, object→local, kv→local', () => {
  const preset = getPreset('local');

  assertNotEquals(preset.typeRouting, undefined);
  assertEquals(preset.typeRouting?.blob, 'files');
  assertEquals(preset.typeRouting?.object, 'local');
  assertEquals(preset.typeRouting?.kv, 'local');
});

Deno.test('getPreset - local-sqlite preset has typeRouting: blob→files, object→sqlite, kv→sqlite', () => {
  const preset = getPreset('local-sqlite');

  assertNotEquals(preset.typeRouting, undefined);
  assertEquals(preset.typeRouting?.blob, 'files');
  assertEquals(preset.typeRouting?.object, 'sqlite');
  assertEquals(preset.typeRouting?.kv, 'sqlite');
});

Deno.test('getPreset - cloud preset has typeRouting with fallback', () => {
  const preset = getPreset('cloud');
  const hasUpstash = !!(
    (Deno.env.get('UPSTASH_REDIS_REST_URL') || Deno.env.get('SM_UPSTASH_URL')) &&
    (Deno.env.get('UPSTASH_REDIS_REST_TOKEN') || Deno.env.get('SM_UPSTASH_TOKEN'))
  );
  const hasR2 = !!(
    (Deno.env.get('SM_R2_ACCOUNT_ID') || Deno.env.get('R2_ACCOUNT_ID')) &&
    (Deno.env.get('SM_R2_ACCESS_KEY_ID') || Deno.env.get('R2_ACCESS_KEY_ID')) &&
    (Deno.env.get('SM_R2_SECRET_ACCESS_KEY') || Deno.env.get('R2_SECRET_ACCESS_KEY')) &&
    (Deno.env.get('SM_R2_BUCKET_NAME') || Deno.env.get('R2_BUCKET_NAME'))
  );
  const expectedObj = hasUpstash ? 'upstash' : 'memory';
  const expectedBlob = hasR2 ? 'r2' : 'memory';

  assertNotEquals(preset.typeRouting, undefined);
  assertEquals(preset.typeRouting?.blob, expectedBlob);
  assertEquals(preset.typeRouting?.object, expectedObj);
  assertEquals(preset.typeRouting?.kv, expectedObj);
});

Deno.test('getPreset - hybrid preset has typeRouting: blob→files, object→sqlite, kv→sqlite', () => {
  const preset = getPreset('hybrid');

  assertNotEquals(preset.typeRouting, undefined);
  assertEquals(preset.typeRouting?.blob, 'files');
  assertEquals(preset.typeRouting?.object, 'sqlite');
  assertEquals(preset.typeRouting?.kv, 'sqlite');
});

Deno.test('resolvePreset - preset typeRouting is included in resolved config', () => {
  const resolved = resolvePreset({ preset: 'local' });

  assertNotEquals(resolved.typeRouting, undefined);
  assertEquals(resolved.typeRouting?.blob, 'files');
  assertEquals(resolved.typeRouting?.object, 'local');
});

Deno.test('resolvePreset - explicit typeRouting overrides preset typeRouting', () => {
  const resolved = resolvePreset({
    preset: 'local',
    typeRouting: { blob: 'memory' },
  });

  // Explicit typeRouting wins entirely
  assertEquals(resolved.typeRouting?.blob, 'memory');
});

Deno.test({
  name: 'createSmallstore - local preset routes blob data to files adapter via typeRouting',
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');

    const store = createSmallstore({ preset: 'local' });

    // Write blob data WITHOUT files/* prefix — typeRouting should route to files adapter
    const blobData = new TextEncoder().encode('binary image data');
    await store.set('photos/cat.jpg', blobData);

    const result = await store.get('photos/cat.jpg');
    assertNotEquals(result, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'createSmallstore - local-sqlite preset routes blob data to files adapter via typeRouting',
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');

    const store = createSmallstore({ preset: 'local-sqlite' });

    // Write blob data — should route to files adapter via typeRouting
    const blobData = new TextEncoder().encode('binary pdf data');
    await store.set('docs/report.pdf', blobData);

    const result = await store.get('docs/report.pdf');
    assertNotEquals(result, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'createSmallstore - hybrid preset has files adapter and routes blobs',
  fn: async () => {
    const { createSmallstore } = await import('../mod.ts');

    const store = createSmallstore({ preset: 'hybrid' });

    // Write blob data — should route to files adapter via typeRouting
    const blobData = new TextEncoder().encode('hybrid blob data');
    await store.set('media/audio.mp3', blobData);

    const result = await store.get('media/audio.mp3');
    assertNotEquals(result, null);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// Cleanup
// ============================================================================

Deno.test({
  name: 'cleanup - remove preset test artifacts',
  fn: async () => {
    try { await Deno.remove('./data/store.db'); } catch { /* ok */ }
    try { await Deno.remove('./data', { recursive: true }); } catch { /* ok */ }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
