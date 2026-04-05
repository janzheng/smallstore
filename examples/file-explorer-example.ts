/**
 * File Explorer Example
 * 
 * Phase 3.2: Demonstrates Universal File Explorer & Content Negotiation
 * 
 * Run with: deno run --allow-env examples/file-explorer-example.ts
 */

import {
  createSmallstore,
  createMemoryAdapter,
  FileExplorer,
} from '../mod.ts';

// ============================================================================
// Setup
// ============================================================================

console.log("🗂️  Phase 3.2: File Explorer Example\n");

// Create storage with memory adapter
const storage = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
  },
  defaultAdapter: 'memory',
  metadataAdapter: 'memory',
});

// Create file explorer
const explorer = new FileExplorer(storage);

// ============================================================================
// Example 1: Mixed Content Storage
// ============================================================================

console.log("📁 Example 1: Storing Mixed Content\n");

// Store different types of data with natural filenames
await storage.set("my-workspace/documents/report.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])); // PDF magic bytes
await storage.set("my-workspace/documents/notes.txt", "Remember to review the quarterly report");
await storage.set("my-workspace/documents/metadata", {
  title: "Q4 Report",
  author: "Alice",
  date: "2025-11-18",
});

await storage.set("my-workspace/images/logo.png", new Uint8Array([0x89, 0x50, 0x4E, 0x47])); // PNG magic bytes
await storage.set("my-workspace/images/photo.jpg", new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])); // JPEG magic bytes

await storage.set("my-workspace/config.json", {
  version: "1.0.0",
  features: ["documents", "images"],
});

console.log("✅ Stored 6 files across different types\n");

// ============================================================================
// Example 2: Browse Files
// ============================================================================

console.log("📋 Example 2: Browse Files Like a Filesystem\n");

const allFiles = await explorer.browse("my-workspace");
console.log(`Found ${allFiles.length} file(s) in my-workspace/\n`);

for (const file of allFiles) {
  console.log(`  📄 ${file.filename}`);
  console.log(`     Type: ${file.type} (${file.mimeType || 'unknown'})`);
  console.log(`     Size: ${file.sizeFormatted}`);
  console.log(`     Adapter: ${file.adapter}`);
  console.log(`     Updated: ${file.updated}\n`);
}

// Browse subdirectory
const docFiles = await explorer.browse("my-workspace/documents");
console.log(`Found ${docFiles.length} file(s) in my-workspace/documents/\n`);

// ============================================================================
// Example 3: File Metadata
// ============================================================================

console.log("📊 Example 3: Get File Metadata\n");

const reportMeta = await explorer.metadata("my-workspace/documents/report.pdf");
if (reportMeta) {
  console.log("Report PDF Metadata:");
  console.log(`  Filename: ${reportMeta.filename}`);
  console.log(`  MIME Type: ${reportMeta.mimeType}`);
  console.log(`  Size: ${reportMeta.sizeFormatted} (${reportMeta.size} bytes)`);
  console.log(`  Data Type: ${reportMeta.type}`);
  console.log(`  Adapter: ${reportMeta.adapter}`);
  console.log(`  Created: ${reportMeta.created}`);
  console.log(`  Updated: ${reportMeta.updated}\n`);
}

// ============================================================================
// Example 4: Tree Visualization
// ============================================================================

console.log("🌲 Example 4: Tree Structure\n");

const tree = await explorer.tree("my-workspace");
console.log("Workspace Structure:");
console.log(JSON.stringify(tree, null, 2));
console.log();

// ============================================================================
// Example 5: Content Negotiation - JSON
// ============================================================================

console.log("📄 Example 5: Content Negotiation - JSON\n");

const json = await storage.getAsJson("my-workspace/documents");
console.log("Documents as JSON:");
console.log(`  Collection: ${json.collection}`);
console.log(`  Count: ${json.count}`);
console.log(`  Total Size: ${json.metadata.totalSize}`);
console.log(`  Adapters: ${JSON.stringify(json.metadata.adapters)}`);
console.log(`\n  Items:`);
for (const item of json.items) {
  console.log(`    - ${item.key} (${item.type}, ${item.size} bytes)`);
}
console.log();

// ============================================================================
// Example 6: Content Negotiation - Markdown
// ============================================================================

console.log("📝 Example 6: Content Negotiation - Markdown\n");

const markdown = await storage.getAsMarkdown("my-workspace/documents");
console.log("Documents as Markdown:");
console.log("---");
console.log(markdown.split('\n').slice(0, 30).join('\n')); // First 30 lines
console.log("...");
console.log("---\n");

