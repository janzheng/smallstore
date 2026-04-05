/**
 * Distributed KV Cache Middleware for Smallstore HTTP
 *
 * Two-level cache cascade: fast in-memory L1 backed by a persistent
 * smallstore adapter L2. This allows HTTP response caching to survive
 * process restarts and to be shared across workers that point at the
 * same storage backend (e.g., Upstash, Cloudflare KV, SQLite).
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { distributedCache } from '@smallstore/http/middleware/distributed-cache.ts';
 * import { createMemoryAdapter } from '@smallstore/adapters/memory.ts';
 *
 * const app = new Hono();
 * const { middleware } = distributedCache({
 *   adapter: createMemoryAdapter(),
 *   collection: '_http_cache',
 * });
 * app.use('*', middleware);
 * ```
 */

import type { Context } from 'hono';

// ============================================================================
// Types — keep minimal; we only need get/set/delete/keys from the adapter
// ============================================================================

/**
 * Minimal adapter interface required by distributed cache.
 * Matches the common subset of all smallstore adapters.
 */
export interface DistributedCacheAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

// ============================================================================
// Configuration
// ============================================================================

export interface DistributedCacheConfig {
  /** Enable distributed caching (default: true) */
  enabled?: boolean;

  /** Smallstore adapter to use as L2 persistent store */
  adapter: DistributedCacheAdapter;

  /** Collection/namespace prefix for cache keys in the adapter (default: '_http_cache') */
  collection?: string;

  /** L1 in-memory TTL in seconds (default: 30) — short to keep memory bounded */
  l1TTL?: number;

  /** L2 persistent TTL in seconds (default: 300) */
  l2TTL?: number;

  /** Maximum L1 entries (default: 500) */
  maxL1Entries?: number;

  /** Path prefixes that should never be cached (default: []) */
  neverCache?: string[];

  /** Cleanup interval in milliseconds for L1 (default: 60000) */
  cleanupInterval?: number;
}

const DEFAULT_CONFIG = {
  enabled: true,
  collection: '_http_cache',
  l1TTL: 30,
  l2TTL: 300,
  maxL1Entries: 500,
  neverCache: [] as string[],
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
  ttl: number; // L2 TTL
}

// ============================================================================
// Distributed Cache Store
// ============================================================================

/**
 * Two-level cache: in-memory L1 → persistent L2 (smallstore adapter).
 *
 * Reads check L1 first, then L2 (promoting to L1 on hit).
 * Writes go to both levels simultaneously.
 */
export class DistributedCacheStore {
  private l1 = new Map<string, { entry: CacheEntry; insertedAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private l1Hits = 0;
  private l2Hits = 0;
  private misses = 0;

  private adapter: DistributedCacheAdapter;
  private collection: string;
  private l1TTL: number;
  private l2TTL: number;
  private maxL1: number;
  private neverCache: string[];

  constructor(private config: Required<Omit<DistributedCacheConfig, 'adapter'>> & { adapter: DistributedCacheAdapter }) {
    this.adapter = config.adapter;
    this.collection = config.collection;
    this.l1TTL = config.l1TTL;
    this.l2TTL = config.l2TTL;
    this.maxL1 = config.maxL1Entries;
    this.neverCache = config.neverCache;

    if (config.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupL1(), config.cleanupInterval);
      if (typeof Deno !== 'undefined') {
        Deno.unrefTimer(this.cleanupTimer as number);
      }
    }
  }

  /** Build the full adapter key from a cache key */
  private adapterKey(cacheKey: string): string {
    return `${this.collection}/${cacheKey}`;
  }

  /** Generate cache key from request */
  generateKey(method: string, path: string, queryString: string): string {
    // Normalize: strip trailing slash, lowercase method
    return `${method.toUpperCase()}:${path}${queryString}`;
  }

  /** Check if a path should be cached */
  shouldCache(path: string): boolean {
    for (const prefix of this.neverCache) {
      if (path.startsWith(prefix)) return false;
    }
    return true;
  }

