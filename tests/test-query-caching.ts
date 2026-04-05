/**
 * Tests for Phase 3.6h-a: Query Result Caching
 */

import { assertEquals, assertExists } from "@std/assert";
import { createSmallstore } from '../mod.ts';
import { createMemoryAdapter } from '../src/adapters/memory.ts';

Deno.test("Query caching: Basic cache hit/miss", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000, // 1 minute
      autoInvalidate: false,
    },
  });
  
  // Store test data
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A', year: 2020 },
    { id: 2, title: 'Paper B', year: 2021 },
    { id: 3, title: 'Paper C', year: 2022 },
  ]);
  
  // First query (cache miss)
  const result1 = await storage.query('test-caching/papers', {
    filter: { year: { $gte: 2021 } },
    cache: true,
  });
  
  assertEquals(result1.data.length, 2);
  assertEquals(result1.meta?.cached, undefined); // Not from cache
  
  // Second query with same options (cache hit)
  const result2 = await storage.query('test-caching/papers', {
    filter: { year: { $gte: 2021 } },
    cache: true,
  });
  
  assertEquals(result2.data.length, 2);
  assertEquals(result2.meta?.cached, true); // From cache!
  assertExists(result2.meta?.cachedAt);
  
  // Get cache stats
  const stats = await storage.getCacheStats('test-caching');
  assertEquals(stats.hits, 1);
  assertEquals(stats.misses, 1);
  assertEquals(stats.hitRate, 0.5);
  
  console.log('✅ Basic cache hit/miss test passed');
});

Deno.test("Query caching: Different queries get different caches", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A', year: 2020 },
    { id: 2, title: 'Paper B', year: 2021 },
    { id: 3, title: 'Paper C', year: 2022 },
  ]);
  
  // Query 1: year >= 2021
  const result1 = await storage.query('test-caching/papers', {
    filter: { year: { $gte: 2021 } },
    cache: true,
  });
  assertEquals(result1.data.length, 2);
  
  // Query 2: year >= 2020 (different query, should be cache miss)
  const result2 = await storage.query('test-caching/papers', {
    filter: { year: { $gte: 2020 } },
    cache: true,
  });
  assertEquals(result2.data.length, 3);
  assertEquals(result2.meta?.cached, undefined); // Cache miss (different query)
  
  // Query 3: Repeat query 1 (should be cache hit)
  const result3 = await storage.query('test-caching/papers', {
    filter: { year: { $gte: 2021 } },
    cache: true,
  });
  assertEquals(result3.data.length, 2);
  assertEquals(result3.meta?.cached, true); // Cache hit!
  
  console.log('✅ Different queries test passed');
});

Deno.test("Query caching: Custom TTL", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A' },
  ]);
  
  // Query with custom short TTL (100ms)
  await storage.query('test-caching/papers', {
    cache: { enabled: true, ttl: 100 },
  });
  
  // Immediately query again (should hit cache)
  const result1 = await storage.query('test-caching/papers', {
    cache: { enabled: true, ttl: 100 },
  });
  assertEquals(result1.meta?.cached, true);
  
  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Query again (should be cache miss - expired)
  const result2 = await storage.query('test-caching/papers', {
    cache: { enabled: true, ttl: 100 },
  });
  assertEquals(result2.meta?.cached, undefined); // Cache expired!
  
  console.log('✅ Custom TTL test passed');
});

Deno.test("Query caching: Auto-invalidation on write", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
      autoInvalidate: true, // Enable auto-invalidation
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A' },
  ]);
  
  // Query (cache miss)
  const result1 = await storage.query('test-caching/papers', {
    cache: true,
  });
  assertEquals(result1.data.length, 1);
  
  // Query again (cache hit)
  const result2 = await storage.query('test-caching/papers', {
    cache: true,
  });
  assertEquals(result2.meta?.cached, true);
  
  // Write new data (should invalidate cache)
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A' },
    { id: 2, title: 'Paper B' },
  ], { mode: 'overwrite' });
  
  // Query again (should be cache miss - invalidated)
  const result3 = await storage.query('test-caching/papers', {
    cache: true,
  });
  assertEquals(result3.data.length, 2); // New data!
  assertEquals(result3.meta?.cached, undefined); // Cache was invalidated
  
  console.log('✅ Auto-invalidation test passed');
});

