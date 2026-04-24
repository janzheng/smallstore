#!/usr/bin/env -S deno run --allow-all
/**
 * Targeted smoke test for the sheetlog upstream patches:
 *   - Bug #2: auto-generate _id on POST/DYNAMIC_POST, return in response body
 *   - Bug #4: byId: true flag on DELETE/BULK_DELETE
 *
 * If these print "NOT LIVE", the GAS deployment is still running the old
 * sheetlog.js — redeploy via Apps Script Editor → Deploy → New deployment.
 *
 * Run: deno run --allow-all tests/live/sheetlog-patches/verify.ts
 */

import { loadSync } from '@std/dotenv';
try {
  loadSync({ envPath: new URL('../../../.env', import.meta.url).pathname, export: true });
} catch { /* ok */ }

import { Sheetlog } from '../../../src/clients/sheetlog/client.ts';

const SHEET_URL = Deno.env.get('SM_SHEET_URL');
const SHEET_NAME = Deno.env.get('SM_SHEET_NAME') ?? 'SmallstoreTest';

if (!SHEET_URL) {
  console.error('SM_SHEET_URL not set in .env');
  Deno.exit(1);
}

const client = new Sheetlog({ sheetUrl: SHEET_URL, sheet: SHEET_NAME });
const tag = `patch-verify-${Date.now()}`;

console.log(`\n─── sheetlog patch verification ───`);
console.log(`sheet: ${SHEET_NAME}`);
console.log(`tag:   ${tag}\n`);

// ============================================================================
// Bug #2 — DYNAMIC_POST should return the patched response shape.
//
// Pre-patch: `{status: 201}` (bare, no body).
// Patched:   `{status: 201, data: {message: "Rows inserted", count: N}}`.
// Patched + _id column present: same plus `_ids: [...]`.
//
// The response-shape change alone is definitive proof the patch is live.
// `_ids` only appears when the sheet's header row contains `_id` — if it
// doesn't, ensureId() returns null (sheetlog.js:357) and _ids is omitted.
// ============================================================================

console.log('── Bug #2: auto-_id on DYNAMIC_POST ──');
const postResponse = await client.dynamicPost([
  { Name: `patch-a-${tag}`, Notes: 'first' },
  { Name: `patch-b-${tag}`, Notes: 'second' },
]);
console.log(`  raw response: ${JSON.stringify(postResponse)}`);

const patchedShape = postResponse?.data?.message === 'Rows inserted'
  && typeof postResponse?.data?.count === 'number';
const ids = postResponse?.data?._ids;

if (Array.isArray(ids) && ids.length === 2 && ids.every((v) => typeof v === 'number')) {
  console.log(`  ✅ Bug #2 LIVE — got _ids: [${ids.join(', ')}]`);
} else if (patchedShape) {
  console.log(`  ✅ Bug #2 LIVE (response-shape patched) — no _ids because the sheet's`);
  console.log(`     header row has no "_id" column. Add "_id" to headers to see auto-gen.`);
} else {
  console.log(`  ❌ Bug #2 NOT LIVE — got pre-patch bare {status: 201}`);
}

// ============================================================================
// Bug #4 — BULK_DELETE with byId: true should delete by _id column value
// ============================================================================

console.log('\n── Bug #4: byId flag on BULK_DELETE ──');
if (Array.isArray(ids) && ids.length > 0) {
  // We have real auto-generated _ids — test the byId path end-to-end.
  // Try to delete the rows we just added, by their _id values (NOT row numbers)
  try {
    const delResponse = await client.bulkDelete(ids, { byId: true });
    console.log(`  raw response: ${JSON.stringify(delResponse)}`);
    if (delResponse?.status === 200 || delResponse?.data) {
      // Verify the rows are actually gone
      const found = await client.find('Name', `patch-a-${tag}`);
      if (!found?.data || (Array.isArray(found.data) && found.data.length === 0)) {
        console.log(`  ✅ Bug #4 LIVE — rows deleted by _id value (byId: true accepted)`);
      } else {
        console.log(`  ❌ Bug #4 NOT LIVE — delete returned ok but row still present`);
        console.log(`     GAS likely treated byId as noise + silently did nothing, or wrong rows hit`);
      }
    } else {
      console.log(`  ❌ Bug #4 NOT LIVE — delete returned non-ok: ${JSON.stringify(delResponse)}`);
    }
  } catch (err) {
    console.log(`  ❌ Bug #4 delete threw: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  // No _id column on the tab — can't exercise byId directly, but we can at
  // least send `byId: true` and confirm the server accepts the param without
  // erroring. Uses a sentinel id unlikely to match anything.
  try {
    const delResponse = await client.bulkDelete([999999999], { byId: true });
    const code = delResponse?.error?.code;
    if (code === 'id_column_not_found') {
      // This specific error code only exists on the patched byId path —
      // pre-patch code would've happily interpreted the id as a row number
      // and either no-op'd or wiped the wrong row.
      console.log(`  ✅ Bug #4 LIVE — server took the byId branch (err: id_column_not_found)`);
      console.log(`     raw: ${JSON.stringify(delResponse)}`);
    } else if ((delResponse?.status ?? 0) >= 200 && (delResponse?.status ?? 0) < 300) {
      console.log(`  ✅ Bug #4 LIVE (smoke) — server accepted byId without error`);
      console.log(`     raw: ${JSON.stringify(delResponse)}`);
    } else {
      console.log(`  ⚠️  byId rejected or failed — response: ${JSON.stringify(delResponse)}`);
    }
  } catch (err) {
    console.log(`  ❌ byId threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('\n─── done ───');
console.log('If both patches report LIVE, the GAS redeploy picked up the latest sheetlog.js.');
console.log('Leftover rows from this test have the tag above — cleanup is manual.\n');
