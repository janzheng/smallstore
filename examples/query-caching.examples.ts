/**
 * Examples for Phase 3.6h-a: Query Result Caching
 * 
 * Demonstrates:
 * - Basic query caching
 * - Custom TTL
 * - Auto-invalidation
 * - Cache management (clear, stats)
 * - External cron trigger pattern
 */

import { createSmallstore } from '../mod.ts';
import { createMemoryAdapter } from '../src/adapters/memory.ts';
import { createUpstashAdapter } from '../src/adapters/upstash.ts';
import { getEnv } from '../src/utils/env.ts';

// ============================================================================
// Example 1: Basic Query Caching
// ============================================================================

async function example1_BasicCaching() {
  console.log('\n=== Example 1: Basic Query Caching ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 900000, // 15 minutes
      autoInvalidate: true,
    },
  });
  
  // Store research papers
  await storage.set('research/papers', [
    { id: 1, title: 'Machine Learning in 2020', year: 2020, citations: 150 },
    { id: 2, title: 'Deep Learning Advances', year: 2021, citations: 250 },
    { id: 3, title: 'Transformers Explained', year: 2022, citations: 500 },
    { id: 4, title: 'Large Language Models', year: 2023, citations: 800 },
  ]);
  
  // First query (cache miss)
  console.time('Query 1 (cache miss)');
  const result1 = await storage.query('research/papers', {
    filter: { year: { $gte: 2021 } },
    sort: { citations: -1 },
    cache: true,
  });
  console.timeEnd('Query 1 (cache miss)');
  
  console.log(`  Found ${result1.data.length} papers`);
  console.log(`  Cached: ${result1.meta?.cached || false}`);
  
  // Second query with same options (cache hit!)
  console.time('Query 2 (cache hit)');
  const result2 = await storage.query('research/papers', {
    filter: { year: { $gte: 2021 } },
    sort: { citations: -1 },
    cache: true,
  });
  console.timeEnd('Query 2 (cache hit)');
  
  console.log(`  Found ${result2.data.length} papers`);
  console.log(`  Cached: ${result2.meta?.cached || false}`);
  console.log(`  Cached at: ${result2.meta?.cachedAt}`);
  
  // Cache stats
  const stats = await storage.getCacheStats('research');
  console.log('\n  Cache Stats:');
  console.log(`    Hits: ${stats.hits}`);
  console.log(`    Misses: ${stats.misses}`);
  console.log(`    Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%`);
  console.log(`    Size: ${stats.size}`);
  console.log(`    Entries: ${stats.entries}`);
}

// ============================================================================
// Example 2: Custom TTL (Short-lived Cache)
// ============================================================================

async function example2_CustomTTL() {
  console.log('\n=== Example 2: Custom TTL ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 3600000, // 1 hour default
    },
  });
  
  await storage.set('api/live-data', [
    { sensor: 'temperature', value: 22.5 },
    { sensor: 'humidity', value: 65 },
  ]);
  
  // Query with short TTL for live data
  console.log('Querying with 5-second TTL...');
  const result1 = await storage.query('api/live-data', {
    cache: {
      enabled: true,
      ttl: 5000,  // 5 seconds
    },
  });
  console.log(`  Data: ${result1.data.length} sensors`);
  
  // Immediate second query (cache hit)
  const result2 = await storage.query('api/live-data', {
    cache: { enabled: true, ttl: 5000 },
  });
  console.log(`  Cached: ${result2.meta?.cached || false}`);
  
  // Wait for expiration
  console.log('\nWaiting 6 seconds for cache to expire...');
  await new Promise(resolve => setTimeout(resolve, 6000));
  
  // Query again (cache miss - expired)
  const result3 = await storage.query('api/live-data', {
    cache: { enabled: true, ttl: 5000 },
  });
  console.log(`  Cached: ${result3.meta?.cached || false} (expired!)`);
}

