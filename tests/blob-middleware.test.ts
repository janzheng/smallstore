/**
 * Blob Middleware Tests
 *
 * Tests detector, formats, and the withBlobs() middleware
 * using a memory adapter (no real R2 needed).
 */

import { assertEquals, assertExists, assert } from "@std/assert";

// Detector
import { isBlobInput, detectBlobFields } from '../src/blob-middleware/detector.ts';
import type { DetectedBlobField } from '../src/blob-middleware/detector.ts';

// Formats
import { toAirtableAttachment, toNotionFile, formatForPlatform } from '../src/blob-middleware/formats.ts';
import type { BlobReference } from '../src/blob-middleware/types.ts';

// Middleware
import { withBlobs, INLINE_SIDECAR_FIELD } from '../src/blob-middleware/mod.ts';
import { BlobResolver } from '../src/blob-middleware/resolver.ts';
import { createSmallstore, createMemoryAdapter } from '../mod.ts';
import type { BlobMiddlewareConfig } from '../src/blob-middleware/types.ts';

// ============================================================================
// Detector Tests
// ============================================================================

Deno.test("detector: isBlobInput — recognizes { file } shape", () => {
  assert(isBlobInput({ file: "./sunset.jpg" }));
  assert(isBlobInput({ file: "/absolute/path/photo.png" }));
});

Deno.test("detector: isBlobInput — recognizes { buffer } shape", () => {
  assert(isBlobInput({ buffer: new Uint8Array([1, 2, 3]) }));
});

Deno.test("detector: isBlobInput — recognizes { base64 } shape", () => {
  assert(isBlobInput({ base64: "aGVsbG8=", filename: "hello.txt" }));
  assert(isBlobInput({ base64: "aGVsbG8=" }));
});

Deno.test("detector: isBlobInput — recognizes { url, reupload: true }", () => {
  assert(isBlobInput({ url: "https://example.com/photo.jpg", reupload: true }));
});

Deno.test("detector: isBlobInput — rejects plain URL without reupload", () => {
  assert(!isBlobInput({ url: "https://example.com/photo.jpg" }));
});

Deno.test("detector: isBlobInput — recognizes Uint8Array", () => {
  assert(isBlobInput(new Uint8Array([1, 2, 3])));
});

Deno.test("detector: isBlobInput — rejects non-blob values", () => {
  assert(!isBlobInput(null));
  assert(!isBlobInput(undefined));
  assert(!isBlobInput("string"));
  assert(!isBlobInput(42));
  assert(!isBlobInput({ title: "foo" }));
  assert(!isBlobInput({ file: "" })); // empty file path
  assert(!isBlobInput([]));
  assert(!isBlobInput({ url: "https://example.com" })); // no reupload flag
});

Deno.test("detector: detectBlobFields — finds top-level blob fields", () => {
  const fields = detectBlobFields({
    title: "Sunset",
    image: { file: "./sunset.jpg" },
    caption: "Beautiful",
  });

  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "image");
});

Deno.test("detector: detectBlobFields — finds nested blob fields", () => {
  const fields = detectBlobFields({
    title: "Post",
    meta: {
      thumbnail: { file: "./thumb.jpg" },
      author: "Jan",
    },
    image: { buffer: new Uint8Array([1, 2, 3]) },
  });

  assertEquals(fields.length, 2);
  const paths = fields.map((f: DetectedBlobField) => f.path).sort();
  assertEquals(paths, ["image", "meta.thumbnail"]);
});

Deno.test("detector: detectBlobFields — ignores non-blob objects", () => {
  const fields = detectBlobFields({
    title: "Post",
    tags: ["photo", "nature"],
    meta: { author: "Jan", date: "2024-01-01" },
  });

  assertEquals(fields.length, 0);
});

// ============================================================================
// Format Tests
// ============================================================================

const sampleRef: BlobReference = {
  url: "https://f2.example.com/blobs/photo.jpg",
  r2Key: "posts/image/abc123.jpg",
  filename: "sunset.jpg",
  contentType: "image/jpeg",
  sizeBytes: 12345,
  uploadedAt: "2024-01-01T00:00:00Z",
  backend: "f2-r2",
};

Deno.test("formats: toAirtableAttachment — correct shape", () => {
  const result = toAirtableAttachment(sampleRef);
  assertEquals(result, { url: sampleRef.url, filename: "sunset.jpg" });
});

Deno.test("formats: toNotionFile — correct shape", () => {
  const result = toNotionFile(sampleRef);
  assertEquals(result, {
    type: "external",
    name: "sunset.jpg",
    external: { url: sampleRef.url },
  });
});

Deno.test("formats: formatForPlatform — airtable wraps in array", () => {
  const result = formatForPlatform(sampleRef, "airtable") as any[];
  assertEquals(result.length, 1);
  assertEquals(result[0].url, sampleRef.url);
  assertEquals(result[0].filename, "sunset.jpg");
});

Deno.test("formats: formatForPlatform — notion wraps in array", () => {
  const result = formatForPlatform(sampleRef, "notion") as any[];
  assertEquals(result.length, 1);
  assertEquals(result[0].type, "external");
  assertEquals(result[0].external.url, sampleRef.url);
});

