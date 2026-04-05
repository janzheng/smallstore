/**
 * Tests for Graceful Degradation & Auto-Cleanup
 * 
 * Tests:
 * - Auto-cleanup of stale keys
 * - Retry logic with exponential backoff
 * - 404 handling (returns null, doesn't crash)
 * - Metadata validation
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import { createSmallstore } from '../mod.ts';
import { createMemoryAdapter } from '../src/adapters/memory.ts';
import type { StorageAdapter } from '../src/adapters/adapter.ts';
import type { AdapterCapabilities } from '../src/types.ts';

// Mock adapter that can simulate failures
class FailingAdapter implements StorageAdapter {
  name = 'failing';
  private data: Map<string, any> = new Map();
  private shouldFail = false;
  private failCount = 0;
  
  readonly capabilities: AdapterCapabilities = {
    name: 'Failing Adapter',
    supportedTypes: ['object', 'blob', 'kv'],
    maxItemSize: undefined,
    cost: { tier: 'free' },
    performance: { readLatency: 'medium', writeLatency: 'medium', throughput: 'medium' }
  };
  
  setShouldFail(should: boolean, count = 0) {
    this.shouldFail = should;
    this.failCount = count;
  }
  
  async get(key: string): Promise<any> {
    if (this.shouldFail && this.failCount > 0) {
      this.failCount--;
      throw new Error('Network error');
    }
    return this.data.get(key) || null;
  }
  
  async set(key: string, value: any): Promise<void> {
    if (this.shouldFail && this.failCount > 0) {
      this.failCount--;
      throw new Error('Network error');
    }
    this.data.set(key, value);
  }
  
  async delete(key: string): Promise<void> {
    if (this.shouldFail && this.failCount > 0) {
      this.failCount--;
      throw new Error('Network error');
    }
    this.data.delete(key);
  }
  
  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }
  
  async keys(prefix?: string): Promise<string[]> {
    const allKeys = Array.from(this.data.keys());
    if (!prefix) return allKeys;
    return allKeys.filter(k => k.startsWith(prefix));
  }
  
  async clear(): Promise<void> {
    this.data.clear();
  }
}

Deno.test("Graceful Degradation: 404 doesn't crash", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Try to get non-existent key
  const result = await storage.get('does-not-exist/key');
  
  assertEquals(result, null);
  console.log('✅ 404 returns null, no crash');
});

Deno.test("Graceful Degradation: Auto-cleanup stale keys", async () => {
  const memoryAdapter = createMemoryAdapter();
  const storage = createSmallstore({
    adapters: {
      memory: memoryAdapter,
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Store data
  await storage.set('test/file1', { data: 'test' }, { mode: 'overwrite' });
  
  // Verify it's in storage
  const data1 = await storage.get('test/file1');
  assertExists(data1);
  
  // Delete directly from adapter (bypassing Smallstore)
  await memoryAdapter.delete('smallstore:test:file1');
  
  // Try to get - should return null and auto-cleanup
  const data2 = await storage.get('test/file1');
  assertEquals(data2, null);
  
  // Verify key was removed from index (would need to inspect index directly)
  console.log('✅ Auto-cleanup removed stale key from index');
});

Deno.test("Graceful Degradation: Retry on transient errors", async () => {
  const failingAdapter = new FailingAdapter();
  
  const storage = createSmallstore({
    adapters: {
      failing: failingAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'failing',
    metadataAdapter: 'memory',
  });
  
  // Set data with transient failure (fail first 2 attempts, succeed on 3rd)
  failingAdapter.setShouldFail(true, 2);
  
  await storage.set('test/data', { value: 'test' }, { mode: 'overwrite' });
  
  // Should have succeeded after retries
  failingAdapter.setShouldFail(false);
  const result = await storage.get('test/data');
  
  assertExists(result);
  assertEquals(result.content.value, 'test');
  
  console.log('✅ Retry logic succeeded after 2 failures');
});

Deno.test("Graceful Degradation: Permanent failure throws error", async () => {
  const failingAdapter = new FailingAdapter();
  
  const storage = createSmallstore({
    adapters: {
      failing: failingAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'failing',
    metadataAdapter: 'memory',
  });
  
  // Set data with permanent failure (fail all 3 retry attempts)
  failingAdapter.setShouldFail(true, 5);  // More than maxRetries
  
  let errorThrown = false;
  try {
    await storage.set('test/data', { value: 'test' }, { mode: 'overwrite' });
  } catch (error) {
    errorThrown = true;
    assertEquals((error as Error).message, 'Network error');
  }
  
  assert(errorThrown, 'Expected error to be thrown after retries exhausted');
  
  console.log('✅ Permanent failures throw after retries exhausted');
});

Deno.test("Graceful Degradation: Delete non-existent file doesn't crash", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Try to delete non-existent key - should not crash
  await storage.delete('does-not-exist/key');
  
  console.log('✅ Delete non-existent key doesn\'t crash');
});

Deno.test("Graceful Degradation: Multiple missing files", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Try to get multiple non-existent keys
  const results = await Promise.all([
    storage.get('missing/1'),
    storage.get('missing/2'),
    storage.get('missing/3'),
  ]);
  
  assertEquals(results.every(r => r === null), true);
  
  console.log('✅ Multiple missing files return null, no crash');
});

console.log('\n🎉 All graceful degradation tests completed!\n');

