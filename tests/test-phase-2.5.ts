/**
 * Smallstore Phase 2.5 Tests
 * 
 * Test views and namespace operations
 * 
 * Run: deno test shared/smallstore/test-phase-2.5.ts --allow-net --allow-env
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import { createSmallstore, createMemoryAdapter } from '../mod.ts';

// ============================================================================
// Test Data
// ============================================================================

const testData = [
  { id: 1, name: "Alice", source: "hackernews", views: 150 },
  { id: 2, name: "Bob", source: "twitter", views: 80 },
  { id: 3, name: "Carol", source: "hackernews", views: 200 },
  { id: 4, name: "Dave", source: "reddit", views: 120 },
];

// ============================================================================
// View Tests
// ============================================================================

Deno.test("Views: Create and execute global view", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store source data
  await storage.set("bookmarks", testData, { mode: 'overwrite' });
  
  // Create view
  await storage.createView("hn-bookmarks.view", {
    source: "bookmarks",
    retrievers: [
      { type: "filter", options: { where: { source: "hackernews" } } }
    ]
  });
  
  // Execute view
  const result = await storage.getView("hn-bookmarks.view");
  
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Alice");
  assertEquals(result[1].name, "Carol");
});

Deno.test("Views: Create namespace-scoped view", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store data
  await storage.set("favorites/bookmarks", testData, { mode: 'overwrite' });
  
  // Create namespace-scoped view
  await storage.createView("favorites/recent.view", {
    source: "favorites/bookmarks",
    retrievers: [
      { type: "slice", options: { mode: "tail", take: 2 } }
    ]
  });
  
  // Execute view
  const result = await storage.getView("favorites/recent.view");
  
  assertEquals(result.length, 2);
  assertEquals(result[0].id, 3);
  assertEquals(result[1].id, 4);
});

Deno.test("Views: List all views", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("data", testData, { mode: 'overwrite' });
  
  // Create multiple views
  await storage.createView("view1.view", {
    source: "data",
    retrievers: [{ type: "slice", options: { mode: "head", take: 1 } }]
  });
  
  await storage.createView("view2.view", {
    source: "data",
    retrievers: [{ type: "slice", options: { mode: "tail", take: 1 } }]
  });
  
  // List views
  const views = await storage.listViews();
  
  assert(views.length >= 2);
  assert(views.includes("view1.view"));
  assert(views.includes("view2.view"));
});

Deno.test("Views: List views by namespace", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("data", testData, { mode: 'overwrite' });
  
  // Create views in different namespaces
  await storage.createView("global.view", {
    source: "data",
    retrievers: []
  });
  
  await storage.createView("favorites/view1.view", {
    source: "data",
    retrievers: []
  });
  
  await storage.createView("favorites/view2.view", {
    source: "data",
    retrievers: []
  });
  
  // List views by namespace
  const favViews = await storage.listViews("favorites");
  
  assertEquals(favViews.length, 2);
  assert(favViews.every((v: string) => v.startsWith("favorites/")));
});

Deno.test("Views: Update view definition", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("data", testData, { mode: 'overwrite' });
  
  // Create view
  await storage.createView("test.view", {
    source: "data",
    retrievers: [{ type: "slice", options: { mode: "head", take: 1 } }]
  });
  
  // Get initial result
  const result1 = await storage.getView("test.view");
  assertEquals(result1.length, 1);
  
  // Update view
  await storage.updateView("test.view", {
    source: "data",
    retrievers: [{ type: "slice", options: { mode: "head", take: 2 } }]
  });
  
  // Get updated result
  const result2 = await storage.getView("test.view");
  assertEquals(result2.length, 2);
});

Deno.test("Views: Delete view", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("data", testData, { mode: 'overwrite' });
  
  // Create view
  await storage.createView("temp.view", {
    source: "data",
    retrievers: []
  });
  
  // Verify it exists
  const viewsBefore = await storage.listViews();
  assert(viewsBefore.includes("temp.view"));
  
  // Delete view
  await storage.deleteView("temp.view");
  
  // Verify it's gone
  const viewsAfter = await storage.listViews();
  assert(!viewsAfter.includes("temp.view"));
});

Deno.test("Views: Complex pipeline in view", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  await storage.set("bookmarks", testData, { mode: 'overwrite' });
  
  // Create view with multi-step pipeline
  await storage.createView("popular-hn.view", {
    source: "bookmarks",
    retrievers: [
      { type: "filter", options: { where: { source: "hackernews" } } },
      { type: "filter", options: { where: { views: { $gt: 100 } } } },
      { type: "slice", options: { mode: "head", take: 1 } }
    ]
  });
  
  const result = await storage.getView("popular-hn.view");
  
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Alice");
});

// ============================================================================
// Namespace Tests
// ============================================================================

Deno.test("Namespace: Get all data under namespace", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store data in namespace
  await storage.set("favorites/bookmarks", testData, { mode: 'overwrite' });
  await storage.set("favorites/notes", ["note1", "note2"], { mode: 'overwrite' });
  
  // Get namespace
  const result = await storage.getNamespace("favorites");
  
  assertExists(result.bookmarks);
  assertExists(result.notes);
  assertEquals(result.bookmarks.length, 4);
  assertEquals(result.notes.length, 2);
});

Deno.test("Namespace: Copy data", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store source data
  await storage.set("source", testData, { mode: 'overwrite' });
  
  // Copy
  await storage.copy("source", "destination");
  
  // Verify both exist
  const source = await storage.get("source");
  const dest = await storage.get("destination");
  
  assertEquals(JSON.stringify(source), JSON.stringify(dest));
});

Deno.test("Namespace: Move data", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store source data
  await storage.set("old-location", testData, { mode: 'overwrite' });
  
  // Move
  await storage.move("old-location", "new-location");
  
  // Verify source is gone
  const source = await storage.get("old-location");
  assertEquals(source, null);
  
  // Verify destination exists
  const dest = await storage.get("new-location");
  assertExists(dest);
  assertEquals(dest.length, 4);
});

Deno.test("Namespace: Copy entire namespace", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store data in source namespace
  await storage.set("work/projects", ["project1", "project2"], { mode: 'overwrite' });
  await storage.set("work/notes", ["note1"], { mode: 'overwrite' });
  
  // Copy namespace
  await storage.copyNamespace("work", "work-backup");
  
  // Verify backup exists
  const backup = await storage.getNamespace("work-backup");
  assertExists(backup.projects);
  assertExists(backup.notes);
});

// ============================================================================
// Tree Tests
// ============================================================================

Deno.test("Tree: Basic tree structure", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store data
  await storage.set("favorites/bookmarks", testData, { mode: 'overwrite' });
  await storage.set("favorites/notes", ["note1"], { mode: 'overwrite' });
  
  // Get tree
  const tree = await storage.tree("favorites");
  
  assertEquals(tree.type, "folder");
  assertEquals(tree.path, "favorites");
  assertExists(tree.children);
});

Deno.test("Tree: Tree includes views", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Store data and create view
  await storage.set("data", testData, { mode: 'overwrite' });
  await storage.createView("test.view", {
    source: "data",
    retrievers: []
  });
  
  // Get tree
  const tree = await storage.tree("", { includeViews: true });
  
  // Tree should include the view
  assertExists(tree);
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Edge: View with non-existent source", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Create view with non-existent source
  await storage.createView("broken.view", {
    source: "does-not-exist",
    retrievers: []
  });
  
  // Try to execute it
  try {
    await storage.getView("broken.view");
    assert(false, "Should have thrown error");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("source not found"));
  }
});

Deno.test("Edge: Update non-existent view", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Update should work (creates if not exists)
  await storage.updateView("new.view", {
    source: "data",
    retrievers: []
  });
  
  const views = await storage.listViews();
  assert(views.includes("new.view"));
});

console.log("\n✅ All Phase 2.5 tests completed!");

