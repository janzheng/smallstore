/**
 * Local File Adapter Tests
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { createLocalFileAdapter } from '../src/adapters/local-file.ts';

const TEST_DIR = './data/_test-local-file';

// ============================================================================
// Basic CRUD
// ============================================================================

Deno.test('LocalFileAdapter - set and get binary data', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  const data = new TextEncoder().encode('hello binary world');
  await adapter.set('test.bin', data);

  const result = await adapter.get('test.bin');
  assertNotEquals(result, null);
  assertEquals(result instanceof Uint8Array, true);
  assertEquals(new TextDecoder().decode(result!), 'hello binary world');
});

Deno.test('LocalFileAdapter - set and get string', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  await adapter.set('readme.txt', 'This is a text file');

  const result = await adapter.get('readme.txt');
  assertNotEquals(result, null);
  assertEquals(new TextDecoder().decode(result!), 'This is a text file');
});

Deno.test('LocalFileAdapter - set and get JSON (auto-serialized)', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  await adapter.set('config.json', { name: 'test', version: 1 });

  const result = await adapter.get('config.json');
  assertNotEquals(result, null);
  const parsed = JSON.parse(new TextDecoder().decode(result!));
  assertEquals(parsed.name, 'test');
  assertEquals(parsed.version, 1);
});

Deno.test('LocalFileAdapter - get nonexistent returns null', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  const result = await adapter.get('nonexistent.txt');
  assertEquals(result, null);
});

Deno.test('LocalFileAdapter - nested directories', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  await adapter.set('media/images/photo.txt', 'fake image data');

  const result = await adapter.get('media/images/photo.txt');
  assertNotEquals(result, null);
  assertEquals(new TextDecoder().decode(result!), 'fake image data');
});

// ============================================================================
// Delete
// ============================================================================

Deno.test('LocalFileAdapter - delete file', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  await adapter.set('to-delete.txt', 'bye');
  assertEquals(await adapter.has('to-delete.txt'), true);

  await adapter.delete('to-delete.txt');
  assertEquals(await adapter.has('to-delete.txt'), false);
  assertEquals(await adapter.get('to-delete.txt'), null);
});

// ============================================================================
// Has
// ============================================================================

Deno.test('LocalFileAdapter - has returns true for existing files', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  await adapter.set('exists.txt', 'yes');
  assertEquals(await adapter.has('exists.txt'), true);
});

Deno.test('LocalFileAdapter - has returns false for missing files', async () => {
  const adapter = createLocalFileAdapter({ baseDir: TEST_DIR });

  assertEquals(await adapter.has('nope.txt'), false);
});

// ============================================================================
// Keys
// ============================================================================

Deno.test('LocalFileAdapter - keys lists all files', async () => {
  const adapter = createLocalFileAdapter({ baseDir: `${TEST_DIR}/keys-test` });

  await adapter.set('a.txt', 'a');
  await adapter.set('b.txt', 'b');
  await adapter.set('sub/c.txt', 'c');

  const keys = await adapter.keys();
  assertEquals(keys.length, 3);
  assertEquals(keys.includes('a.txt'), true);
  assertEquals(keys.includes('b.txt'), true);
  assertEquals(keys.includes('sub/c.txt'), true);
});

// ============================================================================
// Clear
// ============================================================================

Deno.test('LocalFileAdapter - clear removes all files', async () => {
  const adapter = createLocalFileAdapter({ baseDir: `${TEST_DIR}/clear-test` });

  await adapter.set('a.txt', 'a');
  await adapter.set('b.txt', 'b');

  await adapter.clear();

  const keys = await adapter.keys();
  assertEquals(keys.length, 0);
});

// ============================================================================
// Capabilities
// ============================================================================

Deno.test('LocalFileAdapter - capabilities', () => {
  const adapter = createLocalFileAdapter();

  assertEquals(adapter.capabilities.name, 'local-file');
  assertEquals(adapter.capabilities.supportedTypes.includes('blob'), true);
  assertEquals(adapter.capabilities.cost?.tier, 'free');
});

// ============================================================================
// Cleanup
// ============================================================================

Deno.test({
  name: 'cleanup - remove local-file test artifacts',
  fn: async () => {
    try { await Deno.remove(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
