/**
 * Memory Storage Adapter
 * 
 * In-memory storage adapter for Smallstore.
 * - Fast (synchronous Map operations)
 * - Free (no external costs)
 * - Ephemeral (clears on process restart)
 * - Unlimited size (for Phase 1)
 * - Supports ALL data types
 * 
 * Use cases:
 * - Development/testing
 * - Temporary caching
 * - Large arrays (Phase 1, will migrate to proper DB later)
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities, SearchProvider, KeysPageOptions, KeysPage } from '../types.ts';
import { MemoryBm25SearchProvider } from '../search/memory-bm25-provider.ts';

// ============================================================================
// TTL Entry
// ============================================================================

interface TTLEntry {
  value: any;
  expiresAt: number | null; // Timestamp in ms, null = no expiration
}

// ============================================================================
// Memory Adapter
// ============================================================================

/**
 * Memory storage adapter
 * 
 * Stores data in-memory using Map.
 * Supports TTL via timestamp checking.
 */
export interface MemoryAdapterConfig {
  /** Plug in a custom SearchProvider. Defaults to MemoryBm25SearchProvider. */
  searchProvider?: SearchProvider;
}

export class MemoryAdapter implements StorageAdapter {
  // Storage: Map of key → TTLEntry
  private store: Map<string, TTLEntry> = new Map();
  private _searchProvider: SearchProvider;

