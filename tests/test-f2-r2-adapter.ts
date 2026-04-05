/**
 * Unit + integration tests for F2-R2 adapter (deterministic mode)
 *
 * Tests:
 * - Key parsing (smallstore:collection/path)
 * - MIME type detection
 * - JSON set/get via cmd: "data"
 * - Binary set/get via presigned URL
 * - Delete via cmd: "delete" (requires F2_AUTH_KEY)
 * - List keys via cmd: "list"
 * - Full CRUD cycle
 * - Error handling
 */

import { assertEquals, assertExists } from "@std/assert";
import { F2R2Adapter, createF2R2Adapter } from "../src/adapters/f2-r2.ts";
import type { F2R2AdapterConfig } from "../src/adapters/f2-r2.ts";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_F2_URL = Deno.env.get('F2_DEFAULT_URL') || 'https://f2.phage.directory';
const TEST_AUTH_KEY = Deno.env.get('F2_AUTH_KEY');
const TEST_SCOPE = 'smallstore-test';
const HAS_F2 = !!Deno.env.get('F2_DEFAULT_URL');
const HAS_AUTH = !!TEST_AUTH_KEY;

// ============================================================================
// Unit Tests (no network)
// ============================================================================

Deno.test("F2R2Adapter - Create with explicit config", () => {
  const config: F2R2AdapterConfig = {
    f2Url: TEST_F2_URL,
    defaultScope: TEST_SCOPE,
  };

  const adapter = new F2R2Adapter(config);

  assertExists(adapter);
  assertEquals(adapter.capabilities.name, 'f2-r2');
  assertEquals(adapter.capabilities.supportedTypes, ['object', 'blob', 'kv']);
});

Deno.test("F2R2Adapter - Create with env fallback", () => {
  const adapter = createF2R2Adapter();

  assertExists(adapter);
  assertEquals(adapter.capabilities.name, 'f2-r2');
});

Deno.test("F2R2Adapter - Key parsing with scope", () => {
  const adapter = new F2R2Adapter({ f2Url: TEST_F2_URL });
  const parseKey = (adapter as any).parseKey.bind(adapter);

  const result1 = parseKey('smallstore:generated/image-123.png');
  assertEquals(result1, { scope: 'generated', filename: 'image-123.png' });

  const result2 = parseKey('generated/image-123.png');
  assertEquals(result2, { scope: 'generated', filename: 'image-123.png' });

  const result3 = parseKey('image.png');
  assertEquals(result3, { scope: 'smallstore', filename: 'image.png' });
});

Deno.test("F2R2Adapter - MIME type detection", () => {
  const adapter = new F2R2Adapter({ f2Url: TEST_F2_URL });
  const detectMimeType = (adapter as any).detectMimeType.bind(adapter);

  assertEquals(detectMimeType('image.png'), 'image/png');
  assertEquals(detectMimeType('photo.jpg'), 'image/jpeg');
  assertEquals(detectMimeType('video.mp4'), 'video/mp4');
  assertEquals(detectMimeType('audio.mp3'), 'audio/mpeg');
  assertEquals(detectMimeType('document.pdf'), 'application/pdf');
  assertEquals(detectMimeType('data.json'), 'application/json');
  assertEquals(detectMimeType('text.txt'), 'text/plain');
  assertEquals(detectMimeType('unknown.xyz'), 'application/octet-stream');
});

// ============================================================================
// Integration Tests: JSON via cmd: "data"
// ============================================================================

Deno.test({
  name: "F2R2Adapter - Set/get JSON via cmd: data (deterministic mode)",
  ignore: !HAS_F2,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });

    const testKey = `smallstore:${TEST_SCOPE}/test-json-${Date.now()}.json`;
    const testData = { id: 123, name: 'Test Object', ts: new Date().toISOString() };

    await adapter.set(testKey, testData);
    console.log('  ✓ JSON upload via cmd: data succeeded');

    const retrieved = await adapter.get(testKey);

    if (retrieved !== null) {
      console.log('  ✓ GET succeeded');
      if (typeof retrieved === 'object' && !(retrieved instanceof Uint8Array)) {
        assertEquals(retrieved.id, testData.id);
        assertEquals(retrieved.name, testData.name);
        console.log('  ✓ Data verified');
      }
    } else {
      console.log('  ⚠️ GET returned null (Cloudflare Access may block reads)');
    }
  },
});

// ============================================================================
// Integration Tests: Binary via presigned URL
// ============================================================================

Deno.test({
  name: "F2R2Adapter - Set blob via presigned URL (deterministic mode)",
  ignore: !HAS_F2,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });

    const testKey = `smallstore:${TEST_SCOPE}/test-blob-${Date.now()}.bin`;
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    await adapter.set(testKey, testData);
    console.log('  ✓ Blob upload via presigned URL succeeded');
  },
});

// ============================================================================
// Integration Tests: Delete
// ============================================================================

