/**
 * Smallstore Retriever Tests
 * 
 * Phase 2: Test retrieval adapters
 * 
 * Run: deno test shared/smallstore/test-retrievers.ts --allow-net --allow-env
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import { createSmallstore, createMemoryAdapter } from '../mod.ts';

// ============================================================================
// Test Data
// ============================================================================

const testData = [
  { id: 1, name: "Alice", topic: "AI", date: "2024-01-15", views: 150 },
  { id: 2, name: "Bob", topic: "Web", date: "2024-02-20", views: 80 },
  { id: 3, name: "Carol", topic: "AI", date: "2024-03-10", views: 200 },
  { id: 4, name: "Dave", topic: "ML", date: "2024-04-05", views: 120 },
];

// Simple nested object (won't trigger heterogeneous splitting - only 1 complex value)
const nestedData = {
  user: {
    name: "Alice",
    address: {
      street: "123 Main St",
      city: "NYC",
      coordinates: { lat: 40.7, lng: -74.0 }
    }
  },
  role: "developer",  // Simple string, not a complex value
  active: true
};

// ============================================================================
// Metadata Retriever Tests
// ============================================================================

Deno.test("Retriever: Metadata - basic info", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const meta = await storage.get("test", { retriever: "metadata" });
  assertEquals(meta.itemCount, 4);
  assertEquals(meta.dataType, "array");
  assertEquals(meta.isEmpty, false);
});

Deno.test("Retriever: Metadata - with type analysis", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const meta = await storage.get("test", { 
    retriever: "metadata",
    analyzeTypes: true 
  });
  
  assertExists(meta.types);
  assertEquals(meta.types.object, 4);
});

Deno.test("Retriever: Metadata - with size analysis", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const meta = await storage.get("test", { 
    retriever: "metadata",
    includeSizes: true 
  });
  
  assertExists(meta.sizes);
  assert(meta.sizes.min > 0);
  assert(meta.sizes.max > 0);
  assert(meta.sizes.avg > 0);
});

// ============================================================================
// Slice Retriever Tests
// ============================================================================

Deno.test("Retriever: Slice - head mode", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", { 
    retriever: "slice",
    mode: "head",
    take: 2
  });
  
  assertEquals(result.length, 2);
  assertEquals(result[0].id, 1);
  assertEquals(result[1].id, 2);
});

Deno.test("Retriever: Slice - tail mode", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", { 
    retriever: "slice",
    mode: "tail",
    take: 2
  });
  
  assertEquals(result.length, 2);
  assertEquals(result[0].id, 3);
  assertEquals(result[1].id, 4);
});

Deno.test("Retriever: Slice - range mode", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", { 
    retriever: "slice",
    mode: "range",
    skip: 1,
    take: 2
  });
  
  assertEquals(result.length, 2);
  assertEquals(result[0].id, 2);
  assertEquals(result[1].id, 3);
});

Deno.test("Retriever: Slice - random mode with seed", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result1 = await storage.get("test", { 
    retriever: "slice",
    mode: "random",
    take: 2,
    seed: 12345
  });
  
  const result2 = await storage.get("test", { 
    retriever: "slice",
    mode: "random",
    take: 2,
    seed: 12345
  });
  
  // Same seed should give same results
  assertEquals(result1.length, 2);
  assertEquals(result2.length, 2);
  // Compare the actual results (should be identical with same seed)
  assertEquals(JSON.stringify(result1), JSON.stringify(result2));
});

// ============================================================================
// Filter Retriever Tests
// ============================================================================

Deno.test("Retriever: Filter - exact match", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "filter",
    where: { topic: "AI" }
  });
  
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Alice");
  assertEquals(result[1].name, "Carol");
});

Deno.test("Retriever: Filter - $gt operator", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "filter",
    where: { views: { $gt: 100 } }
  });
  
  assertEquals(result.length, 3);
});

Deno.test("Retriever: Filter - $in operator", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "filter",
    where: { topic: { $in: ["AI", "ML"] } }
  });
  
  assertEquals(result.length, 3);
});

Deno.test("Retriever: Filter - AND conditions", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "filter",
    and: [
      { topic: "AI" },
      { views: { $gt: 100 } }
    ]
  });
  
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Alice");
  assertEquals(result[1].name, "Carol");
});

Deno.test("Retriever: Filter - OR conditions", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "filter",
    or: [
      { name: "Alice" },
      { name: "Bob" }
    ]
  });
  
  assertEquals(result.length, 2);
});

// ============================================================================
// Structured Retriever Tests
// ============================================================================

Deno.test("Retriever: Structured - wrap primitives", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  const mixedData = ["hello", 42, { name: "Alice" }];
  await storage.set("test", mixedData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "structured",
    wrapPrimitives: true
  });
  
  assertEquals(result.length, 3);
  assertEquals(result[0].value, "hello");
  assertEquals(result[0]._type, "string");
  assertEquals(result[1].value, 42);
  assertEquals(result[1]._type, "number");
  assertEquals(result[2].name, "Alice");
});

Deno.test("Retriever: Structured - add index", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "structured",
    addIndex: true
  });
  
  assertEquals(result.length, 4);
  assertEquals(result[0]._index, 0);
  assertEquals(result[1]._index, 1);
});

// ============================================================================
// Text Retriever Tests
// ============================================================================

Deno.test("Retriever: Text - default format", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "text"
  });
  
  assertEquals(typeof result, "string");
  assert(result.includes("Alice"));
  assert(result.includes("Bob"));
});

Deno.test("Retriever: Text - custom formatter", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "text",
    formatter: (item: any) => `${item.name}: ${item.topic}`,
    separator: "\n"
  });
  
  assertEquals(typeof result, "string");
  assert(result.includes("Alice: AI"));
  assert(result.includes("Bob: Web"));
});

Deno.test("Retriever: Text - with indices", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "text",
    formatter: (item: any) => item.name,
    separator: ", ",
    includeIndices: true
  });
  
  assertEquals(typeof result, "string");
  assert(result.includes("[0] Alice"));
  assert(result.includes("[1] Bob"));
});

// ============================================================================
// Flatten Retriever Tests
// ============================================================================

Deno.test("Retriever: Flatten - basic", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", nestedData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "flatten"
  });
  
  assertEquals(result["user.name"], "Alice");
  assertEquals(result["user.address.street"], "123 Main St");
  assertEquals(result["user.address.city"], "NYC");
  assertEquals(result["user.address.coordinates.lat"], 40.7);
  assertEquals(result["role"], "developer");
  assertEquals(result["active"], true);
});

Deno.test("Retriever: Flatten - custom separator", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", nestedData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "flatten",
    separator: "_"
  });
  
  assertEquals(result["user_name"], "Alice");
  assertEquals(result["user_address_city"], "NYC");
});

Deno.test("Retriever: Flatten - flatten arrays", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Use data with arrays that won't trigger heterogeneous splitting
  const dataWithArrays = {
    name: "Project",
    tags: ["developer", "ai", "ml"],
    count: 3
  };
  
  await storage.set("test", dataWithArrays, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retriever: "flatten",
    arrays: "flatten"
  });
  
  assertEquals(result["tags.0"], "developer");
  assertEquals(result["tags.1"], "ai");
  assertEquals(result["tags.2"], "ml");
  assertEquals(result["name"], "Project");
});

// ============================================================================
// Retrieval Pipeline Tests
// ============================================================================

Deno.test("Retriever: Pipeline - filter then slice", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retrievers: [
      { type: "filter", options: { where: { topic: "AI" } } },
      { type: "slice", options: { mode: "head", take: 1 } }
    ]
  });
  
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Alice");
});

Deno.test("Retriever: Pipeline - filter, slice, then text", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retrievers: [
      { type: "filter", options: { where: { views: { $gt: 100 } } } },
      { type: "slice", options: { mode: "head", take: 2 } },
      { type: "text", options: { 
        formatter: (item: any) => `${item.name} (${item.views} views)`,
        separator: ", "
      }}
    ]
  });
  
  assertEquals(typeof result, "string");
  assert(result.includes("Alice"));
  assert(result.includes("views"));
});

Deno.test("Retriever: Pipeline - structured then flatten", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  const data = [{ user: { name: "Alice", age: 30 } }];
  await storage.set("test", data, { mode: 'overwrite' });
  
  const result = await storage.get("test", {
    retrievers: [
      { type: "structured", options: { addIndex: true } },
      { type: "slice", options: { mode: "head", take: 1 } }
    ]
  });
  
  assertEquals(result.length, 1);
  assertEquals(result[0]._index, 0);
  assertEquals(result[0].user.name, "Alice");
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Retriever: Empty array", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", [], { mode: 'overwrite' });
  
  const meta = await storage.get("test", { retriever: "metadata" });
  assertEquals(meta.itemCount, 0);
  assertEquals(meta.isEmpty, true);
});

Deno.test("Retriever: Single object (not array)", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", { name: "Alice", age: 30 }, { mode: 'overwrite' });
  
  const result = await storage.get("test", { 
    retriever: "structured",
    addIndex: true
  });
  
  assertEquals(result._index, 0);
  assertEquals(result.name, "Alice");
});

Deno.test("Retriever: Error on unknown retriever", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("test", testData, { mode: 'overwrite' });
  
  try {
    await storage.get("test", { retriever: "nonexistent" });
    assert(false, "Should have thrown error");
  } catch (error) {
    assert(error instanceof Error && error.message.includes("not found"));
  }
});

