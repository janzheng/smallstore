#!/usr/bin/env -S deno run --allow-all
/**
 * Live Airtable + Blob Middleware Test
 *
 * Fetches bunny images from the web, uploads them to R2 via blob middleware,
 * and stores contacts in Airtable with profile photos as attachment URLs.
 *
 * Prerequisites:
 * - Working Airtable adapter (run `deno task live:airtable` first)
 * - Working R2 adapter (run `deno task live:r2` first)
 *
 * Run: deno task live:airtable-blobs
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { createSmallstore, createAirtableAdapter, createMemoryAdapter, withBlobs } from '../../../mod.ts';
import type { BlobReference, R2DirectBackendConfig } from '../../../src/blob-middleware/types.ts';

// ============================================================================
// Credential Check
// ============================================================================

const API_KEY = Deno.env.get('SM_AIRTABLE_API_KEY');
const BASE_ID = Deno.env.get('SM_AIRTABLE_BASE_ID');
const TABLE_NAME = Deno.env.get('SM_AIRTABLE_BLOB_TABLE') || Deno.env.get('SM_AIRTABLE_TABLE_NAME') || 'SmallstoreTest';

const ACCOUNT_ID = Deno.env.get('SM_R2_ACCOUNT_ID');
const ACCESS_KEY_ID = Deno.env.get('SM_R2_ACCESS_KEY_ID');
const SECRET_ACCESS_KEY = Deno.env.get('SM_R2_SECRET_ACCESS_KEY');
const BUCKET_NAME = Deno.env.get('SM_R2_BUCKET_NAME');

const missingAirtable = !API_KEY || !BASE_ID || BASE_ID.startsWith('appXXX');
const missingR2 = !ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME
    || ACCOUNT_ID.startsWith('your-');

if (missingAirtable || missingR2) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Airtable + Blob Live Test — Setup Required                  ║
╚══════════════════════════════════════════════════════════════╝

${missingAirtable ? `Missing Airtable credentials. Run \`deno task live:airtable\` first.
  SM_AIRTABLE_API_KEY=pat...
  SM_AIRTABLE_BASE_ID=appYourBaseId
  SM_AIRTABLE_BLOB_TABLE=${TABLE_NAME}   (defaults to "BlobTest")
` : '  Airtable: OK'}

${missingR2 ? `Missing R2 credentials. Run \`deno task live:r2\` first.
  SM_R2_ACCOUNT_ID=...
  SM_R2_ACCESS_KEY_ID=...
  SM_R2_SECRET_ACCESS_KEY=...
  SM_R2_BUCKET_NAME=...
` : '  R2: OK'}

Run again: deno task live:airtable-blobs
`);
  Deno.exit(0);
}

// ============================================================================
// Test images (fetched from the web with proper headers)
// ============================================================================

const TEST_IMAGES = [
  {
    name: 'Cottontail',
    url: 'https://picsum.photos/id/237/200/200.jpg',  // cute dog (reliable source)
    filename: 'cottontail.jpg',
    bio: 'A wild European rabbit spotted near a meadow',
  },
  {
    name: 'Snowball',
    url: 'https://picsum.photos/id/40/200/200.jpg',   // nature scene
    filename: 'snowball.jpg',
    bio: 'Relaxing in a Tasmanian field',
  },
  {
    name: 'Thumper',
    url: 'https://picsum.photos/id/1074/200/200.jpg',  // another animal
    filename: 'thumper.jpg',
    bio: 'A curious European rabbit in the wild',
  },
];

/** Fetch image with proper headers to avoid rate limiting */
async function fetchImage(url: string): Promise<Uint8Array> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Smallstore-LiveTest/1.0' },
  });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
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
║  Airtable + Blob Middleware Live Test                        ║
║  Table: ${TABLE_NAME}${' '.repeat(Math.max(0, 50 - TABLE_NAME.length))}║
║  R2 Bucket: ${BUCKET_NAME}${' '.repeat(Math.max(0, 46 - BUCKET_NAME!.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup: Airtable adapter with blob middleware ──────────
  const airtableAdapter = createAirtableAdapter({
    apiKey: API_KEY!,
    baseId: BASE_ID!,
    tableIdOrName: TABLE_NAME,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    timeout: 60000,
  });

  const r2Backend: R2DirectBackendConfig = {
    type: 'r2-direct',
    accountId: ACCOUNT_ID!,
    accessKeyId: ACCESS_KEY_ID!,
    secretAccessKey: SECRET_ACCESS_KEY!,
    bucketName: BUCKET_NAME!,
    urlStrategy: 'signed',
    signedUrlTTL: 3600,
  };

  // Wrap with SmartRouter (withBlobs needs Smallstore interface; memory needed for metadata + sidecar)
  const store = createSmallstore({
    adapters: { airtable: airtableAdapter, memory: createMemoryAdapter() },
    defaultAdapter: 'airtable',
    metadataAdapter: 'memory',
  });

  const blobStore = withBlobs(store, {
    backend: r2Backend,
    collections: {
      'bunnies/*': [
        { field: 'Attachments', targetFormat: 'airtable' },
      ],
    },
    autoDetect: false,
    filenameStrategy: 'preserve',
    sidecarMode: 'inline',  // store blob metadata on the same row, not a separate record
  });

  const testId = `test-${Date.now()}`;

  // ── Step 1: Store bunnies with photos ─────────────────────
  console.log('── Step 1: Store bunnies with web images → R2 → Airtable ──');

  const keys: string[] = [];
  for (const img of TEST_IMAGES) {
    const key = `bunnies/${img.name.toLowerCase()}-${testId}`;
    console.log(`\n  Fetching + uploading: ${img.name}...`);

    // Fetch image from web first (with User-Agent to avoid rate limits)
    const imageBytes = await fetchImage(img.url);
    log('📥', `Fetched: ${img.filename} (${imageBytes.length} bytes)`);

    await blobStore.set(key, {
      Name: `${img.name}-${testId}`,
      Bio: img.bio,
      Attachments: { buffer: imageBytes, filename: img.filename },
    });

    keys.push(key);
    log('✅', `Stored: ${img.name} (uploaded to R2, attachment URL in Airtable)`);
  }

  // ── Step 2: Read back and verify ──────────────────────────
  console.log('\n── Step 2: Read back and verify Attachments field ──');

  for (let i = 0; i < keys.length; i++) {
    const result = await store.get(keys[i]);
    if (result?.content) {
      const data = Array.isArray(result.content) ? result.content[0] : result.content;
      const attachField = data.Attachments;

      if (Array.isArray(attachField) && attachField.length > 0 && attachField[0]?.url) {
        log('✅', `${TEST_IMAGES[i].name}: Attachment URL present`);
        log('  ', `URL: ${attachField[0].url.slice(0, 70)}...`);
      } else if (typeof attachField === 'string' && attachField.startsWith('http')) {
        log('✅', `${TEST_IMAGES[i].name}: Attachment URL present (string)`);
        log('  ', `URL: ${attachField.slice(0, 70)}...`);
      } else {
        log('⚠️', `${TEST_IMAGES[i].name}: Attachments field: ${JSON.stringify(attachField)?.slice(0, 80)}`);
      }
    } else {
      log('❌', `Failed to read: ${keys[i]}`);
    }
  }

  // ── Step 3: Check inline sidecar metadata ────────────────
  console.log('\n── Step 3: Check inline sidecar metadata (_blob_meta field) ──');

  for (let i = 0; i < keys.length; i++) {
    const result = await store.get(keys[i]);
    if (result?.content) {
      const data = Array.isArray(result.content) ? result.content[0] : result.content;
      const meta = data._blob_meta;
      if (meta) {
        const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
        if (parsed.Attachments) {
          const ref = parsed.Attachments as BlobReference;
          log('📄', `${TEST_IMAGES[i].name}: r2Key=${ref.r2Key}, size=${ref.sizeBytes}B, type=${ref.contentType}`);
        } else {
          log('📄', `${TEST_IMAGES[i].name}: _blob_meta present, keys: ${Object.keys(parsed).join(', ')}`);
        }
      } else {
        log('⚠️', `${TEST_IMAGES[i].name}: No _blob_meta field on record`);
      }
    }
  }

  // ── Step 4: List keys ─────────────────────────────────────
  console.log('\n── Step 4: List keys ──');

  const allKeys = await store.keys('bunnies');
  const bunnyKeys = allKeys.filter(k => k.includes(testId));
  log('📁', `Found ${bunnyKeys.length} keys for this test run`);
  for (const k of bunnyKeys) {
    log('  ', k);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(`
── Done ──

  Bunnies stored: ${TEST_IMAGES.length}
  Check your Airtable: https://airtable.com/${BASE_ID}
  Check R2 bucket for uploaded images.

  Data is LEFT in Airtable + R2 so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
