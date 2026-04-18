/**
 * CacheManager unit tests
 *
 * Subject: src/utils/cache-manager.ts
 *
 * The CacheManager delegates storage to an injected StorageAdapter.
 * We use MemoryAdapter (src/adapters/memory.ts) as the backing store,
 * since it supports the full keys/get/set/delete surface the manager uses.
 *
 * Note: CacheManager itself does not implement LRU eviction in code —
 * `evictionPolicy` is stored on config but never consulted. LRU is a
 * configuration knob that the backing adapter would need to honor. These
 * tests verify behavior that actually exists (TTL expiry, hit/miss stats,
 * clearCollection, clearAll, cache-key stability) and document the gap.
 */

import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { CacheManager } from '../src/utils/cache-manager.ts';
import { createMemoryAdapter } from '../src/adapters/memory.ts';
import {
  generateQueryCacheKey,
  generateCollectionCachePrefix,
} from '../src/utils/cache-key.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

function makeManager(config = {}) {
  const adapter = createMemoryAdapter();
  const manager = new CacheManager(adapter, config);
  return { adapter, manager };
}

// ============================================================================
// Basic set/get/delete roundtrip
// ============================================================================

Deno.test({
  name: 'CacheManager - set then get returns cached data',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const path = 'research/papers';
    const options = { filter: { tag: 'foo' } };
    const payload = [{ id: 1 }, { id: 2 }];

    await manager.set(path, options, payload);
    const hit = await manager.get(path, options);

    assert(hit, 'expected cache hit');
    assertEquals(hit!.data, payload);
    assertEquals(hit!.query, options);
    assertEquals(typeof hit!.cachedAt, 'number');
  },
});

Deno.test({
  name: 'CacheManager - get returns null on miss',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const result = await manager.get('nope/nonexistent', { filter: { x: 1 } });
    assertEquals(result, null);
  },
});

Deno.test({
  name: 'CacheManager - clearQuery deletes a specific entry',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const path = 'a/b';
    const options = { filter: { id: 1 } };

    await manager.set(path, options, { hello: 'world' });
    assert(await manager.get(path, options));

    await manager.clearQuery(path, options);
    assertEquals(await manager.get(path, options), null);
  },
});

// ============================================================================
// TTL expiry (use short TTL, wait via setTimeout)
// ============================================================================

Deno.test({
  name: 'CacheManager - entry expires after TTL elapses',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const path = 'ttl/test';
    const options = { filter: { x: 1 } };

    // 50ms TTL
    await manager.set(path, options, { data: 'fresh' }, 50);

    // Immediately: hit
    const hit = await manager.get(path, options);
    assert(hit, 'expected hit before expiry');

    // Wait past TTL
    await new Promise((r) => setTimeout(r, 80));

    // After expiry: miss
    const miss = await manager.get(path, options);
    assertEquals(miss, null, 'expected miss after expiry');
  },
});

Deno.test({
  name: 'CacheManager - defaultTTL is used when per-set TTL omitted',
  ...opts,
  fn: async () => {
    const { manager } = makeManager({ defaultTTL: 60 });
    const path = 'ttl/default';
    const options = { filter: { y: 2 } };

    await manager.set(path, options, 'hi');
    const hit = await manager.get(path, options);
    assert(hit);
    assertEquals(hit!.ttl, 60);

    await new Promise((r) => setTimeout(r, 90));
    assertEquals(await manager.get(path, options), null);
  },
});

// ============================================================================
// Hit / miss tracking
// ============================================================================

Deno.test({
  name: 'CacheManager - stats tracks hits and misses',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const path = 'stats/test';
    const options = { filter: { a: 1 } };

    // Miss
    await manager.get(path, options);
    // Set + 2 hits
    await manager.set(path, options, [1, 2, 3]);
    await manager.get(path, options);
    await manager.get(path, options);
    // Miss on different query
    await manager.get(path, { filter: { a: 2 } });

    const stats = await manager.getStats();
    assertEquals(stats.hits, 2);
    assertEquals(stats.misses, 2);
    assertEquals(stats.hitRate, 0.5);
    assertEquals(stats.entries, 1);
  },
});

Deno.test({
  name: 'CacheManager - hitRate is 0 before any ops',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const stats = await manager.getStats();
    assertEquals(stats.hits, 0);
    assertEquals(stats.misses, 0);
    assertEquals(stats.hitRate, 0);
  },
});

