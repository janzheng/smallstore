#!/usr/bin/env -S deno run --allow-all
/**
 * Live R2 Direct Adapter Test
 *
 * Tests blob upload/download against real Cloudflare R2.
 *
 * Setup:
 * 1. Go to Cloudflare dashboard → R2
 * 2. Create a bucket (e.g. "smallstore-test")
 * 3. Create an API token with R2 read/write permissions
 * 4. Set env vars:
 *    SM_R2_ACCOUNT_ID=your-cloudflare-account-id
 *    SM_R2_ACCESS_KEY_ID=your-r2-access-key-id
 *    SM_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
 *    SM_R2_BUCKET_NAME=smallstore-test
 *
 * Run: deno task live:r2
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
import { R2DirectAdapter } from '../../../src/adapters/r2-direct.ts';

// ============================================================================
// Credential Check
// ============================================================================

const ACCOUNT_ID = Deno.env.get('SM_R2_ACCOUNT_ID');
const ACCESS_KEY_ID = Deno.env.get('SM_R2_ACCESS_KEY_ID');
const SECRET_ACCESS_KEY = Deno.env.get('SM_R2_SECRET_ACCESS_KEY');
const BUCKET_NAME = Deno.env.get('SM_R2_BUCKET_NAME');

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME
    || ACCOUNT_ID.startsWith('your-')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  R2 Direct Live Test — Setup Required                       ║
╚══════════════════════════════════════════════════════════════╝

Missing credentials. To set up:

1. Go to Cloudflare dashboard → R2
2. Create a bucket (e.g. "smallstore-test")
3. Under R2 → Manage R2 API Tokens, create a token with:
   - Object Read & Write permissions
   - Apply to your bucket

4. Set environment variables in .env:
   SM_R2_ACCOUNT_ID=your-cloudflare-account-id
   SM_R2_ACCESS_KEY_ID=your-access-key-id
   SM_R2_SECRET_ACCESS_KEY=your-secret-access-key
   SM_R2_BUCKET_NAME=smallstore-test

5. Run again: deno task live:r2
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
║  R2 Direct Live Test                                        ║
║  Bucket: ${BUCKET_NAME}${' '.repeat(Math.max(0, 49 - BUCKET_NAME!.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  const adapter = new R2DirectAdapter({
    accountId: ACCOUNT_ID!,
    accessKeyId: ACCESS_KEY_ID!,
    secretAccessKey: SECRET_ACCESS_KEY!,
    bucketName: BUCKET_NAME!,
  });

  const testId = `live-test-${Date.now()}`;

  // ── JSON data ───────────────────────────────────────────────
  console.log('── Step 1: Store JSON data ──');

  const jsonKey = `smallstore-test/${testId}/data.json`;
  await adapter.set(jsonKey, { hello: 'world', timestamp: new Date().toISOString() });
  log('\u2705', `Stored: ${jsonKey}`);

  const jsonResult = await adapter.get(jsonKey);
  log('\ud83d\udcda', `Read back: ${JSON.stringify(jsonResult)}`);

  // ── Binary blob ─────────────────────────────────────────────
  console.log('\n── Step 2: Store binary blob ──');

  // Tiny 1x1 red PNG
  const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const blobKey = `smallstore-test/${testId}/test-image.png`;
  await adapter.set(blobKey, pngBytes);
  log('\u2705', `Stored blob: ${blobKey} (${pngBytes.length} bytes)`);

  const exists = await adapter.has(blobKey);
  log('\ud83d\udd0d', `Exists check: ${exists}`);

  // ── Signed URL ──────────────────────────────────────────────
  console.log('\n── Step 3: Generate signed download URL ──');

  const signedUrl = await adapter.getSignedDownloadUrl(blobKey, { expiresIn: 300 });
  log('\ud83d\udd17', `Signed URL (5 min): ${signedUrl.slice(0, 80)}...`);

  // ── List keys ───────────────────────────────────────────────
  console.log('\n── Step 4: List keys ──');

  const keys = await adapter.keys(`smallstore-test/${testId}/`);
  log('\ud83d\udcc1', `Found ${keys.length} keys:`);
  for (const k of keys) {
    log('  ', k);
  }

  // ── Done ───────────────────────────────────────────────────
  console.log(`
── Done ──

  All R2 operations succeeded!
  Data is LEFT in R2 so you can inspect it in the Cloudflare dashboard.
  Prefix: smallstore-test/${testId}/
`);
}

main().catch(err => {
  console.error('\n\u274c Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
