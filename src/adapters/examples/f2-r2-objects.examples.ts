/**
 * F2-R2 Adapter - JSON Object Storage Examples
 * 
 * The F2-R2 adapter supports both blobs AND JSON objects!
 * This demonstrates using R2 (via F2) as an object store for structured data.
 * 
 * Phase 3.6g: JSON object support is built-in
 */

import { createF2R2Adapter } from '../f2-r2.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Example 1: Store JSON Objects
// ============================================================================

async function storeJsonObjects() {
  console.log('\n=== Example 1: Store JSON Objects ===\n');
  
  const adapter = createF2R2Adapter({
    f2Url: F2_DEFAULT_URL || 'https://f2.phage.directory',
    defaultScope: 'smallstore-objects',
  });
  
  // Store a user object
  const user = {
    id: 'user-123',
    name: 'Alice Smith',
    email: 'alice@example.com',
    preferences: {
      theme: 'dark',
      notifications: true
    },
    created: new Date().toISOString()
  };
  
  await adapter.set('users/alice.json', user);
  console.log('✓ Stored user object to R2');
  
  // Retrieve it
  const retrieved = await adapter.get('users/alice.json');
  console.log('✓ Retrieved user object:', retrieved);
  console.log(`  Name: ${retrieved.name}`);
  console.log(`  Email: ${retrieved.email}`);
  
  // Cleanup
  await adapter.delete('users/alice.json');
}

// ============================================================================
// Example 2: Store Large Datasets
// ============================================================================

