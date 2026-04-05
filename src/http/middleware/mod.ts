/**
 * Smallstore HTTP Middleware — Unified Configuration & Factory
 *
 * Single entry point for configuring all middleware layers:
 *   1. Rate limiting (reject abuse before any work)
 *   2. Distributed cache (L1 memory + L2 persistent adapter)
 *   3. Response cache (in-memory SWR)
 *   4. Cache headers (Cache-Control, ETag, 304)
 *
 * Also exposes cache stats and clear endpoints.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createSmallstoreMiddleware } from '@smallstore/http/middleware/mod.ts';
 * import { createMemoryAdapter } from '@smallstore/adapters/memory.ts';
 *
 * const app = new Hono();
 * const mw = createSmallstoreMiddleware({
 *   rateLimit: { maxRequests: 200 },
 *   responseCache: { defaultTTL: 120 },
 *   cacheHeaders: { defaultMaxAge: 60 },
 *   distributedCache: { adapter: createMemoryAdapter() },
 * });
 *
 * // Apply all middleware
 * mw.apply(app, '/api');
 *
 * // Or mount stats/clear endpoints
 * mw.mountAdmin(app, '/api/_cache');
 * ```
 */

import type { Context, Hono } from 'hono';

// Re-export individual middleware
export { cacheHeaders } from './cache-headers.ts';
export type { CacheHeadersConfig } from './cache-headers.ts';

export { responseCache, responseCacheMiddleware, ResponseCacheStore } from './response-cache.ts';
export type { ResponseCacheConfig } from './response-cache.ts';

export { rateLimiter, rateLimiterMiddleware, RateLimiterStore } from './rate-limiter.ts';
export type { RateLimitConfig } from './rate-limiter.ts';

export { distributedCache, distributedCacheMiddleware, DistributedCacheStore } from './distributed-cache.ts';
export type { DistributedCacheConfig, DistributedCacheAdapter } from './distributed-cache.ts';

// Import for internal use
import { cacheHeaders, type CacheHeadersConfig } from './cache-headers.ts';
import { responseCache, type ResponseCacheConfig, type ResponseCacheStore } from './response-cache.ts';
import { rateLimiter, type RateLimitConfig, type RateLimiterStore } from './rate-limiter.ts';
import { distributedCache, type DistributedCacheConfig, type DistributedCacheStore } from './distributed-cache.ts';

// ============================================================================
// Unified Configuration
// ============================================================================

export interface SmallstoreMiddlewareConfig {
  /** Rate limiting config. Set to false to disable. */
  rateLimit?: RateLimitConfig | false;

  /** Distributed KV cache config. Requires an adapter. Set to false to disable. */
  distributedCache?: DistributedCacheConfig | false;

  /** In-memory response cache with SWR. Set to false to disable. */
  responseCache?: ResponseCacheConfig | false;

  /** Cache-Control + ETag headers. Set to false to disable. */
  cacheHeaders?: CacheHeadersConfig | false;

  /** Bearer token required for admin endpoints (/_cache/stats, /_cache/clear). If not set, admin endpoints are only accessible from localhost. */
  adminToken?: string;
}

// ============================================================================
// Environment variable support
// ============================================================================

/**
 * Read middleware config overrides from environment variables.
 *
 * Supported env vars:
 *   SM_RATE_LIMIT_MAX_REQUESTS — max read requests per window
 *   SM_RATE_LIMIT_MAX_WRITE — max write requests per window
 *   SM_RATE_LIMIT_WINDOW_MS — sliding window size in ms
 *   SM_CACHE_TTL — default response cache TTL in seconds
 *   SM_CACHE_SWR_TTL — stale-while-revalidate TTL in seconds
 *   SM_CACHE_MAX_ENTRIES — max response cache entries
 *   SM_CACHE_HEADERS_MAX_AGE — Cache-Control max-age
 *   SM_DISTRIBUTED_CACHE_L1_TTL — L1 memory TTL in seconds
 *   SM_DISTRIBUTED_CACHE_L2_TTL — L2 persistent TTL in seconds
 *   SM_MIDDLEWARE_DISABLED — comma-separated list of middleware to disable
 *     e.g. "rateLimit,responseCache"
 */
