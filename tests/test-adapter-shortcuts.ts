/**
 * Test: Adapter Shortcuts (Collection Metadata Routing)
 * 
 * Verifies that collections can specify their adapter via metadata,
 * enabling "just paste your Notion/Airtable ID" patterns.
 */

import { assertEquals, assertExists } from "@std/assert";
import { createSmallstore } from "../mod.ts";
import { createMemoryAdapter } from "../adapters/memory.ts";
import type { Smallstore, AdapterCapabilities } from "../types.ts";
import type { StorageAdapter } from "../adapters/adapter.ts";

// Mock adapter that tracks calls
class MockAdapter implements StorageAdapter {
  name = "mock";
  calls: string[] = [];
  
  readonly capabilities: AdapterCapabilities = {
    name: "Mock Adapter",
    supportedTypes: ["object", "kv", "blob"],
    maxItemSize: undefined,
    cost: { tier: "free" },
    performance: { readLatency: "low", writeLatency: "low", throughput: "high" }
  };
  
  async get(key: string) {
    this.calls.push(`get:${key}`);
    return null;
  }
  
  async set(key: string, data: any) {
    this.calls.push(`set:${key}`);
  }
  
  async delete(key: string) {
    this.calls.push(`delete:${key}`);
  }
  
  async has(key: string) {
    return false;
  }
  
  async keys(prefix?: string) {
    return [];
  }
  
  async clear() {
    this.calls = [];
  }
}

Deno.test("Adapter Shortcuts: Route to adapter specified in collection metadata", async () => {
  const mockAdapter = new MockAdapter();
  mockAdapter.name = "notion";
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      notion: mockAdapter
    },
    metadataAdapter: "memory",
    defaultAdapter: "memory"
  });
  
  // Setup: Configure collection to use Notion adapter
  await storage.setCollectionMetadata('research/papers', {
    name: 'Research Papers',
    adapter: {
      type: 'notion',
      location: '8aec500b9c8f4bd28411da2680848f65'
    }
  });
  
  // Insert data WITHOUT specifying adapter
  await storage.set('research/papers/paper1', {
    title: 'Test Paper',
    year: 2025
  }, { mode: 'overwrite' });
  
  // Verify: Data was routed to Notion adapter
  const setCalls = mockAdapter.calls.filter(c => c.startsWith('set:'));
  assertEquals(setCalls.length, 1, "Should have 1 set call to Notion adapter");
  assertEquals(setCalls[0].includes('research'), true, "Should include collection in key");
});

Deno.test("Adapter Shortcuts: Explicit adapter overrides metadata", async () => {
  const notionAdapter = new MockAdapter();
  notionAdapter.name = "notion";
  
  const r2Adapter = new MockAdapter();
  r2Adapter.name = "r2";
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      notion: notionAdapter,
      r2: r2Adapter
    },
    metadataAdapter: "memory",
    defaultAdapter: "memory"
  });
  
  // Setup: Configure collection to use Notion
  await storage.setCollectionMetadata('data/mixed', {
    adapter: {
      type: 'notion',
      location: 'abc123'
    }
  });
  
  // Insert to Notion (uses metadata)
  await storage.set('data/mixed/structured', { name: 'Test' }, { mode: 'overwrite' });
  
  // Insert to R2 (explicit override)
  await storage.set('data/mixed/blob', new Uint8Array([1, 2, 3]), {
    mode: 'overwrite',
    adapter: 'r2'  // Explicit option takes priority
  });
  
  // Verify routing
  const notionCalls = notionAdapter.calls.filter(c => c.startsWith('set:'));
  const r2Calls = r2Adapter.calls.filter(c => c.startsWith('set:'));
  
  assertEquals(notionCalls.length, 1, "Should have 1 call to Notion");
  assertEquals(r2Calls.length, 1, "Should have 1 call to R2");
  assertEquals(notionCalls[0].includes('structured'), true);
  assertEquals(r2Calls[0].includes('blob'), true);
});

Deno.test("Adapter Shortcuts: Falls back gracefully if adapter not configured", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
      // No 'notion' adapter configured
    },
    metadataAdapter: "memory",
    defaultAdapter: "memory"
  });
  
  // Setup: Metadata specifies 'notion' but it's not configured
  await storage.setCollectionMetadata('data/test', {
    adapter: {
      type: 'notion',
      location: 'abc123'
    }
  });
  
  // Should NOT throw - falls back to default adapter
  await storage.set('data/test/item', { name: 'Test' }, { mode: 'overwrite' });
  
  // Verify data was stored (in memory, not notion)
  const data = await storage.get('data/test/item');
  assertExists(data, "Data should be stored despite missing adapter");
});

Deno.test("Adapter Shortcuts: Metadata persists across calls", async () => {
  const mockAdapter = new MockAdapter();
  mockAdapter.name = "airtable";
  
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      airtable: mockAdapter
    },
    metadataAdapter: "memory",
    defaultAdapter: "memory"
  });
  
  // Setup metadata once
  await storage.setCollectionMetadata('contacts/customers', {
    adapter: {
      type: 'airtable',
      location: 'appXYZ123',
      table: 'Customers'
    }
  });
  
  // Multiple inserts - all should route to Airtable
  await storage.set('contacts/customers/user1', { name: 'Alice' }, { mode: 'overwrite' });
  await storage.set('contacts/customers/user2', { name: 'Bob' }, { mode: 'overwrite' });
  await storage.set('contacts/customers/user3', { name: 'Carol' }, { mode: 'overwrite' });
  
  // Verify all went to Airtable
  const setCalls = mockAdapter.calls.filter(c => c.startsWith('set:'));
  assertEquals(setCalls.length, 3, "All 3 inserts should go to Airtable");
});

Deno.test("Adapter Shortcuts: Can retrieve adapter config from metadata", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    metadataAdapter: "memory",
    defaultAdapter: "memory"
  });
  
  // Setup
  await storage.setCollectionMetadata('test/collection', {
    name: 'Test Collection',
    adapter: {
      type: 'notion',
      location: '8aec500b9c8f4bd28411da2680848f65',
      customField: 'custom-value'
    },
    tags: ['test']
  });
  
  // Retrieve
  const metadata = await storage.getCollectionMetadata('test/collection');
  
  // Verify
  assertExists(metadata, "Metadata should exist");
  assertEquals(metadata.name, 'Test Collection');
  assertEquals(metadata.adapter?.type, 'notion');
  assertEquals(metadata.adapter?.location, '8aec500b9c8f4bd28411da2680848f65');
  assertEquals(metadata.adapter?.customField, 'custom-value');
  assertEquals(metadata.tags, ['test']);
});

console.log("✅ All adapter shortcut tests passed!");

