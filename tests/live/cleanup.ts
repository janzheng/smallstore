#!/usr/bin/env -S deno run --allow-all
/**
 * Live Test Cleanup Utility
 *
 * Deletes stale test data from Airtable that accumulates from
 * repeated live test runs.
 *
 * Identifies test rows by _smallstore_key or Name containing
 * "test-" followed by a timestamp (10+ digits).
 *
 * Usage:
 *   deno task live:cleanup              # Dry run (shows what would be deleted)
 *   deno task live:cleanup --confirm     # Actually delete
 *   deno task live:cleanup --all         # Delete ALL records (careful!)
 */

import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

// ============================================================================
// Config
// ============================================================================

const API_KEY = Deno.env.get('SM_AIRTABLE_API_KEY');
const BASE_ID = Deno.env.get('SM_AIRTABLE_BASE_ID');

const args = Deno.args;
const confirm = args.includes('--confirm');
const deleteAll = args.includes('--all');
const TABLE = 'SmallstoreTest';

if (!API_KEY || !BASE_ID || BASE_ID.startsWith('appXXX')) {
  console.log(`
Missing Airtable credentials. Set in .env:
  SM_AIRTABLE_API_KEY=patXXX...
  SM_AIRTABLE_BASE_ID=appXXX...
`);
  Deno.exit(0);
}

// ============================================================================
// Airtable API helpers
// ============================================================================

interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

async function listAll(): Promise<AirtableRecord[]> {
  const all: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!resp.ok) throw new Error(`List failed: ${resp.status} ${resp.statusText}`);

    const data = await resp.json();
    all.push(...data.records);
    offset = data.offset;
  } while (offset);

  return all;
}

async function deleteRecords(ids: string[]): Promise<void> {
  // Airtable allows max 10 deletes per request
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`);
    for (const id of batch) {
      url.searchParams.append('records[]', id);
    }

    const resp = await fetch(url.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Delete failed: ${resp.status} ${body}`);
    }

    // Rate limit: 5 req/sec
    if (i + 10 < ids.length) await new Promise(r => setTimeout(r, 250));
  }
}

// ============================================================================
// Main
// ============================================================================

function isTestRow(record: AirtableRecord): boolean {
  const key = record.fields._smallstore_key || '';
  const name = record.fields.Name || '';
  return /test-\d{10,}/.test(key) || /test-\d{10,}/.test(name);
}

function describe(r: AirtableRecord): string {
  const key = r.fields._smallstore_key || '(no key)';
  const name = r.fields.Name;
  return name ? `${name}  key=${key}` : `key=${key}`;
}

async function main() {
  console.log(`
+------------------------------------------------------+
|  Live Test Cleanup — ${TABLE}${' '.repeat(Math.max(0, 33 - TABLE.length))}|
|  Base: ${BASE_ID!.slice(0, 8)}...${BASE_ID!.slice(-4)}                                   |
|  Mode: ${deleteAll ? 'DELETE ALL' : confirm ? 'DELETE TEST ROWS' : 'DRY RUN'}${' '.repeat(Math.max(0, deleteAll ? 36 : confirm ? 29 : 40))}|
+------------------------------------------------------+`);

  const allRecords = await listAll();
  console.log(`\n  Total records: ${allRecords.length}`);

  const targets = deleteAll ? allRecords : allRecords.filter(isTestRow);
  console.log(`  ${deleteAll ? 'All' : 'Test'} rows to delete: ${targets.length}`);

  if (targets.length === 0) {
    console.log('  Nothing to clean up.\n');
    return;
  }

  console.log('');
  for (const r of targets) {
    console.log(`  ${confirm ? 'x' : '?'} ${describe(r)}`);
  }

  if (!confirm) {
    console.log(`\n  Run with --confirm to delete these ${targets.length} rows.\n`);
    return;
  }

  console.log(`\n  Deleting ${targets.length} records...`);
  await deleteRecords(targets.map(r => r.id));
  console.log(`  Deleted ${targets.length} records.\n`);
}

main().catch(err => {
  console.error('\nCleanup failed:', err.message);
  Deno.exit(1);
});
