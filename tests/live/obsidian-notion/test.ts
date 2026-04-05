#!/usr/bin/env -S deno run --allow-all
/**
 * Live Obsidian <-> Notion Sync Test
 *
 * Syncs notes between a local Obsidian vault and a Notion database.
 * Demonstrates real cross-adapter sync: markdown files <-> Notion pages.
 *
 * Features: ObsidianAdapter + NotionAdapter + bidirectional sync
 *
 * Prerequisites:
 * - Working Notion adapter (run `deno task live:notion` first)
 * - Test vault at tests/test-obsidian-vault/
 *
 * Run: deno task live:obsidian-notion
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { ObsidianAdapter } from '../../../src/adapters/obsidian.ts';
import { createNotionAdapter, type NotionAdapterConfig } from '../../../src/adapters/notion.ts';
import { copy } from "@std/fs/copy";

// ============================================================================
// Credential Check
// ============================================================================

const NOTION_SECRET = Deno.env.get('SM_NOTION_SECRET');
const NOTION_DB = Deno.env.get('SM_NOTION_DATABASE_ID');

if (!NOTION_SECRET || !NOTION_DB || NOTION_SECRET.startsWith('secret_XXX')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Obsidian <-> Notion Live Sync Test — Setup Required         ║
╚══════════════════════════════════════════════════════════════╝

Missing Notion credentials. Set in .env:
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_DATABASE_ID=your-database-id

Run again: deno task live:obsidian-notion
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

const TEST_VAULT_SRC = new URL("../../test-obsidian-vault", import.meta.url).pathname;

async function makeTempVault(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "obsidian-notion-live-" });
  await copy(TEST_VAULT_SRC, dir, { overwrite: true });
  return {
    dir,
    cleanup: async () => {
      try { await Deno.remove(dir, { recursive: true }); } catch { /* ok */ }
    },
  };
}

// ============================================================================
// Test
// ============================================================================

async function main() {
  const testId = `obs-notion-${Date.now()}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Obsidian <-> Notion Live Sync Test                          ║
║  Notion DB: ${NOTION_DB!.slice(0, 8)}...${NOTION_DB!.slice(-4)}${' '.repeat(36)}║
║  Test ID: ${testId}${' '.repeat(Math.max(0, 45 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  const { dir, cleanup } = await makeTempVault();

  const obsidian = new ObsidianAdapter({ vaultDir: dir });
  const notion = createNotionAdapter({
    notionSecret: NOTION_SECRET!,
    databaseId: NOTION_DB!,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
  });

  const createdNotionKeys: string[] = [];

  try {
    // ── Phase 1: Obsidian -> Notion ─────────────────────────────

    console.log('\n── Phase 1: Export Obsidian notes to Notion ──');

    const obsKeys = await obsidian.keys();
    log('📁', `Found ${obsKeys.length} notes in Obsidian vault`);

    for (const key of obsKeys) {
      const note = await obsidian.get(key);
      if (!note) continue;

      // Build a structured record for Notion
      const notionKey = `${testId}/${key}`;
      // Use "Name" for Notion's built-in title property, "note_title" for our field
      // to avoid conflicting with Notion's title property type
      const record: Record<string, unknown> = {
        Name: note.title,
        note_title: note.title,
        note_status: (note.properties?.status as string) ?? 'unknown',
        note_tags: (note.tags ?? []).join(', '),
        source: 'obsidian',
        note_path: note.path,
        raw_content: note.raw.slice(0, 2000), // Notion rich_text limit
      };

      try {
        await notion.set(notionKey, record);
        createdNotionKeys.push(notionKey);
        log('✅', `Exported: ${key} -> Notion (${notionKey})`);
      } catch (e) {
        log('❌', `Failed to export ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Rate limit: Notion API has 3 req/sec limit
      await delay(400);
    }

    log('📊', `Exported ${createdNotionKeys.length}/${obsKeys.length} notes to Notion`);

    // ── Phase 2: Verify in Notion ───────────────────────────────

    console.log('\n── Phase 2: Verify notes exist in Notion ──');

    for (const nKey of createdNotionKeys) {
      const data = await notion.get(nKey);
      if (data) {
        log('✅', `Verified: ${nKey} — title: ${data.note_title || data.Name || '(untitled)'}`);
      } else {
        log('❌', `Missing: ${nKey}`);
      }
      await delay(350);
    }

    // ── Phase 3: Notion -> Obsidian (new vault) ─────────────────

    console.log('\n── Phase 3: Import from Notion back to a fresh vault ──');

    const importDir = await Deno.makeTempDir({ prefix: "obsidian-notion-import-" });
    const obsidianImport = new ObsidianAdapter({ vaultDir: importDir });

    let importCount = 0;
    for (const nKey of createdNotionKeys) {
      const data = await notion.get(nKey);
      if (!data) continue;

      // Strip test prefix from key for the import vault
      const obsKey = nKey.replace(`${testId}/`, '');

      // If we have raw_content from the roundtrip, use it
      if (data.raw_content) {
        await obsidianImport.set(obsKey, data.raw_content);
      } else {
        // Build markdown from Notion properties
        const title = data.note_title || data.Name || obsKey;
        const md = `---
title: "${title}"
source: notion-import
status: "${data.note_status || 'unknown'}"
---

# ${title}

Imported from Notion on ${new Date().toISOString().split('T')[0]}.
`;
        await obsidianImport.set(obsKey, md);
      }

      importCount++;
      log('✅', `Imported: Notion -> ${obsKey}`);
      await delay(350);
    }

    log('📊', `Imported ${importCount} notes from Notion`);

    // Verify the import vault
    const importKeys = await obsidianImport.keys();
    log('📁', `Import vault has ${importKeys.length} notes`);

    for (const key of importKeys) {
      const note = await obsidianImport.get(key);
      if (note) {
        log('  📝', `${key}: title="${note.title}", properties=${JSON.stringify(note.properties).slice(0, 60)}...`);
      }
    }

    obsidianImport.close();
    try { await Deno.remove(importDir, { recursive: true }); } catch { /* ok */ }

    // ── Phase 4: Cleanup (SKIPPED) ──────────────────────────────

    console.log('\n── Phase 4: Cleanup SKIPPED — data left in Notion for exploration ──');
    log('📌', `Keys in Notion: ${createdNotionKeys.join(', ')}`);

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Test Complete!                                               ║
║  Exported ${String(createdNotionKeys.length).padEnd(3)} notes: Obsidian -> Notion                    ║
║  Imported ${String(importCount).padEnd(3)} notes: Notion -> Obsidian                    ║
║  Data left in Notion for exploration                           ║
╚══════════════════════════════════════════════════════════════╝
`);

  } catch (e) {
    console.error('\n❌ Test failed:', e);

    // Best-effort cleanup on failure
    console.log('\nAttempting cleanup...');
    for (const nKey of createdNotionKeys) {
      try {
        await notion.delete(nKey);
        log('🗑️', `Cleaned up: ${nKey}`);
      } catch { /* ok */ }
      await delay(350);
    }
  } finally {
    obsidian.close();
    await cleanup();
  }
}

main();