  constructor(config: MemoryAdapterConfig = {}) {
    this._searchProvider = config.searchProvider ?? new MemoryBm25SearchProvider();
  }

  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'memory',
    supportedTypes: [
      'object',  // All structured data (arrays, objects, nested)
      'blob',    // Binary data
      'kv',      // Primitives
    ],
    maxItemSize: undefined, // No limit
    maxTotalSize: undefined, // No limit
    cost: {
      tier: 'free',
    },
    performance: {
      readLatency: 'low',   // Synchronous Map.get()
      writeLatency: 'low',  // Synchronous Map.set()
      throughput: 'high',   // In-process, no network
    },
    features: {
      ttl: true, // Manual TTL checking
      search: true,
    },
  };

  get searchProvider(): SearchProvider {
    return this._searchProvider;
  }
  
  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  /**
   * Get value by key
   * 
   * @param key - Storage key
   * @returns Value, or null if not found or expired
   */
  async get(key: string): Promise<any> {
    const entry = this.store.get(key);
    
    if (!entry) {
      return null;
    }
    
    // Check TTL
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      // Expired, delete and return null
      this.store.delete(key);
      return null;
    }
    
    // Return a clone for object/array values to prevent store corruption
    const val = entry.value;
    return (val !== null && typeof val === 'object') ? structuredClone(val) : val;
  }
  
  /**
   * Set value by key
   * 
   * @param key - Storage key
   * @param value - Value to store
   * @param ttl - Optional TTL in seconds
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const expiresAt = ttl
      ? Date.now() + ttl * 1000
      : null;
    
    // Clone object/array values on set to prevent caller from mutating stored data
    const storedValue = (value !== null && typeof value === 'object') ? structuredClone(value) : value;
    this.store.set(key, {
      value: storedValue,
      expiresAt,
    });

    // Auto-index for search (best-effort). Reads through the getter so runtime
    // overrides via Object.defineProperty(adapter, 'searchProvider', ...) work.
    // Pass the cloned storedValue so async providers (vector, zvec) can't
    // observe later mutations the caller makes to their original object.
    try { this.searchProvider.index(key, storedValue); } catch { /* best-effort */ }
  }
  
  /**
   * Delete value by key
   * 
   * @param key - Storage key
   */
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    // Remove from search index (best-effort)
    try { this.searchProvider.remove(key); } catch { /* best-effort */ }
  }
  
  /**
   * Check if key exists (and not expired)
   * 
   * @param key - Storage key
   * @returns true if exists and not expired
   */
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }
  
  /**
   * List keys with optional prefix
   * 
   * @param prefix - Optional prefix filter
   * @returns Array of keys (non-expired)
   */
  async keys(prefix?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());

    // Filter by prefix if provided
    const filteredKeys = prefix
      ? allKeys.filter((key) => key.startsWith(prefix))
      : allKeys;

    // Filter out expired keys
    const validKeys: string[] = [];
    for (const key of filteredKeys) {
      const entry = this.store.get(key);
      if (entry && (entry.expiresAt === null || Date.now() <= entry.expiresAt)) {
        validKeys.push(key);
      }
    }

    return validKeys;
  }

  /**
   * Paged keys — iterates the in-memory Map with offset/limit slicing.
   * Cheap (already O(n)); implemented so the router can return
   * `hasMore`/`total` natively without an extra pass.
   */
  async listKeys(options: KeysPageOptions = {}): Promise<KeysPage> {
    const all = await this.keys(options.prefix);
    const start = Math.max(0, options.offset ?? 0);
    const end = options.limit !== undefined ? start + options.limit : all.length;
    return {
      keys: all.slice(start, end),
      hasMore: end < all.length,
      total: all.length,
    };
  }
  
  /**
   * Clear all data (for testing)
   * 
   * @param prefix - Optional prefix to clear only specific namespace
   */
  async clear(prefix?: string): Promise<void> {
    // Provider.clear() is optional on the SearchProvider interface and may be
    // async (zvec). Prefer clear() when available; fall back to per-key
    // remove() so custom providers that only implement the required surface
    // are still wiped consistently.
    const provider = this.searchProvider as SearchProvider & {
      clear?: () => void | Promise<void>;
    };
    if (!prefix) {
      const keysBefore = Array.from(this.store.keys());
      this.store.clear();
      if (typeof provider.clear === 'function') {
        try { await provider.clear(); } catch { /* best-effort */ }
      } else {
        for (const key of keysBefore) {
          try { await provider.remove(key); } catch { /* best-effort */ }
        }
      }
      return;
    }

    // Clear only keys with prefix
    const keysToDelete = await this.keys(prefix);
    for (const key of keysToDelete) {
      this.store.delete(key);
      try { await provider.remove(key); } catch { /* best-effort */ }
    }
  }
  
  // ============================================================================
  // Utility Methods
  // ============================================================================
  
  /**
   * Get current storage size (for testing/debugging)
   * 
   * @returns Number of stored items
   */
  size(): number {
    return this.store.size;
  }
  
  /**
   * Manually clean up expired entries (for testing/maintenance)
   * 
   * @returns Number of entries removed
   */
  cleanupExpired(): number {
    let removed = 0;
    const now = Date.now();
    
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    
    return removed;
  }
  
  // ============================================================================
  // High-Level Operations
  // ============================================================================
  
  /**
   * Upsert objects by key field
   * 
   * @param data - Single object or array of objects
   * @param options - Upsert options
   * @returns Result with count and keys
   */
  async upsert(
    data: any | any[],
    options?: {
      idField?: string;
      keyGenerator?: (obj: any) => string;
      ttl?: number;
    }
  ): Promise<{ count: number; keys: string[] }> {
    const idField = options?.idField || 'id';
    const keyGenerator = options?.keyGenerator;
    const items = Array.isArray(data) ? data : [data];
    
    const keys: string[] = [];
    
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`upsert() requires object(s), got ${typeof item}`);
      }
      
      let key: string;
      if (keyGenerator) {
        key = keyGenerator(item);
      } else {
        const id = item[idField];
        if (id === undefined || id === null) {
          throw new Error(`Missing required field '${idField}' in object`);
        }
        key = String(id);
      }
      
      await this.set(key, item, options?.ttl);
      keys.push(key);
    }
    
    return { count: items.length, keys };
  }
  
  /**
   * Insert objects with auto-ID detection
   * 
   * @param data - Single object or array of objects
   * @param options - Insert options
   * @returns Result with count, keys, and detected idField
   */
  async insert(
    data: any | any[],
    options?: {
      idField?: string;
      keyGenerator?: (obj: any) => string;
      autoDetect?: boolean;
    }
  ): Promise<{ count: number; keys: string[]; idField?: string }> {
    const items = Array.isArray(data) ? data : [data];
    
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`insert() requires object(s), got ${typeof item}`);
      }
    }
    
    let idField = options?.idField;
    
    if (!idField && !options?.keyGenerator && options?.autoDetect !== false) {
      idField = this.autoDetectIdField(items) ?? undefined;
      if (!idField) {
        throw new Error(
          'Could not auto-detect ID field. Specify idField or keyGenerator.'
        );
      }
    }
    
    const result = await this.upsert(data, {
      idField,
      keyGenerator: options?.keyGenerator
    });
    
    return { ...result, idField };
  }
  
  /**
   * Merge arrays with deduplication
   * 
   * @param key - Storage key for the array
   * @param newItems - New items to merge
   * @param options - Merge options
   * @returns Result with total items, added, and skipped counts
   */
  async merge(
    key: string,
    newItems: any[],
    options?: {
      strategy?: 'id' | 'hash' | 'fields';
      idField?: string;
      hashFields?: string[];
      compareFields?: string[];
    }
  ): Promise<{ totalItems: number; added: number; skipped: number }> {
    if (!Array.isArray(newItems)) {
      throw new Error(`merge() requires an array, got ${typeof newItems}`);
    }
    
    // Get existing array
    const existing = await this.get(key);
    const existingItems = Array.isArray(existing) ? existing : [];
    
    const strategy = options?.strategy || 'id';
    const idField = options?.idField || 'id';
    
    // Build deduplication index
    const existingIndex = new Set<string>();
    
    if (strategy === 'id') {
      for (const item of existingItems) {
        if (typeof item === 'object' && item !== null) {
          const id = item[idField];
          if (id !== undefined && id !== null) {
            existingIndex.add(String(id));
          }
        }
      }
    } else if (strategy === 'hash') {
      for (const item of existingItems) {
        const hash = await this.generateContentHash(item, options?.hashFields);
        existingIndex.add(hash);
      }
    } else if (strategy === 'fields' && options?.compareFields) {
      // Field comparison - will do linear search
    }
    
    // Merge new items
    let added = 0;
    let skipped = 0;
    const itemsToAdd: any[] = [];
    
    for (const newItem of newItems) {
      let isDuplicate = false;
      
      if (strategy === 'id' && typeof newItem === 'object' && newItem !== null) {
        const id = newItem[idField];
        if (id !== undefined && id !== null) {
          isDuplicate = existingIndex.has(String(id));
        }
      } else if (strategy === 'hash') {
        const hash = await this.generateContentHash(newItem, options?.hashFields);
        isDuplicate = existingIndex.has(hash);
        if (!isDuplicate) {
          existingIndex.add(hash);
        }
      } else if (strategy === 'fields' && options?.compareFields) {
        isDuplicate = existingItems.some(existing =>
          this.objectsMatch(existing, newItem, options.compareFields!)
        );
      }
      
      if (isDuplicate) {
        skipped++;
      } else {
        itemsToAdd.push(newItem);
        added++;
        
        if (strategy === 'id' && typeof newItem === 'object' && newItem !== null) {
          const id = newItem[idField];
          if (id !== undefined && id !== null) {
            existingIndex.add(String(id));
          }
        }
      }
    }
    
    // Store merged array
    const mergedArray = [...existingItems, ...itemsToAdd];
    await this.set(key, mergedArray);
    
    return {
      totalItems: mergedArray.length,
      added,
      skipped
    };
  }
  
  /**
   * Query items with filtering
   * 
   * Basic in-memory filtering (not as powerful as Notion/Airtable)
   *
   * @param prefix - Key prefix to search
   * @param filter - Filter function or MongoDB-style filter object
   * @returns Filtered items
   */
  async query(params: {
    prefix?: string;
    filter?: ((item: any) => boolean) | Record<string, any>;
    limit?: number;
  }): Promise<{ data: any[]; totalCount: number }> {
    const keys = await this.keys(params.prefix);
    const results: any[] = [];

    // Convert MongoDB-style filter object to function if needed
    let filterFn: ((item: any) => boolean) | undefined;
    if (params.filter) {
      if (typeof params.filter === 'function') {
        filterFn = params.filter as (item: any) => boolean;
      } else {
        // Import matchesFilter for MongoDB-style filter objects
        const { matchesFilter } = await import('../utils/query-engine.ts');
        const filterObj = params.filter;
        filterFn = (item: any) => matchesFilter(item, filterObj);
      }
    }

    for (const key of keys) {
      const value = await this.get(key);

      if (value !== null) {
        if (!filterFn || filterFn(value)) {
          results.push(value);

          if (params.limit && results.length >= params.limit) {
            break;
          }
        }
      }
    }

    return { data: results, totalCount: results.length };
  }

  /**
   * List all items with optional pagination
   * 
   * @param options - List options
   * @returns Array of items
   */
  async list(options?: {
    prefix?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const keys = await this.keys(options?.prefix);
    const startIdx = options?.offset || 0;
    const endIdx = options?.limit ? startIdx + options.limit : keys.length;
    const keysSlice = keys.slice(startIdx, endIdx);
    
    const items: any[] = [];
    for (const key of keysSlice) {
      const value = await this.get(key);
      if (value !== null) {
        items.push(value);
      }
    }
    
    return items;
  }
  
  // ============================================================================
  // Private Helpers
  // ============================================================================
  
  private autoDetectIdField(items: any[]): string | null {
    if (items.length === 0) return null;
    
    const commonIdFields = [
      'id', '_id', 'pmid', 'doi', 'uuid', 'key', 'uid', 'recordId',
      'userId', 'email', 'objectId', 'entityId'
    ];
    
    for (const field of commonIdFields) {
      if (items[0][field] !== undefined) {
        const sampleSize = Math.min(5, items.length);
        const values = new Set();
        let isUnique = true;
        
        for (let i = 0; i < sampleSize; i++) {
          const value = items[i][field];
          if (value === undefined || value === null) {
            isUnique = false;
            break;
          }
          if (values.has(value)) {
            isUnique = false;
            break;
          }
          values.add(value);
        }
        
        if (isUnique) {
          return field;
        }
      }
    }
    
    return null;
  }
  
  private async generateContentHash(obj: any, fields?: string[]): Promise<string> {
    let content: any;
    
    if (fields && fields.length > 0) {
      content = {};
      for (const field of fields) {
        if (obj[field] !== undefined) {
          content[field] = obj[field];
        }
      }
    } else {
      content = obj;
    }
    
    const jsonStr = JSON.stringify(content, Object.keys(content).sort());
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex.substring(0, 16);
  }
  
  private objectsMatch(obj1: any, obj2: any, fields: string[]): boolean {
    for (const field of fields) {
      if (obj1[field] !== obj2[field]) {
        return false;
      }
    }
    return true;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new Memory adapter instance
 *
 * @param config - Optional config; pass { searchProvider } to plug in a
 *                 custom SearchProvider (e.g. vector or hybrid) instead of
 *                 the default BM25.
 * @returns MemoryAdapter
 */
export function createMemoryAdapter(config: MemoryAdapterConfig = {}): MemoryAdapter {
  return new MemoryAdapter(config);
}