// ============================================================================
// Example 7: Content Negotiation - CSV
// ============================================================================

console.log("📊 Example 7: Content Negotiation - CSV\n");

// Store some structured data
await storage.set("bookmarks/tech/article1", {
  title: "Introduction to Deno",
  url: "https://deno.land/manual",
  tags: ["deno", "typescript"],
});
await storage.set("bookmarks/tech/article2", {
  title: "Web APIs",
  url: "https://developer.mozilla.org/",
  tags: ["web", "javascript"],
});

const csv = await storage.getAsCsv("bookmarks/tech");
console.log("Bookmarks as CSV:");
console.log("---");
console.log(csv);
console.log("---\n");

// ============================================================================
// Example 8: Content Negotiation - Plain Text
// ============================================================================

console.log("📃 Example 8: Content Negotiation - Plain Text\n");

await storage.set("settings/theme", "dark");
await storage.set("settings/language", "en");
await storage.set("settings/notifications", true);

const text = await storage.getAsText("settings");
console.log("Settings as Plain Text:");
console.log("---");
console.log(text);
console.log("---\n");

// ============================================================================
// Example 9: Content Negotiation - YAML
// ============================================================================

console.log("🔧 Example 9: Content Negotiation - YAML\n");

await storage.set("config/app/database", {
  host: "localhost",
  port: 5432,
  database: "myapp",
});
await storage.set("config/app/cache", {
  enabled: true,
  ttl: 3600,
});

const yaml = await storage.getAsYaml("config/app");
console.log("Config as YAML:");
console.log("---");
console.log(yaml);
console.log("---\n");

// ============================================================================
// Example 10: Working with Response Format
// ============================================================================

console.log("🔍 Example 10: Storage Response Format\n");

const response = await storage.get("my-workspace/config.json");
console.log("Response Structure:");
console.log(`  Reference:`);
console.log(`    - Key: ${response.reference.key}`);
console.log(`    - Name: ${response.reference.name}`);
console.log(`    - MIME Type: ${response.reference.type}`);
console.log(`    - Size: ${response.reference.size} bytes`);
console.log(`    - Source: ${response.reference.source}`);
console.log(`    - Storage: ${response.reference.storage}`);
console.log(`  Content: ${JSON.stringify(response.content)}`);
console.log(`  Adapter: ${response.adapter}`);
console.log(`  Data Type: ${response.dataType}\n`);

// ============================================================================
// Example 11: Real-World Use Case - Project Explorer
// ============================================================================

console.log("🚀 Example 11: Real-World Use Case - Project Explorer\n");

// Simulate a project structure
await storage.set("project/README.md", "# My Project\n\nDescription here");
await storage.set("project/package.json", { name: "my-project", version: "1.0.0" });
await storage.set("project/src/main.ts", "console.log('Hello, World!');");
await storage.set("project/src/utils.ts", "export const helper = () => {};");
await storage.set("project/tests/main.test.ts", "// Tests here");
await storage.set("project/.gitignore", "node_modules\n*.log");

// Browse project
console.log("Project Files:");
const projectFiles = await explorer.browse("project");
for (const file of projectFiles) {
  const icon = file.type === 'blob' ? '📄' : file.type === 'object' ? '📦' : '📝';
  console.log(`  ${icon} ${file.filename} (${file.sizeFormatted})`);
}
console.log();

// Get project documentation as markdown
const projectDocs = await storage.getAsMarkdown("project");
console.log("Project Documentation (Markdown):");
console.log("---");
console.log(projectDocs.split('\n').slice(0, 20).join('\n'));
console.log("...");
console.log("---\n");

// Export project metadata as JSON
const projectMeta = await storage.getAsJson("project");
console.log("Project Metadata (JSON):");
console.log(`  Files: ${projectMeta.count}`);
console.log(`  Total Size: ${projectMeta.metadata.totalSize}`);
console.log(`  Last Updated: ${projectMeta.metadata.updated}\n`);

// ============================================================================
// Summary
// ============================================================================

console.log("✨ Phase 3.2 Features Demonstrated:\n");
console.log("  ✅ Mixed content storage (blobs, objects, kv)");
console.log("  ✅ File explorer (browse, tree, metadata)");
console.log("  ✅ MIME type detection from extensions");
console.log("  ✅ Content negotiation (JSON, Markdown, CSV, Text, YAML)");
console.log("  ✅ Standardized response format");
console.log("  ✅ Multi-type file system interface");
console.log("\n🎉 Universal File Explorer is ready to use!\n");