Deno.test("Query caching: Cache disabled mode", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: false, // Caching disabled globally
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A' },
  ]);
  
  // Query with cache enabled (should be ignored - caching disabled globally)
  const result1 = await storage.query('test-caching/papers', {
    cache: true,
  });
  
  // Query again (should not hit cache)
  const result2 = await storage.query('test-caching/papers', {
    cache: true,
  });
  assertEquals(result2.meta?.cached, undefined); // No caching
  
  console.log('✅ Cache disabled mode test passed');
});

Deno.test("Query caching: Clear specific query cache", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
      autoInvalidate: false,
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A', year: 2020 },
    { id: 2, title: 'Paper B', year: 2021 },
  ]);
  
  // Query 1
  await storage.query('test-caching/papers', {
    filter: { year: 2020 },
    cache: true,
  });
  
  // Query 2 (different)
  await storage.query('test-caching/papers', {
    filter: { year: 2021 },
    cache: true,
  });
  
  // Both should hit cache
  const result1 = await storage.query('test-caching/papers', {
    filter: { year: 2020 },
    cache: true,
  });
  assertEquals(result1.meta?.cached, true);
  
  const result2 = await storage.query('test-caching/papers', {
    filter: { year: 2021 },
    cache: true,
  });
  assertEquals(result2.meta?.cached, true);
  
  // Clear only query 1 cache
  await storage.clearQueryCache('test-caching/papers', {
    filter: { year: 2020 },
  });
  
  // Query 1 should be cache miss now
  const result3 = await storage.query('test-caching/papers', {
    filter: { year: 2020 },
    cache: true,
  });
  assertEquals(result3.meta?.cached, undefined); // Cleared!
  
  // Query 2 should still hit cache
  const result4 = await storage.query('test-caching/papers', {
    filter: { year: 2021 },
    cache: true,
  });
  assertEquals(result4.meta?.cached, true); // Still cached!
  
  console.log('✅ Clear specific query cache test passed');
});

Deno.test("Query caching: Clear collection cache", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
      autoInvalidate: false,
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A' },
  ]);
  
  // Multiple queries
  await storage.query('test-caching/papers', {
    filter: { id: 1 },
    cache: true,
  });
  
  await storage.query('test-caching/papers', {
    limit: 10,
    cache: true,
  });
  
  // Clear all caches for this collection
  const cleared = await storage.clearCollectionCache('test-caching/papers');
  assertEquals(cleared >= 2, true); // At least 2 caches cleared
  
  // All queries should be cache miss now
  const result = await storage.query('test-caching/papers', {
    filter: { id: 1 },
    cache: true,
  });
  assertEquals(result.meta?.cached, undefined);
  
  console.log('✅ Clear collection cache test passed');
});

Deno.test("Query caching: Clear all caches", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
    },
  });
  
  // Create data in multiple collections
  await storage.set('test-caching/papers', [{ id: 1 }]);
  await storage.set('test-caching/books', [{ id: 1 }]);
  
  // Query both
  await storage.query('test-caching/papers', { cache: true });
  await storage.query('test-caching/books', { cache: true });
  
  // Get initial stats
  const statsBefore = await storage.getCacheStats();
  assertEquals(statsBefore.entries >= 2, true);
  
  // Clear all caches
  const cleared = await storage.clearAllCaches();
  assertEquals(cleared >= 2, true);
  
  // Stats should show 0 entries
  const statsAfter = await storage.getCacheStats();
  assertEquals(statsAfter.entries, 0);
  assertEquals(statsAfter.hits, 0);
  assertEquals(statsAfter.misses, 0);
  
  console.log('✅ Clear all caches test passed');
});

Deno.test("Query caching: Cache statistics", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 60000,
    },
  });
  
  await storage.set('test-caching/papers', [
    { id: 1, title: 'Paper A' },
    { id: 2, title: 'Paper B' },
  ]);
  
  // Create some cache hits and misses
  await storage.query('test-caching/papers', { cache: true }); // Miss
  await storage.query('test-caching/papers', { cache: true }); // Hit
  await storage.query('test-caching/papers', { filter: { id: 1 }, cache: true }); // Miss (different query)
  await storage.query('test-caching/papers', { cache: true }); // Hit
  
  // Get stats
  const stats = await storage.getCacheStats('test-caching');
  
  assertEquals(stats.hits, 2);
  assertEquals(stats.misses, 2);
  assertEquals(stats.hitRate, 0.5);
  assertEquals(stats.entries >= 2, true);
  assertExists(stats.size);
  assertExists(stats.newestEntry);
  assertExists(stats.oldestEntry);
  
  console.log('✅ Cache statistics test passed');
  console.log('   Cache stats:', stats);
});

console.log('\n🎉 All query caching tests completed!\n');

