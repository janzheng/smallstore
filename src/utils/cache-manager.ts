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
        // Expired - delete it
        await this.adapter.delete(cacheKey);
        this.stats.misses++;
        return null;
      }
      
      // Valid cache hit
      this.stats.hits++;
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
    
    const cacheKey = generateQueryCacheKey(collectionPath, options);
    const cacheTTL = ttl ?? this.config.defaultTTL;
    
    const cached: CachedResult<T> = {
      data,
      cachedAt: Date.now(),
      ttl: cacheTTL,
      key: cacheKey,
      query: options,
    };
    
    try {
      // Store with TTL (adapter will handle expiration if supported)
      const ttlSeconds = Math.ceil(cacheTTL / 1000);
      await this.adapter.set(cacheKey, cached, ttlSeconds);
      
    } catch (error) {
      console.error('[CacheManager] Error setting cache:', error);
      // Don't throw - caching is best-effort
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
      
      // Reset stats
      this.stats = { hits: 0, misses: 0 };
      
      return keys.length;
      
    } catch (error) {
      console.error('[CacheManager] Error clearing all caches:', error);
      return 0;
    }
  }
  
  /**
   * Get cache statistics
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
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  
  return `${value.toFixed(2)}${units[i]}`;
}

