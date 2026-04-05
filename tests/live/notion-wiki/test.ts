#!/usr/bin/env -S deno run --allow-all
/**
 * Live Hierarchical Wiki Test (Notion)
 *
 * A hierarchical wiki where pages are organized in namespaces and
 * retrievable with different strategies.
 *
 * Features: Namespace (buildTree) + Retrievers + Notion adapter
 *
 * Prerequisites:
 * - Working Notion adapter (run `deno task live:notion` first)
 *
 * Run: deno task live:notion-wiki
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import {
  createSmallstore,
  createNotionAdapter,
  createMemoryAdapter,
  buildTree,
  MetadataRetriever,
  TextRetriever,
  FilterRetriever,
} from '../../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SECRET = Deno.env.get('SM_NOTION_SECRET');
const DATABASE_ID = Deno.env.get('SM_NOTION_DATABASE_ID');

if (!SECRET || !DATABASE_ID || SECRET.startsWith('secret_XXX') || DATABASE_ID.startsWith('xxx')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Wiki Live Test — Setup Required                             ║
╚══════════════════════════════════════════════════════════════╝

Missing Notion credentials. Set in .env:
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_DATABASE_ID=your-database-id

Run again: deno task live:notion-wiki
`);
  Deno.exit(0);
}

// ============================================================================
// Helpers
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

function printTree(tree: any, indent = 0) {
  const prefix = '  '.repeat(indent + 1);
  log('  ', `${prefix}${tree.name}/ (${tree.children?.length || 0} children, ${tree.keys?.length || 0} keys)`);
  for (const key of tree.keys || []) {
    log('  ', `${prefix}  📄 ${key}`);
  }
  for (const child of tree.children || []) {
    printTree(child, indent + 1);
  }
}

// ============================================================================
// Test
// ============================================================================

async function main() {
  const testId = `test-${Date.now()}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Hierarchical Wiki — Notion Live Test                        ║
║  Database: ${DATABASE_ID!.slice(0, 8)}...${DATABASE_ID!.slice(-4)}${' '.repeat(37)}║
║  Test ID:  ${testId}${' '.repeat(Math.max(0, 46 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup ──────────────────────────────────────────────────
  const notionAdapter = createNotionAdapter({
    notionSecret: SECRET!,
    databaseId: DATABASE_ID!,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
  });

  const memoryAdapter = createMemoryAdapter();

  const store = createSmallstore({
    adapters: { notion: notionAdapter, memory: memoryAdapter },
    defaultAdapter: 'notion',
    metadataAdapter: 'memory',
  });

  // ── Step 1: Create wiki pages ──────────────────────────────
  console.log('── Step 1: Create wiki pages ──');

  const pages = [
    { key: `wiki-${testId}/engineering/architecture`, data: { Name: `Architecture-${testId}`, Content: 'System architecture overview with microservices', Tags: 'architecture,system-design', PageStatus: 'published' } },
    { key: `wiki-${testId}/engineering/testing`, data: { Name: `Testing Guide-${testId}`, Content: 'Unit tests, integration tests, and E2E testing strategy', Tags: 'testing,quality', PageStatus: 'published' } },
    { key: `wiki-${testId}/engineering/deployment`, data: { Name: `Deployment-${testId}`, Content: 'CI/CD pipeline with GitHub Actions and Cloudflare Workers', Tags: 'deployment,ci-cd', PageStatus: 'draft' } },
    { key: `wiki-${testId}/product/roadmap`, data: { Name: `Roadmap-${testId}`, Content: 'Q1 2026 product roadmap with feature priorities', Tags: 'roadmap,planning', PageStatus: 'published' } },
    { key: `wiki-${testId}/product/specs/auth`, data: { Name: `Auth Spec-${testId}`, Content: 'OAuth2 + PKCE authentication specification', Tags: 'auth,security,spec', PageStatus: 'review' } },
    { key: `wiki-${testId}/product/specs/search`, data: { Name: `Search Spec-${testId}`, Content: 'Full-text search with BM25 ranking and faceted filters', Tags: 'search,spec', PageStatus: 'draft' } },
    { key: `wiki-${testId}/onboarding/getting-started`, data: { Name: `Getting Started-${testId}`, Content: 'New developer onboarding guide with setup instructions', Tags: 'onboarding,setup', PageStatus: 'published' } },
    { key: `wiki-${testId}/onboarding/faq`, data: { Name: `FAQ-${testId}`, Content: 'Frequently asked questions about the codebase', Tags: 'onboarding,faq', PageStatus: 'published' } },
  ];

  for (const page of pages) {
    await store.set(page.key, page.data, { mode: 'replace' });
    log('📝', `Created: ${page.key.replace(`wiki-${testId}/`, '')}`);
  }

  // ── Step 2: Build namespace tree ───────────────────────────
  console.log('\n── Step 2: Build namespace tree ──');

  try {
    const tree = await buildTree(notionAdapter, memoryAdapter, `wiki-${testId}`);
    log('🌳', 'Namespace tree:');
    printTree(tree);
  } catch (err) {
    log('⚠️', `buildTree not fully supported for this adapter: ${(err as Error).message}`);
    // Fallback: list keys to show the structure
    const allKeys = await store.keys(`wiki-${testId}`);
    log('📁', `Keys under wiki-${testId} (${allKeys.length}):`);
    for (const k of allKeys) {
      log('  ', k);
    }
  }

  // ── Step 3: MetadataRetriever ──────────────────────────────
  console.log('\n── Step 3: MetadataRetriever — titles and paths ──');

  const metaRetriever = new MetadataRetriever();
  const metaResults = [];
  for (const page of pages) {
    const result = await store.get(page.key);
    if (result?.content) {
      const meta = await metaRetriever.retrieve(result.content);
      metaResults.push({ key: page.key, meta });
    }
  }
  log('📋', `Retrieved metadata for ${metaResults.length} pages:`);
  for (const r of metaResults.slice(0, 4)) {
    const shortKey = r.key.replace(`wiki-${testId}/`, '');
    log('  ', `${shortKey}: ${JSON.stringify(r.meta.data).slice(0, 80)}`);
  }

  // ── Step 4: TextRetriever ──────────────────────────────────
  console.log('\n── Step 4: TextRetriever — extract text content ──');

  const textRetriever = new TextRetriever();
  for (const page of pages.slice(0, 3)) {
    const result = await store.get(page.key);
    if (result?.content) {
      const textResult = await textRetriever.retrieve(result.content);
      const shortKey = page.key.replace(`wiki-${testId}/`, '');
      log('📝', `${shortKey}: "${String(textResult.data).slice(0, 60)}..."`);
    }
  }

  // ── Step 5: FilterRetriever ────────────────────────────────
  console.log('\n── Step 5: FilterRetriever — pages with "spec" tag ──');

  const filterRetriever = new FilterRetriever();

  const specPages = [];
  for (const page of pages) {
    const result = await store.get(page.key);
    if (result?.content) {
      const filtered = await filterRetriever.retrieve(result.content, {
        and: [{ Tags: { $contains: 'spec' } }],
      });
      if (filtered.data && (Array.isArray(filtered.data) ? filtered.data.length > 0 : true)) {
        specPages.push(page.key);
      }
    }
  }
  log('🔍', `Found ${specPages.length} pages with "spec" tag:`);
  for (const k of specPages) {
    log('  ', k.replace(`wiki-${testId}/`, ''));
  }

  // ── Step 6: List all keys ──────────────────────────────────
  console.log('\n── Step 6: List all wiki keys ──');

  const allKeys = await store.keys(`wiki-${testId}`);
  log('📁', `Total wiki pages: ${allKeys.length}`);
  for (const k of allKeys) {
    log('  ', k);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`
── Done ──

  Wiki pages created: ${pages.length}
  Namespaces: engineering, product, onboarding
  Retrievers tested: Metadata, Text, Filter

  Data is LEFT in Notion so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
