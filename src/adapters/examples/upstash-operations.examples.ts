/**
 * Examples: Upstash Adapter High-Level Operations
 * 
 * Demonstrates the high-level operations available on the Upstash adapter.
 */

import "jsr:@std/dotenv/load";
import { createUpstashAdapter } from '../upstash.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Setup
// ============================================================================

const upstashAdapter = createUpstashAdapter({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
  namespace: 'examples' // Prefix all keys with 'examples:'
});

// ============================================================================
// Example 1: Upsert with explicit ID field
// ============================================================================

async function example1_upsert() {
  console.log('\n=== Example 1: Upsert with explicit ID field ===\n');
  
  const sessions = [
    { sessionId: 'sess-001', userId: 'alice', createdAt: Date.now() },
    { sessionId: 'sess-002', userId: 'bob', createdAt: Date.now() },
    { sessionId: 'sess-003', userId: 'carol', createdAt: Date.now() },
  ];
  
  const result = await upstashAdapter.upsert(sessions, {
    idField: 'sessionId',
    ttl: 3600 // 1 hour TTL
  });
  
  console.log(`✅ Upserted ${result.count} sessions (with 1hr TTL)`);
  console.log('Keys:', result.keys);
  
  // Verify
  const sess = await upstashAdapter.get('sess-001');
  console.log('Retrieved session:', sess);
}

// ============================================================================
// Example 2: Insert with auto-detection
// ============================================================================

async function example2_autoDetect() {
  console.log('\n=== Example 2: Insert with auto-detection ===\n');
  
  const cacheEntries = [
    { key: 'api-response-1', data: { status: 'success' }, timestamp: Date.now() },
    { key: 'api-response-2', data: { status: 'error' }, timestamp: Date.now() },
  ];
  
  // Will auto-detect 'key' as the ID field
  const result = await upstashAdapter.insert(cacheEntries, {
    autoDetect: true,
    ttl: 300 // 5 minutes
  });
  
  console.log(`✅ Inserted ${result.count} cache entries`);
  console.log(`Auto-detected ID field: ${result.idField}`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 3: Merge arrays with deduplication (Cron job pattern)
// ============================================================================

async function example3_merge() {
  console.log('\n=== Example 3: Merge arrays (Cron job pattern) ===\n');
  
  // Initial data (simulating first cron run)
  await upstashAdapter.set('rss-feed-items', [
    { guid: 'item-111', title: 'Feed Item 1', pubDate: '2024-01-01' },
    { guid: 'item-222', title: 'Feed Item 2', pubDate: '2024-01-02' },
  ]);
  
  // New batch from second cron run (222 is duplicate, 333 is new)
  const newItems = [
    { guid: 'item-222', title: 'Feed Item 2', pubDate: '2024-01-02' }, // Duplicate
    { guid: 'item-333', title: 'Feed Item 3', pubDate: '2024-01-03' }, // New
  ];
  
  const result = await upstashAdapter.merge('rss-feed-items', newItems, {
    strategy: 'id',
    idField: 'guid'
  });
  
  console.log(`✅ Merged RSS feed items`);
  console.log(`Total items: ${result.totalItems}`);
  console.log(`Added: ${result.added}, Skipped: ${result.skipped}`);
  
  // Verify
  const all = await upstashAdapter.get('rss-feed-items');
  console.log(`Final feed has ${all?.length || 0} items`);
}

// ============================================================================
// Example 4: Query with filtering
// ============================================================================

async function example4_query() {
  console.log('\n=== Example 4: Query with filtering ===\n');
  
  // Store some API rate limit data
  await upstashAdapter.set('rate-limit:user-alice', { userId: 'alice', count: 50, limit: 100 });
  await upstashAdapter.set('rate-limit:user-bob', { userId: 'bob', count: 95, limit: 100 });
  await upstashAdapter.set('rate-limit:user-carol', { userId: 'carol', count: 10, limit: 100 });
  
  // Query: Find users near rate limit (>90%)
  const nearLimit = await upstashAdapter.query({
    prefix: 'rate-limit:',
    filter: (item) => (item.count / item.limit) > 0.9
  });
  
  console.log(`✅ Found ${nearLimit.length} users near rate limit:`);
  nearLimit.forEach(u => console.log(`  - ${u.userId}: ${u.count}/${u.limit}`));
}

// ============================================================================
// Example 5: List with pagination
// ============================================================================

async function example5_list() {
  console.log('\n=== Example 5: List with pagination ===\n');
  
  // Get first 2 rate limit entries
  const firstPage = await upstashAdapter.list({
    prefix: 'rate-limit:',
    limit: 2,
    offset: 0
  });
  
  console.log(`✅ First page (${firstPage.length} items):`);
  firstPage.forEach(item => console.log(`  - ${item.userId}: ${item.count}/${item.limit}`));
  
  // Get next page
  const secondPage = await upstashAdapter.list({
    prefix: 'rate-limit:',
    limit: 2,
    offset: 2
  });
  
  console.log(`\n✅ Second page (${secondPage.length} items):`);
  secondPage.forEach(item => console.log(`  - ${item.userId}: ${item.count}/${item.limit}`));
}

// ============================================================================
// Example 6: API Response Caching Pattern
// ============================================================================

async function example6_apiCaching() {
  console.log('\n=== Example 6: API Response Caching Pattern ===\n');
  
  // Simulate caching multiple API responses
  const apiResponses = [
    {
      endpoint: '/users/123',
      data: { id: 123, name: 'Alice' },
      timestamp: Date.now()
    },
    {
      endpoint: '/users/456',
      data: { id: 456, name: 'Bob' },
      timestamp: Date.now()
    }
  ];
  
  // Insert with auto-detected key (endpoint) and 5min TTL
  const result = await upstashAdapter.upsert(apiResponses, {
    keyGenerator: (obj) => `api-cache:${obj.endpoint}`,
    ttl: 300 // 5 minutes
  });
  
  console.log(`✅ Cached ${result.count} API responses (5min TTL)`);
  console.log('Cache keys:', result.keys);
  
  // Retrieve from cache
  const cached = await upstashAdapter.get('api-cache:/users/123');
  console.log('Retrieved from cache:', cached);
}

// ============================================================================
// Example 7: Cleanup
// ============================================================================

async function example7_cleanup() {
  console.log('\n=== Example 7: Cleanup test data ===\n');
  
  // Clear all example data
  await upstashAdapter.clear(); // Clears only 'examples:*' due to namespace
  
  console.log('✅ Cleaned up all example data');
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Upstash Adapter High-Level Operations Examples\n');
  
  try {
    await example1_upsert();
    await example2_autoDetect();
    await example3_merge();
    await example4_query();
    await example5_list();
    await example6_apiCaching();
    await example7_cleanup();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