export function configFromEnv(): Partial<SmallstoreMiddlewareConfig> {
  const env = typeof Deno !== 'undefined' ? Deno.env : undefined;
  if (!env) return {};

  const getNum = (key: string): number | undefined => {
    const v = env.get(key);
    return v ? Number(v) : undefined;
  };

  const disabled = new Set(
    (env.get('SM_MIDDLEWARE_DISABLED') || '').split(',').map(s => s.trim()).filter(Boolean)
  );

  const config: Partial<SmallstoreMiddlewareConfig> = {};

  // Rate limit
  if (disabled.has('rateLimit')) {
    config.rateLimit = false;
  } else {
    const maxRequests = getNum('SM_RATE_LIMIT_MAX_REQUESTS');
    const maxWrite = getNum('SM_RATE_LIMIT_MAX_WRITE');
    const windowMs = getNum('SM_RATE_LIMIT_WINDOW_MS');
    if (maxRequests || maxWrite || windowMs) {
      config.rateLimit = {
        ...(maxRequests && { maxRequests }),
        ...(maxWrite && { maxWrite }),
        ...(windowMs && { windowMs }),
      };
    }
  }

  // Response cache
  if (disabled.has('responseCache')) {
    config.responseCache = false;
  } else {
    const defaultTTL = getNum('SM_CACHE_TTL');
    const swrTTL = getNum('SM_CACHE_SWR_TTL');
    const maxEntries = getNum('SM_CACHE_MAX_ENTRIES');
    if (defaultTTL || swrTTL || maxEntries) {
      config.responseCache = {
        ...(defaultTTL && { defaultTTL }),
        ...(swrTTL && { swrTTL }),
        ...(maxEntries && { maxEntries }),
      };
    }
  }

  // Cache headers
  if (disabled.has('cacheHeaders')) {
    config.cacheHeaders = false;
  } else {
    const defaultMaxAge = getNum('SM_CACHE_HEADERS_MAX_AGE');
    if (defaultMaxAge) {
      config.cacheHeaders = { defaultMaxAge };
    }
  }

  // Distributed cache (needs adapter — env can only set TTLs)
  if (disabled.has('distributedCache')) {
    config.distributedCache = false;
  } else {
    const l1TTL = getNum('SM_DISTRIBUTED_CACHE_L1_TTL');
    const l2TTL = getNum('SM_DISTRIBUTED_CACHE_L2_TTL');
    if (l1TTL || l2TTL) {
      // Adapter must be provided programmatically; env only tweaks TTLs
      // This gets merged into the programmatic config
      // Adapter must be provided programmatically; env only tweaks TTLs.
      // We use `undefined!` as a sentinel — the factory function checks for
      // a truthy adapter before enabling the distributed cache layer.
      config.distributedCache = {
        adapter: undefined as unknown as DistributedCacheConfig['adapter'],
        ...(l1TTL && { l1TTL }),
        ...(l2TTL && { l2TTL }),
      };
    }
  }

  return config;
}

// ============================================================================
// Factory
// ============================================================================

export interface SmallstoreMiddlewareResult {
  /** Apply all enabled middleware to a Hono app at the given prefix */
  apply(app: Hono<any>, prefix?: string): void;

  /** Mount cache admin endpoints (stats + clear) */
  mountAdmin(app: Hono<any>, prefix?: string): void;

  /** Individual stores for programmatic access */
  stores: {
    rateLimit?: RateLimiterStore;
    responseCache?: ResponseCacheStore;
    distributedCache?: DistributedCacheStore;
  };

  /** Destroy all cleanup timers */
  destroy(): void;
}

/**
 * Create a unified middleware stack from a single config object.
 *
 * Applies layers in the correct order:
 *   1. Rate limit (block abuse first)
 *   2. Distributed cache (check persistent cache)
 *   3. Response cache (check in-memory cache)
 *   4. Cache headers (set Cache-Control/ETag on responses)
 *
 * Config is merged with environment variable overrides (env takes precedence
 * for numeric values; `SM_MIDDLEWARE_DISABLED` can disable entire layers).
 */
