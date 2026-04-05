/**
 * Materializer Tests
 *
 * Tests JSON, CSV, Markdown, Text, YAML materialization.
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import {
  createSmallstore,
  createMemoryAdapter,
  materializeJson,
  materializeJsonItem,
  materializeCsv,
  materializeCsvItem,
  materializeMarkdown,
  materializeMarkdownItem,
  materializeText,
  materializeTextItem,
  materializeYaml,
  materializeYamlItem,
} from "../mod.ts";

// Helper: create a store with test data
async function createTestStore() {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });

  await store.set("books/hobbit", { title: "The Hobbit", author: "Tolkien", year: 1937 });
  await store.set("books/dune", { title: "Dune", author: "Herbert", year: 1965 });
  await store.set("books/neuromancer", { title: "Neuromancer", author: "Gibson", year: 1984 });

  return store;
}

// ============================================================================
// materializeJson
// ============================================================================

Deno.test("materializeJson - returns MaterializedJson with items", async () => {
  const store = await createTestStore();
  const result = await materializeJson(store, "books");
  assertExists(result);
  assertExists(result.collection);
  assertExists(result.items);
  assert(Array.isArray(result.items));
  assertEquals(result.items.length, 3);
  assertEquals(result.count, 3);
});

Deno.test("materializeJson - each item has key, type, data", async () => {
  const store = await createTestStore();
  const result = await materializeJson(store, "books");
  for (const item of result.items) {
    assertExists(item.key);
    assertExists(item.type);
    assertExists(item.data);
  }
});

Deno.test("materializeJson - empty collection returns zero items", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  const result = await materializeJson(store, "empty");
  assertExists(result);
  assertEquals(result.count, 0);
  assertEquals(result.items.length, 0);
});

// ============================================================================
// materializeJsonItem
// ============================================================================

Deno.test("materializeJsonItem - returns item with key, type, data", async () => {
  const store = await createTestStore();
  const result = await materializeJsonItem(store, "books/hobbit");
  assertExists(result);
  assertExists(result.key);
  assertExists(result.data);
  assertEquals(result.data.title, "The Hobbit");
  assertEquals(result.data.author, "Tolkien");
});

Deno.test("materializeJsonItem - returns null for non-existent", async () => {
  const store = await createTestStore();
  const result = await materializeJsonItem(store, "books/missing");
  assertEquals(result, null);
});

// ============================================================================
// materializeCsv
// ============================================================================

Deno.test("materializeCsv - returns CSV string with header", async () => {
  const store = await createTestStore();
  const csv = await materializeCsv(store, "books");
  assertExists(csv);
  assert(typeof csv === "string");
  const lines = csv.trim().split("\n");
  assert(lines.length >= 2, "Should have header + data rows");
  // Header should contain field names
  assert(lines[0].includes("title") || lines[0].includes("key"));
});

Deno.test("materializeCsv - empty collection returns header only or empty", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  const csv = await materializeCsv(store, "empty");
  assert(typeof csv === "string");
});

// ============================================================================
// materializeCsvItem
// ============================================================================

Deno.test("materializeCsvItem - returns CSV for single item", async () => {
  const store = await createTestStore();
  const csv = await materializeCsvItem(store, "books/hobbit");
  assertExists(csv);
  assert(csv.includes("Hobbit") || csv.includes("Tolkien"));
});

// ============================================================================
// materializeMarkdown
// ============================================================================

Deno.test("materializeMarkdown - returns markdown string", async () => {
  const store = await createTestStore();
  const md = await materializeMarkdown(store, "books");
  assertExists(md);
  assert(typeof md === "string");
  assert(md.length > 0);
  // Should contain some item data
  assert(md.includes("Hobbit") || md.includes("Dune") || md.includes("Neuromancer"));
});

Deno.test("materializeMarkdown - empty collection", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  const md = await materializeMarkdown(store, "empty");
  assert(typeof md === "string");
});

// ============================================================================
// materializeMarkdownItem
// ============================================================================

Deno.test("materializeMarkdownItem - renders single item", async () => {
  const store = await createTestStore();
  const md = await materializeMarkdownItem(store, "books/hobbit");
  assertExists(md);
  assert(md.includes("Hobbit") || md.includes("Tolkien"));
});

// ============================================================================
// materializeText
// ============================================================================

Deno.test("materializeText - returns plain text", async () => {
  const store = await createTestStore();
  const text = await materializeText(store, "books");
  assertExists(text);
  assert(typeof text === "string");
  assert(text.length > 0);
});

Deno.test("materializeText - empty collection", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  const text = await materializeText(store, "empty");
  assert(typeof text === "string");
});

// ============================================================================
// materializeTextItem
// ============================================================================

Deno.test("materializeTextItem - renders single item", async () => {
  const store = await createTestStore();
  const text = await materializeTextItem(store, "books/hobbit");
  assertExists(text);
  assert(text.includes("Hobbit") || text.includes("Tolkien"));
});

Deno.test("materializeTextItem - string data returns as-is", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  await store.set("notes/hello", "Hello world");
  const text = await materializeTextItem(store, "notes/hello");
  assert(text.includes("Hello world"));
});

// ============================================================================
// materializeYaml
// ============================================================================

Deno.test("materializeYaml - returns YAML string", async () => {
  const store = await createTestStore();
  const yaml = await materializeYaml(store, "books");
  assertExists(yaml);
  assert(typeof yaml === "string");
  assert(yaml.length > 0);
  // YAML should contain key-value-like content
  assert(yaml.includes("Hobbit") || yaml.includes("Dune") || yaml.includes("title"));
});

Deno.test("materializeYaml - empty collection", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  const yaml = await materializeYaml(store, "empty");
  assert(typeof yaml === "string");
});

// ============================================================================
// materializeYamlItem
// ============================================================================

Deno.test("materializeYamlItem - renders single item", async () => {
  const store = await createTestStore();
  const yaml = await materializeYamlItem(store, "books/hobbit");
  assertExists(yaml);
  assert(yaml.includes("Hobbit") || yaml.includes("Tolkien"));
});

// ============================================================================
// Edge cases with different data types
// ============================================================================

Deno.test("materialize - handles array data", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  await store.set("tags/favorites", ["ai", "ml", "data"]);

  const json = await materializeJsonItem(store, "tags/favorites");
  assertExists(json);
  assert(Array.isArray(json.data));
  assertEquals(json.data.length, 3);

  const text = await materializeTextItem(store, "tags/favorites");
  assert(typeof text === "string");
});

Deno.test("materialize - handles nested objects", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  await store.set("config/app", { db: { host: "localhost", port: 5432 }, debug: true });

  const json = await materializeJsonItem(store, "config/app");
  assertEquals(json.data.db.host, "localhost");

  const yaml = await materializeYamlItem(store, "config/app");
  assert(yaml.includes("localhost") || yaml.includes("host"));

  const csv = await materializeCsvItem(store, "config/app");
  assert(typeof csv === "string");
});

Deno.test("materialize - handles numeric and boolean values", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  await store.set("metrics/count", 42);

  const json = await materializeJsonItem(store, "metrics/count");
  assertEquals(json.data, 42);

  const text = await materializeTextItem(store, "metrics/count");
  assert(text.includes("42"));
});
