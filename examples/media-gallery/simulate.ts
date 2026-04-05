#!/usr/bin/env -S deno run --allow-all
/**
 * Media Gallery — Simulation Mode
 *
 * Demonstrates the blob middleware in action. Generates a gallery of
 * "artworks" with fake image data (tiny 1x1 PNGs encoded as base64),
 * stores them through withBlobs() which uploads to R2 and places
 * URLs into the metadata.
 *
 * In simulation mode (default), the backend is set to a non-existent
 * F2 URL, so blob uploads are expected to fail — the simulation
 * gracefully handles this and shows what WOULD happen.
 *
 * With `--live` flag + real F2/R2 credentials, performs actual uploads.
 *
 * Storage: local-json (one .json file per item, human-readable)
 *
 * Run:
 *   deno task gallery            # simulate (no credentials needed)
 *   deno task gallery --clean    # wipe and re-simulate
 *   deno task gallery --live     # use real F2/R2 backend (needs creds)
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createLocalJsonAdapter,
  withBlobs,
  isBlobInput,
  detectBlobFields,
  formatForPlatform,
} from '../../mod.ts';

// ============================================================================
// Config
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const JSON_DIR = join(DATA_DIR, 'json');

const NS = 'gallery';
const isLive = Deno.args.includes('--live');

if (Deno.args.includes('--clean')) {
  try { await Deno.remove(DATA_DIR, { recursive: true }); } catch { /* ok */ }
  console.log('Cleaned data directory.\n');
}
await Deno.mkdir(DATA_DIR, { recursive: true });

// ============================================================================
// Helpers
// ============================================================================

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function unwrap(result: any): any {
  if (result === null || result === undefined) return null;
  if (result.content !== undefined) {
    const c = result.content;
    if (Array.isArray(c) && c.length === 1) return c[0];
    return c;
  }
  return result;
}

function log(icon: string, msg: string) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`  [${time}] ${icon} ${msg}`);
}

// ============================================================================
// Fake image data — 1x1 pixel PNGs in various "colors"
// ============================================================================

// Tiny 1x1 PNG (red pixel) — 67 bytes, valid PNG
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function makeFakeImage(color: string): { base64: string; filename: string } {
  // In a real app, these would be actual image files.
  // For simulation, we use the same tiny PNG with different filenames.
  return {
    base64: TINY_PNG_BASE64,
    filename: `${color}-artwork.png`,
  };
}

function makeFakeBuffer(): { buffer: Uint8Array; filename: string } {
  // Simulate a small binary file (fake JPEG header)
  return {
    buffer: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]),
    filename: 'thumbnail.jpg',
  };
}

// ============================================================================
// Art data pools
// ============================================================================

const ARTWORK_POOL = [
  { title: 'Sunset Over Pacific', artist: 'Marina Sol', medium: 'Oil on canvas', year: 2024, tags: 'landscape,ocean,sunset' },
  { title: 'Urban Geometry #7', artist: 'Kai Chen', medium: 'Digital print', year: 2023, tags: 'abstract,urban,geometric' },
  { title: 'Whispers in Blue', artist: 'Elena Frost', medium: 'Watercolor', year: 2024, tags: 'abstract,blue,watercolor' },
  { title: 'The Last Garden', artist: 'Diego Reyes', medium: 'Acrylic on wood', year: 2023, tags: 'nature,garden,surreal' },
  { title: 'Digital Dawn', artist: 'Yuki Tanaka', medium: 'Generative art', year: 2024, tags: 'digital,generative,dawn' },
  { title: 'Portrait of Silence', artist: 'Anna Volkov', medium: 'Charcoal', year: 2022, tags: 'portrait,monochrome,charcoal' },
  { title: 'Neon Reef', artist: 'Kai Chen', medium: 'Mixed media', year: 2024, tags: 'underwater,neon,mixed-media' },
  { title: 'Fragments of Time', artist: 'Marina Sol', medium: 'Collage', year: 2023, tags: 'collage,time,abstract' },
  { title: 'Cloud Atlas Study', artist: 'Elena Frost', medium: 'Ink wash', year: 2024, tags: 'clouds,ink,study' },
  { title: 'Machine Dream #12', artist: 'Yuki Tanaka', medium: 'AI-assisted', year: 2024, tags: 'ai,dream,generative' },
  { title: 'Stone & Light', artist: 'Diego Reyes', medium: 'Photography', year: 2023, tags: 'photo,architecture,light' },
  { title: 'Winter Garden', artist: 'Anna Volkov', medium: 'Oil on canvas', year: 2024, tags: 'garden,winter,landscape' },
];

