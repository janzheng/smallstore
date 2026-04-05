#!/usr/bin/env -S deno run --allow-all
/**
 * Live Sheetlog / Google Sheets Test
 *
 * Tests CRUD operations against a real Google Sheet via Sheetlog.
 *
 * Setup:
 * 1. Deploy the Sheetlog Apps Script to a Google Sheet
 *    → See https://github.com/yawnxyz/sheetlog for setup
 * 2. Create a sheet/tab called "SmallstoreTest"
 * 3. Set env vars:
 *    SM_SHEET_URL=https://script.google.com/macros/s/.../exec
 *    SM_SHEET_NAME=SmallstoreTest
 *
 * Run: deno task live:sheets
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
import { Sheetlog } from '../../../src/clients/sheetlog/client.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SHEET_URL = Deno.env.get('SM_SHEET_URL');
const SHEET_NAME = Deno.env.get('SM_SHEET_NAME') || 'SmallstoreTest';

if (!SHEET_URL || SHEET_URL.includes('your-script-id')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Sheetlog Live Test — Setup Required                        ║
╚══════════════════════════════════════════════════════════════╝

Missing credentials. To set up:

1. Create a Google Sheet
2. Deploy the Sheetlog Apps Script:
   → https://github.com/yawnxyz/sheetlog
3. Create a tab called "${SHEET_NAME}"

4. Set environment variables in .env:
   SM_SHEET_URL=https://script.google.com/macros/s/your-script-id/exec
   SM_SHEET_NAME=${SHEET_NAME}

5. Run again: deno task live:sheets
`);
  Deno.exit(0);
}

// ============================================================================
// Test
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Sheetlog Live Test                                         ║
║  Sheet: ${SHEET_NAME}${' '.repeat(Math.max(0, 50 - SHEET_NAME.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new Sheetlog({
    sheetUrl: SHEET_URL,
    sheet: SHEET_NAME,
  });

  const testId = `test-${Date.now()}`;

  // ── CREATE ──────────────────────────────────────────────────
  console.log('── Step 1: Create rows ──');

  const rows = [
    { Name: `Alice-${testId}`, Email: 'alice@test.com', Notes: 'First row', Score: 95 },
    { Name: `Bob-${testId}`, Email: 'bob@test.com', Notes: 'Second row', Score: 82 },
    { Name: `Carol-${testId}`, Email: 'carol@test.com', Notes: 'Third row', Score: 91 },
  ];

  // dynamicPost auto-creates columns for any new fields
  const result = await client.dynamicPost(rows);
  log('\u2705', `Created ${rows.length} rows`);
  log('\ud83d\udcdd', `Response: ${JSON.stringify(result)?.slice(0, 100)}`);

  // ── READ ────────────────────────────────────────────────────
  console.log('\n── Step 2: Read all rows ──');

  const allRows = await client.get();
  if (Array.isArray(allRows)) {
    log('\ud83d\udcda', `Got ${allRows.length} rows total`);
    for (const row of allRows.slice(-3)) {
      log('  ', `${row.Name} — ${row.Email} — Score: ${row.Score}`);
    }
  } else {
    log('\ud83d\udcda', `Response: ${JSON.stringify(allRows)?.slice(0, 200)}`);
  }

  // ── FIND ────────────────────────────────────────────────────
  console.log('\n── Step 3: Find by column value ──');

  const found = await client.find('Name', `Alice-${testId}`);
  log('\ud83d\udd0d', `Find Alice: ${JSON.stringify(found)?.slice(0, 200)}`);

  // ── UPSERT ──────────────────────────────────────────────────
  console.log('\n── Step 4: Upsert (update Alice\'s score) ──');

  await client.upsert('Name', `Alice-${testId}`, {
    Name: `Alice-${testId}`,
    Score: 99,
    Notes: 'Updated via upsert!',
  });
  log('\u270f\ufe0f', `Upserted Alice with Score=99`);

  // Verify
  const updated = await client.find('Name', `Alice-${testId}`);
  log('\u2705', `Verified: ${JSON.stringify(updated)?.slice(0, 200)}`);

  console.log(`
── Done ──

  Rows created:  ${rows.length}
  Data is LEFT in the sheet so you can inspect it.
  Open your Google Sheet to see the results.
`);
}

main().catch(err => {
  console.error('\n\u274c Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
