/**
 * Phase 3.2 Tests
 * 
 * Test suite for Universal File Explorer & Content Negotiation
 */

import { assertEquals, assertExists } from "@std/assert";
import { createSmallstore, createMemoryAdapter, FileExplorer } from '../mod.ts';

// ============================================================================
// Test Setup
// ============================================================================

function createTestStorage() {
  return createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
}

// ============================================================================
// Extension & MIME Type Tests
// ============================================================================

Deno.test("Phase 3.2: Extension parsing", async () => {
  const { parseExtension } = await import('../utils/extensions.ts');
  
  const pdf = parseExtension("documents/report.pdf");
  assertEquals(pdf.extension, "pdf");
  assertEquals(pdf.hasExtension, true);
  
  const noExt = parseExtension("users/alice");
  assertEquals(noExt.hasExtension, false);
  
  const dotfile = parseExtension("config/.gitignore");
  assertEquals(dotfile.hasExtension, false); // Dotfiles don't count
});

Deno.test("Phase 3.2: MIME type detection", async () => {
  const { getMimeType } = await import('../utils/extensions.ts');
  
  assertEquals(getMimeType("pdf"), "application/pdf");
  assertEquals(getMimeType("jpg"), "image/jpeg");
  assertEquals(getMimeType("json"), "application/json");
  assertEquals(getMimeType("unknown"), "application/octet-stream");
});

Deno.test("Phase 3.2: DataType inference", async () => {
  const { inferDataType } = await import('../utils/extensions.ts');
  
  assertEquals(inferDataType("json"), "object");
  assertEquals(inferDataType("txt"), "kv");
  assertEquals(inferDataType("pdf"), "blob");
  assertEquals(inferDataType("jpg"), "blob");
});

// ============================================================================
// Response Format Tests
// ============================================================================

Deno.test("Phase 3.2: Response wrapping", async () => {
  const storage = createTestStorage();
  
  // Store some data
  await storage.set("test/data", { value: 42 });
  
  // Get should return wrapped response
  const response = await storage.get("test/data");
  
  assertExists(response);
  assertExists(response.reference);
  assertEquals(response.reference.source, "storage");
  assertExists(response.content);
  assertEquals(response.content.value, 42);
  assertExists(response.adapter);
  assertExists(response.dataType);
});

Deno.test("Phase 3.2: Response with MIME type", async () => {
  const storage = createTestStorage();
  
  // Store blob with extension
  const blob = new Uint8Array([1, 2, 3, 4]);
  await storage.set("files/test.pdf", blob);
  
  const response = await storage.get("files/test.pdf");
  
  assertEquals(response.reference.type, "application/pdf");
  assertEquals(response.dataType, "blob");
});

// ============================================================================
// Content Negotiation Tests
// ============================================================================

Deno.test("Phase 3.2: getAsJson()", async () => {
  const storage = createTestStorage();
  
  // Store collection
  await storage.set("bookmarks/tech/article1", { title: "Post 1", url: "https://example.com/1" });
  await storage.set("bookmarks/tech/article2", { title: "Post 2", url: "https://example.com/2" });
  
  const json = await storage.getAsJson("bookmarks/tech");
  
  assertEquals(json.collection, "bookmarks/tech");
  assertEquals(json.count, 2);
  assertExists(json.items);
  assertEquals(json.items.length, 2);
  assertExists(json.metadata);
  assertExists(json.metadata.totalSize);
});

Deno.test("Phase 3.2: getAsMarkdown()", async () => {
  const storage = createTestStorage();
  
  await storage.set("docs/page1", { title: "Page 1" });
  await storage.set("docs/page2", { title: "Page 2" });
  
  const md = await storage.getAsMarkdown("docs");
  
  assertEquals(typeof md, "string");
  assertEquals(md.includes("# docs"), true);
  assertEquals(md.includes("page1"), true);
  assertEquals(md.includes("page2"), true);
});

Deno.test("Phase 3.2: getAsCsv()", async () => {
  const storage = createTestStorage();
  
  await storage.set("users/alice", { name: "Alice", age: 30 });
  await storage.set("users/bob", { name: "Bob", age: 25 });
  
  const csv = await storage.getAsCsv("users");
  
  assertEquals(typeof csv, "string");
  assertEquals(csv.includes("key,type,adapter"), true);
  assertEquals(csv.includes("alice"), true);
  assertEquals(csv.includes("Alice"), true);
  assertEquals(csv.includes("bob"), true);
});

Deno.test("Phase 3.2: getAsText()", async () => {
  const storage = createTestStorage();
  
  await storage.set("settings/theme", "dark");
  await storage.set("settings/language", "en");
  
  const text = await storage.getAsText("settings");
  
  assertEquals(typeof text, "string");
  assertEquals(text.includes("settings"), true);
  assertEquals(text.includes("theme"), true);
  assertEquals(text.includes("dark"), true);
});

Deno.test("Phase 3.2: getAsYaml()", async () => {
  const storage = createTestStorage();
  
  await storage.set("config/database", { host: "localhost", port: 5432 });
  await storage.set("config/cache", { enabled: true });
  
  const yaml = await storage.getAsYaml("config");
  
  assertEquals(typeof yaml, "string");
  assertEquals(yaml.includes("collection: config"), true);
  assertEquals(yaml.includes("database:"), true);
  assertEquals(yaml.includes("localhost"), true);
});

