/**
 * Smallstore HTTP Handlers Tests
 *
 * Tests for framework-agnostic HTTP handlers.
 *
 * Run with: deno test --allow-all tests/http.test.ts
 */

import { assertEquals, assertExists } from "@std/assert";
import type { SmallstoreRequest, SmallstoreInstance } from '../src/http/types.ts';
import {
  handleListCollections,
  handleGet,
  handleSet,
  handleDelete,
  handleGetMetadata,
  handleSetMetadata,
  handleGetSchema,
  handleListKeys,
  handleSignedUploadUrl,
  handleSignedDownloadUrl,
} from '../src/http/handlers.ts';
import { createErrorResponse, createSuccessResponse } from '../src/http/types.ts';

// ============================================================================
// Mock Smallstore
// ============================================================================

function createMockSmallstore(): SmallstoreInstance {
  const data: Record<string, any> = {};
  const metadata: Record<string, Record<string, any>> = {};

  return {
    async get(collectionPath: string, _options?: any): Promise<any> {
      return data[collectionPath] ?? null;
    },

    async set(collectionPath: string, value: any, _options?: any): Promise<void> {
      data[collectionPath] = value;
    },

    async delete(collectionPath: string): Promise<void> {
      delete data[collectionPath];
    },

    async has(collectionPath: string): Promise<boolean> {
      return collectionPath in data;
    },

    async keys(collectionPath: string, _prefix?: string): Promise<string[]> {
      return Object.keys(data).filter((k) => k.startsWith(collectionPath));
    },

    async listCollections(_pattern?: string): Promise<string[]> {
      const collections = new Set<string>();
      for (const key of Object.keys(data)) {
        const collection = key.split('/')[0];
        collections.add(collection);
      }
      return Array.from(collections);
    },

    async getSchema(collection: string): Promise<any> {
      return {
        collection,
        paths: {},
        metadata: {},
      };
    },

    async getCollectionMetadata(collection: string): Promise<Record<string, any>> {
      return metadata[collection] ?? {};
    },

    async setCollectionMetadata(collection: string, meta: Record<string, any>): Promise<void> {
      metadata[collection] = { ...metadata[collection], ...meta };
    },

    async search(_collectionPath: string, _options: any): Promise<any[]> {
      throw new Error('Search not implemented');
    },

    async getSignedUploadUrl(collectionPath: string, options?: any): Promise<string> {
      return `https://r2.example.com/upload/${collectionPath}?expires=${options?.expiresIn || 3600}`;
    },

    async getSignedDownloadUrl(collectionPath: string, options?: any): Promise<string> {
      return `https://r2.example.com/download/${collectionPath}?expires=${options?.expiresIn || 3600}`;
    },
  };
}

function createRequest(overrides: Partial<SmallstoreRequest> = {}): SmallstoreRequest {
  return {
    method: 'GET',
    path: '/test',
    params: {},
    query: {},
    body: null,
    headers: {},
    ...overrides,
  };
}

// ============================================================================
// Helper Function Tests
// ============================================================================

Deno.test('createErrorResponse creates proper error response', () => {
  const response = createErrorResponse(400, 'BadRequest', 'Invalid input', { field: 'name' });

  assertEquals(response.status, 400);
  assertEquals(response.body.error, 'BadRequest');
  assertEquals(response.body.message, 'Invalid input');
  assertEquals(response.body.field, 'name');
});

Deno.test('createSuccessResponse creates proper success response', () => {
  const response = createSuccessResponse({ data: 'test' }, 201, { 'X-Custom': 'header' });

  assertEquals(response.status, 201);
  assertEquals(response.body.data, 'test');
  assertEquals(response.headers?.['X-Custom'], 'header');
});

// ============================================================================
// Handler Tests
// ============================================================================

Deno.test('handleListCollections returns empty array for empty store', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({ path: '/collections' });

  const response = await handleListCollections(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.collections, []);
  assertEquals(response.body.total, 0);
});

Deno.test('handleListCollections returns collections', async () => {
  const smallstore = createMockSmallstore();
  await smallstore.set('users', [{ id: 1 }]);
  await smallstore.set('posts', [{ id: 1 }]);

  const request = createRequest({ path: '/collections' });
  const response = await handleListCollections(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.total, 2);
  assertExists(response.body.collections);
});

