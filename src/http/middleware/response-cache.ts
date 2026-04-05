/**
 * Response Cache Middleware for Smallstore HTTP
 *
 * In-memory response cache with stale-while-revalidate (SWR) support.
 * Caches GET responses and serves stale data immediately while refreshing
 * in the background.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { responseCache } from '@smallstore/http/middleware/response-cache.ts';
 *
 * const app = new Hono();
 * app.use('*', responseCache({ defaultTTL: 120, swrTTL: 600 }));
 * ```
 */

import type { Context } from 'hono';

// ============================================================================
// Configuration
// ============================================================================

export interface ResponseCacheConfig {
  /** Enable response caching (default: true) */
  enabled?: boolean;

  /** Default TTL in seconds (default: 60) */
  defaultTTL?: number;

  /** SWR TTL in seconds — how long to serve stale data while refreshing (default: 300) */
  swrTTL?: number;

  /** Maximum cache entries (default: 1000) */
  maxEntries?: number;

  /** Path prefixes that should never be cached (default: []) */
  neverCache?: string[];

  /** Cleanup interval in milliseconds (default: 60000) */
  cleanupInterval?: number;
}

const DEFAULT_CONFIG: Required<ResponseCacheConfig> = {
  enabled: true,
  defaultTTL: 60,
  swrTTL: 300,
  maxEntries: 1000,
  neverCache: [],
  cleanupInterval: 60_000,
};

// ============================================================================
// Cache Entry
// ============================================================================

interface CacheEntry {
  body: unknown;
  status: number;
  contentType: string;
  cachedAt: number;
  ttl: number;
}

// ============================================================================
// Response Cache Store
// ============================================================================

/**
 * In-memory response cache with SWR support.
 *
 * Exposed as a class so callers can access stats and manual invalidation.
 */
export class ResponseCacheStore {
  private cache = new Map<string, CacheEntry>();
  private swrInFlight = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private hits = 0;
  private misses = 0;
  private staleHits = 0;

