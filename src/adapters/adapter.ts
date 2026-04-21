/**
 * Storage Adapter Base
 * 
 * Abstract base class for all Smallstore adapters.
 * Each adapter MUST:
 * - Declare capabilities (supported types, size limits, cost)
 * - Implement CRUD operations (get, set, delete, has, keys)
 * - Handle TTL (if supported)
 */

import type { DataType, AdapterCapabilities, SearchProvider, KeysPageOptions, KeysPage } from '../types.ts';
export type { AdapterCapabilities } from '../types.ts';

// ============================================================================
// Storage Adapter Interface
// ============================================================================

/**
 * Storage adapter interface
 * 
 * All adapters MUST implement these methods
 */
export interface StorageAdapter {
  /** Adapter capabilities (MUST be declared) */
  readonly capabilities: AdapterCapabilities;
  
  /**
   * Get value by key
   * 
   * @param key - Storage key
   * @returns Value, or null if not found
   */
  get(key: string): Promise<any>;
  
  /**
   * Set value by key
   * 
   * @param key - Storage key
   * @param value - Value to store
   * @param ttl - Optional TTL in seconds
   */
  set(key: string, value: any, ttl?: number): Promise<void>;
  
  /**
   * Delete value by key
   * 
   * @param key - Storage key
   */
  delete(key: string): Promise<void>;
  
  /**
   * Check if key exists
   * 
   * @param key - Storage key
   * @returns true if exists
   */
  has(key: string): Promise<boolean>;
  
  /**
   * List keys with optional prefix
   *
   * @param prefix - Optional prefix filter
   * @returns Array of keys (unpaged; may be large on remote adapters)
   */
  keys(prefix?: string): Promise<string[]>;

  /**
   * Optional: paged keys. Adapters with efficient native pagination
   * (Upstash SCAN, Airtable offset, Notion start_cursor, SQLite LIMIT/OFFSET,
   * CF KV list) should implement this so callers don't have to round-trip
   * the whole key list. When omitted, the router provides a fallback that
   * wraps `keys()` and slices by offset/limit.
   */
  listKeys?(options?: KeysPageOptions): Promise<KeysPage>;
  
  /**
   * Clear all data (for testing)
   *
   * @param prefix - Optional prefix to clear only specific namespace
   */
  clear(prefix?: string): Promise<void>;

  /**
   * Native query support (optional).
   *
   * Adapters with `capabilities.features.query = true` can implement this
   * for efficient server-side filtering instead of loading all data into
   * memory. The router will check for this method and delegate when available.
   */
  query?(options: AdapterQueryOptions): Promise<AdapterQueryResult>;

  /**
   * Non-destructive append (optional).
   *
   * Adapters whose native shape is an append-log (Sheetlog, audit tables,
   * event streams) can implement this to provide a non-destructive
   * alternative to `set()`. The KV-shaped `set(key, value)` semantics
   * force "replace whole collection" behavior for such adapters; `append`
   * escapes that. Router calls this when `smallstore.append()` is used.
   *
   * Implementations should NOT read-modify-write the existing collection;
   * they should append items directly to the underlying store.
   *
   * @param items - Single item or array of items to append
   * @returns Adapter-defined response (usually includes a count or ids)
   */
  append?(items: any[] | Record<string, any>): Promise<any>;

  /** Optional search provider for full-text/vector/hybrid search */
  readonly searchProvider?: SearchProvider;
}

// ============================================================================
// Adapter Query Types
// ============================================================================

/**
 * Options for adapter-level native query.
 * Uses MongoDB-style filter operators.
 */
export interface AdapterQueryOptions {
  /** Key prefix to scope the query */
  prefix?: string;
  /** MongoDB-style filter (e.g., { age: { $gte: 18 } }) */
  filter?: Record<string, any>;
  /** Sort specification (1 = ascending, -1 = descending) */
  sort?: Record<string, 1 | -1>;
  /** Maximum number of results */
  limit?: number;
  /** Number of results to skip */
  skip?: number;
}

/**
 * Result from adapter-level native query.
 */
export interface AdapterQueryResult {
  /** Matching data items */
  data: any[];
  /** Total count of matching items (before limit/skip) */
  totalCount: number;
}

// ============================================================================
// Helper Functions for Adapters
// ============================================================================

/**
 * Check if adapter can handle a specific data type
 * 
 * @param adapter - Adapter to check
 * @param dataType - Data type to check
 * @returns true if supported
 * 
 * @example
 * canHandleType(memoryAdapter, 'json');       // true
 * canHandleType(upstashAdapter, 'array-large'); // false
 */
export function canHandleType(adapter: StorageAdapter, dataType: DataType): boolean {
  return adapter.capabilities.supportedTypes.includes(dataType);
}

/**
 * Check if adapter can handle a specific data size
 * 
 * @param adapter - Adapter to check
 * @param sizeBytes - Data size in bytes
 * @returns true if within limits
 * 
 * @example
 * canHandleSize(memoryAdapter, 10 * 1024 * 1024);  // true (no limit)
 * canHandleSize(upstashAdapter, 2 * 1024 * 1024);  // false (>1MB limit)
 */
export function canHandleSize(adapter: StorageAdapter, sizeBytes: number): boolean {
  const { maxItemSize } = adapter.capabilities;
  
  // No limit = can handle any size
  if (maxItemSize === undefined) {
    return true;
  }
  
  return sizeBytes <= maxItemSize;
}

/**
 * Get cost tier for adapter
 * 
 * @param adapter - Adapter to check
 * @returns Cost tier
 */
export function getCostTier(adapter: StorageAdapter): 'free' | 'cheap' | 'moderate' | 'expensive' {
  return adapter.capabilities.cost?.tier || 'free';
}

/**
 * Get read latency for adapter
 * 
 * @param adapter - Adapter to check
 * @returns Latency tier
 */
export function getReadLatency(adapter: StorageAdapter): 'low' | 'medium' | 'high' {
  return adapter.capabilities.performance?.readLatency || 'medium';
}

/**
 * Get write latency for adapter
 * 
 * @param adapter - Adapter to check
 * @returns Latency tier
 */
export function getWriteLatency(adapter: StorageAdapter): 'low' | 'medium' | 'high' {
  return adapter.capabilities.performance?.writeLatency || 'medium';
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that adapter can handle data type and size
 * 
 * @param adapter - Adapter to validate
 * @param dataType - Data type
 * @param sizeBytes - Data size
 * @throws Error if adapter cannot handle
 * 
 * @example
 * validateAdapter(upstashAdapter, 'array-large', 2 * 1024 * 1024);
 * // Throws: "Upstash adapter cannot handle data type array-large"
 */
export function validateAdapter(
  adapter: StorageAdapter,
  dataType: DataType,
  sizeBytes: number
): void {
  // Check type support
  if (!canHandleType(adapter, dataType)) {
    throw new Error(
      `${adapter.capabilities.name} adapter cannot handle data type ${dataType}. ` +
      `Supported types: ${adapter.capabilities.supportedTypes.join(', ')}`
    );
  }
  
  // Check size limits
  if (!canHandleSize(adapter, sizeBytes)) {
    const maxSize = adapter.capabilities.maxItemSize;
    throw new Error(
      `${adapter.capabilities.name} adapter cannot handle data size ${formatBytes(sizeBytes)}. ` +
      `Maximum size: ${formatBytes(maxSize!)}`
    );
  }
}

/**
 * Format bytes for error messages
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= k && unitIndex < units.length - 1) {
    size /= k;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