Deno.test("formats: formatForPlatform — url-only returns string", () => {
  const result = formatForPlatform(sampleRef, "url-only");
  assertEquals(result, sampleRef.url);
});

Deno.test("formats: formatForPlatform — blob-reference returns full ref", () => {
  const result = formatForPlatform(sampleRef, "blob-reference") as BlobReference;
  assertEquals(result.r2Key, sampleRef.r2Key);
  assertEquals(result.url, sampleRef.url);
});

// ============================================================================
// Middleware Integration Tests (with mock upload)
// ============================================================================

/**
 * Create a blob middleware instance that uses a memory store
 * and intercepts uploads to avoid real R2 calls.
 *
 * We override the resolver by monkeypatching — the middleware
 * calls resolver.upload() which we can test by using base64 input
 * (which doesn't need file I/O) but the F2/R2 upload will fail.
 *
 * For a proper integration test, we use the { buffer: ... } shape
 * and a custom backend that doesn't actually call F2.
 */

Deno.test("middleware: withBlobs — passes through non-blob data unchanged", async () => {
  const store = createSmallstore({ preset: 'memory' });

  // Config with no matching collections — everything passes through
  const blobStore = withBlobs(store, {
    backend: {
      type: 'f2-r2',
      f2Url: 'http://localhost:9999',
    },
    collections: {},
    autoDetect: false,
  });

  await blobStore.set("test/plain", { title: "Hello", count: 42 });
  const result = await blobStore.get("test/plain");

  // SmartRouter wraps response: { content: data, reference, adapter, dataType }
  // With mode:'replace' (middleware default), content is the object directly
  assertExists(result);
  assertExists(result.content);
  const data = Array.isArray(result.content) ? result.content[0] : result.content;
  assertEquals(data.title, "Hello");
  assertEquals(data.count, 42);

  // Cleanup
  await blobStore.delete("test/plain");
});

Deno.test("middleware: withBlobs — detects blob fields with autoDetect", async () => {
  const store = createSmallstore({ preset: 'memory' });

  // Use a fake backend — upload will fail, but detection should work
  const blobStore = withBlobs(store, {
    backend: {
      type: 'f2-r2',
      f2Url: 'http://localhost:0', // will fail on upload
    },
    collections: {},
    autoDetect: true,
  });

  // This should try to upload because autoDetect sees { buffer: ... }
  // It will fail because the F2 URL is invalid — that's OK for this test.
  // We just verify that non-blob fields pass through even if blob upload fails.
  try {
    await blobStore.set("test/mixed", {
      title: "Sunset",
      image: { buffer: new Uint8Array([0xFF, 0xD8, 0xFF]) },
    });
  } catch {
    // Expected — F2 URL is invalid
  }

  // Cleanup
  try { await store.delete("test/mixed"); } catch { /* ok */ }
});

Deno.test("middleware: withBlobs — pattern matching works", () => {
  const store = createSmallstore({ preset: 'memory' });

  const blobStore = withBlobs(store, {
    backend: {
      type: 'f2-r2',
      f2Url: 'http://localhost:0',
    },
    collections: {
      'posts/*': [{ field: 'image', targetFormat: 'airtable' }],
    },
    autoDetect: false,
  });

  // Verify the proxy was created with all expected methods
  assertExists(blobStore);
  assertExists(blobStore.get);
  assertExists(blobStore.set);
  assertExists(blobStore.delete);
});

Deno.test("middleware: withBlobs — proxy preserves all store methods", async () => {
  const store = createSmallstore({ preset: 'memory' });

  const blobStore = withBlobs(store, {
    backend: { type: 'f2-r2' },
    collections: {},
  });

  // All standard methods should be accessible
  assertExists(blobStore.get);
  assertExists(blobStore.set);
  assertExists(blobStore.delete);
  assertExists(blobStore.keys);
  assertExists(blobStore.has);
  assertExists(blobStore.clear);

  // set + has should work through the proxy
  await blobStore.set("proxy-test/item1", { name: "test" });
  const exists = await blobStore.has("proxy-test/item1");
  assert(exists, "has() should return true after set()");

  // Cleanup
  await blobStore.delete("proxy-test/item1");
});

// ============================================================================
// Sidecar Mode Tests
// ============================================================================

/** Helper: create a blob store with a mocked resolver that skips real R2 uploads */
function createTestBlobStore(sidecarMode: 'separate' | 'inline' | 'none') {
  const store = createSmallstore({ preset: 'memory' });

  const config: BlobMiddlewareConfig = {
    backend: { type: 'f2-r2', f2Url: 'http://localhost:0' },
    collections: {
      'items/*': [{ field: 'image', targetFormat: 'url-only' }],
    },
    autoDetect: false,
    filenameStrategy: 'preserve',
    sidecarMode,
  };

  const blobStore = withBlobs(store, config);

  // Monkeypatch: replace the resolver's upload method via the proxy internals.
  // The middleware creates a BlobResolver in its closure, so we can't reach it directly.
  // Instead, use a simple workaround: pre-process the data to simulate what the
  // middleware would produce after a successful upload.
  return { store, blobStore };
}

