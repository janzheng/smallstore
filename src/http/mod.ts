/**
 * Smallstore HTTP Module
 *
 * Framework-agnostic HTTP handlers for Smallstore REST API.
 *
 * @example
 * ```typescript
 * // Using with Hono
 * import { Hono } from 'hono';
 * import { createSmallstore } from '@smallstore/mod.ts';
 * import { createHonoRoutes } from '@smallstore/http/mod.ts';
 *
 * const app = new Hono();
 * const smallstore = createSmallstore({
 *   adapters: { memory: createMemoryAdapter() },
 *   defaultAdapter: 'memory',
 * });
 *
 * createHonoRoutes(app, smallstore, '/api/smallstore');
 *
 * // Using handlers directly
 * import { handleGet, handleSet } from '@smallstore/http/mod.ts';
 *
 * const response = await handleGet(request, smallstore);
 * ```
 *
 * ## API Endpoints
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /collections | List all collections |
 * | GET | /:collection | Get collection data |
 * | GET | /:collection/:path* | Get data at path |
 * | POST | /:collection | Append to collection |
 * | PUT | /:collection | Overwrite collection |
 * | PATCH | /:collection | Merge into collection |
 * | DELETE | /:collection | Delete collection |
 * | DELETE | /:collection/:path* | Delete path |
 * | GET | /:collection/metadata | Get collection metadata |
 * | PUT | /:collection/metadata | Set collection metadata |
 * | GET | /:collection/schema | Get collection schema |
 * | GET | /:collection/keys | List collection keys |
 * | GET | /:collection/search | Search collection |
 * | POST | /:collection/query | Query collection |
 * | POST | /:collection/slice | Slice collection subset |
 * | POST | /:collection/split | Split collection by field |
 * | POST | /:collection/deduplicate | Deduplicate collection |
 * | POST | /merge | Merge collections |
 */

// ============================================================================
// Types
// ============================================================================

export type {
  SmallstoreRequest,
  SmallstoreResponse,
  SmallstoreHandler,
  SmallstoreInstance,
  SmallstoreErrorBody,
  SmallstoreRoute,
} from './types.ts';

export {
  createErrorResponse,
  createSuccessResponse,
  SMALLSTORE_ROUTES,
} from './types.ts';

// ============================================================================
// Handlers
// ============================================================================

export {
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
  handlers,
} from './handlers.ts';

export type { HandlerName } from './handlers.ts';

// ============================================================================
// Framework Integrations
// ============================================================================

// Hono integration
export {
  createHonoRoutes,
  createHonoRouter,
  smallstoreMiddleware as honoMiddleware,
} from './integrations/hono.ts';

export type { HonoRoutesOptions } from './integrations/hono.ts';

// Express integration (stub) - not exported; see ./integrations/express.ts

// ============================================================================
// Middleware
// ============================================================================

export { cacheHeaders } from './middleware/cache-headers.ts';
export type { CacheHeadersConfig } from './middleware/cache-headers.ts';

export { responseCache, responseCacheMiddleware, ResponseCacheStore } from './middleware/response-cache.ts';
export type { ResponseCacheConfig } from './middleware/response-cache.ts';

export { rateLimiter, rateLimiterMiddleware, RateLimiterStore } from './middleware/rate-limiter.ts';
export type { RateLimitConfig } from './middleware/rate-limiter.ts';

export { distributedCache, distributedCacheMiddleware, DistributedCacheStore } from './middleware/distributed-cache.ts';
export type { DistributedCacheConfig, DistributedCacheAdapter } from './middleware/distributed-cache.ts';

// Unified middleware factory
export { createSmallstoreMiddleware, configFromEnv } from './middleware/mod.ts';
export type { SmallstoreMiddlewareConfig, SmallstoreMiddlewareResult } from './middleware/mod.ts';

// Constant-time bearer-token compare (used by every Authorization check)
export { timingSafeEqualString } from './timing-safe.ts';
