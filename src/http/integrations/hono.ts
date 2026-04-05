/**
 * Smallstore Hono Integration
 *
 * Adapter for using Smallstore HTTP handlers with Hono framework.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createSmallstore } from '@smallstore/mod.ts';
 * import { createHonoRoutes } from '@smallstore/http/integrations/hono.ts';
 *
 * const app = new Hono();
 * const smallstore = createSmallstore({ ... });
 *
 * // Mount Smallstore routes at /api/smallstore
 * createHonoRoutes(app, smallstore, '/api/smallstore');
 *
 * // Or create a separate router
 * const smallstoreRouter = createHonoRouter(smallstore);
 * app.route('/api/smallstore', smallstoreRouter);
 * ```
 */

import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { SmallstoreRequest, SmallstoreResponse, SmallstoreInstance } from '../types.ts';
import * as handlers from '../handlers.ts';
import { cacheHeaders, type CacheHeadersConfig } from '../middleware/cache-headers.ts';
import { responseCache, type ResponseCacheConfig, type ResponseCacheStore } from '../middleware/response-cache.ts';
import { rateLimiter, type RateLimitConfig, type RateLimiterStore } from '../middleware/rate-limiter.ts';
import { distributedCache, type DistributedCacheConfig, type DistributedCacheStore } from '../middleware/distributed-cache.ts';


// ============================================================================
// Request Conversion
// ============================================================================

/**
 * Convert Hono Context to SmallstoreRequest
 */
function honoToRequest(c: Context): SmallstoreRequest {
  // Get all params (Hono uses param('name') for named params)
  const params: Record<string, string> = {};

  // Extract collection param
  const collection = c.req.param('collection');
  if (collection) {
    params.collection = collection;
  }

  // Extract path param (wildcard)
  // Hono uses different syntax for wildcards, try both patterns
  const path = c.req.param('path') || c.req.param('*');
  if (path) {
    params.path = path;
  }

  // Get query parameters
  const query: Record<string, string> = {};
  const url = new URL(c.req.url);
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Get headers (lowercase)
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    method: c.req.method,
    path: url.pathname,
    params,
    query,
    body: null, // Body is parsed asynchronously, handled separately
    headers,
  };
}

/**
 * Convert SmallstoreResponse to Hono Response
 */
function responseToHono(c: Context, response: SmallstoreResponse): Response {
  // Set custom headers if provided
  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      c.header(key, value);
    }
  }

  return c.json(response.body, response.status as any);
}

// ============================================================================
// Route Registration
// ============================================================================

export interface HonoRoutesOptions {
  /** Route prefix (default: '') */
  prefix?: string;

  /** Cache-Control + ETag middleware config. Set to false to disable. */
  cacheHeaders?: CacheHeadersConfig | false;

  /** In-memory response cache with SWR. Set to false to disable. */
  responseCache?: ResponseCacheConfig | false;

  /** Per-IP rate limiting. Set to false to disable. */
  rateLimit?: RateLimitConfig | false;

  /** Distributed KV cache (L1 memory + L2 persistent adapter). Set to false to disable. */
  distributedCache?: DistributedCacheConfig | false;
}

/**
 * Create Hono routes for Smallstore
 *
 * Registers all Smallstore routes on the provided Hono app or router.
 *
 * @param app - Hono app or router instance
 * @param smallstore - Smallstore instance
 * @param prefixOrOptions - Route prefix string OR options object
 *
 * @example
 * ```typescript
 * const app = new Hono();
 * const smallstore = createSmallstore({ ... });
 *
 * // Simple usage with prefix
 * createHonoRoutes(app, smallstore, '/api/smallstore');
 *
 * // With options object
 * createHonoRoutes(app, smallstore, { prefix: '/api/smallstore' });
 * ```
 */
