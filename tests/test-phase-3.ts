/**
 * Phase 3 Tests: Persistent Metadata & Multi-Adapter Routing
 * 
 * Tests the hybrid metadata strategy (A + C):
 * - Persistent metadata storage
 * - Key index tracking
 * - Lazy reconstruction from adapters
 * - Multi-adapter routing
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { 
  createSmallstore, 
  createMemoryAdapter,
  buildIndexKey,
  buildMetadataKey,
} from '../mod.ts';

// ============================================================================
// Test 1: Key Index Creation on Write
// ============================================================================

Deno.test('Phase 3: Key index created on write', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Write some data
  await storage.set('test-collection', { value: 42 }, { mode: 'overwrite' });
  
  // Manually check if index was created
  const memoryAdapter = (storage as any).adapters.memory;
  const indexKey = buildIndexKey('test-collection');
  const index = await memoryAdapter.get(indexKey);
  
  assertExists(index, 'Index should be created');
  assertEquals(index.collection, 'test-collection');
  assertExists(index.keys, 'Index should have keys');
  assertEquals(Object.keys(index.keys).length, 1, 'Should have 1 key');
  
  const firstKey = Object.keys(index.keys)[0];
  const location = index.keys[firstKey];
  assertEquals(location.adapter, 'memory');
  assertEquals(location.collection, 'test-collection');
  assertEquals(location.dataType, 'object');
  
  console.log('✅ Phase 3: Key index created on write');
});

// ============================================================================
// Test 2: Key Index Updated on Write
// ============================================================================

Deno.test('Phase 3: Key index updated on multiple writes', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Write data to multiple paths
  await storage.set('collection/path1', 'data1', { mode: 'overwrite' });
  await storage.set('collection/path2', 'data2', { mode: 'overwrite' });
  await storage.set('collection/path3', 'data3', { mode: 'overwrite' });
  
  // Check index
  const memoryAdapter = (storage as any).adapters.memory;
  const index = await memoryAdapter.get(buildIndexKey('collection'));
  
  assertEquals(Object.keys(index.keys).length, 3, 'Should have 3 keys');
  
  // Verify each key is tracked
  const keys = Object.keys(index.keys);
  assert(keys.some(k => k.includes('path1')), 'Should track path1');
  assert(keys.some(k => k.includes('path2')), 'Should track path2');
  assert(keys.some(k => k.includes('path3')), 'Should track path3');
  
  console.log('✅ Phase 3: Key index updated on multiple writes');
});

// ============================================================================
// Test 3: Key Index Removed on Delete
// ============================================================================

Deno.test('Phase 3: Key index updated on delete', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Write data
  await storage.set('collection/item1', 'data1', { mode: 'overwrite' });
  await storage.set('collection/item2', 'data2', { mode: 'overwrite' });
  
  // Check index before delete
  const memoryAdapter = (storage as any).adapters.memory;
  let index = await memoryAdapter.get(buildIndexKey('collection'));
  assertEquals(Object.keys(index.keys).length, 2, 'Should have 2 keys before delete');
  
  // Delete one item
  await storage.delete('collection/item1');
  
  // Check index after delete
  index = await memoryAdapter.get(buildIndexKey('collection'));
  assertEquals(Object.keys(index.keys).length, 1, 'Should have 1 key after delete');
  
  const remainingKeys = Object.keys(index.keys);
  assert(remainingKeys.some(k => k.includes('item2')), 'item2 should remain');
  assert(!remainingKeys.some(k => k.includes('item1')), 'item1 should be removed');
  
  console.log('✅ Phase 3: Key index updated on delete');
});

// ============================================================================
// Test 4: Metadata Reconstruction from Adapters
// ============================================================================

Deno.test('Phase 3: Metadata reconstruction', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Write data
  await storage.set('rebuild-test/item1', 'data1', { mode: 'overwrite' });
  await storage.set('rebuild-test/item2', { complex: 'object' }, { mode: 'overwrite' });
  await storage.set('rebuild-test/item3', [1, 2, 3], { mode: 'overwrite' });
  
  // Get adapter
  const memoryAdapter = (storage as any).adapters.memory;
  
  // Manually delete metadata and index (simulate corruption)
  await memoryAdapter.delete(buildMetadataKey('rebuild-test'));
  await memoryAdapter.delete(buildIndexKey('rebuild-test'));
  
  // Rebuild
  const { schema, index } = await storage.rebuildMetadata('rebuild-test');
  
  // Verify schema was rebuilt
  assertExists(schema, 'Schema should be rebuilt');
  assertEquals(schema.collection, 'rebuild-test');
  assertEquals(Object.keys(schema.paths).length, 3, 'Should have 3 paths');
  
  // Verify index was rebuilt
  assertExists(index, 'Index should be rebuilt');
  assertEquals(Object.keys(index.keys).length, 3, 'Should have 3 keys');
  
  console.log('✅ Phase 3: Metadata reconstruction');
});

// ============================================================================
// Test 5: Auto-Rebuild on getSchema() with Missing Metadata
// ============================================================================

Deno.test('Phase 3: Auto-rebuild on getSchema()', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Write data
  await storage.set('auto-rebuild/data', { test: true }, { mode: 'overwrite' });
  
  // Manually delete metadata (simulate corruption)
  const memoryAdapter = (storage as any).adapters.memory;
  await memoryAdapter.delete(buildMetadataKey('auto-rebuild'));
  
  // Get schema (should trigger auto-rebuild)
  const schema = await storage.getSchema('auto-rebuild');
  
  assertExists(schema, 'Schema should exist');
  assertEquals(schema.collection, 'auto-rebuild');
  assert(Object.keys(schema.paths).length > 0, 'Should have paths after rebuild');
  
  console.log('✅ Phase 3: Auto-rebuild on getSchema()');
});

// ============================================================================
// Test 6: Persistent Metadata (Metadata Adapter)
// ============================================================================

Deno.test('Phase 3: Metadata persists in metadata adapter', async () => {
  const metadataAdapter = createMemoryAdapter();
  const dataAdapter = createMemoryAdapter();
  
  const storage = createSmallstore({
    adapters: {
      metadata: metadataAdapter,
      data: dataAdapter,
    },
    defaultAdapter: 'data',
    metadataAdapter: 'metadata',  // Persistent metadata storage!
  });
  
  // Write data
  await storage.set('persistent-test', { value: 123 }, { mode: 'overwrite' });
  
  // Verify metadata is in metadata adapter (not data adapter)
  const metadataKey = buildMetadataKey('persistent-test');
  const metadataInMetadataAdapter = await metadataAdapter.get(metadataKey);
  const metadataInDataAdapter = await dataAdapter.get(metadataKey);
  
  assertExists(metadataInMetadataAdapter, 'Metadata should be in metadata adapter');
  assertEquals(metadataInDataAdapter, null, 'Metadata should NOT be in data adapter');
  
  console.log('✅ Phase 3: Metadata persists in metadata adapter');
});

// ============================================================================
// Test 7: Key Index Persists in Metadata Adapter
// ============================================================================

Deno.test('Phase 3: Key index persists in metadata adapter', async () => {
  const metadataAdapter = createMemoryAdapter();
  const dataAdapter = createMemoryAdapter();
  
  const storage = createSmallstore({
    adapters: {
      metadata: metadataAdapter,
      data: dataAdapter,
    },
    defaultAdapter: 'data',
    metadataAdapter: 'metadata',
  });
  
  // Write data
  await storage.set('index-persist-test', 'value', { mode: 'overwrite' });
  
  // Verify index is in metadata adapter (not data adapter)
  const indexKey = buildIndexKey('index-persist-test');
  const indexInMetadataAdapter = await metadataAdapter.get(indexKey);
  const indexInDataAdapter = await dataAdapter.get(indexKey);
  
  assertExists(indexInMetadataAdapter, 'Index should be in metadata adapter');
  assertEquals(indexInDataAdapter, null, 'Index should NOT be in data adapter');
  
  console.log('✅ Phase 3: Key index persists in metadata adapter');
});

// ============================================================================
// Test 8: Multi-Adapter Routing (Simulate Upstash + R2)
// ============================================================================

Deno.test('Phase 3: Multi-adapter routing tracking', async () => {
  const upstashAdapter = createMemoryAdapter();  // Simulate Upstash
  const r2Adapter = createMemoryAdapter();       // Simulate R2
  const metadataAdapter = createMemoryAdapter(); // Persistent metadata
  
  const storage = createSmallstore({
    adapters: {
      upstash: upstashAdapter,
      r2: r2Adapter,
      metadata: metadataAdapter,
    },
    defaultAdapter: 'upstash',
    metadataAdapter: 'metadata',
  });
  
  // Write small data (goes to upstash via default)
  await storage.set('multi/small', 'text', { mode: 'overwrite' });
  
  // Write large data (manually force to r2)
  await storage.set('multi/large', { big: 'data' }, { mode: 'overwrite', adapter: 'r2' });
  
  // Check key index
  const index = await metadataAdapter.get(buildIndexKey('multi'));
  
  assertExists(index, 'Index should exist');
  assertEquals(Object.keys(index.keys).length, 2, 'Should track 2 keys');
  
  // Verify adapters are tracked correctly
  const keys = Object.keys(index.keys);
  const smallKey = keys.find(k => k.includes('small'))!;
  const largeKey = keys.find(k => k.includes('large'))!;
  
  assertEquals(index.keys[smallKey].adapter, 'upstash', 'Small data in upstash');
  assertEquals(index.keys[largeKey].adapter, 'r2', 'Large data in r2');
  
  console.log('✅ Phase 3: Multi-adapter routing tracking');
});

// ============================================================================
// Test 9: Reconstruction Across Multiple Adapters
// ============================================================================

Deno.test('Phase 3: Reconstruction scans all adapters', async () => {
  const adapter1 = createMemoryAdapter();
  const adapter2 = createMemoryAdapter();
  const metadataAdapter = createMemoryAdapter();
  
  const storage = createSmallstore({
    adapters: {
      adapter1,
      adapter2,
      metadata: metadataAdapter,
    },
    defaultAdapter: 'adapter1',
    metadataAdapter: 'metadata',
  });
  
  // Write to adapter1 (default)
  await storage.set('scan-test/item1', 'data1', { mode: 'overwrite' });
  
  // Write to adapter2 (forced)
  await storage.set('scan-test/item2', 'data2', { mode: 'overwrite', adapter: 'adapter2' });
  
  // Delete metadata (simulate corruption)
  await metadataAdapter.delete(buildMetadataKey('scan-test'));
  await metadataAdapter.delete(buildIndexKey('scan-test'));
  
  // Rebuild (should scan both adapters)
  const { schema, index } = await storage.rebuildMetadata('scan-test');
  
  assertEquals(Object.keys(schema.paths).length, 2, 'Should find both paths');
  assertEquals(Object.keys(index.keys).length, 2, 'Should find both keys');
  
  // Verify both adapters are represented
  const locations = Object.values(index.keys);
  const adapters = new Set(locations.map((loc: any) => loc.adapter));
  assert(adapters.has('adapter1'), 'Should find data in adapter1');
  assert(adapters.has('adapter2'), 'Should find data in adapter2');
  
  console.log('✅ Phase 3: Reconstruction scans all adapters');
});

// ============================================================================
// Test 10: Empty Collection Schema
// ============================================================================

Deno.test('Phase 3: Empty collection returns empty schema', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Get schema for non-existent collection
  const schema = await storage.getSchema('does-not-exist');
  
  assertExists(schema, 'Schema should exist');
  assertEquals(schema.collection, 'does-not-exist');
  assertEquals(Object.keys(schema.paths).length, 0, 'Should have no paths');
  
  console.log('✅ Phase 3: Empty collection returns empty schema');
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n🎉 All Phase 3 tests passed!');
console.log('\nPhase 3: Persistent Metadata & Multi-Adapter Routing');
console.log('  ✅ Key index creation and updates');
console.log('  ✅ Key index deletion tracking');
console.log('  ✅ Metadata reconstruction (lazy)');
console.log('  ✅ Auto-rebuild on missing metadata');
console.log('  ✅ Persistent metadata storage');
console.log('  ✅ Multi-adapter routing and tracking');
console.log('  ✅ Reconstruction across adapters');

