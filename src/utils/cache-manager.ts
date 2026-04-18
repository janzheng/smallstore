/**
 * Cache Manager for Query Result Caching
 * 
 * Handles:
 * - Cache storage and retrieval
 * - TTL management
 * - Cache statistics
 * - Eviction policies
 * 
 * Phase 3.6h-a: Query Result Caching
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { CachingConfig, CachedResult, CacheStats, QueryOptions } from '../types.ts';
import { generateQueryCacheKey, generateCollectionCachePrefix, parseCacheKey } from './cache-key.ts';

/**
 * Cache Manager
 * 
 * Manages query result caching with TTL and eviction.
 */
export class CacheManager {
  private adapter: StorageAdapter;
  private config: Required<CachingConfig>;
  private stats: { hits: number; misses: number };
  // Eviction tracking: per-entry size + monotonic access tick. In-process only;
  // if the backing adapter is shared across processes, each tracks its own view.
  // Tick (not Date.now) so repeated ops inside the same ms still sort deterministically.
  private entries: Map<string, { size: number; lastAccess: number }>;
  private totalBytes: number;
  private maxBytes: number;
  private accessTick: number;
  // Serializes concurrent set() calls so two disjoint-key writes can't both
  // read pre-state totalBytes and land together without eviction (overshooting
  // maxBytes), and so evictUntilFits() can't double-evict the same victim.
  private setLock: Promise<void> = Promise.resolve();

  constructor(adapter: StorageAdapter, config: CachingConfig = {}) {
    this.adapter = adapter;
    this.config = {
      enableQueryCache: config.enableQueryCache ?? true,
      defaultTTL: config.defaultTTL ?? 900000, // 15 minutes
      maxCacheSize: config.maxCacheSize ?? '100MB',
      evictionPolicy: config.evictionPolicy ?? 'lru',
      cacheAdapter: config.cacheAdapter ?? 'memory',
      autoInvalidate: config.autoInvalidate ?? true,
    };
    this.stats = { hits: 0, misses: 0 };
    this.entries = new Map();
    this.totalBytes = 0;
    this.maxBytes = parseSizeString(this.config.maxCacheSize);
    this.accessTick = 0;
  }
  
  /**
   * Get cached query result
   * 
   * @param collectionPath - Collection path
   * @param options - Query options
   * @returns Cached result or null if not found/expired
   */
  async get<T = any>(
    collectionPath: string,
    options: QueryOptions
  ): Promise<CachedResult<T> | null> {
    if (!this.config.enableQueryCache) {
      return null;
    }
    
    const cacheKey = generateQueryCacheKey(collectionPath, options);
    
    try {
      const cached = await this.adapter.get(cacheKey);
      
      if (!cached) {
        this.stats.misses++;
        return null;
      }
      
      // Check if expired
      const now = Date.now();
      if (cached.cachedAt + cached.ttl < now) {
        // Expired — delete it and drop tracking so totalBytes doesn't drift
        // upward from ghost entries over the cache's lifetime.
        await this.adapter.delete(cacheKey);
        const tracked = this.entries.get(cacheKey);
        if (tracked) {
          this.totalBytes -= tracked.size;
          this.entries.delete(cacheKey);
        }
        this.stats.misses++;
        return null;
      }
      
      // Valid cache hit
      this.stats.hits++;
      const tracked = this.entries.get(cacheKey);
      if (tracked) tracked.lastAccess = ++this.accessTick;
      return cached as CachedResult<T>;
      
    } catch (error) {
      console.warn('[CacheManager] Cache read error (treating as miss):', error);
      this.stats.misses++;
      return null;
    }
  }
  
  /**
   * Set cached query result
   * 
   * @param collectionPath - Collection path
   * @param options - Query options
   * @param data - Data to cache
   * @param ttl - TTL in milliseconds (optional, uses default)
   */
  async set<T = any>(
    collectionPath: string,
    options: QueryOptions,
    data: T,
    ttl?: number
  ): Promise<void> {
    if (!this.config.enableQueryCache) {
      return;
    }

    // Serialize set() — the eviction check + adapter write + tracking update
    // must be atomic. Without this, two concurrent set()s can both read
    // pre-state totalBytes, both decide no eviction is needed, and land
    // together past maxBytes; or evictUntilFits can double-evict the same LRU
    // victim and drop totalBytes into negatives.
    const prev = this.setLock;
    let release!: () => void;
    this.setLock = new Promise<void>(r => { release = () => r(); });
    await prev;

    try {
      return await this._setUnlocked(collectionPath, options, data, ttl);
    } finally {
      release();
    }
  }

