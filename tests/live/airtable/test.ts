#!/usr/bin/env -S deno run --allow-all
/**
 * Live Airtable Adapter Test
 *
 * Tests CRUD operations against a real Airtable base using the adapter directly.
 *
 * Setup:
 * 1. Go to https://airtable.com and create a new base
 * 2. Create a table called "SmallstoreTest" (just needs Name column to start)
 * 3. Get your API key from https://airtable.com/create/tokens
 *    - Scopes: data.records:read, data.records:write, schema.bases:read, schema.bases:write
 * 4. Set env vars — see SETUP.md
 *
 * Run: deno task live:airtable
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { createAirtableAdapter } from '../../../src/adapters/airtable.ts';

// ============================================================================
// Credential Check
// ============================================================================

const API_KEY = Deno.env.get('SM_AIRTABLE_API_KEY');
const BASE_ID = Deno.env.get('SM_AIRTABLE_BASE_ID');
const TABLE_NAME = Deno.env.get('SM_AIRTABLE_TABLE_NAME') || 'SmallstoreTest';

if (!API_KEY || !BASE_ID || BASE_ID.startsWith('appXXX')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Airtable Live Test — Setup Required                        ║
╚══════════════════════════════════════════════════════════════╝

Missing or placeholder credentials. See SETUP.md for instructions.

Required in .env:
  SM_AIRTABLE_API_KEY=pat...your-token...
  SM_AIRTABLE_BASE_ID=appYourBaseId
  SM_AIRTABLE_TABLE_NAME=${TABLE_NAME}

Run again: deno task live:airtable
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
║  Airtable Live Test (direct adapter)                        ║
║  Base: ${BASE_ID}${' '.repeat(Math.max(0, 48 - BASE_ID!.length))}║
║  Table: ${TABLE_NAME}${' '.repeat(Math.max(0, 47 - TABLE_NAME.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  const adapter = createAirtableAdapter({
    apiKey: API_KEY!,
    baseId: BASE_ID!,
    tableIdOrName: TABLE_NAME,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    timeout: 60000, // 60s timeout for slow API
  });

  const testId = `test-${Date.now()}`;

  // ── CREATE ──────────────────────────────────────────────────
  console.log('── Step 1: Create records ──');

  const records = [
    { Name: `Alice-${testId}`, Email: 'alice@test.com', Notes: 'First test record', Score: 95 },
    { Name: `Bob-${testId}`, Email: 'bob@test.com', Notes: 'Second test record', Score: 82 },
    { Name: `Carol-${testId}`, Email: 'carol@test.com', Notes: 'Third test record', Score: 91 },
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
  Check your Airtable: https://airtable.com/${BASE_ID}

  Data is LEFT in Airtable so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n\u274c Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