  /**
   * Get a cached entry. Checks L1 first, then L2.
   * Returns null on miss.
   */
  async get(key: string): Promise<{ entry: CacheEntry; level: 'L1' | 'L2' } | null> {
    const now = Date.now();

    // Check L1
    const l1Item = this.l1.get(key);
    if (l1Item) {
      const l1Age = (now - l1Item.insertedAt) / 1000;
      if (l1Age < this.l1TTL) {
        // Also check if the entry itself is still valid
        const entryAge = (now - l1Item.entry.cachedAt) / 1000;
        if (entryAge < l1Item.entry.ttl) {
          this.l1Hits++;
          return { entry: l1Item.entry, level: 'L1' };
        }
      }
      // L1 expired, remove it
      this.l1.delete(key);
    }

    // Check L2
    try {
      const stored = await this.adapter.get(this.adapterKey(key)) as CacheEntry | null;
      if (stored && stored.cachedAt && stored.ttl) {
        const age = (now - stored.cachedAt) / 1000;
        if (age < stored.ttl) {
          // Promote to L1
          this.setL1(key, stored);
          this.l2Hits++;
          return { entry: stored, level: 'L2' };
        }
        // L2 expired, clean up (fire and forget)
        this.adapter.delete(this.adapterKey(key)).catch(err => console.warn('[DistributedCache] L2 cleanup failed:', err));
      }
    } catch {
      // L2 read failure — treat as miss, don't block the request
    }

    this.misses++;
    return null;
  }

  /** Store an entry in both L1 and L2 */
  async set(key: string, entry: CacheEntry): Promise<void> {
    this.setL1(key, entry);

    // Write to L2 (fire and forget — don't slow down the response)
    try {
      await this.adapter.set(this.adapterKey(key), entry);
    } catch {
      // L2 write failure is not fatal
    }
  }

  /** Invalidate entries matching a path prefix */
  async invalidate(pathPrefix: string): Promise<number> {
    let count = 0;

    // Invalidate L1 — snapshot keys first to avoid mutating the map during iteration,
    // which can cause keys to be skipped or visited twice.
    const l1Keys = [...this.l1.keys()];
    for (const key of l1Keys) {
      const keyPath = key.replace(/^[A-Z]+:/, '').split('?')[0];
      if (keyPath === pathPrefix || keyPath.startsWith(pathPrefix + '/')) {
        this.l1.delete(key);
        count++;
      }
    }

    // Invalidate L2
    try {
      const allKeys = await this.adapter.keys(this.collection + '/');
      for (const adapterKey of allKeys) {
        const cacheKey = adapterKey.replace(this.collection + '/', '');
        const keyPath = cacheKey.replace(/^[A-Z]+:/, '').split('?')[0];
        if (keyPath === pathPrefix || keyPath.startsWith(pathPrefix + '/')) {
          await this.adapter.delete(adapterKey);
          count++;
        }
      }
    } catch {
      // L2 invalidation failure is not fatal
    }

    return count;
  }

  /** Clear all cached entries */
  async clear(): Promise<number> {
    const l1Count = this.l1.size;
    this.l1.clear();

    let l2Count = 0;
    try {
      const allKeys = await this.adapter.keys(this.collection + '/');
      for (const key of allKeys) {
        await this.adapter.delete(key);
        l2Count++;
      }
    } catch {
      // Best effort
    }

    return l1Count + l2Count;
  }

  /** Get cache statistics */
  getStats() {
    return {
      l1Entries: this.l1.size,
      l1Hits: this.l1Hits,
      l2Hits: this.l2Hits,
      misses: this.misses,
      totalRequests: this.l1Hits + this.l2Hits + this.misses,
      l1HitRate: this.totalHits > 0 ? this.l1Hits / this.totalHits : 0,
      l2HitRate: this.totalHits > 0 ? this.l2Hits / this.totalHits : 0,
      overallHitRate: this.totalRequests > 0 ? this.totalHits / this.totalRequests : 0,
    };
  }

  private get totalHits() {
    return this.l1Hits + this.l2Hits;
  }

  private get totalRequests() {
    return this.l1Hits + this.l2Hits + this.misses;
  }

