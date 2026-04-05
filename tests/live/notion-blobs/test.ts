#!/usr/bin/env -S deno run --allow-all
/**
 * Live Notion + Blob Middleware Test
 *
 * Fetches bunny images from the web, uploads them to R2 via blob middleware,
 * and stores contacts in Notion with profile photos as file properties.
 *
 * Prerequisites:
 * - Working Notion adapter (run `deno task live:notion` first)
 * - Working R2 adapter (run `deno task live:r2` first)
 *
 * Run: deno task live:notion-blobs
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { createSmallstore, createNotionAdapter, createMemoryAdapter, withBlobs } from '../../../mod.ts';
import type { BlobReference, R2DirectBackendConfig } from '../../../src/blob-middleware/types.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SECRET = Deno.env.get('SM_NOTION_SECRET');
const DATABASE_ID = Deno.env.get('SM_NOTION_BLOB_DATABASE_ID') || Deno.env.get('SM_NOTION_DATABASE_ID');

const ACCOUNT_ID = Deno.env.get('SM_R2_ACCOUNT_ID');
const ACCESS_KEY_ID = Deno.env.get('SM_R2_ACCESS_KEY_ID');
const SECRET_ACCESS_KEY = Deno.env.get('SM_R2_SECRET_ACCESS_KEY');
const BUCKET_NAME = Deno.env.get('SM_R2_BUCKET_NAME');

const missingNotion = !SECRET || !DATABASE_ID || SECRET.startsWith('secret_XXX') || DATABASE_ID.startsWith('xxx');
const missingR2 = !ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME
    || ACCOUNT_ID.startsWith('your-');

if (missingNotion || missingR2) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Notion + Blob Live Test — Setup Required                    ║
╚══════════════════════════════════════════════════════════════╝

${missingNotion ? `Missing Notion credentials. Run \`deno task live:notion\` first.
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_BLOB_DATABASE_ID=your-database-id   (or uses SM_NOTION_DATABASE_ID)
` : '  Notion: OK'}

${missingR2 ? `Missing R2 credentials. Run \`deno task live:r2\` first.
  SM_R2_ACCOUNT_ID=...
  SM_R2_ACCESS_KEY_ID=...
  SM_R2_SECRET_ACCESS_KEY=...
  SM_R2_BUCKET_NAME=...
` : '  R2: OK'}

Run again: deno task live:notion-blobs
`);
  Deno.exit(0);
}

// ============================================================================
// Test images (fetched from the web with proper headers)
// ============================================================================

const TEST_IMAGES = [
  {
    name: 'Cottontail',
    url: 'https://picsum.photos/id/237/200/200.jpg',
    filename: 'cottontail.jpg',
    bio: 'A wild European rabbit spotted near a meadow',
  },
  {
    name: 'Snowball',
    url: 'https://picsum.photos/id/40/200/200.jpg',
    filename: 'snowball.jpg',
    bio: 'Relaxing in a Tasmanian field',
  },
  {
    name: 'Thumper',
    url: 'https://picsum.photos/id/1074/200/200.jpg',
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
║  Notion + Blob Middleware Live Test                          ║
║  Database: ${DATABASE_ID!.slice(0, 8)}...${DATABASE_ID!.slice(-4)}${' '.repeat(37)}║
║  R2 Bucket: ${BUCKET_NAME}${' '.repeat(Math.max(0, 46 - BUCKET_NAME!.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup: Notion adapter with blob middleware ────────────
  const notionAdapter = createNotionAdapter({
    notionSecret: SECRET!,
    databaseId: DATABASE_ID!,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
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
    adapters: { notion: notionAdapter, memory: createMemoryAdapter() },
    defaultAdapter: 'notion',
    metadataAdapter: 'memory',
  });

  const blobStore = withBlobs(store, {
    backend: r2Backend,
    collections: {
      'bunnies/*': [
        { field: 'Photo', targetFormat: 'notion' },
      ],
    },
    autoDetect: false,
    filenameStrategy: 'preserve',
    sidecarMode: 'inline',  // store blob metadata on the same row, not a separate record
  });

  const testId = `test-${Date.now()}`;

  // ── Step 1: Store bunnies with photos ─────────────────────
  console.log('── Step 1: Store bunnies with web images → R2 → Notion ──');

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
      Photo: { buffer: imageBytes, filename: img.filename },
    });

    keys.push(key);
    log('✅', `Stored: ${img.name} (photo uploaded to R2, URL in Notion)`);
  }

  // ── Step 2: Read back and verify ──────────────────────────
  console.log('\n── Step 2: Read back and verify file properties ──');

  for (let i = 0; i < keys.length; i++) {
    const result = await store.get(keys[i]);
    if (result?.content) {
      const data = Array.isArray(result.content) ? result.content[0] : result.content;
      const photoField = data.Photo;

      // targetFormat: 'notion' sends [{ type: 'external', name, external: { url } }]
      // If Photo column is "Files & media" type, Notion stores it natively with thumbnails.
      // If auto-created as wrong type, it may show as [object Object].
      if (typeof photoField === 'string' && photoField.startsWith('http')) {
        log('✅', `${TEST_IMAGES[i].name}: Photo URL present (string)`);
        log('  ', `URL: ${photoField.slice(0, 70)}...`);
      } else if (Array.isArray(photoField) && photoField.length > 0) {
        const file = photoField[0];
        const url = file?.external?.url || file?.name || file?.url;
        log('✅', `${TEST_IMAGES[i].name}: Photo files property (${photoField.length} file(s))`);
        if (url) log('  ', `URL: ${String(url).slice(0, 70)}...`);
      } else if (photoField) {
        log('⚠️', `${TEST_IMAGES[i].name}: Photo field = ${JSON.stringify(photoField).slice(0, 80)}`);
      } else {
        log('⚠️', `${TEST_IMAGES[i].name}: No photo data found`);
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
        if (parsed.Photo) {
          const ref = parsed.Photo as BlobReference;
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
  Check your Notion database to see the photo file properties.
  Check R2 bucket for uploaded images.

  Data is LEFT in Notion + R2 so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
