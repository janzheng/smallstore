/**
 * Smallstore HTTP Handlers
 *
 * Framework-agnostic handlers for Smallstore REST API.
 * These handlers work with any HTTP framework through adapters.
 *
 * @example
 * ```typescript
 * import { handleGet, handleSet } from './handlers.ts';
 * import type { SmallstoreRequest } from './types.ts';
 *
 * // In your framework adapter:
 * const response = await handleGet(request, smallstore);
 * ```
 */

import type {
  SmallstoreRequest,
  SmallstoreResponse,
  SmallstoreInstance,
} from './types.ts';
import { createErrorResponse, createSuccessResponse } from './types.ts';
import { UnsupportedOperationError } from '../adapters/errors.ts';

/**
 * Parse a boolean query parameter, case-insensitive.
 * Accepts 'true' (any case) or '1'.
 */
function parseBoolParam(val: string | undefined): boolean {
  return val?.toLowerCase() === 'true' || val === '1';
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely parse an integer from a string, returning a default if the value
 * is undefined, empty, or not a valid number.
 */
function parseIntSafe(value: string | undefined, defaultValue?: number): number | undefined {
  if (value === undefined || value === '') return defaultValue;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? defaultValue : n;
}

// ============================================================================
// Collection Listing
// ============================================================================

/**
 * List all collections
 * GET /collections
 */
export async function handleListCollections(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const pattern = request.query.pattern;
    const collections = await smallstore.listCollections(pattern);

    return createSuccessResponse({
      collections,
      total: collections.length,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error listing collections:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to list collections');
  }
}

// ============================================================================
// Get Operations
// ============================================================================

/**
 * Get collection data
 * GET /:collection
 * GET /:collection/:path*
 */
export async function handleGet(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    const path = request.params.path;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    // Build full path: collection or collection/path
    const fullPath = path ? `${collection}/${path}` : collection;

    // Parse query parameters
    const limit = parseIntSafe(request.query.limit);
    const offset = parseIntSafe(request.query.offset);

    // Get data from Smallstore
    const data = await smallstore.get(fullPath, {
      limit,
    });

    // Handle 404 (null response from Smallstore)
    if (data === null) {
      return createErrorResponse(
        404,
        'NotFound',
        `Collection '${collection}'${path ? ` at path '${path}'` : ''} not found`,
        { collection, path: path || '' }
      );
    }

    // Apply offset if provided (for arrays)
    let processedData = data;
    if (offset && Array.isArray(data)) {
      processedData = data.slice(offset);
    }

    // Determine data type
    const dataType = Array.isArray(processedData)
      ? 'array'
      : typeof processedData === 'object' && processedData !== null
        ? 'object'
        : typeof processedData;

    // Get adapter info from schema (if available)
    let adapter = 'unknown';
    try {
      const schema = await smallstore.getSchema(collection);
      if (schema.paths && typeof schema.paths === 'object') {
        const pathKeys = Object.keys(schema.paths);
        if (pathKeys.length > 0) {
          adapter = schema.paths[pathKeys[0]]?.adapter || 'unknown';
        }
      }
    } catch (schemaErr) {
      console.warn('[SmallstoreHandler] Schema introspection failed for', collection, schemaErr);
    }

    return createSuccessResponse({
      data: processedData,
      collection,
      path: path || '',
      type: dataType,
      count: Array.isArray(processedData) ? processedData.length : undefined,
      adapter,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error getting collection:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to get collection',
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Set Operations
// ============================================================================

/**
 * Set data in collection (supports POST, PUT, PATCH)
 * POST /:collection - Append
 * PUT /:collection - Overwrite
 * PATCH /:collection - Merge
 */
export async function handleSet(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    // Validate body
    const body = request.body;
    if (!body || typeof body !== 'object' || !('data' in body)) {
      return createErrorResponse(
        400,
        'BadRequest',
        'Request body must contain "data" field'
      );
    }

    // Determine mode based on HTTP method
    let mode: 'append' | 'overwrite' | 'merge';
    switch (request.method.toUpperCase()) {
      case 'PUT':
        mode = 'overwrite';
        break;
      case 'PATCH':
        mode = 'merge';
        break;
      case 'POST':
      default:
        mode = body.mode || 'append';
        break;
    }

    const { data } = body;
    const ttl = parseIntSafe(request.query.ttl);

    // Build full path including sub-path if present
    const fullPath = request.params.path
      ? `${collection}/${request.params.path}`
      : collection;

    // Set data in Smallstore
    await smallstore.set(fullPath, data, {
      mode,
      ttl,
    });

    // Return appropriate response based on method
    const status = request.method.toUpperCase() === 'POST' ? 201 : 200;

    return createSuccessResponse(
      {
        success: true,
        collection,
        path: request.params.path || '',
        mode,
        keys: [fullPath],
      },
      status
    );
  } catch (error) {
    console.error('[SmallstoreHandler] Error setting collection:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      `Failed to ${request.method.toLowerCase()} collection`,
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete collection or path
 * DELETE /:collection
 * DELETE /:collection/:path*
 */
export async function handleDelete(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    const path = request.params.path;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    const fullPath = path ? `${collection}/${path}` : collection;

    // Check if path exists
    const exists = await smallstore.has(fullPath);
    if (!exists) {
      const message = path
        ? `Path '${path}' not found in collection '${collection}'`
        : `Collection '${collection}' not found`;
      return createErrorResponse(404, 'NotFound', message, { collection, path: path || '' });
    }

    // Delete
    await smallstore.delete(fullPath);

    return createSuccessResponse({
      success: true,
      collection,
      path: path || '',
      deleted: true,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error deleting:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to delete',
      {
        collection: request.params.collection,
        path: request.params.path || '',
      }
    );
  }
}

// ============================================================================
// Metadata Operations
// ============================================================================

/**
 * Get collection metadata
 * GET /:collection/metadata
 */
export async function handleGetMetadata(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    const metadata = await smallstore.getCollectionMetadata(collection);

    return createSuccessResponse({
      ...metadata,
      collection,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error getting metadata:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to get collection metadata',
      { collection: request.params.collection }
    );
  }
}

/**
 * Set collection metadata
 * PUT /:collection/metadata
 */
export async function handleSetMetadata(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    // Validate body
    const metadata = request.body;
    if (!metadata || typeof metadata !== 'object') {
      return createErrorResponse(400, 'BadRequest', 'Request body must be a JSON object');
    }

    // Set metadata
    await smallstore.setCollectionMetadata(collection, metadata);

    // Get updated metadata to return
    const updatedMetadata = await smallstore.getCollectionMetadata(collection);

    return createSuccessResponse({
      success: true,
      collection,
      metadata: updatedMetadata,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error setting metadata:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to set collection metadata',
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Schema Operations
// ============================================================================

/**
 * Get collection schema
 * GET /:collection/schema
 */
export async function handleGetSchema(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    const schema = await smallstore.getSchema(collection);

    return createSuccessResponse(schema);
  } catch (error) {
    console.error('[SmallstoreHandler] Error getting schema:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to get collection schema',
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Keys Operations
// ============================================================================

/**
 * List collection keys
 * GET /:collection/keys
 */
export async function handleListKeys(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    const prefix = request.query.prefix as string | undefined;
    const limitRaw = request.query.limit as string | undefined;
    const offsetRaw = request.query.offset as string | undefined;
    const cursor = request.query.cursor as string | undefined;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    // Use Number() rather than parseInt() so "999x" gets rejected instead of
    // being silently parsed as 999. Number.isInteger() also covers Infinity / NaN.
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    const offset = offsetRaw !== undefined ? Number(offsetRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return createErrorResponse(400, 'BadRequest', '`limit` must be a positive integer');
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      return createErrorResponse(400, 'BadRequest', '`offset` must be a non-negative integer');
    }

    // Use paged listKeys when any paging param is present; fall back to keys()
    // for the legacy unpaged shape so unchanged callers see the same response.
    const paged = limit !== undefined || offset !== undefined || cursor !== undefined;
    if (paged && typeof smallstore.listKeys === 'function') {
      const page = await smallstore.listKeys(collection, { prefix, limit, offset, cursor });
      return createSuccessResponse({
        keys: page.keys,
        collection,
        hasMore: page.hasMore,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        ...(page.total !== undefined ? { total: page.total } : { total: page.keys.length }),
      });
    }

    const keys = await smallstore.keys(collection, prefix);
    return createSuccessResponse({
      keys,
      collection,
      total: keys.length,
      hasMore: false,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error listing keys:', error);
    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to list collection keys',
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Search Operations
// ============================================================================

/**
 * Search collection
 * GET /:collection/search
 */
export async function handleSearch(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    const query = request.query.q;
    const limit = parseIntSafe(request.query.limit, 10)!;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    if (!query) {
      return createErrorResponse(
        400,
        'BadRequest',
        'Search query parameter "q" is required'
      );
    }

    // Call Smallstore search
    const results = await smallstore.search(collection, {
      query,
      limit,
      type: 'bm25', // Default to BM25 search type
    });

    return createSuccessResponse({
      results,
      query,
      total: results.length,
      limit,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error searching collection:', error);

    if (error instanceof UnsupportedOperationError) {
      return createErrorResponse(
        501,
        'NotImplemented',
        error.message,
        { collection: request.params.collection, suggestion: error.suggestedAlternative }
      );
    }

    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to search collection',
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Query Operations (Phase 3.6f)
// ============================================================================

/**
 * Query collection with complex filters
 * POST /:collection/query
 */
export async function handleQuery(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;

    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    // Check if query method is available
    if (!smallstore.query) {
      return createErrorResponse(
        501,
        'NotImplemented',
        'Query is not implemented in this Smallstore instance',
        { collection }
      );
    }

    const options = request.body || {};

    // Execute query
    const result = await smallstore.query(collection, options);

    return createSuccessResponse(result);
  } catch (error) {
    console.error('[SmallstoreHandler] Error querying collection:', error);

    if (error instanceof UnsupportedOperationError) {
      return createErrorResponse(
        501,
        'NotImplemented',
        error.message,
        { collection: request.params.collection, suggestion: error.suggestedAlternative }
      );
    }

    return createErrorResponse(
      500,
      'InternalServerError',
      'Failed to query collection',
      { collection: request.params.collection }
    );
  }
}

// ============================================================================
// Namespace Operations
// ============================================================================

/**
 * List namespaces (top-level or children of a path)
 * GET /namespaces
 * GET /namespaces/:path/children
 */
export async function handleListNamespaces(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    if (!smallstore.listNamespaces) {
      return createErrorResponse(501, 'NotImplemented', 'listNamespaces not available');
    }

    const parentPath = request.params.path || undefined;
    const namespaces = await smallstore.listNamespaces(parentPath);

    return createSuccessResponse({
      namespaces,
      parent: parentPath || '/',
      total: namespaces.length,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error listing namespaces:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to list namespaces');
  }
}

/**
 * Delete a namespace
 * DELETE /namespaces/:path
 */
export async function handleDeleteNamespace(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    if (!smallstore.deleteNamespace) {
      return createErrorResponse(501, 'NotImplemented', 'deleteNamespace not available');
    }

    const path = request.params.path;
    if (!path) {
      return createErrorResponse(400, 'BadRequest', 'Namespace path is required');
    }

    const recursive = parseBoolParam(request.query.recursive);
    const result = await smallstore.deleteNamespace(path, { recursive });

    return createSuccessResponse({
      success: true,
      path,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete namespace';
    console.error('[SmallstoreHandler] Error deleting namespace:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Get namespace stats
 * GET /namespaces/:path/stat
 */
export async function handleStat(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    if (!smallstore.stat) {
      return createErrorResponse(501, 'NotImplemented', 'stat not available');
    }

    const path = request.params.path;
    if (!path) {
      return createErrorResponse(400, 'BadRequest', 'Path is required');
    }

    const stats = await smallstore.stat(path);
    return createSuccessResponse(stats);
  } catch (error) {
    console.error('[SmallstoreHandler] Error getting stat:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to get namespace stats');
  }
}

/**
 * Get namespace tree
 * GET /tree
 * GET /tree/:path
 */
export async function handleTree(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    if (!smallstore.tree) {
      return createErrorResponse(501, 'NotImplemented', 'tree not available');
    }

    const path = request.params.path || '';
    const tree = await smallstore.tree(path);
    return createSuccessResponse(tree);
  } catch (error) {
    console.error('[SmallstoreHandler] Error getting tree:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to get tree');
  }
}

// ============================================================================
// Batch Operations (slice, split, deduplicate, merge)
// ============================================================================

/**
 * Slice a collection subset
 * POST /:collection/slice
 *
 * Body: { start?: number, end?: number, saveTo?: string, returnData?: boolean }
 */
export async function handleSlice(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.slice) {
    return createErrorResponse(501, 'NotImplemented', 'Slice is not available in this Smallstore instance');
  }
  try {
    const collection = request.params.collection;
    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    const options = request.body || {};
    const result = await smallstore.slice(collection, options);

    return createSuccessResponse({
      success: true,
      collection,
      ...(result ? { data: result, count: result.length } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to slice collection';
    if (message.includes('not found')) {
      return createErrorResponse(404, 'NotFound', message);
    }
    console.error('[SmallstoreHandler] Error slicing collection:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Split a collection by field value
 * POST /:collection/split
 *
 * Body: { by: string, destPattern: string, maxPerSplit?: number }
 */
export async function handleSplit(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.split) {
    return createErrorResponse(501, 'NotImplemented', 'Split is not available in this Smallstore instance');
  }
  try {
    const collection = request.params.collection;
    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    const options = request.body || {};
    if (!options.by) {
      return createErrorResponse(400, 'BadRequest', '"by" field is required');
    }
    if (!options.destPattern) {
      return createErrorResponse(400, 'BadRequest', '"destPattern" field is required');
    }

    await smallstore.split(collection, options);

    return createSuccessResponse({
      success: true,
      collection,
      by: options.by,
      destPattern: options.destPattern,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to split collection';
    if (message.includes('not found')) {
      return createErrorResponse(404, 'NotFound', message);
    }
    console.error('[SmallstoreHandler] Error splitting collection:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Deduplicate a collection
 * POST /:collection/deduplicate
 *
 * Body: { idField?: string, useContentHash?: boolean, compareFields?: string[], keep?: 'first' | 'last' }
 */
export async function handleDeduplicate(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.deduplicate) {
    return createErrorResponse(501, 'NotImplemented', 'Deduplicate is not available in this Smallstore instance');
  }
  try {
    const collection = request.params.collection;
    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection name is required');
    }

    const options = request.body || {};
    await smallstore.deduplicate(collection, options);

    return createSuccessResponse({
      success: true,
      collection,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to deduplicate collection';
    if (message.includes('not found')) {
      return createErrorResponse(404, 'NotFound', message);
    }
    console.error('[SmallstoreHandler] Error deduplicating collection:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Merge multiple collections into one
 * POST /merge
 *
 * Body: { sources: string[], dest: string, deduplicate?: boolean, idField?: string, onConflict?: string, overwrite?: boolean }
 */
export async function handleMerge(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.merge) {
    return createErrorResponse(501, 'NotImplemented', 'Merge is not available in this Smallstore instance');
  }
  try {
    const body = request.body || {};
    const { sources, dest, ...options } = body;

    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return createErrorResponse(400, 'BadRequest', '"sources" must be a non-empty array of collection paths');
    }
    if (!dest || typeof dest !== 'string') {
      return createErrorResponse(400, 'BadRequest', '"dest" must be a collection path string');
    }

    await smallstore.merge(sources, dest, options);

    return createSuccessResponse({
      success: true,
      sources,
      dest,
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to merge collections';
    console.error('[SmallstoreHandler] Error merging collections:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

// ============================================================================
// Materialized Views (Phase 3.6h-b)
// ============================================================================

/**
 * List materialized views
 * GET /views
 */
export async function handleListViews(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.listMaterializedViews) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const source = request.query.source;
    const refresh = request.query.refresh;
    const filter = (source || refresh) ? { source, refresh } : undefined;
    const views = await smallstore.listMaterializedViews(filter);
    return createSuccessResponse({ views, total: views.length });
  } catch (error) {
    console.error('[SmallstoreHandler] Error listing views:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to list views');
  }
}

/**
 * Create a materialized view
 * POST /views
 */
export async function handleCreateView(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.createMaterializedView) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const { name, ...definition } = request.body || {};
    if (!name) {
      return createErrorResponse(400, 'BadRequest', 'View name is required');
    }
    if (!definition.source) {
      return createErrorResponse(400, 'BadRequest', 'View source collection is required');
    }
    if (!definition.refresh) {
      return createErrorResponse(400, 'BadRequest', 'View refresh strategy is required');
    }
    await smallstore.createMaterializedView(name, definition);
    return createSuccessResponse({ success: true, name }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create view';
    if (message.includes('already exists')) {
      return createErrorResponse(409, 'Conflict', message);
    }
    console.error('[SmallstoreHandler] Error creating view:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Get materialized view data
 * GET /views/:name
 */
export async function handleGetView(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const name = request.params.name;
    if (!name) {
      return createErrorResponse(400, 'BadRequest', 'View name is required');
    }
    // Read via .view suffix which triggers the materialized view path
    const data = await smallstore.get(`${name}.view`);
    return createSuccessResponse({ data, view: name });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get view';
    if (message.includes('not found')) {
      return createErrorResponse(404, 'NotFound', message);
    }
    console.error('[SmallstoreHandler] Error getting view:', error);
    return createErrorResponse(500, 'InternalServerError', message);
  }
}

/**
 * Get materialized view metadata
 * GET /views/:name/metadata
 */
export async function handleGetViewMetadata(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.getViewMetadata) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const name = request.params.name;
    if (!name) {
      return createErrorResponse(400, 'BadRequest', 'View name is required');
    }
    const metadata = await smallstore.getViewMetadata(name);
    if (!metadata) {
      return createErrorResponse(404, 'NotFound', `View "${name}" not found`);
    }
    return createSuccessResponse(metadata);
  } catch (error) {
    console.error('[SmallstoreHandler] Error getting view metadata:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to get view metadata');
  }
}

/**
 * Update materialized view definition
 * PUT /views/:name
 */
export async function handleUpdateView(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.updateMaterializedView) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const name = request.params.name;
    if (!name) {
      return createErrorResponse(400, 'BadRequest', 'View name is required');
    }
    await smallstore.updateMaterializedView(name, request.body || {});
    return createSuccessResponse({ success: true, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update view';
    if (message.includes('not found')) {
      return createErrorResponse(404, 'NotFound', message);
    }
    console.error('[SmallstoreHandler] Error updating view:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Delete materialized view
 * DELETE /views/:name
 */
export async function handleDeleteView(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.deleteMaterializedView) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const name = request.params.name;
    if (!name) {
      return createErrorResponse(400, 'BadRequest', 'View name is required');
    }
    const deleteData = request.query.deleteData !== 'false';
    await smallstore.deleteMaterializedView(name, deleteData);
    return createSuccessResponse({ success: true, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete view';
    console.error('[SmallstoreHandler] Error deleting view:', error);
    return createErrorResponse(400, 'BadRequest', message);
  }
}

/**
 * Refresh a materialized view
 * POST /views/:name/refresh
 */
export async function handleRefreshView(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.refreshView) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const name = request.params.name;
    if (!name) {
      return createErrorResponse(400, 'BadRequest', 'View name is required');
    }
    const force = parseBoolParam(request.query.force) || request.body?.force === true;
    const result = await smallstore.refreshView(name, { force });
    return createSuccessResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh view';
    if (message.includes('not found')) {
      return createErrorResponse(404, 'NotFound', message);
    }
    console.error('[SmallstoreHandler] Error refreshing view:', error);
    return createErrorResponse(500, 'InternalServerError', message);
  }
}

/**
 * Refresh all materialized views
 * POST /views/refresh
 */
export async function handleRefreshAllViews(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  if (!smallstore.refreshAllViews) {
    return createErrorResponse(501, 'NotImplemented', 'Materialized views not available');
  }
  try {
    const source = request.query.source || request.body?.source;
    const filter = source ? { source } : undefined;
    const results = await smallstore.refreshAllViews(filter);
    return createSuccessResponse({
      results,
      total: results.length,
      success: results.filter((r: any) => r.success).length,
      failed: results.filter((r: any) => !r.success).length,
    });
  } catch (error) {
    console.error('[SmallstoreHandler] Error refreshing all views:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to refresh views');
  }
}

// ============================================================================
// Signed URLs
// ============================================================================

/**
 * Generate a signed upload URL
 * POST /:collection/signed-upload
 * Body: { key?, expiresIn?, contentType?, maxSize? }
 */
export async function handleSignedUploadUrl(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    const subpath = request.params['*'] || request.body?.key || '';
    const path = subpath ? `${collection}/${subpath}` : collection;

    const url = await smallstore.getSignedUploadUrl(path, {
      expiresIn: request.body?.expiresIn,
      contentType: request.body?.contentType,
      maxSize: request.body?.maxSize,
    });

    return createSuccessResponse({ url, path, expiresIn: request.body?.expiresIn || 3600 });
  } catch (error) {
    if (error instanceof UnsupportedOperationError) {
      return createErrorResponse(501, 'NotImplemented', error.message);
    }
    console.error('[SmallstoreHandler] Error generating signed upload URL:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to generate signed upload URL');
  }
}

/**
 * Generate a signed download URL
 * POST /:collection/signed-download
 * Body: { key?, expiresIn?, filename? }
 */
export async function handleSignedDownloadUrl(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    const subpath = request.params['*'] || request.body?.key || '';
    const path = subpath ? `${collection}/${subpath}` : collection;

    const url = await smallstore.getSignedDownloadUrl(path, {
      expiresIn: request.body?.expiresIn,
      filename: request.body?.filename,
    });

    return createSuccessResponse({ url, path, expiresIn: request.body?.expiresIn || 3600 });
  } catch (error) {
    if (error instanceof UnsupportedOperationError) {
      return createErrorResponse(501, 'NotImplemented', error.message);
    }
    console.error('[SmallstoreHandler] Error generating signed download URL:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to generate signed download URL');
  }
}

// ============================================================================
// Retrieval Pipeline
// ============================================================================

/**
 * Execute a retrieval pipeline
 * POST /:collection/pipeline
 * Body: { steps: [{ provider, options }], query?, vector? }
 *
 * Steps reference providers by name. Available built-in names:
 * - "search:bm25", "search:vector", "search:hybrid" (if adapter has searchProvider)
 * - "filter", "slice", "text", "structured", "flatten", "metadata"
 *
 * @example
 * POST /notes/pipeline
 * { "steps": [
 *     { "provider": "search:bm25", "options": { "limit": 50 } },
 *     { "provider": "filter", "options": { "where": { "status": "published" } } },
 *     { "provider": "slice", "options": { "mode": "head", "take": 10 } }
 *   ],
 *   "query": "machine learning"
 * }
 */
export async function handleRetrievalPipeline(
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance,
): Promise<SmallstoreResponse> {
  try {
    const collection = request.params.collection;
    if (!collection) {
      return createErrorResponse(400, 'BadRequest', 'Collection is required');
    }

    const steps = request.body?.steps;
    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return createErrorResponse(400, 'BadRequest', 'Pipeline requires at least one step in "steps" array');
    }

    // Build the pipeline if the store supports it
    if ('executeRetrievalPipeline' in smallstore && typeof (smallstore as Record<string, any>).executeRetrievalPipeline === 'function') {
      const result = await (smallstore as Record<string, any>).executeRetrievalPipeline(collection, {
        steps,
        query: request.body?.query,
        vector: request.body?.vector,
      });
      return createSuccessResponse(result);
    }

    // Fallback: try to use the retrieval module directly
    const { RetrievalPipeline } = await import('../retrieval/pipeline.ts');
    const { SearchProviderWrapper } = await import('../retrieval/adapters/search-adapter.ts');
    const { RetrieverWrapper } = await import('../retrieval/adapters/retriever-adapter.ts');
    const {
      FilterRetriever,
      SliceRetriever,
      TextRetriever,
      StructuredRetriever,
      FlattenRetriever,
      MetadataRetriever,
    } = await import('../retrievers/mod.ts');

    // Build a registry of available providers
    const registry = new Map();

    // Register built-in retrievers
    registry.set('filter', new RetrieverWrapper(new FilterRetriever()));
    registry.set('slice', new RetrieverWrapper(new SliceRetriever()));
    registry.set('text', new RetrieverWrapper(new TextRetriever()));
    registry.set('structured', new RetrieverWrapper(new StructuredRetriever()));
    registry.set('flatten', new RetrieverWrapper(new FlattenRetriever()));
    registry.set('metadata', new RetrieverWrapper(new MetadataRetriever()));

    // Build pipeline from steps
    const pipeline = RetrievalPipeline.fromSteps(
      steps.map((s: any) => ({
        provider: s.provider,
        options: s.options,
      })),
      registry,
    );

    // Get collection data for the pipeline input
    const data = await smallstore.get(collection);

    const result = await pipeline.execute({
      data,
      query: request.body?.query,
      vector: request.body?.vector,
      collection,
    });

    return createSuccessResponse({
      data: result.data,
      metadata: result.metadata,
    });
  } catch (error: any) {
    console.error('[SmallstoreHandler] Error executing retrieval pipeline:', error);
    return createErrorResponse(500, 'InternalServerError', error.message || 'Failed to execute retrieval pipeline');
  }
}

// ============================================================================
// Handler Registry
// ============================================================================

/**
 * All handlers exported as a registry for use by framework adapters
 */
export const handlers = {
  handleListCollections,
  handleGet,
  handleSet,
  handleDelete,
  handleGetMetadata,
  handleSetMetadata,
  handleGetSchema,
  handleListKeys,
  handleSearch,
  handleQuery,
  handleSlice,
  handleSplit,
  handleDeduplicate,
  handleMerge,
  handleListNamespaces,
  handleDeleteNamespace,
  handleStat,
  handleTree,
  handleListViews,
  handleCreateView,
  handleGetView,
  handleGetViewMetadata,
  handleUpdateView,
  handleDeleteView,
  handleRefreshView,
  handleRefreshAllViews,
  handleSignedUploadUrl,
  handleSignedDownloadUrl,
  handleRetrievalPipeline,
};

export type HandlerName = keyof typeof handlers;