  constructor(private config: Required<ResponseCacheConfig>) {
    if (config.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), config.cleanupInterval);
      // Don't hold the process open
      if (typeof Deno !== 'undefined') {
        Deno.unrefTimer(this.cleanupTimer as number);
      }
    }
  }

  /** Generate cache key from request */
  generateKey(method: string, path: string, queryString: string, cacheSeed?: string): string {
    const seedPart = cacheSeed ? `:seed=${cacheSeed}` : '';
    return `${method}:${path}?${queryString}${seedPart}`;
  }

  /** Get cached entry. Returns { entry, status } where status is 'HIT', 'STALE', or 'MISS'. */
  get(key: string): { entry: CacheEntry | null; status: 'HIT' | 'STALE' | 'MISS' } {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return { entry: null, status: 'MISS' };
    }

    const age = (Date.now() - entry.cachedAt) / 1000;

    if (age < entry.ttl) {
      this.hits++;
      return { entry, status: 'HIT' };
    }

    if (age < entry.ttl + this.config.swrTTL) {
      this.staleHits++;
      return { entry, status: 'STALE' };
    }

    // Expired past SWR window
    this.cache.delete(key);
    this.misses++;
    return { entry: null, status: 'MISS' };
  }

  /** Store a cache entry */
  set(key: string, entry: CacheEntry): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxEntries && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, entry);
  }

  /** Check if a background refresh is already in progress for this key */
  isRefreshing(key: string): boolean {
    return this.swrInFlight.has(key);
  }

  /** Mark a key as being refreshed */
  startRefresh(key: string): void {
    this.swrInFlight.add(key);
  }

  /**
   * Atomically check whether a refresh is in flight and, if not, mark it as started.
   * Returns true if this call won the race and the caller should perform the refresh.
   * Returns false if another refresh is already in progress.
   *
   * This eliminates the race window between separate isRefreshing() + startRefresh() calls
   * where two concurrent stale requests could both see isRefreshing()===false.
   */
  startRefreshIfNotInFlight(key: string): boolean {
    if (this.swrInFlight.has(key)) return false;
    this.swrInFlight.add(key);
    return true;
  }

  /** Mark refresh as complete */
  endRefresh(key: string): void {
    this.swrInFlight.delete(key);
  }

  /** Invalidate cache entries matching a collection path prefix */
  invalidateCollection(path: string): number {
    // Extract collection from path (e.g., /prefix/users/1 → /prefix/users)
    let count = 0;
    for (const key of this.cache.keys()) {
      // Key format: "GET:/path?query"
      const keyPath = key.split('?')[0].replace(/^[A-Z]+:/, '');
      if (keyPath === path || keyPath.startsWith(path + '/') || path.startsWith(keyPath + '/')) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Remove expired entries */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      const age = (now - entry.cachedAt) / 1000;
      if (age >= entry.ttl + this.config.swrTTL) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Clear all cache entries */
  clear(): number {
    const count = this.cache.size;
    this.cache.clear();
    return count;
  }

  /** Get cache statistics */
  getStats() {
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      hitRate: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
      swrInFlight: this.swrInFlight.size,
    };
  }

  /** Stop cleanup timer */
  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ============================================================================
// Middleware
// ============================================================================

/** Methods that should never be cached */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Hono middleware for in-memory response caching with SWR.
 *
 * - Caches GET 200 responses with configurable TTL
 * - Serves stale data immediately with `X-Cache: SWR`, triggers background refresh
 * - Deduplicates background refreshes (one refresh per URL at a time)
 * - Invalidates cache on write operations (POST/PUT/PATCH/DELETE)
 * - Respects `Cache-Control: no-cache` and `no-store` from client
 * - Supports `cacheSeed` query param for cache busting
 *
 * Returns the middleware function AND the cache store for stats/manual control.
 */
export function responseCache(userConfig: ResponseCacheConfig = {}): {
  middleware: (c: Context, next: () => Promise<void>) => Promise<Response | void>;
  store: ResponseCacheStore;
} {
  const config: Required<ResponseCacheConfig> = { ...DEFAULT_CONFIG, ...userConfig };
  const store = new ResponseCacheStore(config);

  const middleware = async (c: Context, next: () => Promise<void>) => {
    if (!config.enabled) {
      await next();
      return;
    }

    const method = c.req.method.toUpperCase();
    const path = c.req.path;

    // On mutation: execute handler, then invalidate matching cache entries
    if (MUTATION_METHODS.has(method)) {
      await next();
      store.invalidateCollection(path);
      return;
    }

    // Only cache GET requests
    if (method !== 'GET') {
      await next();
      return;
    }

    // Check neverCache paths
    for (const prefix of config.neverCache) {
      if (path.startsWith(prefix)) {
        await next();
        c.header('X-Cache', 'BYPASS');
        return;
      }
    }

    // Respect client cache-control directives
    const clientCC = c.req.header('cache-control') || '';
    if (clientCC.includes('no-cache') || clientCC.includes('no-store')) {
      await next();
      c.header('X-Cache', 'BYPASS');
      return;
    }

    // Generate cache key
    const url = new URL(c.req.url);
    const cacheSeed = url.searchParams.get('cacheSeed') || url.searchParams.get('_seed') || undefined;
    const cacheKey = store.generateKey(method, path, url.search, cacheSeed);

    // Check cache
    const { entry, status } = store.get(cacheKey);

    if (status === 'HIT' && entry) {
      c.header('X-Cache', 'HIT');
      c.header('X-Cache-Age', String(Math.round((Date.now() - entry.cachedAt) / 1000)));
      return c.json(entry.body as any, entry.status as any);
    }

    if (status === 'STALE' && entry) {
      // Serve stale data immediately
      c.header('X-Cache', 'SWR');
      c.header('X-Cache-Age', String(Math.round((Date.now() - entry.cachedAt) / 1000)));

      // Trigger background refresh (fire-and-forget, deduplicated)
      // Use atomic startRefreshIfNotInFlight to avoid race where two concurrent
      // stale requests both see isRefreshing()===false and both fire a refresh.
      if (store.startRefreshIfNotInFlight(cacheKey)) {
        // Create a fresh request to the same endpoint
        // We use c.req.raw to get the original request and replay it
        const refreshUrl = c.req.url;
        const refreshHeaders = new Headers(c.req.raw.headers);
        refreshHeaders.set('cache-control', 'no-cache'); // bypass cache on refresh

        // Fire-and-forget: don't await
        fetch(refreshUrl, { headers: refreshHeaders })
          .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (response.ok && body !== null) {
              store.set(cacheKey, {
                body,
                status: response.status,
                contentType: response.headers.get('content-type') || 'application/json',
                cachedAt: Date.now(),
                ttl: config.defaultTTL,
              });
            }
          })
          .catch(err => console.warn('[ResponseCache] Background refresh failed:', err))          .finally(() => store.endRefresh(cacheKey));
      }

      return c.json(entry.body as any, entry.status as any);
    }

    // MISS — execute handler and cache the result
    await next();

    // Only cache successful responses
    const resStatus = c.res.status;
    if (resStatus >= 200 && resStatus < 300) {
      try {
        const cloned = c.res.clone();
        const body = await cloned.json();
        store.set(cacheKey, {
          body,
          status: resStatus,
          contentType: c.res.headers.get('content-type') || 'application/json',
          cachedAt: Date.now(),
          ttl: config.defaultTTL,
        });
      } catch {
        // Non-JSON response, skip caching
      }
    }

    c.header('X-Cache', 'MISS');
  };

  return { middleware, store };
}

/**
 * Simple version that returns just the middleware function (for easy `app.use()`).
 * The returned function has a `destroy()` method to stop the cleanup timer.
 */
export function responseCacheMiddleware(config: ResponseCacheConfig = {}) {
  const { middleware, store } = responseCache(config);
  const fn = middleware as typeof middleware & { destroy: () => void };
  fn.destroy = () => store.destroy();
  return fn;
}
