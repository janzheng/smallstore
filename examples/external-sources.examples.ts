/**
 * External Data Sources Examples
 * 
 * Virtual collections pointing to remote data (JSON, CSV) without local storage.
 * 
 * Phase 3.6g-c
 */

import { createSmallstore, createMemoryAdapter, createUpstashAdapter } from '../mod.ts';
import { getEnv } from '../src/utils/env.ts';

// ============================================================================
// Example 1: Register Public JSON API
// ============================================================================

async function registerGithubStars() {
  console.log('\n=== Example 1: Register GitHub Stars API ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: getEnv('UPSTASH_REDIS_REST_URL')!,
        token: getEnv('UPSTASH_REDIS_REST_TOKEN')!,
      })
    },
    metadataAdapter: 'upstash',
    defaultAdapter: 'memory',
  });
  
  // Register GitHub API as virtual collection
  await storage.registerExternal('external/github-stars', {
    url: 'https://api.github.com/users/github/starred',
    type: 'json',
    cacheTTL: 3600000, // 1 hour
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Smallstore-Test'
    }
  });
  
  console.log('✓ Registered external source: external/github-stars');
  
  // Query it like any collection!
  console.log('\nFetching stars...');
  const stars = await storage.get('external/github-stars');
  console.log(`✓ Fetched ${stars.length} starred repositories`);
  console.log(`  First star: ${stars[0].name} (${stars[0].stargazers_count} stars)`);
  
  // Second fetch should use cache
  console.log('\nFetching again (should use cache)...');
  const cachedStars = await storage.get('external/github-stars');
  console.log(`✓ Fetched from cache: ${cachedStars.length} items`);
  
  // Cleanup
  await storage.unregisterExternal('external/github-stars');
  await storage.clear('external/github-stars');
}

// ============================================================================
// Example 2: Register CSV Data
// ============================================================================

async function registerCsvData() {
  console.log('\n=== Example 2: Register CSV Data ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: getEnv('UPSTASH_REDIS_REST_URL')!,
        token: getEnv('UPSTASH_REDIS_REST_TOKEN')!,
      })
    },
    metadataAdapter: 'upstash',
    defaultAdapter: 'memory',
  });
  
  // Register public CSV dataset
  await storage.registerExternal('external/sample-csv', {
    url: 'https://people.sc.fsu.edu/~jburkardt/data/csv/addresses.csv',
    type: 'csv',
    cacheTTL: 300000, // 5 minutes
  });
  
  console.log('✓ Registered external CSV source');
  
  // Fetch and parse CSV
  const data = await storage.get('external/sample-csv');
  console.log(`✓ Fetched and parsed CSV: ${data.length} rows`);
  console.log(`  First row:`, data[0]);
  
  // Cleanup
  await storage.unregisterExternal('external/sample-csv');
  await storage.clear('external/sample-csv');
}

// ============================================================================
// Example 3: Authenticated API
// ============================================================================

async function registerAuthenticatedApi() {
  console.log('\n=== Example 3: Authenticated API ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: getEnv('UPSTASH_REDIS_REST_URL')!,
        token: getEnv('UPSTASH_REDIS_REST_TOKEN')!,
      })
    },
    metadataAdapter: 'upstash',
    defaultAdapter: 'memory',
  });
  
  // Register API with Bearer token
  await storage.registerExternal('external/private-data', {
    url: 'https://api.example.com/data',
    type: 'json',
    cacheTTL: 600000, // 10 minutes
    auth: {
      type: 'bearer',
      token: 'your-api-token-here'
    }
  });
  
  console.log('✓ Registered external source with authentication');
  
  // For demo purposes, let's not actually fetch (API doesn't exist)
  console.log('  (Skipping actual fetch for demo)');
  
  // Cleanup
  await storage.unregisterExternal('external/private-data', false);
}

// ============================================================================
// Example 4: List and Manage External Sources
// ============================================================================