export function createHonoRoutes(
  app: Hono<any>,
  smallstore: SmallstoreInstance,
  prefixOrOptions: string | HonoRoutesOptions = ''
): void {
  // Parse options
  const options: HonoRoutesOptions = typeof prefixOrOptions === 'string'
    ? { prefix: prefixOrOptions }
    : { prefix: '', ...prefixOrOptions };

  const prefix = options.prefix || '';

  // Apply rate limiter first (reject abusive traffic before any work)
  let rateLimiterStore: RateLimiterStore | undefined;
  if (options.rateLimit !== false && options.rateLimit !== undefined) {
    const { middleware, store } = rateLimiter(
      typeof options.rateLimit === 'object' ? options.rateLimit : {}
    );
    rateLimiterStore = store;
    app.use(`${prefix}/*`, middleware);
    if (prefix) {
      app.use(prefix, middleware);
    }
  }

  // Apply distributed cache middleware (L1 + L2 persistent)
  let distributedCacheStore: DistributedCacheStore | undefined;
  if (options.distributedCache !== false && options.distributedCache !== undefined) {
    const dcConfig = typeof options.distributedCache === 'object' ? options.distributedCache : undefined;
    if (dcConfig?.adapter) {
      const { middleware, store } = distributedCache(dcConfig);
      distributedCacheStore = store;
      app.use(`${prefix}/*`, middleware);
      if (prefix) {
        app.use(prefix, middleware);
      }
    }
  }

  // Apply response cache middleware (must be before cache-headers so cached responses get headers too)
  let responseCacheStore: ResponseCacheStore | undefined;
  if (options.responseCache !== false && options.responseCache !== undefined) {
    const { middleware, store } = responseCache(
      typeof options.responseCache === 'object' ? options.responseCache : {}
    );
    responseCacheStore = store;
    app.use(`${prefix}/*`, middleware);
    if (prefix) {
      app.use(prefix, middleware);
    }
  }

  // Apply cache-headers middleware if not disabled
  if (options.cacheHeaders !== false) {
    const cacheHeadersConfig = typeof options.cacheHeaders === 'object' ? options.cacheHeaders : {};
    app.use(`${prefix}/*`, cacheHeaders(cacheHeadersConfig));
    if (prefix) {
      app.use(prefix, cacheHeaders(cacheHeadersConfig));
    }
  }

  // Helper to wrap handlers
  const wrap = (handler: (req: SmallstoreRequest, ss: SmallstoreInstance) => Promise<SmallstoreResponse>) => {
    return async (c: Context) => {
      const request = honoToRequest(c);

      // Parse body for non-GET requests
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
        try {
          request.body = await c.req.json();
        } catch {
          // Body parsing failed, leave as null
        }
      }

      const response = await handler(request, smallstore);
      return responseToHono(c, response);
    };
  };

  // ============================================================================
  // Collection listing
  // ============================================================================
  app.get(`${prefix}/collections`, wrap(handlers.handleListCollections));

  // ============================================================================
  // Namespace operations (must be before collection wildcard routes)
  // ============================================================================
  app.get(`${prefix}/namespaces`, wrap(handlers.handleListNamespaces));
  app.get(`${prefix}/namespaces/:path{.+}/children`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.path = c.req.param('path') || '';
    const response = await handlers.handleListNamespaces(request, smallstore);
    return responseToHono(c, response);
  });
  app.get(`${prefix}/namespaces/:path{.+}/stat`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.path = c.req.param('path') || '';
    const response = await handlers.handleStat(request, smallstore);
    return responseToHono(c, response);
  });
  app.delete(`${prefix}/namespaces/:path{.+}`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.path = c.req.param('path') || '';
    // Get query params
    const url = new URL(c.req.url);
    request.query = Object.fromEntries(url.searchParams);
    const response = await handlers.handleDeleteNamespace(request, smallstore);
    return responseToHono(c, response);
  });

  // Tree endpoint
  app.get(`${prefix}/tree`, wrap(handlers.handleTree));
  app.get(`${prefix}/tree/:path{.+}`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.path = c.req.param('path') || '';
    const response = await handlers.handleTree(request, smallstore);
    return responseToHono(c, response);
  });

  // ============================================================================
  // Materialized views (must be before wildcard collection routes)
  // ============================================================================
  app.get(`${prefix}/views`, wrap(handlers.handleListViews));
  app.post(`${prefix}/views`, wrap(handlers.handleCreateView));
  app.post(`${prefix}/views/refresh`, wrap(handlers.handleRefreshAllViews));
  app.get(`${prefix}/views/:name`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.name = c.req.param('name') || '';
    const response = await handlers.handleGetView(request, smallstore);
    return responseToHono(c, response);
  });
  app.get(`${prefix}/views/:name/metadata`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.name = c.req.param('name') || '';
    const response = await handlers.handleGetViewMetadata(request, smallstore);
    return responseToHono(c, response);
  });
  app.put(`${prefix}/views/:name`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.name = c.req.param('name') || '';
    try { request.body = await c.req.json(); } catch { /* no body */ }
    const response = await handlers.handleUpdateView(request, smallstore);
    return responseToHono(c, response);
  });
  app.delete(`${prefix}/views/:name`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.name = c.req.param('name') || '';
    const url = new URL(c.req.url);
    request.query = Object.fromEntries(url.searchParams);
    const response = await handlers.handleDeleteView(request, smallstore);
    return responseToHono(c, response);
  });
  app.post(`${prefix}/views/:name/refresh`, async (c: Context) => {
    const request = honoToRequest(c);
    request.params.name = c.req.param('name') || '';
    try { request.body = await c.req.json(); } catch { /* no body */ }
    const response = await handlers.handleRefreshView(request, smallstore);
    return responseToHono(c, response);
  });

  // ============================================================================
  // Special routes (must be before wildcard routes)
  // ============================================================================

  // Metadata routes
  app.get(`${prefix}/:collection/metadata`, wrap(handlers.handleGetMetadata));
  app.put(`${prefix}/:collection/metadata`, wrap(handlers.handleSetMetadata));

  // Schema route
  app.get(`${prefix}/:collection/schema`, wrap(handlers.handleGetSchema));

  // Keys route
  app.get(`${prefix}/:collection/keys`, wrap(handlers.handleListKeys));

  // Search route
  app.get(`${prefix}/:collection/search`, wrap(handlers.handleSearch));

  // Query route
  app.post(`${prefix}/:collection/query`, wrap(handlers.handleQuery));

  // ============================================================================
  // Signed URL routes (must be before wildcard collection routes)
  // ============================================================================
  app.post(`${prefix}/:collection/signed-upload`, wrap(handlers.handleSignedUploadUrl));
  app.post(`${prefix}/:collection/signed-download`, wrap(handlers.handleSignedDownloadUrl));

  // Retrieval pipeline
  app.post(`${prefix}/:collection/pipeline`, wrap(handlers.handleRetrievalPipeline));

  // ============================================================================
  // Batch operations (must be before wildcard collection routes)
  // ============================================================================
  app.post(`${prefix}/merge`, wrap(handlers.handleMerge));
  app.post(`${prefix}/:collection/slice`, wrap(handlers.handleSlice));
  app.post(`${prefix}/:collection/split`, wrap(handlers.handleSplit));
  app.post(`${prefix}/:collection/deduplicate`, wrap(handlers.handleDeduplicate));

  // ============================================================================
  // Collection CRUD (with wildcard path support)
  // ============================================================================

  // GET collection or path
  app.get(`${prefix}/:collection`, wrap(handlers.handleGet));
  app.get(`${prefix}/:collection/*`, async (c: Context) => {
    const request = honoToRequest(c);
    // Extract the wildcard part as the path
    const collection = c.req.param('collection');
    const fullPath = c.req.path.replace(`${prefix}/${collection}/`, '');
    request.params.path = fullPath;

    const response = await handlers.handleGet(request, smallstore);
    return responseToHono(c, response);
  });

  // Helper for wildcard write routes
  const wrapWrite = (c: Context) => {
    return async () => {
      const request = honoToRequest(c);
      const collection = c.req.param('collection');
      const fullPath = c.req.path.replace(`${prefix}/${collection}/`, '');
      request.params.path = fullPath;

      // Parse body for write requests
      try {
        request.body = await c.req.json();
      } catch {
        // Body parsing failed, leave as null
      }

      const response = await handlers.handleSet(request, smallstore);
      return responseToHono(c, response);
    };
  };

  // POST (append) to collection or path
  app.post(`${prefix}/:collection`, wrap(handlers.handleSet));
  app.post(`${prefix}/:collection/*`, async (c: Context) => {
    return (await wrapWrite(c))();
  });

  // PUT (overwrite) collection or path
  app.put(`${prefix}/:collection`, wrap(handlers.handleSet));
  app.put(`${prefix}/:collection/*`, async (c: Context) => {
    return (await wrapWrite(c))();
  });

  // PATCH (merge) collection or path
  app.patch(`${prefix}/:collection`, wrap(handlers.handleSet));
  app.patch(`${prefix}/:collection/*`, async (c: Context) => {
    return (await wrapWrite(c))();
  });

  // DELETE collection or path
  app.delete(`${prefix}/:collection`, wrap(handlers.handleDelete));
  app.delete(`${prefix}/:collection/*`, async (c: Context) => {
    const request = honoToRequest(c);
    // Extract the wildcard part as the path
    const collection = c.req.param('collection');
    const fullPath = c.req.path.replace(`${prefix}/${collection}/`, '');
    request.params.path = fullPath;

    const response = await handlers.handleDelete(request, smallstore);
    return responseToHono(c, response);
  });
}

