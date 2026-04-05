#!/usr/bin/env -S deno run --allow-all
/**
 * Interactive Obsidian <-> Notion bidirectional sync demo.
 *
 * Uses syncAdapters() with syncId for true 3-way merge:
 * - Edits on Obsidian side push to Notion
 * - Edits on Notion side pull to Obsidian
 * - Conflicts (both sides edited) are reported
 *
 * Run: deno run --allow-all tests/live/obsidian-notion/sync-demo.ts
 */

import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { ObsidianAdapter } from '../../../src/adapters/obsidian.ts';
import { createNotionAdapter } from '../../../src/adapters/notion.ts';
import { syncAdapters } from '../../../src/sync.ts';

const NOTION_SECRET = Deno.env.get('SM_NOTION_SECRET')!;
const NOTION_DB = Deno.env.get('SM_NOTION_DATABASE_ID')!;

if (!NOTION_SECRET || !NOTION_DB) {
  console.log('Missing SM_NOTION_SECRET or SM_NOTION_DATABASE_ID in .env');
  Deno.exit(0);
}

const TEST_VAULT = new URL("../../test-obsidian-vault", import.meta.url).pathname;

const obsidian = new ObsidianAdapter({ vaultDir: TEST_VAULT });
const notion = createNotionAdapter({
  notionSecret: NOTION_SECRET,
  databaseId: NOTION_DB,
  introspectSchema: true,
  unmappedStrategy: 'auto-create',
  contentProperty: 'body_content',  // Store full note content in page body
});

const PREFIX = 'obs-sync/';
const SYNC_ID = 'obsidian-notion-demo';

// ── Phase 1: Show what's on both sides ──────────────────────────

console.log('\n── Obsidian vault ──');
const obsKeys = await obsidian.keys();
for (const key of obsKeys) {
  const note = await obsidian.get(key);
  const snippet = note?.raw?.slice(0, 80)?.replace(/\n/g, ' ') ?? '';
  console.log(`  📝 ${key}: "${note?.title}" — ${snippet}...`);
}

console.log('\n── Notion DB (obs-sync/* keys) ──');
const notionKeys = await notion.keys();
const prefixedKeys = notionKeys.filter(k => k.startsWith(PREFIX));
console.log(`  Found ${prefixedKeys.length} keys with prefix "${PREFIX}"`);
for (const key of prefixedKeys) {
  const data = await notion.get(key);
  console.log(`  📄 ${key}: "${data?.note_title || data?.Name || '?'}" — source: ${data?.source ?? '?'}`);
}

// ── Phase 2: Bidirectional sync with 3-way merge ────────────────

console.log('\n── Bidirectional sync (Obsidian ↔ Notion) ──');
const result = await syncAdapters(obsidian, notion, {
  mode: 'sync',
  syncId: SYNC_ID,
  targetPrefix: PREFIX,
  conflictResolution: 'source-wins',  // Obsidian wins on conflicts
  batchDelay: 200,
  baselineAdapter: notion,  // Store baseline in Notion (persists across runs)
  transform: (key, value) => {
    // When pushing (Obsidian → Notion): transform note to Notion fields
    if (value?.raw !== undefined && value?.title !== undefined) {
      return {
        key: PREFIX + key,
        value: {
          Name: value.title,
          note_title: value.title,
          note_status: value.properties?.status ?? 'unknown',
          note_tags: (value.tags ?? []).join(', '),
          source: 'obsidian',
          note_path: value.path,
          body_content: value.raw ?? '',  // Full content → page body (no truncation)
        },
      };
    }
    // When pulling (Notion → Obsidian): use body_content from page body
    if (value?.body_content) {
      return { key, value: value.body_content };
    }
    const title = value?.note_title || value?.Name || key;
    const md = `---\ntitle: "${title}"\nsource: notion\nstatus: "${value?.note_status || 'unknown'}"\n---\n\n# ${title}\n\nImported from Notion.\n`;
    return { key, value: md };
  },
  onProgress: (e) => {
    console.log(`  [${e.index + 1}/${e.total}] ${e.phase}: ${e.key}`);
  },
});

console.log(`\n  Result:`);
console.log(`    created:   ${result.created}`);
console.log(`    updated:   ${result.updated}`);
console.log(`    skipped:   ${result.skipped}`);
console.log(`    deleted:   ${result.deleted}`);
console.log(`    conflicts: ${result.conflicts}`);
console.log(`    errors:    ${result.errors.length}`);

if (result.keys.conflicts.length > 0) {
  console.log(`  Conflicts: ${result.keys.conflicts.join(', ')}`);
}
if (result.errors.length > 0) {
  for (const err of result.errors) console.log(`  ❌ ${err.key}: ${err.error}`);
}
if (result.baseline) {
  console.log(`  Baseline saved with ${Object.keys(result.baseline.entries).length} entries`);
}

// ── Summary ─────────────────────────────────────────────────────

console.log('\n── Final state ──');
const finalObsKeys = await obsidian.keys();
console.log(`  Obsidian vault: ${finalObsKeys.length} notes`);
for (const k of finalObsKeys) {
  const n = await obsidian.get(k);
  console.log(`    📝 ${k}: "${n?.title}"`);
}

const finalNotionKeys = (await notion.keys()).filter(k => k.startsWith(PREFIX));
console.log(`  Notion (${PREFIX}*): ${finalNotionKeys.length} notes`);

obsidian.close();
console.log('\nDone!');