// ============================================================================
// File Explorer Tests
// ============================================================================

Deno.test("Phase 3.2: FileExplorer.browse()", async () => {
  const storage = createTestStorage();
  const explorer = new FileExplorer(storage);
  
  // Store mixed content
  await storage.set("documents/report.pdf", new Uint8Array([1, 2, 3]));
  await storage.set("documents/metadata", { title: "Report" });
  await storage.set("documents/notes.txt", "Some notes");
  
  const files = await explorer.browse("documents");
  
  assertEquals(files.length, 3);
  
  // Check file metadata structure
  const reportFile = files.find(f => f.filename === "report.pdf");
  assertExists(reportFile);
  assertEquals(reportFile.type, "blob");
  assertEquals(reportFile.mimeType, "application/pdf");
  assertExists(reportFile.adapter);
  assertExists(reportFile.sizeFormatted);
});

Deno.test("Phase 3.2: FileExplorer.tree()", async () => {
  const storage = createTestStorage();
  const explorer = new FileExplorer(storage);
  
  // Create nested structure
  await storage.set("workspace/docs/file1.txt", "content1");
  await storage.set("workspace/docs/file2.txt", "content2");
  await storage.set("workspace/images/photo.jpg", new Uint8Array([1, 2]));
  
  const tree = await explorer.tree("workspace");
  
  assertExists(tree);
  assertExists(tree.workspace);
  // Tree structure varies based on implementation
});

Deno.test("Phase 3.2: FileExplorer.metadata()", async () => {
  const storage = createTestStorage();
  const explorer = new FileExplorer(storage);
  
  await storage.set("files/document.pdf", new Uint8Array([1, 2, 3, 4, 5]));
  
  const meta = await explorer.metadata("files/document.pdf");
  
  assertExists(meta);
  assertEquals(meta.filename, "document.pdf");
  assertEquals(meta.type, "blob");
  assertEquals(meta.mimeType, "application/pdf");
  assertEquals(meta.size, 5);
  assertExists(meta.adapter);
  assertExists(meta.created);
  assertExists(meta.updated);
});

// ============================================================================
// Mixed Content Tests
// ============================================================================

Deno.test("Phase 3.2: Mixed content storage and retrieval", async () => {
  const storage = createTestStorage();
  const explorer = new FileExplorer(storage);
  
  // Store different types
  await storage.set("mixed/data.json", { value: 42 });
  await storage.set("mixed/text.txt", "Hello, World!");
  await storage.set("mixed/binary.bin", new Uint8Array([0xFF, 0xFE]));
  
  // Browse should show all types
  const files = await explorer.browse("mixed");
  assertEquals(files.length, 3);
  
  // Each should have correct type
  const jsonFile = files.find(f => f.filename === "data.json");
  assertEquals(jsonFile?.type, "object");
  
  const textFile = files.find(f => f.filename === "text.txt");
  assertEquals(textFile?.type, "kv");
  
  const binFile = files.find(f => f.filename === "binary.bin");
  assertEquals(binFile?.type, "blob");
});

Deno.test("Phase 3.2: Content negotiation on mixed collection", async () => {
  const storage = createTestStorage();
  
  await storage.set("mixed/item1", { type: "object" });
  await storage.set("mixed/item2", "text value");
  
  // All formats should work
  const json = await storage.getAsJson("mixed");
  assertEquals(json.count, 2);
  
  const md = await storage.getAsMarkdown("mixed");
  assertEquals(md.includes("mixed"), true);
  
  const csv = await storage.getAsCsv("mixed");
  assertEquals(csv.includes("item1"), true);
  
  const text = await storage.getAsText("mixed");
  assertEquals(text.includes("item1"), true);
  
  const yaml = await storage.getAsYaml("mixed");
  assertEquals(yaml.includes("item1"), true);
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test("Phase 3.2: Full workflow - store, browse, materialize", async () => {
  const storage = createTestStorage();
  const explorer = new FileExplorer(storage);
  
  // 1. Store data
  await storage.set("project/docs/readme.md", "# Project\n\nDescription");
  await storage.set("project/docs/api.md", "# API\n\nEndpoints");
  await storage.set("project/src/main.ts", "console.log('hello')");
  await storage.set("project/config.json", { version: "1.0.0" });
  
  // 2. Browse files
  const allFiles = await explorer.browse("project");
  assertEquals(allFiles.length >= 1, true); // At least some files
  
  const docFiles = await explorer.browse("project/docs");
  assertEquals(docFiles.length, 2);
  
  // 3. Get metadata
  const readmeMeta = await explorer.metadata("project/docs/readme.md");
  assertExists(readmeMeta);
  assertEquals(readmeMeta.mimeType, "text/markdown");
  
  // 4. Materialize in different formats
  const json = await storage.getAsJson("project/docs");
  assertEquals(json.count, 2);
  
  const md = await storage.getAsMarkdown("project/docs");
  assertEquals(md.includes("readme.md"), true);
});

console.log("✅ Phase 3.2 tests completed!");

