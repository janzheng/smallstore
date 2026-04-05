/**
 * Retriever Tests
 *
 * Tests all 6 retriever types: Metadata, Slice, Filter, Structured, Text, Flatten
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import {
  MetadataRetriever,
  SliceRetriever,
  FilterRetriever,
  StructuredRetriever,
  TextRetriever,
  FlattenRetriever,
  createMetadata,
} from "../mod.ts";

// Test data
const people = [
  { name: "Alice", age: 30, role: "engineer", tags: ["ai", "ml"] },
  { name: "Bob", age: 25, role: "designer", tags: ["ui", "ux"] },
  { name: "Carol", age: 35, role: "engineer", tags: ["systems", "ml"] },
  { name: "Dan", age: 28, role: "pm", tags: ["product"] },
  { name: "Eve", age: 32, role: "engineer", tags: ["security", "crypto"] },
];

// ============================================================================
// createMetadata helper
// ============================================================================

Deno.test("createMetadata - array data counts correctly", () => {
  const meta = createMetadata("test", [1, 2], [1, 2, 3, 4]);
  assertEquals(meta.retriever, "test");
  assertEquals(meta.itemsReturned, 2);
  assertEquals(meta.itemsTotal, 4);
});

Deno.test("createMetadata - single item counts as 1", () => {
  const meta = createMetadata("test", { x: 1 }, { x: 1 });
  assertEquals(meta.itemsReturned, 1);
  assertEquals(meta.itemsTotal, 1);
});

// ============================================================================
// MetadataRetriever
// ============================================================================

Deno.test("MetadataRetriever - array metadata", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve(people);
  assertEquals(result.data.itemCount, 5);
  assertEquals(result.data.dataType, "array");
  assertEquals(result.data.isEmpty, false);
});

Deno.test("MetadataRetriever - empty array", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve([]);
  assertEquals(result.data.itemCount, 0);
  assertEquals(result.data.isEmpty, true);
});

Deno.test("MetadataRetriever - single object", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve({ name: "Alice" });
  assertEquals(result.data.itemCount, 1);
  assertEquals(result.data.dataType, "object");
});

Deno.test("MetadataRetriever - analyzeTypes option", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve([1, "two", 3, true], { analyzeTypes: true });
  assertExists(result.data.types);
  assertEquals(result.data.types.number, 2);
  assertEquals(result.data.types.string, 1);
  assertEquals(result.data.types.boolean, 1);
});

Deno.test("MetadataRetriever - includeSizes option", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve(people, { includeSizes: true });
  assertExists(result.data.sizes);
  assert(result.data.sizes.min > 0);
  assert(result.data.sizes.max >= result.data.sizes.min);
  assert(result.data.sizes.avg > 0);
});

Deno.test("MetadataRetriever - blob detection", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve(new Uint8Array([1, 2, 3]));
  assertEquals(result.data.dataType, "blob");
  assertEquals(result.data.sizeBytes, 3);
});

Deno.test("MetadataRetriever - primitive", async () => {
  const r = new MetadataRetriever();
  const result = await r.retrieve("hello");
  assertEquals(result.data.dataType, "string");
  assertEquals(result.data.itemCount, 1);
});

// ============================================================================
// SliceRetriever
// ============================================================================

Deno.test("SliceRetriever - head (default)", async () => {
  const r = new SliceRetriever();
  const result = await r.retrieve(people, { take: 2 });
  assertEquals(result.data.length, 2);
  assertEquals(result.data[0].name, "Alice");
  assertEquals(result.data[1].name, "Bob");
});

Deno.test("SliceRetriever - tail", async () => {
  const r = new SliceRetriever();
  const result = await r.retrieve(people, { mode: "tail", take: 2 });
  assertEquals(result.data.length, 2);
  assertEquals(result.data[0].name, "Dan");
  assertEquals(result.data[1].name, "Eve");
});

Deno.test("SliceRetriever - range with skip", async () => {
  const r = new SliceRetriever();
  const result = await r.retrieve(people, { mode: "range", skip: 1, take: 2 });
  assertEquals(result.data.length, 2);
  assertEquals(result.data[0].name, "Bob");
  assertEquals(result.data[1].name, "Carol");
});

Deno.test("SliceRetriever - random with seed is deterministic", async () => {
  const r = new SliceRetriever();
  const result1 = await r.retrieve(people, { mode: "random", take: 3, seed: 42 });
  const result2 = await r.retrieve(people, { mode: "random", take: 3, seed: 42 });
  assertEquals(result1.data.map((p: any) => p.name), result2.data.map((p: any) => p.name));
});

Deno.test("SliceRetriever - take more than available", async () => {
  const r = new SliceRetriever();
  const result = await r.retrieve(people, { take: 100 });
  assertEquals(result.data.length, 5);
});

Deno.test("SliceRetriever - single item wrapped in array", async () => {
  const r = new SliceRetriever();
  const result = await r.retrieve({ name: "solo" }, { take: 1 });
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0].name, "solo");
});

Deno.test("SliceRetriever - metadata tracks totals", async () => {
  const r = new SliceRetriever();
  const result = await r.retrieve(people, { take: 2 });
  assertEquals(result.metadata.itemsReturned, 2);
  assertEquals(result.metadata.itemsTotal, 5);
});

// ============================================================================
// FilterRetriever
// ============================================================================

Deno.test("FilterRetriever - simple equality", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, { where: { role: "engineer" } });
  assertEquals(result.data.length, 3);
});

Deno.test("FilterRetriever - $gt operator", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, { where: { age: { $gt: 30 } } });
  assertEquals(result.data.length, 2); // Carol(35), Eve(32)
});

Deno.test("FilterRetriever - $in operator", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, { where: { role: { $in: ["engineer", "pm"] } } });
  assertEquals(result.data.length, 4);
});

Deno.test("FilterRetriever - $contains on array field", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, { where: { tags: { $contains: "ml" } } });
  assertEquals(result.data.length, 2); // Alice, Carol
});

Deno.test("FilterRetriever - $ne operator", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, { where: { role: { $ne: "engineer" } } });
  assertEquals(result.data.length, 2); // Bob, Dan
});

Deno.test("FilterRetriever - AND conditions", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, {
    and: [{ role: "engineer" }, { age: { $gte: 32 } }],
  });
  assertEquals(result.data.length, 2); // Carol(35), Eve(32)
});

Deno.test("FilterRetriever - OR conditions", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, {
    or: [{ name: "Alice" }, { name: "Dan" }],
  });
  assertEquals(result.data.length, 2);
});

Deno.test("FilterRetriever - no filter returns all", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, {});
  assertEquals(result.data.length, 5);
});

Deno.test("FilterRetriever - dot notation for nested fields", async () => {
  const r = new FilterRetriever();
  const nested = [
    { user: { role: "admin" }, id: 1 },
    { user: { role: "viewer" }, id: 2 },
  ];
  const result = await r.retrieve(nested, { where: { "user.role": "admin" } });
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0].id, 1);
});

Deno.test("FilterRetriever - metadata includes filterRate", async () => {
  const r = new FilterRetriever();
  const result = await r.retrieve(people, { where: { role: "engineer" } });
  assertEquals(result.metadata.filterRate, 3 / 5);
});

// ============================================================================
// StructuredRetriever
// ============================================================================

Deno.test("StructuredRetriever - wraps primitives by default", async () => {
  const r = new StructuredRetriever();
  const result = await r.retrieve(["hello", 42, true]);
  assertEquals(result.data.length, 3);
  assertEquals(result.data[0].value, "hello");
  assertEquals(result.data[0]._type, "string");
  assertEquals(result.data[1].value, 42);
  assertEquals(result.data[2].value, true);
});

Deno.test("StructuredRetriever - objects pass through", async () => {
  const r = new StructuredRetriever();
  const result = await r.retrieve([{ name: "Alice" }]);
  assertEquals(result.data[0].name, "Alice");
});

Deno.test("StructuredRetriever - custom valueKey", async () => {
  const r = new StructuredRetriever();
  const result = await r.retrieve(["test"], { valueKey: "content" });
  assertEquals(result.data[0].content, "test");
});

Deno.test("StructuredRetriever - addIndex option", async () => {
  const r = new StructuredRetriever();
  const result = await r.retrieve(["a", "b"], { addIndex: true });
  assertEquals(result.data[0]._index, 0);
  assertEquals(result.data[1]._index, 1);
});

Deno.test("StructuredRetriever - wrapPrimitives false", async () => {
  const r = new StructuredRetriever();
  const result = await r.retrieve(["hello"], { wrapPrimitives: false });
  assertEquals(result.data[0], "hello");
});

Deno.test("StructuredRetriever - single item (not array)", async () => {
  const r = new StructuredRetriever();
  const result = await r.retrieve({ name: "Alice" });
  assertEquals(result.data.name, "Alice");
});

// ============================================================================
// TextRetriever
// ============================================================================

Deno.test("TextRetriever - converts objects to JSON text", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve({ name: "Alice" });
  assert(typeof result.data === "string");
  assert(result.data.includes("Alice"));
});

Deno.test("TextRetriever - strings pass through", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve("hello world");
  assertEquals(result.data, "hello world");
});

Deno.test("TextRetriever - array items joined by separator", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve(["one", "two"], { separator: " | " });
  assertEquals(result.data, "one | two");
});

Deno.test("TextRetriever - custom formatter", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve(people.slice(0, 2), {
    formatter: (p: any) => `${p.name} (${p.age})`,
  });
  assert(result.data.includes("Alice (30)"));
  assert(result.data.includes("Bob (25)"));
});

Deno.test("TextRetriever - includeIndices", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve(["a", "b"], { includeIndices: true });
  assert(result.data.includes("[0]"));
  assert(result.data.includes("[1]"));
});

Deno.test("TextRetriever - pretty false gives compact JSON", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve({ x: 1 }, { pretty: false });
  assertEquals(result.data, '{"x":1}');
});

Deno.test("TextRetriever - metadata includes length info", async () => {
  const r = new TextRetriever();
  const result = await r.retrieve("hello");
  assertExists(result.metadata.lengthChars);
  assertExists(result.metadata.lengthLines);
});

// ============================================================================
// FlattenRetriever
// ============================================================================

Deno.test("FlattenRetriever - flattens nested object", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve({
    user: { name: "Alice", address: { city: "NYC" } },
  });
  assertEquals(result.data["user.name"], "Alice");
  assertEquals(result.data["user.address.city"], "NYC");
});

Deno.test("FlattenRetriever - custom separator", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve({ a: { b: 1 } }, { separator: "/" });
  assertEquals(result.data["a/b"], 1);
});

Deno.test("FlattenRetriever - arrays kept by default", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve({ tags: ["a", "b"] });
  assert(Array.isArray(result.data.tags));
  assertEquals(result.data.tags, ["a", "b"]);
});

Deno.test("FlattenRetriever - arrays flattened with indexed keys", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve({ tags: ["a", "b"] }, { arrays: "flatten" });
  assertEquals(result.data["tags.0"], "a");
  assertEquals(result.data["tags.1"], "b");
});

Deno.test("FlattenRetriever - maxDepth limits flattening", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve({ a: { b: { c: { d: 1 } } } }, { maxDepth: 1 });
  // At maxDepth 1, first level (a) is flattened to get key "b", but b's nested value stays as object
  assertExists(result.data["b"]);
  assertEquals(typeof result.data["b"], "object");
  assertEquals(result.data["b"].c.d, 1);
});

Deno.test("FlattenRetriever - flat object unchanged", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve({ x: 1, y: 2 });
  assertEquals(result.data.x, 1);
  assertEquals(result.data.y, 2);
});

Deno.test("FlattenRetriever - array of objects", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve([{ a: { b: 1 } }, { a: { b: 2 } }]);
  assert(Array.isArray(result.data));
  assertEquals(result.data[0]["a.b"], 1);
  assertEquals(result.data[1]["a.b"], 2);
});

Deno.test("FlattenRetriever - primitive passthrough", async () => {
  const r = new FlattenRetriever();
  const result = await r.retrieve("hello");
  assertEquals(result.data, "hello");
});
