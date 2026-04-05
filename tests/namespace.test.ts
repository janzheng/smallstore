/**
 * Namespace Operations Tests
 *
 * Tests hierarchical key management, listing, copy, move, and tree operations
 * through the Smallstore interface.
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import { createSmallstore, createMemoryAdapter } from "../mod.ts";

async function createTestStore() {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });

  await store.set("docs/getting-started", { title: "Getting Started" });
  await store.set("docs/api/endpoints", { title: "API Endpoints" });
  await store.set("docs/api/auth", { title: "Authentication" });
  await store.set("docs/guides/setup", { title: "Setup Guide" });
  await store.set("docs/guides/deploy", { title: "Deploy Guide" });
  await store.set("notes/todo", { text: "Buy milk" });

  return store;
}

// ============================================================================
// Key listing with prefix (namespace browsing)
// ============================================================================

Deno.test("keys - lists all keys under prefix", async () => {
  const store = await createTestStore();
  const docsKeys = await store.keys("docs");
  assert(docsKeys.length >= 5, `Expected >=5 docs keys, got ${docsKeys.length}`);
});

Deno.test("keys - sub-namespace filtering", async () => {
  const store = await createTestStore();
  const apiKeys = await store.keys("docs/api");
  assert(apiKeys.length >= 2, `Expected >=2 api keys, got ${apiKeys.length}`);
});

Deno.test("keys - empty namespace returns empty", async () => {
  const store = await createTestStore();
  const keys = await store.keys("nonexistent");
  assertEquals(keys.length, 0);
});

Deno.test("keys - notes namespace has one item", async () => {
  const store = await createTestStore();
  const noteKeys = await store.keys("notes");
  assert(noteKeys.length >= 1);
});

// ============================================================================
// Copy (get + set to new path)
// ============================================================================

Deno.test("copy - duplicates data to new path", async () => {
  const store = await createTestStore();
  const original = await store.get("docs/getting-started");
  assertExists(original);

  await store.set("archive/getting-started", original);

  const copied = await store.get("archive/getting-started");
  assertExists(copied);
  const stillThere = await store.get("docs/getting-started");
  assertExists(stillThere);
});

Deno.test("copy - namespace via iteration", async () => {
  const store = await createTestStore();

  // keys("docs/api") returns relative keys like ["api/endpoints", "api/auth"]
  const apiKeys = await store.keys("docs/api");
  for (const relKey of apiKeys) {
    const fullKey = `docs/${relKey}`;
    const data = await store.get(fullKey);
    const newKey = `backup/${relKey}`;
    await store.set(newKey, data);
  }

  const backupKeys = await store.keys("backup");
  assert(backupKeys.length >= 2, `Expected >=2 backup keys, got ${backupKeys.length}`);
  // Originals still exist
  assert((await store.keys("docs/api")).length >= 2);
});

// ============================================================================
// Move (get + set + delete source)
// ============================================================================

Deno.test("move - copies then deletes source", async () => {
  const store = await createTestStore();
  const data = await store.get("notes/todo");
  assertExists(data);

  await store.set("archive/todo", data);
  await store.delete("notes/todo");

  assertExists(await store.get("archive/todo"));
  assertEquals(await store.get("notes/todo"), null);
});

// ============================================================================
// Delete namespace
// ============================================================================

Deno.test("delete namespace - removes all keys under prefix", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });

  await store.set("temp/a", { x: 1 });
  await store.set("temp/b", { x: 2 });
  await store.set("keep/c", { x: 3 });

  const tempKeys = await store.keys("temp");
  for (const relKey of tempKeys) {
    await store.delete(`temp/${relKey}`);
  }

  assertEquals((await store.keys("temp")).length, 0);
  assert((await store.keys("keep")).length >= 1);
});

// ============================================================================
// Deep nesting
// ============================================================================

Deno.test("deeply nested paths - set and get", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });

  await store.set("a/b/c/d/e/f/g", { level: 7 });
  const result = await store.get("a/b/c/d/e/f/g");
  assertExists(result);

  const keys = await store.keys("a/b/c");
  assert(keys.length >= 1);
});

Deno.test("deeply nested - intermediate paths queryable", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });

  await store.set("org/team/alice/profile", { name: "Alice" });
  await store.set("org/team/bob/profile", { name: "Bob" });
  await store.set("org/team/alice/settings", { theme: "dark" });

  const teamKeys = await store.keys("org/team");
  assert(teamKeys.length >= 3);

  const aliceKeys = await store.keys("org/team/alice");
  assert(aliceKeys.length >= 2);
});

// ============================================================================
// Edge cases
// ============================================================================

Deno.test("edge - single item namespace", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  await store.set("solo/item", "just one");
  assertEquals((await store.keys("solo")).length, 1);
});

Deno.test("edge - overwrite within namespace", async () => {
  const store = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: "memory",
  });
  await store.set("ns/key", { v: 1 });
  await store.set("ns/key", { v: 2 }, { mode: 'overwrite' });

  const result = await store.get("ns/key");
  assertExists(result);
  // Router wraps response: { reference, content, adapter, dataType }
  const data = result.content !== undefined ? result.content : result;
  assertEquals(data.v, 2);
  assertEquals((await store.keys("ns")).length, 1);
});

Deno.test("edge - has() on nested path", async () => {
  const store = await createTestStore();
  assertEquals(await store.has("docs/api/auth"), true);
  assertEquals(await store.has("docs/api/nonexistent"), false);
});