const ALBUM_POOL = [
  { name: 'Exhibition: Spring 2024', description: 'Annual spring showcase at Downtown Gallery', curator: 'James Park' },
  { name: 'Private Collection', description: 'Personal favorites and commissioned works', curator: 'Self' },
  { name: 'Digital Art Series', description: 'Generative and AI-assisted artworks', curator: 'Yuki Tanaka' },
  { name: 'Landscapes & Nature', description: 'Works inspired by natural environments', curator: 'Marina Sol' },
];

const COLORS = ['crimson', 'cobalt', 'emerald', 'amber', 'violet', 'teal', 'coral', 'slate'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================================
// Simulation
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log(`\u2551  Media Gallery \u2014 Simulation (local-json + blob middleware)   \u2551`);
  console.log(`\u2551  Mode: ${isLive ? 'LIVE (real R2 uploads)' : 'Simulated (no R2)'}${' '.repeat(isLive ? 25 : 30)}\u2551`);
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  // ── Setup store ─────────────────────────────────────────────
  const jsonAdapter = createLocalJsonAdapter({ baseDir: JSON_DIR, prettyPrint: true });
  const baseStore = createSmallstore({
    adapters: {
      json: jsonAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'json',
  });

  // Wrap with blob middleware
  const f2Url = isLive
    ? (Deno.env.get('F2_URL') || Deno.env.get('F2_DEFAULT_URL') || 'https://f2.phage.directory')
    : 'http://localhost:0'; // will fail gracefully

  const store = withBlobs(baseStore, {
    backend: {
      type: 'f2-r2',
      f2Url,
      token: Deno.env.get('F2_TOKEN'),
      defaultScope: 'media-gallery',
    },
    collections: {
      [`${NS}/artworks/*`]: [
        { field: 'image', targetFormat: 'url-only' },
        { field: 'thumbnail', targetFormat: 'url-only' },
      ],
      [`${NS}/albums/*`]: [
        { field: 'cover', targetFormat: 'url-only' },
      ],
    },
    autoDetect: true,
    filenameStrategy: 'uuid',
  });

  // ── Phase 1: Blob detection demo ───────────────────────────
  console.log('\n\u2500\u2500 Phase 0: Blob Detection Demo \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const sampleData = {
    title: 'Test Artwork',
    image: { base64: TINY_PNG_BASE64, filename: 'test.png' },
    thumbnail: makeFakeBuffer(),
    description: 'A plain text field',
    tags: ['art', 'test'],
  };

  const detected = detectBlobFields(sampleData);
  console.log(`  Detected ${detected.length} blob field(s) in sample data:`);
  for (const field of detected) {
    const inputType = 'base64' in (field.value as any) ? 'base64'
      : 'buffer' in (field.value as any) ? 'buffer'
      : 'file' in (field.value as any) ? 'file'
      : 'unknown';
    console.log(`    - "${field.path}" (${inputType})`);
  }

  console.log(`\n  isBlobInput checks:`);
  console.log(`    { base64: "..." }     → ${isBlobInput({ base64: 'abc' })}`);
  console.log(`    { buffer: <bytes> }   → ${isBlobInput({ buffer: new Uint8Array(4) })}`);
  console.log(`    { file: "./img.png" } → ${isBlobInput({ file: './img.png' })}`);
  console.log(`    { title: "foo" }      → ${isBlobInput({ title: 'foo' })}`);
  console.log(`    "plain string"        → ${isBlobInput('plain string')}`);

  // ── Phase 1: Create artworks ───────────────────────────────
  console.log('\n\u2500\u2500 Phase 1: Creating artworks (12 items) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  let artCount = 0;
  for (const artwork of ARTWORK_POOL) {
    const color = pick(COLORS);
    const key = `${NS}/artworks/${slug(artwork.title)}-${Date.now()}`;

    const data: any = {
      ...artwork,
      image: makeFakeImage(color),           // blob: base64 PNG
      thumbnail: makeFakeBuffer(),           // blob: raw bytes
      dimensions: `${800 + Math.floor(Math.random() * 600)}x${600 + Math.floor(Math.random() * 400)}`,
      addedAt: ts(),
    };

    try {
      await store.set(key, data, { mode: 'replace' });
      log('\ud83c\udfa8', `"${artwork.title}" by ${artwork.artist} [${color}]`);
    } catch {
      // In simulation mode, blob upload fails — store without blobs
      const { image, thumbnail, ...plainData } = data;
      plainData.image = `[would upload: ${color}-artwork.png to R2]`;
      plainData.thumbnail = `[would upload: thumbnail.jpg to R2]`;
      await baseStore.set(key, plainData, { mode: 'replace' });
      log('\ud83c\udfa8', `"${artwork.title}" by ${artwork.artist} [simulated blobs]`);
    }
    artCount++;
    await sleep(50);
  }

  // ── Phase 2: Create albums ─────────────────────────────────
  console.log('\n\u2500\u2500 Phase 2: Creating albums (4 items) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  let albumCount = 0;
  for (const album of ALBUM_POOL) {
    const key = `${NS}/albums/${slug(album.name)}-${Date.now()}`;

    const data: any = {
      ...album,
      cover: makeFakeImage(pick(COLORS)),    // blob: base64 PNG
      artworkCount: Math.floor(Math.random() * 20) + 3,
      createdAt: ts(),
    };

    try {
      await store.set(key, data, { mode: 'replace' });
      log('\ud83d\udcda', `Album: "${album.name}" (${album.curator})`);
    } catch {
      const { cover, ...plainData } = data;
      plainData.cover = `[would upload: cover image to R2]`;
      await baseStore.set(key, plainData, { mode: 'replace' });
      log('\ud83d\udcda', `Album: "${album.name}" [simulated cover]`);
    }
    albumCount++;
    await sleep(50);
  }

  // Flush writes
  await jsonAdapter.flush();

  // ── Phase 3: Read back and verify ──────────────────────────
  console.log('\n\u2500\u2500 Phase 3: Reading back data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const artworkKeys = await store.keys(`${NS}/artworks`);
  const albumKeys = await store.keys(`${NS}/albums`);
  log('\ud83d\udcc1', `Found ${artworkKeys.length} artworks, ${albumKeys.length} albums`);

  // Read a sample artwork
  if (artworkKeys.length > 0) {
    const sampleKey = `${NS}/${artworkKeys[0]}`;
    const sample = unwrap(await store.get(sampleKey));
    if (sample) {
      log('\ud83d\udd0d', `Sample artwork: "${sample.title}" by ${sample.artist}`);
      const imageField = sample.image;
      if (typeof imageField === 'string' && imageField.startsWith('http')) {
        log('\u2705', `Image URL: ${imageField}`);
      } else if (typeof imageField === 'string' && imageField.startsWith('[would')) {
        log('\ud83d\udca1', `Image: ${imageField}`);
      } else {
        log('\u2139\ufe0f', `Image field type: ${typeof imageField}`);
      }
    }
  }

  // ── Phase 4: Format demos ──────────────────────────────────
  console.log('\n\u2500\u2500 Phase 4: Platform format demos \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const fakeRef = {
    url: 'https://f2.phage.directory/media-gallery/abc123.png',
    r2Key: 'gallery/artworks/image/abc123.png',
    filename: 'sunset-artwork.png',
    contentType: 'image/png',
    sizeBytes: 67,
    uploadedAt: ts(),
    backend: 'f2-r2' as const,
  };

  console.log('  How blob URLs get formatted per platform:\n');

  const airtable = formatForPlatform(fakeRef, 'airtable');
  console.log(`  Airtable:  ${JSON.stringify(airtable)}`);

  const notion = formatForPlatform(fakeRef, 'notion');
  console.log(`  Notion:    ${JSON.stringify(notion)}`);

  const urlOnly = formatForPlatform(fakeRef, 'url-only');
  console.log(`  URL-only:  ${JSON.stringify(urlOnly)}`);

  const blobRef = formatForPlatform(fakeRef, 'blob-reference');
  console.log(`  Full ref:  ${JSON.stringify(blobRef).slice(0, 80)}...`);

  // ── Summary ────────────────────────────────────────────────
  console.log('\n\u2500\u2500 Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log(`  Artworks created:  ${artCount}`);
  console.log(`  Albums created:    ${albumCount}`);
  console.log(`  Mode:              ${isLive ? 'LIVE (real R2 uploads)' : 'Simulated'}`);
  console.log(`  Data directory:    ${DATA_DIR}`);
  console.log(`\n  Browse the gallery data:`);
  console.log(`    ${JSON_DIR}/gallery/artworks/`);
  console.log(`    ${JSON_DIR}/gallery/albums/`);
  if (!isLive) {
    console.log(`\n  To test with real R2 uploads:`);
    console.log(`    F2_URL=https://f2.phage.directory deno task gallery --live`);
  }
  console.log('');
}

main().catch(console.error);
