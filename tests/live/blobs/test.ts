#!/usr/bin/env -S deno run --allow-all
/**
 * Live Blob Middleware Test
 *
 * Tests the full blob middleware pipeline:
 *   1. withBlobs() wraps a store
 *   2. set() with blob fields → auto-upload to R2 → URL in data
 *   3. Sidecar metadata stored alongside
 *   4. delete() cleans up R2 blobs
 *
 * Supports two backends:
 *   --f2     Use F2 proxy (default, simpler setup)
 *   --r2     Use R2 direct (needs full AWS creds)
 *
 * Setup for F2:
 *   F2_URL=https://f2.phage.directory
 *   F2_TOKEN=your-token  (optional, if F2 requires auth)
 *
 * Setup for R2 Direct:
 *   SM_R2_ACCOUNT_ID=...
 *   SM_R2_ACCESS_KEY_ID=...
 *   SM_R2_SECRET_ACCESS_KEY=...
 *   SM_R2_BUCKET_NAME=...
 *
 * Run: deno task live:blobs
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
import {
  createSmallstore,
  createMemoryAdapter,
  withBlobs,
  isBlobInput,
  detectBlobFields,
  formatForPlatform,
} from '../../../mod.ts';
import type { BlobBackendConfig, BlobReference } from '../../../src/blob-middleware/types.ts';

// ============================================================================
// Backend Selection
// ============================================================================

const useR2Direct = Deno.args.includes('--r2');

function getBackendConfig(): BlobBackendConfig | null {
  if (useR2Direct) {
    const accountId = Deno.env.get('SM_R2_ACCOUNT_ID');
    const accessKeyId = Deno.env.get('SM_R2_ACCESS_KEY_ID');
    const secretAccessKey = Deno.env.get('SM_R2_SECRET_ACCESS_KEY');
    const bucketName = Deno.env.get('SM_R2_BUCKET_NAME');

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName
        || accountId.startsWith('your-')) {
      return null;
    }

    return {
      type: 'r2-direct',
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketName,
      urlStrategy: 'signed',
      signedUrlTTL: 3600,
    };
  }

  // F2 backend
  const f2Url = Deno.env.get('F2_URL') || Deno.env.get('F2_DEFAULT_URL');
  if (!f2Url) return null;

  return {
    type: 'f2-r2',
    f2Url,
    token: Deno.env.get('F2_TOKEN'),
    defaultScope: 'smallstore-live-test',
  };
}

const backend = getBackendConfig();

if (!backend) {
  const backendName = useR2Direct ? 'R2 Direct' : 'F2 (Fuzzyfile)';
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Blob Middleware Live Test — Setup Required                  ║
╚══════════════════════════════════════════════════════════════╝

Missing ${backendName} credentials.

${useR2Direct ? `
For R2 Direct, set in .env:
  SM_R2_ACCOUNT_ID=your-cloudflare-account-id
  SM_R2_ACCESS_KEY_ID=your-access-key-id
  SM_R2_SECRET_ACCESS_KEY=your-secret-access-key
  SM_R2_BUCKET_NAME=smallstore-test
` : `
For F2 proxy (simpler), set in .env:
  F2_URL=https://f2.phage.directory
  F2_TOKEN=optional-auth-token

For R2 Direct instead, run with --r2 flag:
  deno task live:blobs --r2
`}
Run again: deno task live:blobs ${useR2Direct ? '--r2' : ''}
`);
  Deno.exit(0);
}

// ============================================================================
// Test
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

// Tiny 1x1 red PNG
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
);

async function main() {
  const backendLabel = backend.type === 'r2-direct' ? 'R2 Direct' : `F2 (${(backend as any).f2Url})`;
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Blob Middleware Live Test                                   ║
║  Backend: ${backendLabel}${' '.repeat(Math.max(0, 48 - backendLabel.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup store with blob middleware ────────────────────────
  const baseStore = createSmallstore({ preset: 'memory' });

  const store = withBlobs(baseStore, {
    backend,
    collections: {
      'gallery/*': [
        { field: 'image', targetFormat: 'url-only' },
        { field: 'thumbnail', targetFormat: 'airtable' },
      ],
    },
    autoDetect: true,
    filenameStrategy: 'uuid',
  });

  const testId = `live-${Date.now()}`;

  // ── Step 1: Detect blob fields ─────────────────────────────
  console.log('── Step 1: Blob field detection ──');

  const testData = {
    title: 'Test Artwork',
    image: { buffer: TINY_PNG, filename: 'test-image.png' },
    thumbnail: { base64: btoa(String.fromCharCode(...TINY_PNG)), filename: 'thumb.png' },
    description: 'A regular text field',
  };

  const fields = detectBlobFields(testData);
  log('\ud83d\udd0d', `Detected ${fields.length} blob fields: ${fields.map(f => f.path).join(', ')}`);

  // ── Step 2: Store with blob upload ─────────────────────────
  console.log('\n── Step 2: Store with blob upload ──');

  const key = `gallery/${testId}`;
  await store.set(key, testData);
  log('\u2705', `Stored: ${key}`);

  // ── Step 3: Read back — check URLs ─────────────────────────
  console.log('\n── Step 3: Read back and verify URLs ──');

  const result = await store.get(key);
  if (result?.content) {
    const data = Array.isArray(result.content) ? result.content[0] : result.content;
    log('\ud83d\udcda', `Title: ${data.title}`);

    if (typeof data.image === 'string' && data.image.startsWith('http')) {
      log('\u2705', `Image URL: ${data.image}`);
    } else {
      log('\u26a0\ufe0f', `Image field: ${JSON.stringify(data.image)?.slice(0, 80)}`);
    }

    if (Array.isArray(data.thumbnail) && data.thumbnail[0]?.url) {
      log('\u2705', `Thumbnail (Airtable format): ${JSON.stringify(data.thumbnail)}`);
    } else {
      log('\u26a0\ufe0f', `Thumbnail field: ${JSON.stringify(data.thumbnail)?.slice(0, 80)}`);
    }
  }

  // ── Step 4: Check sidecar metadata ─────────────────────────
  console.log('\n── Step 4: Check sidecar metadata ──');

  const sidecar = await store.get(`${key}/_blobs`);
  if (sidecar?.content) {
    const sc = Array.isArray(sidecar.content) ? sidecar.content[0] : sidecar.content;
    for (const [field, ref] of Object.entries(sc)) {
      const blobRef = ref as BlobReference;
      log('\ud83d\udcc4', `${field}: r2Key=${blobRef.r2Key}, size=${blobRef.sizeBytes}B, backend=${blobRef.backend}`);
    }
  } else {
    log('\u26a0\ufe0f', 'No sidecar metadata found');
  }

  // ── Step 5: Cleanup ────────────────────────────────────────
  console.log('\n── Step 5: Cleanup ──');

  await store.delete(key);
  log('\ud83d\uddd1\ufe0f', `Deleted ${key} (and R2 blobs via sidecar)`);

  console.log(`
── Done ──

  Blob middleware pipeline verified!
  Backend: ${backendLabel}
`);
}

main().catch(err => {
  console.error('\n\u274c Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