/**
 * Create a standalone Hono router for Smallstore
 *
 * Returns a Hono instance that can be mounted as a sub-router.
 *
 * @param smallstore - Smallstore instance
 * @param HonoClass - The Hono class (pass in to avoid hard dependency)
 * @returns Hono router with all Smallstore routes
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createSmallstore } from '@smallstore/mod.ts';
 * import { createHonoRouter } from '@smallstore/http/integrations/hono.ts';
 *
 * const smallstore = createSmallstore({ ... });
 * const smallstoreRouter = createHonoRouter(smallstore, Hono);
 *
 * const app = new Hono();
 * app.route('/api/smallstore', smallstoreRouter);
 * ```
 */
export function createHonoRouter(
  smallstore: SmallstoreInstance,
  HonoClass?: new () => Hono
): Hono {
  // If HonoClass is not provided, the caller must pass it
  if (!HonoClass) {
    throw new Error(
      'createHonoRouter requires the Hono class as second argument. ' +
      'Example: createHonoRouter(smallstore, Hono)'
    );
  }
  const router = new HonoClass();
  createHonoRoutes(router, smallstore);
  return router;
}

/**
 * Hono middleware factory for Smallstore
 *
 * Creates middleware that adds smallstore to context.
 *
 * @example
 * ```typescript
 * const app = new Hono();
 * const smallstore = createSmallstore({ ... });
 *
 * app.use('/api/smallstore/*', smallstoreMiddleware(smallstore));
 * ```
 */
export function smallstoreMiddleware(smallstore: SmallstoreInstance): MiddlewareHandler {
  return async (c: Context, next: () => Promise<void>) => {
    // Add smallstore to context for use in handlers
    c.set('smallstore', smallstore);
    await next();
  };
}
