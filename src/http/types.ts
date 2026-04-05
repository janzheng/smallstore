/**
 * Smallstore HTTP Types
 *
 * Framework-agnostic request/response types for Smallstore HTTP handlers.
 * These types allow the handlers to work with any HTTP framework (Hono, Express, etc.)
 */

// ============================================================================
// Request Types
// ============================================================================

/**
 * Framework-agnostic HTTP request
 *
 * Adapters (Hono, Express) convert their native request to this format.
 */
export interface SmallstoreRequest {
  /** HTTP method (GET, POST, PUT, PATCH, DELETE) */
  method: string;

  /** Request path (e.g., "/api/smallstore/users/profile") */
  path: string;

  /** URL path parameters (e.g., { collection: "users", path: "profile" }) */
  params: Record<string, string>;

  /** Query string parameters (e.g., { limit: "10", format: "json" }) */
  query: Record<string, string>;

  /** Request body (parsed JSON) */
  body: any;

  /** Request headers (lowercase keys) */
  headers: Record<string, string>;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Framework-agnostic HTTP response
 *
 * Handlers return this, and adapters convert to their native response format.
 */
export interface SmallstoreResponse {
  /** HTTP status code */
  status: number;

  /** Response body (will be JSON serialized) */
  body: any;

  /** Optional response headers */
  headers?: Record<string, string>;
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Smallstore HTTP handler function signature
 */
export type SmallstoreHandler = (
  request: SmallstoreRequest,
  smallstore: SmallstoreInstance
) => Promise<SmallstoreResponse>;

/**
 * Minimal Smallstore interface required by HTTP handlers
 *
 * This is a subset of the full Smallstore interface, containing only
 * the methods used by HTTP handlers.
 */
export interface SmallstoreInstance {
  get(collectionPath: string, options?: any): Promise<any>;
  set(collectionPath: string, data: any, options?: any): Promise<void>;
  delete(collectionPath: string): Promise<void>;
  has(collectionPath: string): Promise<boolean>;
  keys(collectionPath: string, prefix?: string): Promise<string[]>;
  listCollections(pattern?: string): Promise<string[]>;
  getSchema(collection: string): Promise<any>;
  getCollectionMetadata(collection: string): Promise<Record<string, any>>;
  setCollectionMetadata(collection: string, metadata: Record<string, any>): Promise<void>;
  search(collectionPath: string, options: any): Promise<any[]>;
  query?(collectionPath: string, options?: any): Promise<any>;

  // Namespace operations
  listNamespaces?(parentPath?: string): Promise<string[]>;
  deleteNamespace?(path: string, options?: { recursive?: boolean }): Promise<{ deleted: number }>;
  stat?(path: string): Promise<any>;
  tree?(path: string, options?: any): Promise<any>;

  // Materialized views
  createMaterializedView?(name: string, definition: any): Promise<void>;
  listMaterializedViews?(filter?: any): Promise<any[]>;
  getViewMetadata?(name: string): Promise<any>;
  refreshView?(name: string, options?: any): Promise<any>;
  updateMaterializedView?(name: string, updates: any): Promise<void>;
  deleteMaterializedView?(name: string, deleteData?: boolean): Promise<void>;
  refreshAllViews?(filter?: any): Promise<any[]>;

  // Batch operations (slice, split, deduplicate, merge)
  slice?(collectionPath: string, options: any): Promise<any[] | void>;
  split?(collectionPath: string, options: any): Promise<void>;
  deduplicate?(collectionPath: string, options: any): Promise<void>;
  merge?(sources: string[], dest: string, options?: any): Promise<void>;

  // Signed URLs (for adapters that support S3-compatible presigned URLs)
  getSignedUploadUrl(collectionPath: string, options?: any): Promise<string>;
  getSignedDownloadUrl(collectionPath: string, options?: any): Promise<string>;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Standard error response body
 */
export interface SmallstoreErrorBody {
  /** Error type/code */
  error: string;

  /** Human-readable error message */
  message: string;