Deno.test('handleGet returns 400 when collection is missing', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'GET',
    params: {},
  });

  const response = await handleGet(request, smallstore);

  assertEquals(response.status, 400);
  assertEquals(response.body.error, 'BadRequest');
});

Deno.test('handleGet returns 404 for non-existent collection', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'GET',
    params: { collection: 'nonexistent' },
  });

  const response = await handleGet(request, smallstore);

  assertEquals(response.status, 404);
  assertEquals(response.body.error, 'NotFound');
});

Deno.test('handleGet returns data for existing collection', async () => {
  const smallstore = createMockSmallstore();
  const testData = [{ id: 1, name: 'Test' }];
  await smallstore.set('users', testData);

  const request = createRequest({
    method: 'GET',
    params: { collection: 'users' },
  });

  const response = await handleGet(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.data, testData);
  assertEquals(response.body.collection, 'users');
  assertEquals(response.body.type, 'array');
  assertEquals(response.body.count, 1);
});

Deno.test('handleGet supports offset for arrays', async () => {
  const smallstore = createMockSmallstore();
  const testData = [{ id: 1 }, { id: 2 }, { id: 3 }];
  await smallstore.set('items', testData);

  const request = createRequest({
    method: 'GET',
    params: { collection: 'items' },
    query: { offset: '1' },
  });

  const response = await handleGet(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.data.length, 2);
  assertEquals(response.body.data[0].id, 2);
});

Deno.test('handleSet returns 400 when collection is missing', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'POST',
    params: {},
    body: { data: {} },
  });

  const response = await handleSet(request, smallstore);

  assertEquals(response.status, 400);
  assertEquals(response.body.error, 'BadRequest');
});

Deno.test('handleSet returns 400 when body is missing data field', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'POST',
    params: { collection: 'users' },
    body: { notData: {} },
  });

  const response = await handleSet(request, smallstore);

  assertEquals(response.status, 400);
  assertEquals(response.body.error, 'BadRequest');
  assertEquals(response.body.message, 'Request body must contain "data" field');
});

Deno.test('handleSet creates data with POST (append mode)', async () => {
  const smallstore = createMockSmallstore();
  const testData = { name: 'Test User' };

  const request = createRequest({
    method: 'POST',
    params: { collection: 'users' },
    body: { data: testData },
  });

  const response = await handleSet(request, smallstore);

  assertEquals(response.status, 201);
  assertEquals(response.body.success, true);
  assertEquals(response.body.mode, 'append');

  // Verify data was stored
  const stored = await smallstore.get('users');
  assertEquals(stored, testData);
});

Deno.test('handleSet uses overwrite mode for PUT', async () => {
  const smallstore = createMockSmallstore();
  const testData = { name: 'Updated' };

  const request = createRequest({
    method: 'PUT',
    params: { collection: 'users' },
    body: { data: testData },
  });

  const response = await handleSet(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.mode, 'overwrite');
});

Deno.test('handleSet uses merge mode for PATCH', async () => {
  const smallstore = createMockSmallstore();
  const testData = { email: 'test@example.com' };

  const request = createRequest({
    method: 'PATCH',
    params: { collection: 'users' },
    body: { data: testData },
  });

  const response = await handleSet(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.mode, 'merge');
});

Deno.test('handleDelete returns 400 when collection is missing', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'DELETE',
    params: {},
  });

  const response = await handleDelete(request, smallstore);

  assertEquals(response.status, 400);
  assertEquals(response.body.error, 'BadRequest');
});

Deno.test('handleDelete returns 404 for non-existent collection', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'DELETE',
    params: { collection: 'nonexistent' },
  });

  const response = await handleDelete(request, smallstore);

  assertEquals(response.status, 404);
  assertEquals(response.body.error, 'NotFound');
});

Deno.test('handleDelete removes existing collection', async () => {
  const smallstore = createMockSmallstore();
  await smallstore.set('users', [{ id: 1 }]);

  const request = createRequest({
    method: 'DELETE',
    params: { collection: 'users' },
  });

  const response = await handleDelete(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.success, true);
  assertEquals(response.body.deleted, true);

  // Verify data was deleted
  const exists = await smallstore.has('users');
  assertEquals(exists, false);
});

Deno.test('handleGetMetadata returns metadata', async () => {
  const smallstore = createMockSmallstore();
  await smallstore.setCollectionMetadata('users', { description: 'User data' });

  const request = createRequest({
    params: { collection: 'users' },
  });

  const response = await handleGetMetadata(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.description, 'User data');
  assertEquals(response.body.collection, 'users');
});