  private async _setUnlocked<T = any>(
    collectionPath: string,
    options: QueryOptions,
    data: T,
    ttl?: number,
  ): Promise<void> {
    const cacheKey = generateQueryCacheKey(collectionPath, options);
    const cacheTTL = ttl ?? this.config.defaultTTL;

    const cached: CachedResult<T> = {
      data,
      cachedAt: Date.now(),
      ttl: cacheTTL,
      key: cacheKey,
      query: options,
    };

    const entrySize = estimateSize(cached);

    // Snapshot tracking state so we can roll back evictions if adapter.set throws.
    const trackingSnapshot = new Map(this.entries);
    const totalSnapshot = this.totalBytes;

    try {
      // Enforce max-size with configured eviction policy.
      if (this.maxBytes > 0 && this.config.evictionPolicy !== 'ttl-only') {
        const existing = this.entries.get(cacheKey);
        const projected = this.totalBytes - (existing?.size ?? 0) + entrySize;
        if (projected > this.maxBytes) {
          await this.evictUntilFits(entrySize - (existing?.size ?? 0), cacheKey);
        }
        // A single entry larger than the entire cap lands anyway (evicting
        // everything else). Warn so operators can raise maxCacheSize or shard.
        if (entrySize > this.maxBytes) {
          console.warn(
            `[CacheManager] Entry ${entrySize}B exceeds maxCacheSize ${this.maxBytes}B — caching anyway, but maxCacheSize enforcement is effectively bypassed for this key.`,
          );
        }
      }

      // Store with TTL (adapter will handle expiration if supported)
      const ttlSeconds = Math.ceil(cacheTTL / 1000);
      await this.adapter.set(cacheKey, cached, ttlSeconds);

      // Update tracking after successful write.
      const existing = this.entries.get(cacheKey);
      if (existing) this.totalBytes -= existing.size;
      this.entries.set(cacheKey, { size: entrySize, lastAccess: ++this.accessTick });
      this.totalBytes += entrySize;
    } catch (error) {
      // Roll back in-process tracking so evictions that committed to the
      // adapter don't leave us reporting phantom free space. The adapter-side
      // evictions are already gone (that's a visible effect of the attempted
      // write), but keeping tracking consistent with adapter state avoids
      // further drift.
      this.entries = trackingSnapshot;
      this.totalBytes = totalSnapshot;
      console.error('[CacheManager] Error setting cache:', error);
      // Don't throw - caching is best-effort
    }
  }

  /**
   * Evict entries until `bytesNeeded` bytes of headroom exist (under maxBytes).
   * Policy is LRU by default; 'lfu' falls back to LRU here (hit counts not tracked per-entry).
   */
  private async evictUntilFits(bytesNeeded: number, skipKey?: string): Promise<void> {
    if (bytesNeeded <= 0) return;
    const candidates = [...this.entries.entries()]
      .filter(([k]) => k !== skipKey)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    let freed = 0;
    for (const [key, meta] of candidates) {
      if (this.totalBytes + bytesNeeded - freed <= this.maxBytes) break;
      try { await this.adapter.delete(key); } catch { /* best-effort */ }
      this.entries.delete(key);
      this.totalBytes -= meta.size;
      freed += meta.size;
    }
  }
  
  /**
   * Clear cache for specific query
   * 
   * @param collectionPath - Collection path
   * @param options - Query options
   */
  async clearQuery(collectionPath: string, options: QueryOptions): Promise<void> {
    const cacheKey = generateQueryCacheKey(collectionPath, options);

    try {
      await this.adapter.delete(cacheKey);
      const tracked = this.entries.get(cacheKey);
      if (tracked) {
        this.totalBytes -= tracked.size;
        this.entries.delete(cacheKey);
      }
    } catch (error) {
      console.error('[CacheManager] Error clearing query cache:', error);
    }
  }
  
