/**
 * Cache Key Generation for Query Result Caching
 * 
 * Generates stable, deterministic cache keys from query options.
 * 
 * Phase 3.6h-a: Query Result Caching
 */

import type { QueryOptions } from '../types.ts';

/**
 * Generate a stable cache key from collection path and query options
 * 
 * The key includes:
 * - Collection path
 * - Hash of query options (filter, sort, select, etc.)
 * 
 * Example:
 *   "_cache/query:research/papers:a3f5d8c1"
 * 
 * @param collectionPath - Collection being queried
 * @param options - Query options
 * @returns Cache key string
 */
export function generateQueryCacheKey(
  collectionPath: string,
  options: QueryOptions = {}
): string {
  // Extract cacheable query parameters
  const cacheableOptions = {
    filter: options.filter,
    where: options.where,
    sort: options.sort,
    select: options.select,
    omit: options.omit,
    limit: options.limit,
    skip: options.skip,
    page: options.page,
    pageSize: options.pageSize,
    range: options.range,
  };
  
  // Remove undefined values for consistent hashing
  const cleaned = Object.fromEntries(
    Object.entries(cacheableOptions).filter(([_, v]) => v !== undefined)
  );
  
  // Generate hash of query options
  // Use a replacer to handle function values (JSON.stringify drops them, causing key collisions)
  const hash = simpleHash(JSON.stringify(cleaned, (_key, val) => typeof val === 'function' ? `[Function:${val.name || 'anonymous'}]` : val));
  
  // Build cache key
  return `_cache/query:${collectionPath}:${hash}`;
}

/**
 * Simple hash function for generating cache keys
 * 
 * Uses FNV-1a hash algorithm (fast, good distribution)
 * 
 * @param str - String to hash
 * @returns Hexadecimal hash string
 */
export function simpleHash(str: string): string {
  let hash = 2166136261; // FNV offset basis
  
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  
  // Convert to positive number and hex
  return (hash >>> 0).toString(16);
}

/**
 * Parse cache key back into components
 * 
 * @param cacheKey - Cache key string
 * @returns Parsed components or null if invalid
 */
export function parseCacheKey(cacheKey: string): {
  type: 'query' | 'view' | 'index';
  collectionPath: string;
  hash: string;
} | null {
  // Expected format: "_cache/query:collection/path:hash"
  const match = cacheKey.match(/^_cache\/(query|view|index):(.+):([a-f0-9]+)$/);
  
  if (!match) {
    return null;
  }
  
  return {
    type: match[1] as 'query' | 'view' | 'index',
    collectionPath: match[2],
    hash: match[3],
  };
}

/**
 * Generate cache key for a collection (all queries)
 * 
 * Used for clearing all caches for a collection.
 * 
 * @param collectionPath - Collection path
 * @returns Prefix for all query caches in this collection
 */
export function generateCollectionCachePrefix(collectionPath: string): string {
  return `_cache/query:${collectionPath}:`;
}

/**
 * Check if a key is a cache key
 * 
 * @param key - Key to check
 * @returns True if this is a cache key
 */
export function isCacheKey(key: string): boolean {
  return key.startsWith('_cache/');
}

/**
 * Extract collection path from cache key
 * 
 * @param cacheKey - Cache key
 * @returns Collection path or null
 */
export function getCollectionFromCacheKey(cacheKey: string): string | null {
  const parsed = parseCacheKey(cacheKey);
  return parsed?.collectionPath || null;
}