Deno.test({
  name: 'CacheManager - expired read counts as miss (not hit)',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();
    const path = 'stats/expire';
    const options = { filter: { z: 9 } };

    await manager.set(path, options, 'tmp', 30);
    await new Promise((r) => setTimeout(r, 60));
    const result = await manager.get(path, options);
    assertEquals(result, null);

    const stats = await manager.getStats();
    assertEquals(stats.hits, 0);
    assertEquals(stats.misses, 1);
  },
});

// ============================================================================
// clearCollection / clearAll
// ============================================================================

Deno.test({
  name: 'CacheManager - clearCollection drops only that collection\'s caches',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();

    await manager.set('colA', { filter: { a: 1 } }, [1]);
    await manager.set('colA', { filter: { a: 2 } }, [2]);
    await manager.set('colB', { filter: { b: 1 } }, [3]);

    const cleared = await manager.clearCollection('colA');
    assertEquals(cleared, 2);

    assertEquals(await manager.get('colA', { filter: { a: 1 } }), null);
    assertEquals(await manager.get('colA', { filter: { a: 2 } }), null);
    const surviving = await manager.get('colB', { filter: { b: 1 } });
    assert(surviving, 'colB cache should survive clearCollection(colA)');
  },
});

Deno.test({
  name: 'CacheManager - clearAll drops everything and resets stats',
  ...opts,
  fn: async () => {
    const { manager } = makeManager();

    await manager.set('x', { filter: { p: 1 } }, 'v1');
    await manager.set('y', { filter: { p: 2 } }, 'v2');
    await manager.get('x', { filter: { p: 1 } }); // 1 hit

    const cleared = await manager.clearAll();
    assertEquals(cleared, 2);

    const stats = await manager.getStats();
    assertEquals(stats.hits, 0);
    assertEquals(stats.misses, 0);
    assertEquals(stats.entries, 0);
  },
});

// ============================================================================
// Cache key stability
// ============================================================================

Deno.test({
  name: 'CacheManager - same query options produce same cache key',
  ...opts,
  fn: () => {
    const path = 'research/papers';
    const k1 = generateQueryCacheKey(path, { filter: { year: 2024 }, limit: 10 });
    const k2 = generateQueryCacheKey(path, { filter: { year: 2024 }, limit: 10 });
    assertEquals(k1, k2);
  },
});

Deno.test({
  name: 'CacheManager - different query options produce different cache keys',
  ...opts,
  fn: () => {
    const path = 'research/papers';
    const k1 = generateQueryCacheKey(path, { filter: { year: 2024 } });
    const k2 = generateQueryCacheKey(path, { filter: { year: 2025 } });
    assertNotEquals(k1, k2);
  },
});

Deno.test({
  name: 'CacheManager - cache key starts with collection prefix',
  ...opts,
  fn: () => {
    const path = 'a/b/c';
    const key = generateQueryCacheKey(path, { filter: { x: 1 } });
    const prefix = generateCollectionCachePrefix(path);
    assert(
      key.startsWith(prefix),
      `expected ${key} to start with ${prefix}`,
    );
  },
});

// ============================================================================
// Enable/disable behavior
// ============================================================================

Deno.test({
  name: 'CacheManager - when disabled, get returns null and set is no-op',
  ...opts,
  fn: async () => {
    const { manager, adapter } = makeManager({ enableQueryCache: false });
    assertEquals(manager.isEnabled(), false);

    await manager.set('disabled', { filter: { x: 1 } }, 'payload');
    const got = await manager.get('disabled', { filter: { x: 1 } });
    assertEquals(got, null);

    const keys = await adapter.keys('_cache/');
    assertEquals(keys.length, 0, 'disabled cache should not store anything');
  },
});

Deno.test({
  name: 'CacheManager - getConfig returns full resolved config',
  ...opts,
  fn: () => {
    const { manager } = makeManager({ defaultTTL: 123 });
    const config = manager.getConfig();
    assertEquals(config.defaultTTL, 123);
    assertEquals(config.enableQueryCache, true);
    assertEquals(config.evictionPolicy, 'lru');
    assertEquals(config.autoInvalidate, true);
  },
});

// ============================================================================
// No-leak on delete
// ============================================================================

Deno.test({
  name: 'CacheManager - deleting an entry removes it from adapter keys',
  ...opts,
  fn: async () => {
    const { manager, adapter } = makeManager();
    const path = 'leak/check';
    const options = { filter: { id: 42 } };

    await manager.set(path, options, { foo: 'bar' });
    let keys = await adapter.keys('_cache/');
    assertEquals(keys.length, 1);

    await manager.clearQuery(path, options);
    keys = await adapter.keys('_cache/');
    assertEquals(keys.length, 0);
  },
});