  /**
   * Clear all caches for a collection
   * 
   * @param collectionPath - Collection path
   * @returns Number of caches cleared
   */
  async clearCollection(collectionPath: string): Promise<number> {
    const prefix = generateCollectionCachePrefix(collectionPath);

    try {
      // Get all cache keys for this collection
      const keys = await this.adapter.keys(prefix);

      // Delete all in parallel
      await Promise.all(keys.map(key => this.adapter.delete(key)));

      // Drop tracking for these keys
      for (const key of keys) {
        const tracked = this.entries.get(key);
        if (tracked) {
          this.totalBytes -= tracked.size;
          this.entries.delete(key);
        }
      }

      return keys.length;

    } catch (error) {
      console.error('[CacheManager] Error clearing collection cache:', error);
      return 0;
    }
  }
  
  /**
   * Clear all caches
   * 
   * @returns Number of caches cleared
   */
  async clearAll(): Promise<number> {
    try {
      // Get all cache keys
      const keys = await this.adapter.keys('_cache/');

      // Delete all in parallel
      await Promise.all(keys.map(key => this.adapter.delete(key)));

      // Reset stats + tracking
      this.stats = { hits: 0, misses: 0 };
      this.entries.clear();
      this.totalBytes = 0;

      return keys.length;

    } catch (error) {
      console.error('[CacheManager] Error clearing all caches:', error);
      return 0;
    }
  }
  
  /**
   * Get cache statistics.
   *
   * Scope caveat: `hits` and `misses` are PER-PROCESS counters on this
   * CacheManager instance, while `entries`, `size`, and the timestamps
   * come from a live scan of the backing adapter (shared across all
   * processes). On a shared remote adapter (e.g. Upstash), hit-rate is
   * this process's view; entry count is the whole cache. Not a single
   * coherent snapshot — interpret accordingly.
   *
   * @param collectionPath - Optional collection to filter stats
   * @returns Cache statistics
   */
  async getStats(collectionPath?: string): Promise<CacheStats> {
    try {
      // Get cache keys
      const prefix = collectionPath 
        ? generateCollectionCachePrefix(collectionPath)
        : '_cache/';
      
      const keys = await this.adapter.keys(prefix);
      
      // Calculate total size (approximate)
      let totalSize = 0;
      let oldestTimestamp: number | undefined;
      let newestTimestamp: number | undefined;
      
      for (const key of keys) {
        try {
          const cached = await this.adapter.get(key) as CachedResult<any>;
          
          if (cached) {
            // Estimate size (rough approximation)
            const size = JSON.stringify(cached.data).length;
            totalSize += size;
            
            // Track timestamps
            if (!oldestTimestamp || cached.cachedAt < oldestTimestamp) {
              oldestTimestamp = cached.cachedAt;
            }
            if (!newestTimestamp || cached.cachedAt > newestTimestamp) {
              newestTimestamp = cached.cachedAt;
            }
          }
        } catch {
          // Skip invalid cache entries
        }
      }
      
      // Calculate hit rate
      const total = this.stats.hits + this.stats.misses;
      const hitRate = total > 0 ? this.stats.hits / total : 0;
      
      return {
        hits: this.stats.hits,
        misses: this.stats.misses,
        hitRate,
        size: formatBytes(totalSize),
        entries: keys.length,
        oldestEntry: oldestTimestamp ? new Date(oldestTimestamp).toISOString() : undefined,
        newestEntry: newestTimestamp ? new Date(newestTimestamp).toISOString() : undefined,
      };
      
    } catch (error) {
      console.error('[CacheManager] Error getting cache stats:', error);
      return {
        hits: this.stats.hits,
        misses: this.stats.misses,
        hitRate: 0,
        size: '0B',
        entries: 0,
      };
    }
  }
  
  /**
   * Check if caching is enabled
   */
  isEnabled(): boolean {
    return this.config.enableQueryCache;
  }
  
  /**
   * Get cache configuration
   */
  getConfig(): Required<CachingConfig> {
    return { ...this.config };
  }
}

/**
 * Parse a size string ('100MB', '1.5GB', '500KB', '1024', '1B') to bytes.
 * Returns 0 for falsy / unparseable inputs (which disables size-based eviction).
 */
function parseSizeString(input: string | number | undefined): number {
  if (!input) return 0;
  if (typeof input === 'number') return input > 0 ? input : 0;
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.floor(n * (mult[unit] ?? 1));
}

/** Estimate in-memory cost of a cache entry as UTF-8 byte length. */
const SIZE_ENCODER = new TextEncoder();
function estimateSize(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json ? SIZE_ENCODER.encode(json).byteLength : 0;
  } catch { return 0; }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  
  return `${value.toFixed(2)}${units[i]}`;
}