async function storeLargeDataset() {
  console.log('\n=== Example 2: Store Large Dataset ===\n');
  
  const adapter = createF2R2Adapter({
    defaultScope: 'datasets',
  });
  
  // Generate a large dataset (1000 items)
  const dataset = Array.from({ length: 1000 }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${i}`,
    value: Math.random() * 100,
    timestamp: Date.now(),
    tags: ['tag1', 'tag2', 'tag3'],
  }));
  
  console.log(`Generated dataset with ${dataset.length} items`);
  
  // Store to R2
  await adapter.set('analytics/daily-metrics-2024-11-20.json', dataset);
  console.log('✓ Stored large dataset to R2');
  
  // Retrieve and verify
  const retrieved = await adapter.get('analytics/daily-metrics-2024-11-20.json');
  console.log(`✓ Retrieved dataset with ${retrieved.length} items`);
  console.log(`  First item:`, retrieved[0]);
  console.log(`  Last item:`, retrieved[retrieved.length - 1]);
  
  // Cleanup
  await adapter.delete('analytics/daily-metrics-2024-11-20.json');
}

// ============================================================================
// Example 3: Configuration Storage
// ============================================================================

async function storeConfiguration() {
  console.log('\n=== Example 3: Store Configuration ===\n');
  
  const adapter = createF2R2Adapter({
    defaultScope: 'config',
  });
  
  // Application configuration
  const config = {
    app: {
      name: 'My App',
      version: '2.1.0',
      environment: 'production',
    },
    api: {
      baseUrl: 'https://api.example.com',
      timeout: 30000,
      retries: 3,
    },
    features: {
      auth: true,
      search: true,
      analytics: false,
    },
    lastUpdated: new Date().toISOString(),
  };
  
  await adapter.set('production/app-config.json', config);
  console.log('✓ Stored configuration to R2');
  
  // Retrieve config
  const retrievedConfig = await adapter.get('production/app-config.json');
  console.log('✓ Retrieved configuration');
  console.log(`  App: ${retrievedConfig.app.name} v${retrievedConfig.app.version}`);
  console.log(`  API Base: ${retrievedConfig.api.baseUrl}`);
  console.log(`  Features:`, retrievedConfig.features);
  
  // Cleanup
  await adapter.delete('production/app-config.json');
}

// ============================================================================
// Example 4: Cache Storage (Alternative to Upstash)
// ============================================================================

async function useAsCache() {
  console.log('\n=== Example 4: Use R2 as Object Cache ===\n');
  
  const adapter = createF2R2Adapter({
    defaultScope: 'cache',
  });
  
  // Simulate expensive API call result
  const apiResult = {
    query: 'machine learning papers',
    results: [
      { title: 'Paper 1', score: 0.95 },
      { title: 'Paper 2', score: 0.89 },
      { title: 'Paper 3', score: 0.82 },
    ],
    metadata: {
      totalResults: 1234,
      executionTime: 250,
      cached: true,
    },
    timestamp: Date.now(),
  };
  
  // Cache the result
  const cacheKey = 'search-results/machine-learning-papers.json';
  await adapter.set(cacheKey, apiResult);
  console.log('✓ Cached API result to R2');
  
  // Retrieve from cache
  const cached = await adapter.get(cacheKey);
  console.log('✓ Retrieved from cache');
  console.log(`  Query: ${cached.query}`);
  console.log(`  Results: ${cached.results.length} items`);
  console.log(`  Top result: ${cached.results[0].title} (${cached.results[0].score})`);
  
  // Check if key exists
  const exists = await adapter.has(cacheKey);
  console.log(`✓ Cache key exists: ${exists}`);
  
  // Cleanup
  await adapter.delete(cacheKey);
}

// ============================================================================
// Example 5: Mixed Content Storage
// ============================================================================

async function mixedContentStorage() {
  console.log('\n=== Example 5: Store Both Objects and Blobs ===\n');
  
  const adapter = createF2R2Adapter({
    defaultScope: 'mixed',
  });
  
  // Store JSON object
  const metadata = {
    id: 'doc-123',
    title: 'Important Document',
    author: 'Alice',
    created: new Date().toISOString(),
  };
  await adapter.set('documents/doc-123-metadata.json', metadata);
  console.log('✓ Stored JSON metadata');
  
  // Store binary blob (simulated PDF)
  const pdfData = new TextEncoder().encode('This would be PDF content...');
  await adapter.set('documents/doc-123.pdf', pdfData);
  console.log('✓ Stored binary PDF');
  
  // Retrieve both
  const retrievedMeta = await adapter.get('documents/doc-123-metadata.json');
  const retrievedPdf = await adapter.get('documents/doc-123.pdf');
  
  console.log('✓ Retrieved metadata:', retrievedMeta);
  console.log(`✓ Retrieved PDF (${retrievedPdf.length} bytes)`);
  
  // Cleanup
  await adapter.delete('documents/doc-123-metadata.json');
  await adapter.delete('documents/doc-123.pdf');
}

// ============================================================================
// Example 6: Use with Smallstore
// ============================================================================

async function useWithSmallstore() {
  console.log('\n=== Example 6: F2-R2 with Smallstore ===\n');
  
  const { createSmallstore, createMemoryAdapter } = await import('../../mod.ts');
  const { createF2R2Adapter } = await import('../f2-r2.ts');
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      r2: createF2R2Adapter({ defaultScope: 'smallstore' }),
    },
    metadataAdapter: 'memory',
    defaultAdapter: 'memory',
    // Route large objects to R2
    typeRouting: {
      blob: 'r2',
      // Keep objects in memory by default, but could route to R2:
      // object: 'r2',
    },
  });
  
  // Store JSON object (will go to memory by default)
  await storage.set('users/bob', {
    id: 'user-456',
    name: 'Bob',
    email: 'bob@example.com',
  });
  console.log('✓ Stored user object (memory)');
  
  // Store large binary (will go to R2)
  const imageData = new Uint8Array(1024 * 100); // 100KB
  await storage.set('images/photo.jpg', imageData);
  console.log('✓ Stored image blob (R2 via F2)');
  
  // You can explicitly route to R2 for objects too:
  await storage.set('datasets/large-data', {
    items: Array.from({ length: 10000 }, (_, i) => ({ id: i, value: Math.random() })),
  }, { adapter: 'r2' });
  console.log('✓ Stored large dataset to R2');
  
  // Cleanup
  await storage.clear('users/bob');
  await storage.clear('images/photo.jpg');
  await storage.clear('datasets/large-data');
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  try {
    await storeJsonObjects();
    await storeLargeDataset();
    await storeConfiguration();
    await useAsCache();
    await mixedContentStorage();
    await useWithSmallstore();
    
    console.log('\n✅ All F2-R2 object storage examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