// ============================================================================
// Eviction policy
// ============================================================================

Deno.test({
  name: 'CacheManager - LRU evicts oldest entries when maxCacheSize exceeded',
  ...opts,
  fn: async () => {
    const { manager, adapter } = makeManager({
      maxCacheSize: '200B', // room for ~1 entry of our test payload
      evictionPolicy: 'lru',
    });

    await manager.set('col/a', { filter: {} }, { id: 'a', data: 'x'.repeat(80) });
    await manager.set('col/b', { filter: {} }, { id: 'b', data: 'x'.repeat(80) });
    await manager.set('col/c', { filter: {} }, { id: 'c', data: 'x'.repeat(80) });

    const keys = await adapter.keys('_cache/');
    assert(keys.length < 3, `expected eviction to drop at least 1 of 3 entries, got ${keys.length}`);
    // 'a' was set first (oldest access) so should be gone; 'c' is newest so should remain.
    const hitA = await manager.get('col/a', { filter: {} });
    const hitC = await manager.get('col/c', { filter: {} });
    assertEquals(hitA, null, 'LRU should have evicted oldest (col/a)');
    assert(hitC, 'most-recent entry (col/c) should still be present');
  },
});

Deno.test({
  name: 'CacheManager - ttl-only policy does NOT evict on size',
  ...opts,
  fn: async () => {
    const { manager, adapter } = makeManager({
      maxCacheSize: '1B',
      evictionPolicy: 'ttl-only',
    });

    for (let i = 0; i < 5; i++) {
      await manager.set(`col/${i}`, { filter: { n: i } }, { i });
    }

    const keys = await adapter.keys('_cache/');
    assertEquals(keys.length, 5, 'ttl-only should not evict on size');
  },
});

Deno.test({
  name: 'CacheManager - maxCacheSize:0 disables size eviction',
  ...opts,
  fn: async () => {
    const { manager, adapter } = makeManager({
      maxCacheSize: '0',
      evictionPolicy: 'lru',
    });

    for (let i = 0; i < 5; i++) {
      await manager.set(`col/${i}`, { filter: { n: i } }, { i });
    }

    const keys = await adapter.keys('_cache/');
    assertEquals(keys.length, 5, 'zero max-size disables eviction');
  },
});

Deno.test({
  name: 'CacheManager - TTL-expired get() drops tracking (no phantom drift)',
  ...opts,
  fn: async () => {
    const { manager } = makeManager({ maxCacheSize: '10KB', evictionPolicy: 'lru' });

    await manager.set('col/a', { filter: {} }, { id: 'a' }, 10); // 10ms TTL
    const before = (manager as any).totalBytes;
    assert(before > 0, 'set should populate totalBytes');

    await new Promise(r => setTimeout(r, 20)); // wait past TTL

    // Expired read — should delete + drop tracking
    const hit = await manager.get('col/a', { filter: {} });
    assertEquals(hit, null);
    assertEquals((manager as any).totalBytes, 0, 'totalBytes should drop back to 0');
    assertEquals((manager as any).entries.size, 0, 'entries map should be empty');
  },
});

Deno.test({
  name: 'CacheManager - get() touches lastAccess (LRU "recent" protection)',
  ...opts,
  fn: async () => {
    // Each test entry is ~110B JSON; 250B fits two but forces eviction of one on the third set.
    const { manager } = makeManager({
      maxCacheSize: '250B',
      evictionPolicy: 'lru',
    });

    await manager.set('col/a', { filter: {} }, { id: 'a' });
    await manager.set('col/b', { filter: {} }, { id: 'b' });
    // Touch 'a' so it's now the most-recent access.
    await manager.get('col/a', { filter: {} });
    // Adding 'c' should evict 'b' (now oldest), not 'a'.
    await manager.set('col/c', { filter: {} }, { id: 'c' });

    const hitA = await manager.get('col/a', { filter: {} });
    const hitB = await manager.get('col/b', { filter: {} });
    const hitC = await manager.get('col/c', { filter: {} });
    assert(hitA, 'recently-read col/a should survive');
    assertEquals(hitB, null, 'col/b should be evicted');
    assert(hitC, 'new col/c should be present');
  },
});