  /** Remove expired L1 entries */
  cleanupL1(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, item] of this.l1) {
      const l1Age = (now - item.insertedAt) / 1000;
      const entryAge = (now - item.entry.cachedAt) / 1000;
      if (l1Age >= this.l1TTL || entryAge >= item.entry.ttl) {
        this.l1.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Stop cleanup timer */
  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ---- private helpers ----

  private setL1(key: string, entry: CacheEntry): void {
    if (this.l1.size >= this.maxL1 && !this.l1.has(key)) {
      const firstKey = this.l1.keys().next().value;
      // Guard: if the key to evict was already deleted by a concurrent call,
      // this is a benign race — just proceed with insertion.
      if (firstKey && this.l1.has(firstKey)) {
        this.l1.delete(firstKey);
      }
    }
    this.l1.set(key, { entry, insertedAt: Date.now() });
  }
}

// ============================================================================
// Middleware
// ============================================================================

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Hono middleware for distributed two-level caching.
 *
 * - L1: fast in-memory cache with short TTL
 * - L2: persistent smallstore adapter with longer TTL
 * - Reads cascade L1 → L2 → handler
 * - Writes populate both levels and invalidate on mutations
 * - Sets X-Cache header: L1-HIT, L2-HIT, or MISS
 */
export function distributedCache(userConfig: DistributedCacheConfig): {
  middleware: (c: Context, next: () => Promise<void>) => Promise<Response | void>;
  store: DistributedCacheStore;
} {
  const config = { ...DEFAULT_CONFIG, ...userConfig } as Required<Omit<DistributedCacheConfig, 'adapter'>> & { adapter: DistributedCacheAdapter };

  const store = new DistributedCacheStore(config);

  const middleware = async (c: Context, next: () => Promise<void>) => {
    if (!config.enabled) {
      await next();
      return;
    }

    const method = c.req.method.toUpperCase();
    const path = c.req.path;

    // On mutation: execute handler, then invalidate
    if (MUTATION_METHODS.has(method)) {
      await next();
      store.invalidate(path).catch(err => console.warn('[DistributedCache] L2 invalidation failed:', err)); // fire and forget
      return;
    }

    // Only cache GET
    if (method !== 'GET') {
      await next();
      return;
    }

    // Check neverCache
    if (!store.shouldCache(path)) {
      await next();
      c.header('X-Distributed-Cache', 'BYPASS');
      return;
    }

    // Respect client cache-control
    const clientCC = c.req.header('cache-control') || '';
    if (clientCC.includes('no-cache') || clientCC.includes('no-store')) {
      await next();
      c.header('X-Distributed-Cache', 'BYPASS');
      return;
    }

    // Generate cache key
    const url = new URL(c.req.url);
    const cacheKey = store.generateKey(method, path, url.search);

    // Check cache (L1 → L2)
    const cached = await store.get(cacheKey);
    if (cached) {
      c.header('X-Distributed-Cache', `${cached.level}-HIT`);
      c.header('X-Cache-Age', String(Math.round((Date.now() - cached.entry.cachedAt) / 1000)));
      return c.json(cached.entry.body as any, cached.entry.status as any);
    }

    // MISS — execute handler and cache result
    await next();

    const resStatus = c.res.status;
    if (resStatus >= 200 && resStatus < 300) {
      try {
        const cloned = c.res.clone();
        const body = await cloned.json();
        // Don't await — write to cache in background
        store.set(cacheKey, {
          body,
          status: resStatus,
          contentType: c.res.headers.get('content-type') || 'application/json',
          cachedAt: Date.now(),
          ttl: config.l2TTL,
        }).catch(err => console.warn('[DistributedCache] L2 write failed:', err));
      } catch {
        // Non-JSON response, skip caching
      }
    }

    c.header('X-Distributed-Cache', 'MISS');
  };

  return { middleware, store };
}

/**
 * Simple version that returns just the middleware function.
 * The returned function has a `destroy()` method to stop the cleanup timer.
 */
export function distributedCacheMiddleware(config: DistributedCacheConfig) {
  const { middleware, store } = distributedCache(config);
  const fn = middleware as typeof middleware & { destroy: () => void };
  fn.destroy = () => store.destroy();
  return fn;
}