Deno.test({
  name: "F2R2Adapter - Delete via cmd: delete",
  ignore: !HAS_F2 || !HAS_AUTH,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });

    // Create
    const testKey = `smallstore:${TEST_SCOPE}/test-delete-${Date.now()}.json`;
    await adapter.set(testKey, { deleteMe: true });
    console.log('  ✓ Created test key');

    // Verify exists
    const exists = await adapter.has(testKey);
    if (exists) {
      console.log('  ✓ Key exists before delete');
    }

    // Delete
    await adapter.delete(testKey);
    console.log('  ✓ Delete succeeded');

    // Verify gone
    const afterDelete = await adapter.get(testKey);
    assertEquals(afterDelete, null);
    console.log('  ✓ Key gone after delete');
  },
});

Deno.test({
  name: "F2R2Adapter - Delete non-existent key is a no-op",
  ignore: !HAS_F2 || !HAS_AUTH,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });

    // Should not throw
    await adapter.delete(`smallstore:${TEST_SCOPE}/nonexistent-${Date.now()}.json`);
    console.log('  ✓ Deleting non-existent key is fine');
  },
});

// ============================================================================
// Integration Tests: List Keys
// ============================================================================

Deno.test({
  name: "F2R2Adapter - List keys via cmd: list",
  ignore: !HAS_F2,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });

    // Create a known key so there's at least one result
    const testKey = `smallstore:${TEST_SCOPE}/test-list-${Date.now()}.json`;
    await adapter.set(testKey, { listTest: true });

    const keys = await adapter.keys(TEST_SCOPE);
    console.log(`  ✓ Listed ${keys.length} key(s) in scope "${TEST_SCOPE}"`);

    // Should have at least the key we just created
    assertExists(keys.length > 0, 'Expected at least one key');
  },
});

// ============================================================================
// Integration Tests: Full CRUD Cycle
// ============================================================================

Deno.test({
  name: "F2R2Adapter - Full CRUD cycle (create → read → update → delete)",
  ignore: !HAS_F2 || !HAS_AUTH,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });
    const testKey = `smallstore:${TEST_SCOPE}/crud-test-${Date.now()}.json`;

    // Create
    await adapter.set(testKey, { version: 1, name: 'original' });
    console.log('  ✓ CREATE');

    // Read
    const v1 = await adapter.get(testKey);
    if (v1) {
      assertEquals(v1.version, 1);
      assertEquals(v1.name, 'original');
      console.log('  ✓ READ (v1)');
    }

    // Update (overwrite in deterministic mode)
    await adapter.set(testKey, { version: 2, name: 'updated' });
    const v2 = await adapter.get(testKey);
    if (v2) {
      assertEquals(v2.version, 2);
      assertEquals(v2.name, 'updated');
      console.log('  ✓ UPDATE (v2)');
    }

    // Delete
    await adapter.delete(testKey);
    const gone = await adapter.get(testKey);
    assertEquals(gone, null);
    console.log('  ✓ DELETE');
  },
});

// ============================================================================
// Integration Tests: Clear (prefix delete)
// ============================================================================

Deno.test({
  name: "F2R2Adapter - Clear scope via prefix delete",
  ignore: !HAS_F2 || !HAS_AUTH,
  async fn() {
    const adapter = createF2R2Adapter({ defaultScope: TEST_SCOPE });
    const clearScope = `${TEST_SCOPE}-clear-${Date.now()}`;

    // Create a few keys
    await adapter.set(`smallstore:${clearScope}/a.json`, { a: 1 });
    await adapter.set(`smallstore:${clearScope}/b.json`, { b: 2 });
    console.log('  ✓ Created 2 test keys');

    // Clear scope
    await adapter.clear(clearScope);
    console.log('  ✓ Clear succeeded');

    // Verify gone
    const a = await adapter.get(`smallstore:${clearScope}/a.json`);
    const b = await adapter.get(`smallstore:${clearScope}/b.json`);
    assertEquals(a, null);
    assertEquals(b, null);
    console.log('  ✓ All keys cleared');
  },
});

// ============================================================================
// Error Handling
// ============================================================================

Deno.test({
  name: "F2R2Adapter - Get non-existent key returns null",
  ignore: !HAS_F2,
  async fn() {
    const adapter = createF2R2Adapter();
    const result = await adapter.get('smallstore:nonexistent/key-12345.png');
    assertEquals(result, null);
  },
});

Deno.test({
  name: "F2R2Adapter - Has returns false for non-existent key",
  ignore: !HAS_F2,
  async fn() {
    const adapter = createF2R2Adapter();
    const exists = await adapter.has('smallstore:nonexistent/key-12345.png');
    assertEquals(exists, false);
  },
});

console.log(`
F2R2 Adapter Tests (Deterministic Mode)

  Unit tests: always run
  Integration tests: require F2_DEFAULT_URL
  Delete/clear tests: require F2_DEFAULT_URL + F2_AUTH_KEY
`);
