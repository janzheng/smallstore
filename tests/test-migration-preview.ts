/**
 * Migration Preview Test
 * 
 * This test writes data to Upstash using Smallstore WITHOUT deleting it,
 * so you can inspect the keys/values in the Upstash console before doing
 * a full migration.
 * 
 * Run: deno run --allow-env --allow-net --allow-read shared/smallstore/test-migration-preview.ts
 */

import "jsr:@std/dotenv/load";
import { createSmallstore, createUpstashAdapter, createMemoryAdapter } from '../mod.ts';

const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL");
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error("❌ Missing Upstash credentials!");
  console.error("   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  Deno.exit(1);
}

console.log("🔄 Smallstore Migration Preview");
console.log("================================\n");

// Create Smallstore instance
const storage = createSmallstore({
  adapters: {
    upstash: createUpstashAdapter({
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
    }),
    memory: createMemoryAdapter(),
  },
  defaultAdapter: 'upstash',
  metadataAdapter: 'memory',
});

// ============================================================================
// Test 1: Write a simple collection
// ============================================================================

console.log("📝 Test 1: Writing a simple collection...\n");

try {
  await storage.set("migration-test/bookmarks", [
  {
    title: "Attention is All You Need",
    url: "https://arxiv.org/abs/1706.03762",
    source: "arxiv",
    tags: ["ai", "transformers", "nlp"],
    savedAt: new Date().toISOString(),
  },
  {
    title: "GPT-4 Technical Report",
    url: "https://arxiv.org/abs/2303.08774",
    source: "arxiv",
    tags: ["ai", "gpt", "llm"],
    savedAt: new Date().toISOString(),
  },
  {
    title: "LLaMA: Open and Efficient Foundation Language Models",
    url: "https://arxiv.org/abs/2302.13971",
    source: "arxiv",
    tags: ["ai", "llm", "open-source"],
    savedAt: new Date().toISOString(),
  }
], { mode: 'overwrite', adapter: 'upstash' }); // 🔧 FORCE Upstash adapter!

  console.log("✅ Wrote: smallstore:migration-test:bookmarks");
  console.log("   Contains: 3 research paper bookmarks\n");
} catch (error) {
  console.error("❌ Error writing bookmarks:", error);
  if (error instanceof Error) {
    console.error(error.stack);
  }
}

// ============================================================================
// Test 2: Write a nested namespace
// ============================================================================

console.log("📝 Test 2: Writing nested namespace structure...\n");

await storage.set("migration-test/research/ai-papers", {
  topic: "Artificial Intelligence",
  papers: [
    { title: "Deep Learning", year: 2015 },
    { title: "Neural Networks", year: 2018 },
  ],
  lastUpdated: new Date().toISOString(),
}, { adapter: 'upstash' });

await storage.set("migration-test/research/quantum-papers", {
  topic: "Quantum Computing",
  papers: [
    { title: "Quantum Supremacy", year: 2019 },
    { title: "Quantum Algorithms", year: 2020 },
  ],
  lastUpdated: new Date().toISOString(),
}, { adapter: 'upstash' });

console.log("✅ Wrote: smallstore:migration-test:research:ai-papers");
console.log("✅ Wrote: smallstore:migration-test:research:quantum-papers");
console.log("   Nested namespace structure created\n");

// ============================================================================
// Test 3: Write a collection with metadata
// ============================================================================

console.log("📝 Test 3: Writing collection with rich metadata...\n");

await storage.set("migration-test/favorites", {
  name: "My Favorite Papers",
  description: "Collection of papers I reference often",
  items: [
    {
      title: "Attention is All You Need",
      rating: 5,
      notes: "Revolutionary paper on transformers",
    },
    {
      title: "BERT",
      rating: 5,
      notes: "Pre-training of deep bidirectional transformers",
    },
  ],
  createdAt: new Date().toISOString(),
}, { mode: 'overwrite', adapter: 'upstash' });

console.log("✅ Wrote: smallstore:migration-test:favorites");
console.log("   With metadata and structured items\n");

// ============================================================================
// Test 4: Create a view (stored in metadata)
// ============================================================================

console.log("📝 Test 4: Creating a view definition...\n");

await storage.createView("migration-test/arxiv-papers.view", {
  source: "migration-test/bookmarks",
  retrievers: [
    {
      type: "filter",
      options: {
        where: { source: "arxiv" }
      }
    }
  ],
  description: "View of ArXiv papers only",
});

console.log("✅ Created view: migration-test/arxiv-papers.view");
console.log("   Filters bookmarks for ArXiv sources only\n");

// ============================================================================
// Verify what was written
// ============================================================================

console.log("🔍 Verification: Reading back data...\n");

const bookmarks = await storage.get("migration-test/bookmarks");
console.log(`✅ Read back ${bookmarks?.length || 0} bookmarks`);

const aiPapers = await storage.get("migration-test/research/ai-papers");
console.log(`✅ Read back AI papers collection (${aiPapers?.papers?.length || 0} papers)`);

const favorites = await storage.get("migration-test/favorites");
console.log(`✅ Read back favorites (${favorites?.items?.length || 0} items)`);

const views = await storage.listViews("migration-test");
console.log(`✅ Found ${views?.length || 0} views in migration-test namespace`);

// ============================================================================
// Show the keys in Upstash (check ALL keys with migration-test)
// ============================================================================

console.log("\n📊 Keys written to Upstash:");
console.log("================================\n");

// Check via direct API call to get ALL keys
const response = await fetch(`${UPSTASH_URL}/keys/*migration-test*`, {
  headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
});
const data = await response.json() as any;
const allKeys = data.result || [];

if (allKeys.length === 0) {
  console.log("   ❌ No keys found with 'migration-test' in name!");
  console.log("   This suggests writes may not be persisting.\n");
} else {
  allKeys.forEach((key: string) => {
    console.log(`   - ${key}`);
  });
}

console.log("\n================================");
console.log("✅ Migration Preview Complete!");
console.log("================================\n");

console.log("🔎 Next Steps:");
console.log("   1. Check Upstash console to inspect these keys");
console.log("   2. Verify the data structure looks correct");
console.log("   3. Once verified, we can create the full migration script");
console.log("   4. Keys are prefixed with 'smallstore:migration-test:' for easy identification\n");

console.log("🧹 To clean up test data:");
console.log("   Run: deno run --allow-env --allow-net --allow-read shared/smallstore/examples/cleanup-migration-test.ts\n");