// ============================================================================
// Example 3: Auto-Invalidation on Write
// ============================================================================

async function example3_AutoInvalidation() {
  console.log('\n=== Example 3: Auto-Invalidation ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 3600000,
      autoInvalidate: true,  // Auto-clear caches on write
    },
  });
  
  // Initial data
  await storage.set('products/inventory', [
    { sku: 'A001', stock: 10 },
    { sku: 'B002', stock: 5 },
  ]);
  
  // Query (cache miss)
  const result1 = await storage.query('products/inventory', {
    filter: { stock: { $gt: 0 } },
    cache: true,
  });
  console.log(`Initial query: ${result1.data.length} in stock`);
  console.log(`  Cached: ${result1.meta?.cached || false}`);
  
  // Query again (cache hit)
  const result2 = await storage.query('products/inventory', {
    filter: { stock: { $gt: 0 } },
    cache: true,
  });
  console.log(`Second query: ${result2.data.length} in stock`);
  console.log(`  Cached: ${result2.meta?.cached || false}`);
  
  // Update inventory (triggers cache invalidation)
  console.log('\nUpdating inventory...');
  await storage.set('products/inventory', [
    { sku: 'A001', stock: 0 },  // Out of stock!
    { sku: 'B002', stock: 5 },
  ], { mode: 'overwrite' });
  
  // Query again (cache miss - auto-invalidated)
  const result3 = await storage.query('products/inventory', {
    filter: { stock: { $gt: 0 } },
    cache: true,
  });
  console.log(`After update: ${result3.data.length} in stock (cache invalidated!)`);
  console.log(`  Cached: ${result3.meta?.cached || false}`);
}

// ============================================================================
// Example 4: Cache Management (Clear, Stats)
// ============================================================================

async function example4_CacheManagement() {
  console.log('\n=== Example 4: Cache Management ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 3600000,
      autoInvalidate: false,  // Manual cache management
    },
  });
  
  // Store data
  await storage.set('analytics/events', [
    { event: 'page_view', count: 100 },
    { event: 'click', count: 50 },
    { event: 'purchase', count: 5 },
  ]);
  
  // Create multiple cached queries
  await storage.query('analytics/events', {
    filter: { count: { $gt: 10 } },
    cache: true,
  });
  
  await storage.query('analytics/events', {
    filter: { count: { $gte: 50 } },
    cache: true,
  });
  
  await storage.query('analytics/events', {
    sort: { count: -1 },
    cache: true,
  });
  
  // Check stats
  const stats1 = await storage.getCacheStats('analytics');
  console.log('Cache Stats:');
  console.log(`  Entries: ${stats1.entries}`);
  console.log(`  Size: ${stats1.size}`);
  
  // Clear specific query
  console.log('\nClearing one specific query cache...');
  await storage.clearQueryCache('analytics/events', {
    filter: { count: { $gt: 10 } },
  });
  
  const stats2 = await storage.getCacheStats('analytics');
  console.log(`  Entries after clearing: ${stats2.entries}`);
  
  // Clear all caches for collection
  console.log('\nClearing all collection caches...');
  const cleared = await storage.clearCollectionCache('analytics/events');
  console.log(`  Cleared ${cleared} caches`);
  
  const stats3 = await storage.getCacheStats('analytics');
  console.log(`  Entries after: ${stats3.entries}`);
}

// ============================================================================
// Example 5: External Cron Trigger Pattern
// ============================================================================

