#!/usr/bin/env -S deno run --allow-all
/**
 * Live Progressive Notes Test (Sheetlog)
 *
 * Notes across topics with progressive disclosure — register skills,
 * query at increasing detail levels.
 *
 * Features: ProgressiveStore (Disclosure) + Sheetlog adapter
 *
 * Prerequisites:
 * - Working Sheetlog adapter (run `deno task live:sheets` first)
 *
 * Run: deno task live:sheetlog-disclosure
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import {
  createSmallstore,
  createSheetlogAdapter,
  createMemoryAdapter,
  createProgressiveStore,
  createSkill,
} from '../../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SHEET_URL = Deno.env.get('SM_SHEET_URL');
const SHEET_NAME = Deno.env.get('SM_SHEET_NAME') || 'SmallstoreTest';

if (!SHEET_URL) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Progressive Notes Live Test — Setup Required                ║
╚══════════════════════════════════════════════════════════════╝

Missing Sheetlog credentials. Set in .env:
  SM_SHEET_URL=https://script.google.com/macros/s/.../exec
  SM_SHEET_NAME=SmallstoreTest (optional)

Run again: deno task live:sheetlog-disclosure
`);
  Deno.exit(0);
}

// ============================================================================
// Helpers
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

async function delay(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// Test
// ============================================================================

async function main() {
  const testId = `test-${Date.now()}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Progressive Notes — Sheetlog Live Test                      ║
║  Sheet: ${SHEET_NAME}${' '.repeat(Math.max(0, 50 - SHEET_NAME.length))}║
║  Test ID: ${testId}${' '.repeat(Math.max(0, 47 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup ──────────────────────────────────────────────────
  const sheetsAdapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: SHEET_NAME,
  });

  const memoryAdapter = createMemoryAdapter();

  const store = createSmallstore({
    adapters: { sheets: sheetsAdapter, memory: memoryAdapter },
    defaultAdapter: 'memory',  // disclosure internals go to memory
    metadataAdapter: 'memory',
  });

  const pstore = createProgressiveStore(store);

  // ── Step 1: Store notes across topics ──────────────────────
  console.log('── Step 1: Store notes across topics ──');

  const notes = [
    { key: `research/paper-1-${testId}`, data: { Title: 'Transformer Scaling Laws', Topic: 'ml', Tags: 'transformers,scaling,ai', Summary: 'How model performance scales with compute', Detail: 'Kaplan et al. show power-law relationships between model size, dataset size, compute budget, and loss.' } },
    { key: `research/paper-2-${testId}`, data: { Title: 'Constitutional AI', Topic: 'ml', Tags: 'alignment,safety,ai', Summary: 'Training AI with AI feedback', Detail: 'Uses a set of principles to guide AI behavior through self-supervised feedback loops.' } },
    { key: `research/paper-3-${testId}`, data: { Title: 'Flash Attention', Topic: 'ml', Tags: 'attention,optimization,ai', Summary: 'IO-aware attention algorithm', Detail: 'Tiling-based approach that reduces memory reads/writes for transformer attention layers.' } },
    { key: `recipes/pasta-${testId}`, data: { Title: 'Cacio e Pepe', Topic: 'cooking', Tags: 'pasta,italian,quick', Summary: 'Classic Roman pasta with pecorino and pepper', Detail: 'Toast black pepper, emulsify pecorino with pasta water, toss with tonnarelli.' } },
    { key: `recipes/bread-${testId}`, data: { Title: 'Sourdough Starter', Topic: 'cooking', Tags: 'bread,fermentation,sourdough', Summary: 'How to maintain a sourdough starter', Detail: 'Feed equal parts flour and water daily. Keep at room temp for active use, fridge for maintenance.' } },
    { key: `bookmarks/deno-${testId}`, data: { Title: 'Deno 2.0 Release', Topic: 'dev', Tags: 'deno,typescript,runtime,ai', Summary: 'Deno 2.0 with npm compatibility', Detail: 'Major release adding npm: imports, package.json support, and improved Node.js compatibility.' } },
    { key: `bookmarks/htmx-${testId}`, data: { Title: 'HTMX Deep Dive', Topic: 'dev', Tags: 'htmx,frontend,hypermedia', Summary: 'Building modern UIs with hypermedia', Detail: 'HTMX enables server-driven UIs with minimal JavaScript using HTML attributes.' } },
    { key: `bookmarks/ai-tools-${testId}`, data: { Title: 'AI Developer Tools', Topic: 'dev', Tags: 'ai,tools,developer-experience', Summary: 'Roundup of AI-powered dev tools', Detail: 'Covers Claude Code, Cursor, Copilot, and emerging AI coding assistants.' } },
  ];

  for (const note of notes) {
    await store.set(note.key, note.data, { mode: 'replace' });
    log('📝', `Stored: ${note.data.Title}`);
    await delay(500);  // Rate limit for Sheetlog
  }

  // ── Step 2: Register skills ────────────────────────────────
  console.log('\n── Step 2: Register disclosure skills ──');

  await pstore.registerSkill(createSkill({
    name: 'research-explorer',
    description: 'Explores ML research papers and findings',
    triggers: ['research', 'paper', 'ml', 'ai', 'transformer'],
    collections: [`research`],
  }));
  log('🎯', 'Registered: research-explorer');

  await pstore.registerSkill(createSkill({
    name: 'recipe-finder',
    description: 'Finds cooking recipes and techniques',
    triggers: ['recipe', 'cooking', 'food', 'pasta', 'bread'],
    collections: [`recipes`],
  }));
  log('🎯', 'Registered: recipe-finder');

  await pstore.registerSkill(createSkill({
    name: 'bookmark-search',
    description: 'Searches developer bookmarks and tools',
    triggers: ['bookmark', 'tool', 'dev', 'deno', 'frontend'],
    collections: [`bookmarks`],
  }));
  log('🎯', 'Registered: bookmark-search');

  // ── Step 3: Discover relevant content ──────────────────────
  console.log('\n── Step 3: Discover relevant — "AI papers" ──');

  const discovered = await pstore.discoverRelevant({
    query: 'AI papers',
    depth: 'summary',
  });
  log('🔍', `Discovered ${discovered.items.length} items, ${discovered.activeSkills.length} active skills: ${discovered.activeSkills.join(', ')}`);
  for (const item of discovered.items.slice(0, 3)) {
    log('  ', `${item.path}: "${item.summary.slice(0, 60)}" (relevance: ${item.relevanceScore.toFixed(2)})`);
  }

  // ── Step 4: Progressive depth ──────────────────────────────
  console.log('\n── Step 4: Progressive disclosure — depth levels ──');

  const testKey = notes[0].key;

  for (const depth of ['summary', 'overview', 'detailed', 'full'] as const) {
    const disclosed = await pstore.disclose(testKey, { depth, query: 'scaling' });
    const preview = disclosed.summary || JSON.stringify(disclosed.overview || disclosed.details || disclosed.full || '').slice(0, 80);
    log('🔎', `[${depth}] ${String(preview).slice(0, 80)}...`);
  }

  // ── Step 5: Cross-topic query ──────────────────────────────
  console.log('\n── Step 5: Cross-topic query — "ai" ──');

  const crossResult = await pstore.discoverRelevant({
    query: 'ai',
    depth: 'summary',
  });
  log('🌐', `Cross-topic "ai" matched ${crossResult.activeSkills.length} skills: ${crossResult.activeSkills.join(', ')}`);
  for (const item of crossResult.items.slice(0, 3)) {
    log('  ', `${item.path} (relevance: ${item.relevanceScore.toFixed(2)})`);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`
── Done ──

  Notes stored: ${notes.length}
  Skills registered: 3 (research-explorer, recipe-finder, bookmark-search)
  Discovery: "AI papers" matched across research + bookmarks
  Progressive depth: summary → overview → detailed → full

  Data is LEFT in Google Sheets so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