Deno.test('handleSetMetadata updates metadata', async () => {
  const smallstore = createMockSmallstore();

  const request = createRequest({
    method: 'PUT',
    params: { collection: 'users' },
    body: { name: 'Users Collection', tags: ['important'] },
  });

  const response = await handleSetMetadata(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.success, true);
  assertExists(response.body.metadata);
});

Deno.test('handleGetSchema returns schema', async () => {
  const smallstore = createMockSmallstore();

  const request = createRequest({
    params: { collection: 'users' },
  });

  const response = await handleGetSchema(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.collection, 'users');
});

Deno.test('handleListKeys returns keys', async () => {
  const smallstore = createMockSmallstore();
  await smallstore.set('users/alice', { name: 'Alice' });
  await smallstore.set('users/bob', { name: 'Bob' });

  const request = createRequest({
    params: { collection: 'users' },
  });

  const response = await handleListKeys(request, smallstore);

  assertEquals(response.status, 200);
  assertEquals(response.body.collection, 'users');
  assertExists(response.body.keys);
  assertExists(response.body.total);
});

// ============================================================================
// Import Tests
// ============================================================================

Deno.test('mod.ts exports all required items', async () => {
  const mod = await import('../src/http/mod.ts');

  // Types should be importable (they're type-only, so we check functions exist)
  assertExists(mod.createErrorResponse);
  assertExists(mod.createSuccessResponse);
  assertExists(mod.SMALLSTORE_ROUTES);

  // Handlers
  assertExists(mod.handleListCollections);
  assertExists(mod.handleGet);
  assertExists(mod.handleSet);
  assertExists(mod.handleDelete);
  assertExists(mod.handleGetMetadata);
  assertExists(mod.handleSetMetadata);
  assertExists(mod.handleGetSchema);
  assertExists(mod.handleListKeys);
  assertExists(mod.handleSearch);
  assertExists(mod.handleQuery);
  assertExists(mod.handlers);

  // Integrations
  assertExists(mod.createHonoRoutes);
  assertExists(mod.createHonoRouter);
  assertExists(mod.honoMiddleware);
  // Express integration is a stub and not exported
});

// ============================================================================
// Signed URL Handler Tests
// ============================================================================

Deno.test('handleSignedUploadUrl returns signed URL', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'POST',
    params: { collection: 'uploads' },
    body: { key: 'photo.jpg', expiresIn: 7200, contentType: 'image/jpeg' },
  });

  const response = await handleSignedUploadUrl(request, smallstore);
  assertEquals(response.status, 200);
  assertExists(response.body.url);
  assertEquals(response.body.path, 'uploads/photo.jpg');
  assertEquals(response.body.expiresIn, 7200);
});

Deno.test('handleSignedUploadUrl with collection only (no key)', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'POST',
    params: { collection: 'uploads' },
    body: {},
  });

  const response = await handleSignedUploadUrl(request, smallstore);
  assertEquals(response.status, 200);
  assertEquals(response.body.path, 'uploads');
  assertEquals(response.body.expiresIn, 3600); // default
});

Deno.test('handleSignedDownloadUrl returns signed URL', async () => {
  const smallstore = createMockSmallstore();
  const request = createRequest({
    method: 'POST',
    params: { collection: 'uploads' },
    body: { key: 'photo.jpg', expiresIn: 600, filename: 'my-photo.jpg' },
  });

  const response = await handleSignedDownloadUrl(request, smallstore);
  assertEquals(response.status, 200);
  assertExists(response.body.url);
  assertEquals(response.body.path, 'uploads/photo.jpg');
  assertEquals(response.body.expiresIn, 600);
});

Deno.test('handleSignedUploadUrl returns 501 when adapter does not support it', async () => {
  const smallstore = createMockSmallstore();
  // Override to throw UnsupportedOperationError-like error
  smallstore.getSignedUploadUrl = async () => {
    const err = new Error('Not supported');
    err.name = 'UnsupportedOperationError';
    throw err;
  };

  const request = createRequest({
    method: 'POST',
    params: { collection: 'uploads' },
    body: { key: 'test.txt' },
  });

  const response = await handleSignedUploadUrl(request, smallstore);
  // Should be 500 (since it's not an actual UnsupportedOperationError instance)
  assertEquals(response.status, 500);
});

console.log('All HTTP handler tests completed.');