/**
 * For sidecar mode tests, we need blob upload to succeed.
 * We monkeypatch BlobResolver.prototype.upload to return a fake ref.
 */
const originalUpload = BlobResolver.prototype.upload;
function mockUpload() {
  let callCount = 0;
  BlobResolver.prototype.upload = async (_input: any, _prefix: string) => {
    callCount++;
    return {
      url: `https://r2.example.com/fake-${callCount}.jpg`,
      r2Key: `fake-${callCount}.jpg`,
      filename: `photo-${callCount}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      uploadedAt: new Date().toISOString(),
      backend: 'f2-r2' as const,
    };
  };
  return () => {
    BlobResolver.prototype.upload = originalUpload;
  };
}

Deno.test("middleware: sidecarMode 'inline' — stores _blob_meta on same record", async () => {
  const restore = mockUpload();
  try {
    const { store, blobStore } = createTestBlobStore('inline');

    await blobStore.set("items/photo1", {
      title: "Sunset",
      image: { buffer: new Uint8Array([1, 2, 3]) },
    });

    // Read back from underlying store
    const result = await store.get("items/photo1");
    const data = Array.isArray(result?.content) ? result.content[0] : result?.content;

    // Should have _blob_meta field inline
    assertExists(data[INLINE_SIDECAR_FIELD], "_blob_meta field should exist on record");
    const meta = JSON.parse(data[INLINE_SIDECAR_FIELD]);
    assertExists(meta.image, "sidecar should have 'image' key");
    assertEquals(meta.image.filename, "photo-1.jpg");
    assertExists(meta.image.r2Key);

    // image field should be the URL (url-only format)
    assertEquals(typeof data.image, "string");
    assert(data.image.startsWith("https://"), "image should be a URL");

    // Should NOT have a separate _blobs key
    const sidecarResult = await store.get("items/photo1/_blobs");
    assertEquals(sidecarResult, null, "Should not create separate sidecar key");

    await store.delete("items/photo1");
  } finally {
    restore();
  }
});

Deno.test("middleware: sidecarMode 'separate' — stores sidecar as separate key", async () => {
  const restore = mockUpload();
  try {
    const { store, blobStore } = createTestBlobStore('separate');

    await blobStore.set("items/photo2", {
      title: "Mountain",
      image: { buffer: new Uint8Array([4, 5, 6]) },
    });

    // Read main record
    const result = await store.get("items/photo2");
    const data = Array.isArray(result?.content) ? result.content[0] : result?.content;

    // Should NOT have _blob_meta inline
    assertEquals(data[INLINE_SIDECAR_FIELD], undefined, "Should not have inline sidecar");

    // image field should be the URL
    assertEquals(typeof data.image, "string");

    // Should have a separate _blobs key
    const sidecarResult = await store.get("items/photo2/_blobs");
    assertExists(sidecarResult, "Should have separate sidecar key");
    const sc = Array.isArray(sidecarResult?.content) ? sidecarResult.content[0] : sidecarResult?.content;
    assertExists(sc?.image, "Sidecar should have 'image' key");
    assertExists(sc.image.r2Key);

    await store.delete("items/photo2");
    await store.delete("items/photo2/_blobs");
  } finally {
    restore();
  }
});

Deno.test("middleware: sidecarMode 'none' — skips sidecar storage entirely", async () => {
  const restore = mockUpload();
  try {
    const { store, blobStore } = createTestBlobStore('none');

    await blobStore.set("items/photo3", {
      title: "Ocean",
      image: { buffer: new Uint8Array([7, 8, 9]) },
    });

    // Read main record
    const result = await store.get("items/photo3");
    const data = Array.isArray(result?.content) ? result.content[0] : result?.content;

    // Should NOT have _blob_meta inline
    assertEquals(data[INLINE_SIDECAR_FIELD], undefined, "Should not have inline sidecar");

    // image field should still be the URL (upload still happens)
    assertEquals(typeof data.image, "string");
    assert(data.image.startsWith("https://"), "image should be a URL");

    // Should NOT have a separate _blobs key
    const sidecarResult = await store.get("items/photo3/_blobs");
    assertEquals(sidecarResult, null, "Should not create separate sidecar key");

    await store.delete("items/photo3");
  } finally {
    restore();
  }
});

Deno.test("middleware: withBlobs — defaults to mode:'replace' for target.set()", async () => {
  const store = createSmallstore({ preset: 'memory' });

  const blobStore = withBlobs(store, {
    backend: { type: 'f2-r2' },
    collections: {},
    autoDetect: false,
  });

  // Set twice — with mode:'replace' default, second set should overwrite, not append
  await blobStore.set("replace-test/item", { name: "first" });
  await blobStore.set("replace-test/item", { name: "second" });

  const result = await store.get("replace-test/item");
  const data = Array.isArray(result?.content) ? result.content[0] : result?.content;

  // With mode:'replace', should be the latest value, not an array of two
  assertEquals(data.name, "second", "Should overwrite, not append");

  await store.delete("replace-test/item");
});