export function createSmallstoreMiddleware(
  userConfig: SmallstoreMiddlewareConfig = {}
): SmallstoreMiddlewareResult {
  // Merge env overrides
  const envConfig = configFromEnv();
  const config: SmallstoreMiddlewareConfig = mergeConfig(userConfig, envConfig);

  const stores: SmallstoreMiddlewareResult['stores'] = {};

  // Build middleware stack
  type MiddlewareFn = (c: Context, next: () => Promise<void>) => Promise<void | Response>;
  const middlewares: MiddlewareFn[] = [];

  // 1. Rate limiter
  if (config.rateLimit !== false && config.rateLimit !== undefined) {
    const rl = rateLimiter(typeof config.rateLimit === 'object' ? config.rateLimit : {});
    stores.rateLimit = rl.store;
    middlewares.push(rl.middleware);
  }

  // 2. Distributed cache
  if (config.distributedCache !== false && config.distributedCache !== undefined) {
    const dcConfig = typeof config.distributedCache === 'object' ? config.distributedCache : undefined;
    if (dcConfig?.adapter) {
      const dc = distributedCache(dcConfig);
      stores.distributedCache = dc.store;
      middlewares.push(dc.middleware);
    }
  }

  // 3. Response cache
  if (config.responseCache !== false && config.responseCache !== undefined) {
    const rc = responseCache(typeof config.responseCache === 'object' ? config.responseCache : {});
    stores.responseCache = rc.store;
    middlewares.push(rc.middleware);
  }

  // 4. Cache headers
  if (config.cacheHeaders !== false) {
    const ch = cacheHeaders(typeof config.cacheHeaders === 'object' ? config.cacheHeaders : {});
    middlewares.push(ch);
  }

  const apply = (app: Hono<any>, prefix = '') => {
    for (const mw of middlewares) {
      app.use(`${prefix}/*`, mw);
      if (prefix) {
        app.use(prefix, mw);
      }
    }
  };

  const mountAdmin = (app: Hono<any>, prefix = '/_cache') => {
    // Auth guard for admin endpoints
    const adminAuth = async (c: Context, next: () => Promise<void>) => {
      const isLocal = c.req.header('host')?.startsWith('localhost') || c.req.header('host')?.startsWith('127.0.0.1');
      const adminToken = config.adminToken;
      if (adminToken) {
        const auth = c.req.header('authorization');
        if (auth !== `Bearer ${adminToken}`) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      } else if (!isLocal) {
        return c.json({ error: 'Admin endpoints only available on localhost' }, 403);
      }
      await next();
    };

    // GET stats
    app.get(`${prefix}/stats`, adminAuth, (c: Context) => {
      return c.json({
        rateLimit: stores.rateLimit?.getStats() ?? null,
        responseCache: stores.responseCache?.getStats() ?? null,
        distributedCache: stores.distributedCache?.getStats() ?? null,
      });
    });

    // POST clear
    app.post(`${prefix}/clear`, adminAuth, async (c: Context) => {
      const cleared: Record<string, number> = {};

      if (stores.responseCache) {
        cleared.responseCache = stores.responseCache.clear();
      }
      if (stores.distributedCache) {
        cleared.distributedCache = await stores.distributedCache.clear();
      }

      return c.json({ cleared });
    });
  };

  const destroy = () => {
    stores.rateLimit?.destroy();
    stores.responseCache?.destroy();
    stores.distributedCache?.destroy();
  };

  return { apply, mountAdmin, stores, destroy };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Shallow merge: base values are overridden by override values.
 * `false` in override disables the layer.
 */
function mergeConfig(
  base: SmallstoreMiddlewareConfig,
  override: Partial<SmallstoreMiddlewareConfig>
): SmallstoreMiddlewareConfig {
  const result = { ...base };

  for (const key of Object.keys(override) as (keyof SmallstoreMiddlewareConfig)[]) {
    const ov = override[key];
    if (ov === false) {
      // Explicit disable
      (result as any)[key] = false;
    } else if (ov && typeof ov === 'object') {
      const bv = base[key];
      if (bv && typeof bv === 'object' && (bv as unknown) !== false) {
        (result as any)[key] = { ...bv, ...ov };
      } else {
        (result as any)[key] = ov;
      }
    }
    // undefined in override → keep base
  }

  return result;
}
