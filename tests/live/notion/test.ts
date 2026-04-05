#!/usr/bin/env -S deno run --allow-all
/**
 * Live Notion Adapter Test
 *
 * Tests CRUD operations against a real Notion database using the adapter directly.
 *
 * Setup:
 * 1. Go to https://www.notion.so/my-integrations and create an integration
 * 2. Create a database with a Name (title) column — adapter auto-discovers the rest
 * 3. Share the database with your integration (click "..." → "Add connections")
 * 4. Set env vars — see SETUP.md
 *
 * Run: deno task live:notion
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { createNotionAdapter } from '../../../src/adapters/notion.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SECRET = Deno.env.get('SM_NOTION_SECRET');
const DATABASE_ID = Deno.env.get('SM_NOTION_DATABASE_ID');

if (!SECRET || !DATABASE_ID || SECRET.startsWith('secret_XXX') || DATABASE_ID.startsWith('xxx')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Notion Live Test — Setup Required                          ║
╚══════════════════════════════════════════════════════════════╝

Missing credentials. See SETUP.md for instructions.

Required in .env:
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_DATABASE_ID=your-32-char-database-id

Run again: deno task live:notion
`);
  Deno.exit(0);
}

// ============================================================================
// Test (adapter-level, bypasses SmartRouter)
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Notion Live Test (direct adapter)                          ║
║  Database: ${DATABASE_ID!.slice(0, 8)}...${DATABASE_ID!.slice(-4)}${' '.repeat(37)}║
╚══════════════════════════════════════════════════════════════╝
`);

  const adapter = createNotionAdapter({
    notionSecret: SECRET!,
    databaseId: DATABASE_ID!,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
  });

  const testId = `test-${Date.now()}`;

  // ── CREATE ──────────────────────────────────────────────────
  console.log('── Step 1: Create records ──');

  const records = [
    { Name: `Alice-${testId}`, Email: 'alice@test.com', Notes: 'First notion test', Score: 95 },
    { Name: `Bob-${testId}`, Email: 'bob@test.com', Notes: 'Second notion test', Score: 82 },
    { Name: `Carol-${testId}`, Email: 'carol@test.com', Notes: 'Third notion test', Score: 91 },
  ];

  const keys: string[] = [];
  for (const rec of records) {
    const key = `contacts:${rec.Name.toLowerCase().replace(/\s+/g, '-')}`;
    await adapter.set(key, rec);
    keys.push(key);
    log('\u2705', `Created: ${rec.Name} (${rec.Email})`);
  }

  // ── READ ────────────────────────────────────────────────────
  console.log('\n── Step 2: Read back ──');

  for (const key of keys) {
    const result = await adapter.get(key);
    if (result) {
      log('\ud83d\udcda', `Read: ${result.Name} → Score: ${result.Score}, Email: ${result.Email}`);
    } else {
      log('\u274c', `Failed to read: ${key}`);
    }
  }

  // ── UPDATE ──────────────────────────────────────────────────
  console.log('\n── Step 3: Update a record ──');

  const updateKey = keys[0];
  await adapter.set(updateKey, {
    Name: records[0].Name,
    Email: records[0].Email,
    Notes: 'Updated notes — live test verified!',
    Score: 99,
  });
  log('\u270f\ufe0f', `Updated: ${records[0].Name} → Score: 99`);

  // Verify
  const updated = await adapter.get(updateKey);
  if (updated) {
    log('\u2705', `Verified: Score=${updated.Score}, Notes="${updated.Notes}"`);
  }

  // ── LIST ────────────────────────────────────────────────────
  console.log('\n── Step 4: List keys ──');

  const allKeys = await adapter.keys();
  log('\ud83d\udcc1', `Found ${allKeys.length} keys total`);
  for (const k of allKeys.slice(0, 5)) {
    log('  ', k);
  }
  if (allKeys.length > 5) {
    log('  ', `...and ${allKeys.length - 5} more`);
  }

  // ── HAS ───────────────────────────────────────────────────
  console.log('\n── Step 5: Check existence ──');

  const exists = await adapter.has(keys[0]);
  log(exists ? '\u2705' : '\u274c', `has("${keys[0]}"): ${exists}`);

  const notExists = await adapter.has('contacts:nonexistent');
  log(!notExists ? '\u2705' : '\u274c', `has("contacts:nonexistent"): ${notExists}`);

  // ── SUMMARY ─────────────────────────────────────────────────
  console.log(`
── Done ──

  Records created:  ${records.length}
  Check your Notion database to see the data.

  Data is LEFT in Notion so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n\u274c Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