async function manageExternalSources() {
  console.log('\n=== Example 4: Manage External Sources ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: getEnv('UPSTASH_REDIS_REST_URL')!,
        token: getEnv('UPSTASH_REDIS_REST_TOKEN')!,
      })
    },
    metadataAdapter: 'upstash',
    defaultAdapter: 'memory',
  });
  
  // Register multiple sources
  await storage.registerExternal('external/source-1', {
    url: 'https://api.example.com/data1.json',
    type: 'json',
    cacheTTL: 300000,
  });
  
  await storage.registerExternal('external/source-2', {
    url: 'https://api.example.com/data2.csv',
    type: 'csv',
    cacheTTL: 600000,
  });
  
  console.log('✓ Registered 2 external sources');
  
  // List all external sources
  const sources = await storage.listExternalSources();
  console.log(`\nExternal sources (${sources.length}):`);
  for (const source of sources) {
    console.log(`  - ${source}`);
  }
  
  // Get configuration for one source
  const config = await storage.getExternalSource('external/source-1');
  console.log(`\nConfiguration for source-1:`);
  console.log(`  URL: ${config?.url}`);
  console.log(`  Type: ${config?.type}`);
  console.log(`  Cache TTL: ${config?.cacheTTL}ms`);
  
  // Update configuration
  await storage.updateExternalSource('external/source-1', {
    cacheTTL: 900000, // 15 minutes
  });
  console.log('\n✓ Updated cache TTL for source-1');
  
  // Cleanup
  await storage.unregisterExternal('external/source-1');
  await storage.unregisterExternal('external/source-2');
}

// ============================================================================
// Example 5: Force Refresh External Data
// ============================================================================

async function forceRefresh() {
  console.log('\n=== Example 5: Force Refresh External Data ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: getEnv('UPSTASH_REDIS_REST_URL')!,
        token: getEnv('UPSTASH_REDIS_REST_TOKEN')!,
      })
    },
    metadataAdapter: 'upstash',
    defaultAdapter: 'memory',
  });
  
  // Register source with long cache
  await storage.registerExternal('external/long-cache', {
    url: 'https://api.github.com/users/github/starred',
    type: 'json',
    cacheTTL: 86400000, // 24 hours
    headers: {
      'User-Agent': 'Smallstore-Test'
    }
  });
  
  console.log('✓ Registered source with 24h cache');
  
  // First fetch
  console.log('\nFetching data...');
  const data1 = await storage.get('external/long-cache');
  console.log(`✓ Fetched ${data1.length} items`);
  
  // Second fetch uses cache
  console.log('\nFetching again (uses cache)...');
  const data2 = await storage.get('external/long-cache');
  console.log(`✓ Fetched ${data2.length} items from cache`);
  
  // Force refresh ignores cache
  console.log('\nForce refreshing...');
  const data3 = await storage.refreshExternal('external/long-cache');
  console.log(`✓ Force fetched ${data3.length} items (bypassed cache)`);
  
  // Cleanup
  await storage.unregisterExternal('external/long-cache');
  await storage.clear('external/long-cache');
}

// ============================================================================
// Example 6: No-Cache Mode (Always Fresh)
// ============================================================================

async function noCacheMode() {
  console.log('\n=== Example 6: No-Cache Mode ===\n');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      upstash: createUpstashAdapter({
        url: getEnv('UPSTASH_REDIS_REST_URL')!,
        token: getEnv('UPSTASH_REDIS_REST_TOKEN')!,
      })
    },
    metadataAdapter: 'upstash',
    defaultAdapter: 'memory',
  });
  
  // Register source with cacheTTL: 0 (no cache)
  await storage.registerExternal('external/no-cache', {
    url: 'https://api.github.com/zen', // Random zen quote
    type: 'json',
    cacheTTL: 0, // Always fetch fresh
    headers: {
      'User-Agent': 'Smallstore-Test'
    }
  });
  
  console.log('✓ Registered source with no cache (always fresh)');
  
  // Each fetch will hit the API
  console.log('\nFetching...');
  const quote1 = await storage.get('external/no-cache');
  console.log(`  Quote: "${quote1}"`);
  
  console.log('\nFetching again (fresh API call)...');
  const quote2 = await storage.get('external/no-cache');
  console.log(`  Quote: "${quote2}"`);
  
  // Cleanup
  await storage.unregisterExternal('external/no-cache', false);
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  try {
    await registerGithubStars();
    await registerCsvData();
    await registerAuthenticatedApi();
    await manageExternalSources();
    await forceRefresh();
    await noCacheMode();
    
    console.log('\n✅ All external source examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

