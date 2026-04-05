/**
 * Tests for Phase 3.6h-b: Materialized Views
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import { createSmallstore } from '../mod.ts';
import { createMemoryAdapter } from '../src/adapters/memory.ts';

Deno.test("Materialized Views: Create and access lazy view", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Store source data
  await storage.set('research/papers', [
    { id: 1, title: 'Paper A', year: 2020, citations: 100 },
    { id: 2, title: 'Paper B', year: 2021, citations: 250 },
    { id: 3, title: 'Paper C', year: 2022, citations: 500 },
    { id: 4, title: 'Paper D', year: 2023, citations: 800 },
  ], { mode: 'overwrite' });
  
  // Create materialized view
  await storage.createMaterializedView('recent-papers', {
    source: 'research/papers',
    query: {
      filter: { year: { $gte: 2022 } },
      sort: { citations: -1 },
    },
    refresh: 'lazy',
    ttl: 60000, // 1 minute
  });
  
  // Access view
  const papers = await storage.get('recent-papers.view');
  
  assertEquals(Array.isArray(papers), true);
  assertEquals(papers.length, 2);
  assertEquals(papers[0].year >= 2022, true);
  assertEquals(papers[0].citations > papers[1].citations, true); // Sorted
  
  // Get metadata
  const metadata = await storage.getViewMetadata('recent-papers');
  assertExists(metadata);
  assertEquals(metadata.name, 'recent-papers');
  assertEquals(metadata.refresh, 'lazy');
  assertEquals(metadata.stats.itemCount, 2);
  
  console.log('✅ Lazy view test passed');
});

Deno.test("Materialized Views: On-write refresh", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Store source data
  await storage.set('bookmarks', [
    { id: 1, title: 'Bookmark A', created: '2025-01-01' },
    { id: 2, title: 'Bookmark B', created: '2025-01-02' },
  ], { mode: 'overwrite' });
  
  // Create view with on-write refresh
  await storage.createMaterializedView('recent-bookmarks', {
    source: 'bookmarks',
    query: {
      sort: { created: -1 },
      limit: 10,
    },
    refresh: 'on-write',
  });
  
  // Get initial view
  const bookmarks1 = await storage.get('recent-bookmarks.view');
  assertEquals(bookmarks1.length, 2);
  
  // Add new bookmark (should trigger refresh)
  await storage.set('bookmarks', [
    { id: 1, title: 'Bookmark A', created: '2025-01-01' },
    { id: 2, title: 'Bookmark B', created: '2025-01-02' },
    { id: 3, title: 'Bookmark C', created: '2025-01-03' },
  ], { mode: 'overwrite' });
  
  // View should be updated
  const bookmarks2 = await storage.get('recent-bookmarks.view');
  assertEquals(bookmarks2.length, 3);
  assertEquals(bookmarks2[0].id, 3); // Newest first
  
  console.log('✅ On-write refresh test passed');
});

Deno.test("Materialized Views: Manual refresh", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Store source data
  await storage.set('products', [
    { sku: 'A001', price: 10, stock: 5 },
    { sku: 'B002', price: 20, stock: 0 },
    { sku: 'C003', price: 15, stock: 10 },
  ], { mode: 'overwrite' });
  
  // Create view with manual refresh
  await storage.createMaterializedView('in-stock', {
    source: 'products',
    query: {
      filter: { stock: { $gt: 0 } },
    },
    refresh: 'manual',
  });
  
  // Initial view
  const products1 = await storage.get('in-stock.view');
  assertEquals(products1.length, 2);
  
  // Update source (should NOT auto-refresh)
  await storage.set('products', [
    { sku: 'A001', price: 10, stock: 0 },  // Out of stock
    { sku: 'B002', price: 20, stock: 5 },  // Back in stock
    { sku: 'C003', price: 15, stock: 10 },
  ], { mode: 'overwrite' });
  
  // View should still show old data
  const products2 = await storage.get('in-stock.view');
  assertEquals(products2.length, 2); // Still old data
  
  // Manual refresh
  const refreshResult = await storage.refreshView('in-stock');
  assertEquals(refreshResult.success, true);
  assertEquals(refreshResult.itemCount, 2); // Now updated
  
  // View should now show new data
  const products3 = await storage.get('in-stock.view');
  assertEquals(products3.length, 2);
  // Should include B002 and C003, not A001
  const skus = products3.map((p: any) => p.sku);
  assert(skus.includes('B002'));
  assert(skus.includes('C003'));
  assert(!skus.includes('A001'));
  
  console.log('✅ Manual refresh test passed');
});

Deno.test("Materialized Views: External refresh (cron pattern)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Store analytics data
  await storage.set('analytics/events', [
    { event: 'page_view', count: 100 },
    { event: 'click', count: 50 },
    { event: 'purchase', count: 5 },
  ], { mode: 'overwrite' });
  
  // Create view for external refresh
  await storage.createMaterializedView('top-events', {
    source: 'analytics/events',
    query: {
      sort: { count: -1 },
      limit: 5,
    },
    refresh: 'external',
    description: 'Top events for dashboard',
  });
  
  // Access view
  const events1 = await storage.get('top-events.view');
  assertEquals(events1.length, 3);
  assertEquals(events1[0].count, 100); // Highest first
  
  // Update source
  await storage.set('analytics/events', [
    { event: 'page_view', count: 100 },
    { event: 'click', count: 50 },
    { event: 'purchase', count: 500 },  // Big spike!
  ], { mode: 'overwrite' });
  
  // View should NOT auto-refresh (external strategy)
  const events2 = await storage.get('top-events.view');
  assertEquals(events2[0].count, 100); // Still old
  
  // Simulate cron job refresh
  await storage.refreshView('top-events');
  
  // Now view should be updated
  const events3 = await storage.get('top-events.view');
  assertEquals(events3[0].count, 500); // Updated!
  
  console.log('✅ External refresh test passed');
});

Deno.test("Materialized Views: Lazy refresh with TTL", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  await storage.set('test/data', [{ id: 1, value: 'A' }], { mode: 'overwrite' });
  
  // Create view with short TTL
  await storage.createMaterializedView('test-view', {
    source: 'test/data',
    query: {},
    refresh: 'lazy',
    ttl: 100, // 100ms
  });
  
  // First access (fresh)
  const data1 = await storage.get('test-view.view');
  assertEquals(data1.length, 1);
  
  // Update source
  await storage.set('test/data', [{ id: 1, value: 'A' }, { id: 2, value: 'B' }], { mode: 'overwrite' });
  
  // Immediate access (still cached, not stale yet)
  const data2 = await storage.get('test-view.view');
  assertEquals(data2.length, 1); // Still old data
  
  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Access again (should auto-refresh)
  const data3 = await storage.get('test-view.view');
  assertEquals(data3.length, 2); // Refreshed!
  
  console.log('✅ Lazy TTL test passed');
});

Deno.test("Materialized Views: Update view definition", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  await storage.set('test/numbers', [
    { value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }
  ], { mode: 'overwrite' });
  
  // Create view
  await storage.createMaterializedView('big-numbers', {
    source: 'test/numbers',
    query: {
      filter: { value: { $gt: 2 } },
    },
    refresh: 'manual',
  });
  
  const data1 = await storage.get('big-numbers.view');
  assertEquals(data1.length, 3); // 3, 4, 5
  
  // Update filter to be more restrictive
  await storage.updateMaterializedView('big-numbers', {
    query: {
      filter: { value: { $gt: 3 } },
    },
  });
  
  // Should auto-refresh after definition change
  const data2 = await storage.get('big-numbers.view');
  assertEquals(data2.length, 2); // 4, 5
  
  console.log('✅ Update view definition test passed');
});

Deno.test("Materialized Views: Delete view", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  await storage.set('test/data', [{ id: 1 }], { mode: 'overwrite' });
  
  await storage.createMaterializedView('test-view', {
    source: 'test/data',
    query: {},
    refresh: 'manual',
  });
  
  // View exists
  const metadata1 = await storage.getViewMetadata('test-view');
  assertExists(metadata1);
  
  // Delete view
  await storage.deleteMaterializedView('test-view');
  
  // View no longer exists
  const metadata2 = await storage.getViewMetadata('test-view');
  assertEquals(metadata2, null);
  
  console.log('✅ Delete view test passed');
});

Deno.test("Materialized Views: List views with filters", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  await storage.set('source1', [{ id: 1 }], { mode: 'overwrite' });
  await storage.set('source2', [{ id: 2 }], { mode: 'overwrite' });
  
  // Create multiple views
  await storage.createMaterializedView('view1', {
    source: 'source1',
    query: {},
    refresh: 'lazy',
    ttl: 60000,
  });
  
  await storage.createMaterializedView('view2', {
    source: 'source1',
    query: {},
    refresh: 'manual',
  });
  
  await storage.createMaterializedView('view3', {
    source: 'source2',
    query: {},
    refresh: 'lazy',
    ttl: 60000,
  });
  
  // List all views
  const allViews = await storage.listMaterializedViews();
  assertEquals(allViews.length, 3);
  
  // Filter by source
  const source1Views = await storage.listMaterializedViews({ source: 'source1' });
  assertEquals(source1Views.length, 2);
  
  // Filter by refresh strategy
  const lazyViews = await storage.listMaterializedViews({ refresh: 'lazy' });
  assertEquals(lazyViews.length, 2);
  
  console.log('✅ List views test passed');
});

Deno.test("Materialized Views: Batch refresh all", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  await storage.set('source1', [{ id: 1 }], { mode: 'overwrite' });
  await storage.set('source2', [{ id: 2 }], { mode: 'overwrite' });
  
  // Create views
  await storage.createMaterializedView('view1', {
    source: 'source1',
    query: {},
    refresh: 'manual',
  });
  
  await storage.createMaterializedView('view2', {
    source: 'source2',
    query: {},
    refresh: 'manual',
  });
  
  // Update sources
  await storage.set('source1', [{ id: 1 }, { id: 2 }], { mode: 'overwrite' });
  await storage.set('source2', [{ id: 2 }, { id: 3 }], { mode: 'overwrite' });
  
  // Batch refresh all views
  const results = await storage.refreshAllViews();
  
  assertEquals(results.length, 2);
  assertEquals(results.every((r: any) => r.success), true);
  assertEquals(results[0].itemCount, 2);
  assertEquals(results[1].itemCount, 2);
  
  console.log('✅ Batch refresh test passed');
});

console.log('\n🎉 All materialized view tests completed!\n');