  /** Additional context (collection, path, etc.) */
  [key: string]: any;
}

/**
 * Create a standard error response
 */
export function createErrorResponse(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, any>
): SmallstoreResponse {
  return {
    status,
    body: {
      error,
      message,
      ...extra,
    },
  };
}

/**
 * Create a standard success response
 */
export function createSuccessResponse(
  body: any,
  status = 200,
  headers?: Record<string, string>
): SmallstoreResponse {
  return {
    status,
    body,
    headers,
  };
}

// ============================================================================
// Route Configuration
// ============================================================================

/**
 * Route definition for Smallstore HTTP API
 */
export interface SmallstoreRoute {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** Route pattern (e.g., "/collections", "/:collection", "/:collection/:path*") */
  pattern: string;

  /** Handler function name */
  handler: string;

  /** Route description */
  description?: string;
}

/**
 * All Smallstore HTTP routes
 */
export const SMALLSTORE_ROUTES: SmallstoreRoute[] = [
  // Collection listing
  { method: 'GET', pattern: '/collections', handler: 'handleListCollections', description: 'List all collections' },

  // Collection operations
  { method: 'GET', pattern: '/:collection', handler: 'handleGet', description: 'Get collection data' },
  { method: 'GET', pattern: '/:collection/:path*', handler: 'handleGet', description: 'Get data at path' },
  { method: 'POST', pattern: '/:collection', handler: 'handleSet', description: 'Append to collection' },
  { method: 'PUT', pattern: '/:collection', handler: 'handleSet', description: 'Overwrite collection' },
  { method: 'PATCH', pattern: '/:collection', handler: 'handleSet', description: 'Merge into collection' },
  { method: 'DELETE', pattern: '/:collection', handler: 'handleDelete', description: 'Delete collection' },
  { method: 'DELETE', pattern: '/:collection/:path*', handler: 'handleDelete', description: 'Delete path' },

  // Metadata operations
  { method: 'GET', pattern: '/:collection/metadata', handler: 'handleGetMetadata', description: 'Get collection metadata' },
  { method: 'PUT', pattern: '/:collection/metadata', handler: 'handleSetMetadata', description: 'Set collection metadata' },

  // Schema operations
  { method: 'GET', pattern: '/:collection/schema', handler: 'handleGetSchema', description: 'Get collection schema' },

  // Keys operations
  { method: 'GET', pattern: '/:collection/keys', handler: 'handleListKeys', description: 'List collection keys' },

  // Search operations
  { method: 'GET', pattern: '/:collection/search', handler: 'handleSearch', description: 'Search collection' },

  // Query operations (Phase 3.6f)
  { method: 'POST', pattern: '/:collection/query', handler: 'handleQuery', description: 'Query collection' },

  // Batch operations (slice, split, deduplicate, merge)
  { method: 'POST', pattern: '/:collection/slice', handler: 'handleSlice', description: 'Slice collection subset' },
  { method: 'POST', pattern: '/:collection/split', handler: 'handleSplit', description: 'Split collection by field' },
  { method: 'POST', pattern: '/:collection/deduplicate', handler: 'handleDeduplicate', description: 'Deduplicate collection' },
  { method: 'POST', pattern: '/merge', handler: 'handleMerge', description: 'Merge collections' },

  // Materialized views
  { method: 'GET', pattern: '/views', handler: 'handleListViews', description: 'List materialized views' },
  { method: 'POST', pattern: '/views', handler: 'handleCreateView', description: 'Create materialized view' },
  { method: 'POST', pattern: '/views/refresh', handler: 'handleRefreshAllViews', description: 'Refresh all views' },
  { method: 'GET', pattern: '/views/:name', handler: 'handleGetView', description: 'Get view data' },
  { method: 'GET', pattern: '/views/:name/metadata', handler: 'handleGetViewMetadata', description: 'Get view metadata' },
  { method: 'PUT', pattern: '/views/:name', handler: 'handleUpdateView', description: 'Update view definition' },
  { method: 'DELETE', pattern: '/views/:name', handler: 'handleDeleteView', description: 'Delete materialized view' },
  { method: 'POST', pattern: '/views/:name/refresh', handler: 'handleRefreshView', description: 'Refresh a view' },
];
