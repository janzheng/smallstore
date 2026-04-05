/**
 * Key Index Module Tests
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import {
  createEmptyIndex,
  addKeyToIndex,
  removeKeyFromIndex,
  getKeyLocation,
  saveIndex,
  loadIndex,
  deleteIndex,
  createMemoryAdapter,
} from "../mod.ts";
import type { KeyIndex, KeyLocation } from "../mod.ts";

function loc(overrides: Partial<KeyLocation> & { key: string }): KeyLocation {
  return {
    collection: "test",
    path: "/item",
    adapter: "memory",
    dataType: "json",
    sizeBytes: 42,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    ...overrides,
  };
}

// createEmptyIndex

Deno.test("createEmptyIndex - returns index with correct collection name", () => {
  const idx = createEmptyIndex("my-collection");
  assertEquals(idx.collection, "my-collection");
});

Deno.test("createEmptyIndex - keys map is empty", () => {
  const idx = createEmptyIndex("c");
  assertEquals(Object.keys(idx.keys).length, 0);
});

Deno.test("createEmptyIndex - metadata has timestamps and zero keyCount", () => {
  const idx = createEmptyIndex("c");
  assertExists(idx.metadata.created);
  assertExists(idx.metadata.updated);
  assertEquals(idx.metadata.keyCount, 0);
});

// addKeyToIndex

Deno.test("addKeyToIndex - adds a new key", () => {
  const idx = createEmptyIndex("col");
  const updated = addKeyToIndex(idx, loc({ key: "col:alpha" }));
  assertExists(updated.keys["col:alpha"]);
});

Deno.test("addKeyToIndex - preserves existing keys", () => {
  let idx = createEmptyIndex("col");
  idx = addKeyToIndex(idx, loc({ key: "col:a" }));
  idx = addKeyToIndex(idx, loc({ key: "col:b" }));
  assertExists(idx.keys["col:a"]);
  assertExists(idx.keys["col:b"]);
});

Deno.test("addKeyToIndex - duplicate key overwrites", () => {
  let idx = createEmptyIndex("col");
  idx = addKeyToIndex(idx, loc({ key: "col:x", sizeBytes: 10 }));
  idx = addKeyToIndex(idx, loc({ key: "col:x", sizeBytes: 99 }));
  assertEquals(idx.keys["col:x"].sizeBytes, 99);
});

// removeKeyFromIndex

Deno.test("removeKeyFromIndex - removes existing key", () => {
  let idx = createEmptyIndex("col");
  idx = addKeyToIndex(idx, loc({ key: "col:a" }));
  idx = addKeyToIndex(idx, loc({ key: "col:b" }));
  const updated = removeKeyFromIndex(idx, "col:a");
  assertEquals(updated.keys["col:a"], undefined);
  assertExists(updated.keys["col:b"]);
});

Deno.test("removeKeyFromIndex - removing non-existent key is a no-op", () => {
  let idx = createEmptyIndex("col");
  idx = addKeyToIndex(idx, loc({ key: "col:a" }));
  const updated = removeKeyFromIndex(idx, "col:missing");
  assertEquals(Object.keys(updated.keys).length, 1);
});

// getKeyLocation

Deno.test("getKeyLocation - returns location for existing key", () => {
  let idx = createEmptyIndex("col");
  idx = addKeyToIndex(idx, loc({ key: "col:x", adapter: "upstash" }));
  const result = getKeyLocation(idx, "col:x");
  assertExists(result);
  assertEquals(result!.adapter, "upstash");
});

Deno.test("getKeyLocation - returns null for non-existent key", () => {
  const idx = createEmptyIndex("col");
  assertEquals(getKeyLocation(idx, "col:nope"), null);
});

Deno.test("getKeyLocation - returns null for empty index", () => {
  const idx = createEmptyIndex("col");
  assertEquals(getKeyLocation(idx, "anything"), null);
});

// saveIndex / loadIndex / deleteIndex

Deno.test("saveIndex + loadIndex - round-trip preserves data", async () => {
  const adapter = createMemoryAdapter();
  let idx = createEmptyIndex("notes");
  idx = addKeyToIndex(idx, loc({ key: "notes:todo", collection: "notes" }));
  idx = addKeyToIndex(idx, loc({ key: "notes:ideas", collection: "notes" }));

  await saveIndex(adapter, idx);
  const loaded = await loadIndex(adapter, "notes");

  assertExists(loaded);
  assertEquals(loaded!.collection, "notes");
  assertEquals(Object.keys(loaded!.keys).length, 2);
});

Deno.test("loadIndex - returns null for non-existent collection", async () => {
  const adapter = createMemoryAdapter();
  const result = await loadIndex(adapter, "does-not-exist");
  assertEquals(result, null);
});

Deno.test("deleteIndex - removes the index", async () => {
  const adapter = createMemoryAdapter();
  const idx = createEmptyIndex("temp");
  await saveIndex(adapter, idx);
  assertExists(await loadIndex(adapter, "temp"));

  await deleteIndex(adapter, "temp");
  assertEquals(await loadIndex(adapter, "temp"), null);
});

Deno.test("deleteIndex - deleting non-existent index does not throw", async () => {
  const adapter = createMemoryAdapter();
  await deleteIndex(adapter, "no-such-collection");
});

// Edge cases

Deno.test("edge - key with special characters", () => {
  let idx = createEmptyIndex("col");
  const specialKey = "col:path/to/file.json?query=1&foo=bar";
  idx = addKeyToIndex(idx, loc({ key: specialKey }));
  const result = getKeyLocation(idx, specialKey);
  assertExists(result);
});

Deno.test("edge - add then remove then add same key", () => {
  let idx = createEmptyIndex("col");
  idx = addKeyToIndex(idx, loc({ key: "col:flip", sizeBytes: 1 }));
  idx = removeKeyFromIndex(idx, "col:flip");
  assertEquals(getKeyLocation(idx, "col:flip"), null);
  idx = addKeyToIndex(idx, loc({ key: "col:flip", sizeBytes: 2 }));
  assertEquals(getKeyLocation(idx, "col:flip")!.sizeBytes, 2);
});

Deno.test("edge - multiple collections in same adapter", async () => {
  const adapter = createMemoryAdapter();

  let idx1 = createEmptyIndex("alpha");
  idx1 = addKeyToIndex(idx1, loc({ key: "alpha:one", collection: "alpha" }));
  await saveIndex(adapter, idx1);

  let idx2 = createEmptyIndex("beta");
  idx2 = addKeyToIndex(idx2, loc({ key: "beta:one", collection: "beta" }));
  await saveIndex(adapter, idx2);

  const loadedAlpha = await loadIndex(adapter, "alpha");
  const loadedBeta = await loadIndex(adapter, "beta");

  assertExists(loadedAlpha);
  assertExists(loadedBeta);
  assertEquals(loadedAlpha!.collection, "alpha");
  assertEquals(loadedBeta!.collection, "beta");
});
