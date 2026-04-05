#!/usr/bin/env -S deno run --allow-all
/**
 * Live Adapter Search Test
 *
 * Tests BM25 search on Airtable and Notion adapters using real data.
 * Pattern: hydrate (keys → get all) → search → verify results.
 *
 * Run: deno run --allow-all tests/live/adapter-search/test.ts
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

// ============================================================================
// Airtable Search Test
// ============================================================================

async function testAirtableSearch() {
  const API_KEY = Deno.env.get('SM_AIRTABLE_API_KEY');
  const BASE_ID = Deno.env.get('SM_AIRTABLE_BASE_ID');
  const TABLE_NAME = Deno.env.get('SM_AIRTABLE_TABLE_NAME') || 'SmallstoreTest';

  if (!API_KEY || !BASE_ID || BASE_ID.startsWith('appXXX')) {
    log('⏭️', 'Airtable: skipped (no credentials)');
    return;
  }

  console.log('\n── Airtable Search Test ──');

  const { createAirtableAdapter } = await import('../../../src/adapters/airtable.ts');

  const adapter = createAirtableAdapter({
    apiKey: API_KEY!,
    baseId: BASE_ID!,
    tableIdOrName: TABLE_NAME,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    timeout: 60000,
  });

  // Step 1: Write test records with searchable content
  const testId = `search-${Date.now()}`;
  const records = [
    { Name: `SearchAlice-${testId}`, description: 'Machine learning engineer at Acme Corp' },
    { Name: `SearchBob-${testId}`, description: 'Frontend designer specializing in React' },
    { Name: `SearchCarol-${testId}`, description: 'Data scientist working on machine learning models' },
  ];

  const keys: string[] = [];
  for (const rec of records) {
    const key = `search-test:${rec.Name.toLowerCase()}`;
    await adapter.set(key, rec);
    keys.push(key);
    log('✅', `Created: ${rec.Name}`);
  }

  // Step 2: Search — the BM25 index was populated during set()
  const searchProvider = adapter.searchProvider;
  if (!searchProvider) {
    log('❌', 'No search provider on adapter!');
    return;
  }

  log('🔍', `Search provider: ${searchProvider.name}`);

  const results = searchProvider.search('machine learning');
  log('📊', `"machine learning" → ${results.length} results`);
  for (const r of results) {
    log('  ', `${r.key} (score: ${r.score.toFixed(3)}) — ${r.snippet?.slice(0, 60)}`);
  }

  if (results.length >= 2) {
    log('✅', 'Search found expected records');
  } else {
    log('❌', `Expected >=2 results, got ${results.length}`);
  }

  // Step 3: Hydration pattern — get all existing records and index them
  console.log('\n  ── Hydration test ──');
  const allKeys = await adapter.keys();
  log('📁', `Total keys in table: ${allKeys.length}`);

  let hydrated = 0;
  for (const k of allKeys) {
    const data = await adapter.get(k);
    if (data) {
      searchProvider.index(k, data);
      hydrated++;
    }
  }
  log('💧', `Hydrated ${hydrated} records into BM25 index`);

  // Now search across ALL data (not just our test records)
  const allResults = searchProvider.search('test');
  log('🔍', `"test" across all data → ${allResults.length} results`);

  // Cleanup: delete test records
  console.log('\n  ── Cleanup ──');
  for (const key of keys) {
    await adapter.delete(key);
    log('🗑️', `Deleted: ${key}`);
  }

  log('✅', 'Airtable search test complete');
}

// ============================================================================
// Notion Search Test
// ============================================================================

async function testNotionSearch() {
  const NOTION_SECRET = Deno.env.get('SM_NOTION_SECRET');
  const DATABASE_ID = Deno.env.get('SM_NOTION_DATABASE_ID');

  if (!NOTION_SECRET || !DATABASE_ID || DATABASE_ID.startsWith('xxx')) {
    log('⏭️', 'Notion: skipped (no credentials)');
    return;
  }

  console.log('\n── Notion Search Test ──');

  const { NotionDatabaseAdapter } = await import('../../../src/adapters/notion.ts');

  const adapter = new NotionDatabaseAdapter({
    notionSecret: NOTION_SECRET!,
    databaseId: DATABASE_ID!,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
  });

  // Step 1: Write test records
  const testId = `search-${Date.now()}`;
  const records = [
    { Name: `NotionAlice-${testId}`, description: 'Backend systems engineer' },
    { Name: `NotionBob-${testId}`, description: 'Product designer and researcher' },
    { Name: `NotionCarol-${testId}`, description: 'Systems engineer and architect' },
  ];

  const keys: string[] = [];
  for (const rec of records) {
    const key = `notion-search:${rec.Name.toLowerCase()}`;
    await adapter.set(key, rec);
    keys.push(key);
    log('✅', `Created: ${rec.Name}`);
  }

  // Step 2: Search
  const searchProvider = adapter.searchProvider;
  if (!searchProvider) {
    log('❌', 'No search provider on adapter!');
    return;
  }

  log('🔍', `Search provider: ${searchProvider.name}`);

  const results = searchProvider.search('engineer');
  log('📊', `"engineer" → ${results.length} results`);
  for (const r of results) {
    log('  ', `${r.key} (score: ${r.score.toFixed(3)})`);
  }

  if (results.length >= 1) {
    log('✅', 'Search found expected records');
  } else {
    log('❌', `Expected >=1 results, got ${results.length}`);
  }

  // Step 3: Hydrate all existing records
  console.log('\n  ── Hydration test ──');
  const allKeys = await adapter.keys();
  log('📁', `Total keys in database: ${allKeys.length}`);

  let hydrated = 0;
  for (const k of allKeys) {
    const data = await adapter.get(k);
    if (data) {
      searchProvider.index(k, data);
      hydrated++;
    }
  }
  log('💧', `Hydrated ${hydrated} records into BM25 index`);

  // Cleanup
  console.log('\n  ── Cleanup ──');
  for (const key of keys) {
    await adapter.delete(key);
    log('🗑️', `Deleted: ${key}`);
  }

  log('✅', 'Notion search test complete');
}

// ============================================================================
// Run
// ============================================================================

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Live Adapter Search Test (BM25 on Airtable + Notion)       ║
╚══════════════════════════════════════════════════════════════╝`);

  await testAirtableSearch();
  await testNotionSearch();

  console.log('\n── All done ──\n');
}

main().catch(err => {
  console.error('Test failed:', err);
  Deno.exit(1);
});
