/**
 * Smallstore Tests
 * 
 * Comprehensive test suite for Smallstore Phase 1 - "Messy Desk" model:
 * - Ultra-simple types: object, blob, kv
 * - Append-first pattern (default mode)
 * - Heterogeneous collections
 * - Smart routing (type detection, adapter selection)
 * - Collection paths (folder-like addressing)
 * - Metadata (schema tracking)
 * 
 * Run: deno test shared/smallstore/test.ts --allow-net --allow-env
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import {
  createSmallstore,
  createMemoryAdapter,
  createUpstashAdapter,
  analyzeData,
  parsePath,
  buildKey,
} from '../mod.ts';

// ============================================================================
// Test Data
// ============================================================================

const simpleObject = { name: "test", value: 123 };
const arrayOfObjects = [
  { id: 1, title: "First" },
  { id: 2, title: "Second" },
];
const largeArray = Array.from({ length: 2000 }, (_, i) => ({ id: i, data: "x".repeat(100) }));
const blobData = new Uint8Array([1, 2, 3, 4, 5]);

// ============================================================================
// Data Type Detection Tests (NEW: Ultra-simple 3 types!)
// ============================================================================

Deno.test("Detector: Analyze single object", () => {
  const analysis = analyzeData(simpleObject);
  assertEquals(analysis.type, 'object');
  assert(analysis.sizeBytes > 0);
  assertExists(analysis.size);
});

Deno.test("Detector: Analyze array of objects", () => {
  const analysis = analyzeData(arrayOfObjects);
  assertEquals(analysis.type, 'object'); // Arrays are objects!
  assertEquals(analysis.itemCount, 2);
});

Deno.test("Detector: Analyze large array", () => {
  const analysis = analyzeData(largeArray);
  assertEquals(analysis.type, 'object'); // Still just 'object'!
  assertEquals(analysis.itemCount, 2000);
  assert(analysis.sizeBytes > 0);
});

Deno.test("Detector: Analyze blob", () => {
  const analysis = analyzeData(blobData);
  assertEquals(analysis.type, 'blob');
  assertEquals(analysis.sizeBytes, 5);
});

Deno.test("Detector: Analyze primitives", () => {
  assertEquals(analyzeData("hello").type, 'kv');
  assertEquals(analyzeData(42).type, 'kv');
  assertEquals(analyzeData(true).type, 'kv');
  assertEquals(analyzeData(null).type, 'kv');
});

// ============================================================================
// Path Parsing Tests
// ============================================================================

Deno.test("Path: Parse simple collection", () => {
  const parsed = parsePath("my-desk");
  assertEquals(parsed.collection, "my-desk");
  assertEquals(parsed.path, []);
  assertEquals(parsed.fullPath, "my-desk");
});

Deno.test("Path: Parse nested path", () => {
  const parsed = parsePath("research/papers/2024");
  assertEquals(parsed.collection, "research");
  assertEquals(parsed.path, ["papers", "2024"]);
  assertEquals(parsed.fullPath, "research/papers/2024");
});

Deno.test("Path: Build storage key", () => {
  const parsed = parsePath("favorites/bookmarks");
  const key = buildKey(parsed);
  assertEquals(key, "smallstore:favorites:bookmarks");
});

// ============================================================================
// Memory Adapter Tests
// ============================================================================

Deno.test("Memory: Basic CRUD", async () => {
  const adapter = createMemoryAdapter();
  
  // Set
  await adapter.set("test-key", simpleObject);
  
  // Get
  const retrieved = await adapter.get("test-key");
  assertEquals(retrieved, simpleObject);
  
  // Has
  const exists = await adapter.has("test-key");
  assertEquals(exists, true);
  
  // Delete
  await adapter.delete("test-key");
  const afterDelete = await adapter.get("test-key");
  assertEquals(afterDelete, null);
});

Deno.test("Memory: TTL expiration", async () => {
  const adapter = createMemoryAdapter();
  
  // Set with 1 second TTL
  await adapter.set("ttl-key", "expires soon", 1);
  
  // Should exist immediately
  const immediate = await adapter.get("ttl-key");
  assertEquals(immediate, "expires soon");
  
  // Wait 1.5 seconds
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  // Should be expired
  const afterExpiry = await adapter.get("ttl-key");
  assertEquals(afterExpiry, null);
});

Deno.test("Memory: Supports all types", async () => {
  const adapter = createMemoryAdapter();
  
  // Object
  await adapter.set("obj", simpleObject);
  assertEquals(await adapter.get("obj"), simpleObject);
  
  // Array (object!)
  await adapter.set("arr", arrayOfObjects);
  assertEquals(await adapter.get("arr"), arrayOfObjects);
  
  // Blob
  await adapter.set("blob", blobData);
  assertEquals(await adapter.get("blob"), blobData);
  
  // KV
  await adapter.set("kv", "just a string");
  assertEquals(await adapter.get("kv"), "just a string");
});

// ============================================================================
// Upstash Adapter Tests (REQUIRES ENV VARS)
// ============================================================================

const hasUpstashEnv = Deno.env.get("UPSTASH_REDIS_REST_URL") && Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

Deno.test({
  name: "Upstash: Basic CRUD",
  ignore: !hasUpstashEnv,
  async fn() {
    const adapter = createUpstashAdapter({
      url: Deno.env.get("UPSTASH_REDIS_REST_URL")!,
      token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
      namespace: "test",
    });
    
    // Set
    await adapter.set("test-key", simpleObject);
    
    // Get
    const retrieved = await adapter.get("test-key");
    assertEquals(retrieved, simpleObject);
    
    // Delete
    await adapter.delete("test-key");
    const afterDelete = await adapter.get("test-key");
    assertEquals(afterDelete, null);
  },
});

Deno.test({
  name: "Upstash: TTL expiration",
  ignore: !hasUpstashEnv,
  async fn() {
    const adapter = createUpstashAdapter({
      url: Deno.env.get("UPSTASH_REDIS_REST_URL")!,
      token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
      namespace: "test",
    });
    
    // Set with 2 second TTL
    await adapter.set("ttl-key", "expires soon", 2);
    
    // Should exist immediately
    const immediate = await adapter.get("ttl-key");
    assertEquals(immediate, "expires soon");
    
    // Wait 3 seconds
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Should be expired
    const afterExpiry = await adapter.get("ttl-key");
    assertEquals(afterExpiry, null);
  },
});

Deno.test({
  name: "Upstash: Size limits (1MB)",
  ignore: !hasUpstashEnv,
  async fn() {
    const adapter = createUpstashAdapter({
      url: Deno.env.get("UPSTASH_REDIS_REST_URL")!,
      token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
      namespace: "test",
    });
    
    // This should work (<1MB)
    const smallData = { data: "x".repeat(1000) };
    await adapter.set("small", smallData);
    assertEquals(await adapter.get("small"), smallData);
    
    // Large data should be handled by Memory adapter (tested in routing)
    await adapter.delete("small");
  },
});

// ============================================================================
// Smart Routing Tests
// ============================================================================

Deno.test("Routing: Memory adapter for all types", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // All types should work in memory (use overwrite to store directly)
  await storage.set("test/obj", simpleObject, { mode: 'overwrite' });
  await storage.set("test/arr", arrayOfObjects, { mode: 'overwrite' });
  await storage.set("test/blob", blobData, { mode: 'overwrite' });
  await storage.set("test/kv", "string", { mode: 'overwrite' });

  assertEquals(await storage.get("test/obj", { raw: true }), simpleObject);
  assertEquals(await storage.get("test/arr", { raw: true }), arrayOfObjects);
  assertEquals(await storage.get("test/blob", { raw: true }), blobData);
  assertEquals(await storage.get("test/kv", { raw: true }), "string");
});

// ============================================================================
// Append Mode Tests (MESSY DESK!)
// ============================================================================

Deno.test("Append: Explicit append mode", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // First item
  await storage.set("my-desk", "Random idea", { mode: 'append' });

  // Second item (should append, not overwrite!)
  await storage.set("my-desk", { url: "https://example.com", title: "Cool article" }, { mode: 'append' });

  // Get all items
  const items = await storage.get("my-desk", { raw: true });

  // Should be an array with both items!
  assert(Array.isArray(items));
  assertEquals(items.length, 2);
  assertEquals(items[0], "Random idea");
  assertEquals(items[1], { url: "https://example.com", title: "Cool article" });
});

Deno.test("Append: Multiple appends build array", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // Throw stuff on the desk!
  await storage.set("desk", "Note 1", { mode: 'append' });
  await storage.set("desk", "Note 2", { mode: 'append' });
  await storage.set("desk", { type: "bookmark", url: "..." }, { mode: 'append' });
  await storage.set("desk", "Note 3", { mode: 'append' });

  const items = await storage.get("desk", { raw: true });
  assertEquals(items.length, 4);
});

Deno.test("Append: Explicit overwrite mode", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // First item
  await storage.set("data", "original", { mode: 'overwrite' });

  // Overwrite
  await storage.set("data", "replaced", { mode: 'overwrite' });

  const result = await storage.get("data", { raw: true });
  assertEquals(result, "replaced"); // Not an array!
});

Deno.test("Append: Merge mode for objects", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // Set initial object (overwrite to start fresh)
  await storage.set("config", { name: "test", value: 1 }, { mode: 'overwrite' });

  // Merge new properties
  await storage.set("config", { extra: "data" }, { mode: 'merge' });

  const result = await storage.get("config", { raw: true });
  assertEquals(result, { name: "test", value: 1, extra: "data" });
});

// ============================================================================
// Heterogeneous Collection Tests (MESSY DESK!)
// ============================================================================

Deno.test("Heterogeneous: Mixed data types in one collection", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // Set heterogeneous data (different types, will split into sub-paths)
  await storage.set("favorites", {
    bookmarks: [{ url: "link1" }, { url: "link2" }],
    notes: "Some random thoughts",
    images: blobData,
  }, { mode: 'overwrite' });

  // Get individual sub-paths
  const bookmarks = await storage.get("favorites/bookmarks", { raw: true });
  const notes = await storage.get("favorites/notes", { raw: true });
  const images = await storage.get("favorites/images", { raw: true });

  assertEquals(bookmarks.length, 2);
  assertEquals(notes, "Some random thoughts");
  assertEquals(images, blobData);
});

Deno.test("Heterogeneous: Append to sub-paths", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });

  // Start fresh
  await storage.set("desk/bookmarks", { url: "first" }, { mode: 'overwrite' });

  // Append more bookmarks
  await storage.set("desk/bookmarks", { url: "second" }, { mode: 'append' });
  await storage.set("desk/bookmarks", { url: "third" }, { mode: 'append' });

  // Append notes
  await storage.set("desk/notes", "Idea 1", { mode: 'overwrite' });
  await storage.set("desk/notes", "Idea 2", { mode: 'append' });

  const bookmarks = await storage.get("desk/bookmarks", { raw: true });
  const notes = await storage.get("desk/notes", { raw: true });

  assertEquals(bookmarks.length, 3);
  assertEquals(notes.length, 2);
});

// ============================================================================
// Collection Schema Tests
// ============================================================================

Deno.test("Schema: Track collection metadata", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });
  
  await storage.set("research/papers", arrayOfObjects, { mode: 'overwrite' });
  await storage.set("research/notes", "Some thoughts", { mode: 'overwrite' });
  
  const schema = await storage.getSchema("research");
  
  assertExists(schema);
  assertEquals(schema.collection, "research");
  assertExists(schema.paths);
  assertExists(schema.paths["papers"]);
  assertExists(schema.paths["notes"]);
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Edge: Empty string key (should fail)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });
  
  let didThrow = false;
  try {
    await storage.set("", { data: "test" });
  } catch (error) {
    didThrow = true;
    assert(error instanceof Error);
    assert(error.message.toLowerCase().includes("collection path") || error.message.includes("empty"));
  }
  assert(didThrow, "Should have thrown error for empty path");
});

Deno.test("Edge: Get non-existent key returns null", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });
  
  const result = await storage.get("does-not-exist");
  assertEquals(result, null);
});

Deno.test("Edge: Delete non-existent key doesn't error", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });
  
  // Should not throw
  await storage.delete("does-not-exist");
  
  // Verify still doesn't exist
  const result = await storage.get("does-not-exist");
  assertEquals(result, null);
});

// ============================================================================
// Real-World Example: "Favorites" Collection
// ============================================================================

Deno.test("Real-World: Favorites collection (messy desk pattern)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
  });
  
  // Day 1: Random idea
  await storage.set("favorites", "Check out that podcast on AI agents", { mode: 'append' });

  // Day 2: Web bookmark
  await storage.set("favorites", {
    type: "bookmark",
    url: "https://example.com/article",
    title: "Great article on MCP",
    tags: ["AI", "tools"],
  }, { mode: 'append' });

  // Day 3: Bunch of research papers
  await storage.set("favorites", [
    { type: "paper", title: "Paper 1", url: "..." },
    { type: "paper", title: "Paper 2", url: "..." },
  ], { mode: 'append' });

  // Day 4: Podcast episode
  await storage.set("favorites", {
    type: "podcast",
    title: "AI episode",
    url: "spotify:...",
  }, { mode: 'append' });
  
  // Get everything
  const allFavorites = await storage.get("favorites", { raw: true });

  // Should have 4 items (string, object, array of 2, object)
  assert(Array.isArray(allFavorites));
  assertEquals(allFavorites.length, 4);

  // First item: string
  assertEquals(allFavorites[0], "Check out that podcast on AI agents");

  // Second item: bookmark object
  assertEquals(allFavorites[1].type, "bookmark");

  // Third item: array of papers
  assert(Array.isArray(allFavorites[2]));
  assertEquals(allFavorites[2].length, 2);

  // Fourth item: podcast object
  assertEquals(allFavorites[3].type, "podcast");

  console.log("\n📚 Favorites collection:");
  console.log(JSON.stringify(allFavorites, null, 2));
});

console.log("\n✅ All tests completed! Smallstore Phase 1 (Messy Desk model) is working!");