async function example5_ExternalCronTrigger() {
  console.log('\n=== Example 5: External Cron Trigger (Warm Cache) ===\n');
  
  // This pattern is for scheduled jobs (cron) that pre-compute/warm caches
  // In production, this would be triggered by:
  // - Deno Cron
  // - GitHub Actions scheduled workflow
  // - Cloudflare Workers Cron Triggers
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
    caching: {
      enableQueryCache: true,
      defaultTTL: 3600000, // 1 hour
    },
  });
  
  // Seed data
  await storage.set('dashboard/metrics', [
    { metric: 'users', value: 1000, category: 'engagement' },
    { metric: 'revenue', value: 50000, category: 'business' },
    { metric: 'requests', value: 100000, category: 'performance' },
  ]);
  
  console.log('🕐 Cron job started: Warming caches...\n');
  
  // Pre-compute common queries
  const commonQueries = [
    { name: 'All Engagement Metrics', options: { filter: { category: 'engagement' }, cache: true } },
    { name: 'Business Metrics', options: { filter: { category: 'business' }, cache: true } },
    { name: 'Top Metrics', options: { sort: { value: -1 } as Record<string, 1 | -1>, limit: 5, cache: true } },
  ];
  
  for (const query of commonQueries) {
    console.time(`  Warming: ${query.name}`);
    await storage.query('dashboard/metrics', query.options);
    console.timeEnd(`  Warming: ${query.name}`);
  }
  
  console.log('\n✅ Cache warming complete!\n');
  
  // Show stats
  const stats = await storage.getCacheStats('dashboard');
  console.log('Cache Stats:');
  console.log(`  Entries: ${stats.entries}`);
  console.log(`  Size: ${stats.size}`);
  
  // User request (instant response from cache!)
  console.log('\n👤 User request...');
  console.time('User query (from cache)');
  const result = await storage.query('dashboard/metrics', {
    filter: { category: 'engagement' },
    cache: true,
  });
  console.timeEnd('User query (from cache)');
  console.log(`  Cached: ${result.meta?.cached || false} ⚡`);
}

// ============================================================================
// Example 6: Production-Grade with Upstash (Persistent Cache)
// ============================================================================

async function example6_ProductionWithUpstash() {
  console.log('\n=== Example 6: Production with Upstash ===\n');
  
  // Check for Upstash credentials - using centralized config
  const upstashUrl = getEnv('UPSTASH_REDIS_REST_URL');
  const upstashToken = getEnv('UPSTASH_REDIS_REST_TOKEN');
  
  if (!upstashUrl || !upstashToken) {
    console.log('⚠️  Upstash credentials not found. Skipping this example.');
    console.log('   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to run.');
    return;
  }
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: upstashUrl,
        token: upstashToken,
      }),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'upstash',  // Metadata in Upstash
    caching: {
      enableQueryCache: true,
      defaultTTL: 900000, // 15 minutes
      cacheAdapter: 'upstash',  // Cache in Upstash (persistent!)
      autoInvalidate: true,
    },
  });
  
  // Store data
  await storage.set('production/orders', [
    { id: 1, status: 'pending', amount: 100 },
    { id: 2, status: 'completed', amount: 250 },
    { id: 3, status: 'pending', amount: 75 },
  ]);
  
  // Query (cache persists across restarts!)
  const result = await storage.query('production/orders', {
    filter: { status: 'pending' },
    cache: true,
  });
  
  console.log(`Found ${result.data.length} pending orders`);
  console.log(`Cached: ${result.meta?.cached || false}`);
  
  // Cache stats (from Upstash)
  const stats = await storage.getCacheStats('production');
  console.log('\nCache Stats (Upstash):');
  console.log(`  Entries: ${stats.entries}`);
  console.log(`  Hits: ${stats.hits}`);
  console.log(`  Misses: ${stats.misses}`);
  console.log(`  Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%`);
}

// ============================================================================
// Run All Examples
// ============================================================================

async function runAllExamples() {
  await example1_BasicCaching();
  await example2_CustomTTL();
  await example3_AutoInvalidation();
  await example4_CacheManagement();
  await example5_ExternalCronTrigger();
  await example6_ProductionWithUpstash();
  
  console.log('\n🎉 All query caching examples completed!\n');
}

// Run if executed directly
if (import.meta.main) {
  await runAllExamples();
}

