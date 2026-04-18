/**
 * Cloudflare KV Storage Adapter
 * 
 * Redis-style key-value storage via Cloudflare KV.
 * - Fast (edge-distributed)
 * - Cheap (generous free tier)
 * - Persistent (survives restarts)
 * - Limited size (25MB per value with Workers, 1MB recommended)
 * - Eventually consistent
 * - Supports TTL natively
 * 
 * Dual Mode:
 * - HTTP Mode: External access via Cloudflare Workers HTTP API
 * - Native Mode: Direct binding access (inside Workers)
 * 
 * Use cases:
 * - API caching
 * - Small persistent data (<1MB)
 * - Session storage
 * - Pipeline memory (key-based)
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities, KeysPageOptions, KeysPage } from '../types.ts';
import type { RetryOptions } from '../utils/retry.ts';
import { retryFetch, type RetryFetchOptions } from '../utils/retry-fetch.ts';
import { debug } from '../utils/debug.ts';

// Type declaration for Cloudflare Workers KV (when not in Workers environment)
interface KVNamespace {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

// ============================================================================
// Cloudflare KV Config
// ============================================================================

export interface CloudflareKVConfig {
  /**
   * HTTP Mode: Base URL of smallstore-workers service
   * Example: "https://your-workers.your-subdomain.workers.dev"
   */
  baseUrl?: string;

  /**
   * Native Mode: Direct KV binding (inside Workers)
   * Example: env.SM_KV
   */
  binding?: KVNamespace;
  
  /** Optional namespace for all keys */
  namespace?: string;
  
  /** HTTP Mode: Optional API key for authentication */
  apiKey?: string;

  /** HTTP Mode: Retry options for transient failures (false to disable) */
  retry?: RetryOptions | false;
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// Cloudflare KV Adapter
// ============================================================================

/**
 * Cloudflare KV storage adapter
 * 
 * Uses either HTTP API or native KV binding for storage.
 */
export class CloudflareKVAdapter implements StorageAdapter {
  private baseUrl?: string;
  private binding?: KVNamespace;
  private namespace: string;
  private apiKey?: string;
  private mode: 'http' | 'native';
  private retryOpts?: RetryFetchOptions;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'cloudflare-kv',
    supportedTypes: [
      'kv',           // Primitives (ideal for KV)
      'object',       // Small-medium objects/arrays (<1MB)
    ],
    maxItemSize: 1 * 1024 * 1024, // 1MB recommended (25MB max with Workers)
    cost: {
      perGB: '$0.50/GB',
      perOperation: 'Free tier: 100k reads/day, 1k writes/day',
      tier: 'cheap',
    },
    performance: {
      readLatency: 'low',       // Edge-distributed, fast reads
      writeLatency: 'medium',   // Eventually consistent
      throughput: 'high',
    },
    features: {
      ttl: true,               // Native KV TTL
      transactions: false,
    },
  };
  
  constructor(config: CloudflareKVConfig = {}) {
    // Determine mode
    if (config.binding) {
      this.mode = 'native';
      this.binding = config.binding;
    } else if (config.baseUrl) {
      this.mode = 'http';
      this.baseUrl = config.baseUrl;
      this.apiKey = config.apiKey;
    } else {
      throw new Error(
        'CloudflareKVAdapter requires either baseUrl (HTTP mode) or binding (native mode)'
      );
    }
    
    this.namespace = config.namespace || '';
    this.retryOpts = config.retry === false ? { enabled: false } : config.retry ? { ...config.retry } : undefined;
  }
  
  // ============================================================================
  // Helper: Full Key with Namespace
  // ============================================================================
  
  private getFullKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }
  
  // ============================================================================
  // HTTP Mode Helpers
  // ============================================================================
  
  private async httpRequest<T = any>(
    path: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    if (!this.baseUrl) {
      throw new Error('HTTP mode requires baseUrl');
    }
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    const response = await retryFetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    }, this.retryOpts);

    const data = await response.json();
    if (!data || typeof data !== 'object') {
      throw new Error('Unexpected API response format from Cloudflare');
    }
    return data as ApiResponse<T>;
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  /**
   * Get value by key
   * 
   * @param key - Storage key
   * @returns Value, or null if not found
   */
  async get(key: string): Promise<any> {
    const fullKey = this.getFullKey(key);
    
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        const result = await this.binding.get(fullKey, 'json');
        return result;
      } else {
        // HTTP mode
        const scope = this.namespace || undefined;
        const params = new URLSearchParams();
        params.set('key', key);
        if (scope) params.set('scope', scope);
        
        const response = await this.httpRequest<{ key: string; value: any }>(
          `/kv?${params.toString()}`
        );
        
        if (!response.success) {
          return null;
        }
        
        return response.data?.value ?? null;
      }
    } catch (error) {
      console.error(`[CloudflareKVAdapter] Error getting ${key}:`, error);
      return null;
    }
  }
  
  /**
   * Set value by key
   * 
   * @param key - Storage key
   * @param value - Value to store
   * @param ttl - Optional TTL in seconds (KV native TTL)
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const fullKey = this.getFullKey(key);
    
    // Serialize value to JSON string if needed
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    
    if (this.mode === 'native' && this.binding) {
      // Native mode
      const options: any = {};
      if (ttl) {
        options.expirationTtl = ttl;
      }
      await this.binding.put(fullKey, serialized, options);
    } else {
      // HTTP mode
      await this.httpRequest('/kv', {
        method: 'POST',
        body: JSON.stringify({
          key,
          value,
          scope: this.namespace || undefined,
          ttl,
        }),
      });
    }
  }
  
  /**
   * Delete value by key
   * 
   * @param key - Storage key
   */
  async delete(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        await this.binding.delete(fullKey);
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('key', key);
        if (this.namespace) params.set('scope', this.namespace);
        
        await this.httpRequest(`/kv?${params.toString()}`, {
          method: 'DELETE',
        });
      }
    } catch (error) {
      console.error(`[CloudflareKVAdapter] Error removing ${key}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if key exists
   * 
   * @param key - Storage key
   * @returns true if exists
   */
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }
  
  /**
   * List keys with optional prefix
   * 
   * @param prefix - Optional prefix filter
   * @returns Array of keys
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        let listPrefix = '';
        if (this.namespace && prefix) {
          listPrefix = `${this.namespace}:${prefix}`;
        } else if (this.namespace) {
          listPrefix = `${this.namespace}:`;
        } else if (prefix) {
          listPrefix = prefix;
        }
        
        const options: any = {};
        if (listPrefix) {
          options.prefix = listPrefix;
        }
        
        const result = await this.binding.list(options);
        
        // Remove namespace prefix if present
        if (this.namespace) {
          const nsPrefix = `${this.namespace}:`;
          return result.keys.map((item: any) =>
            item.name.startsWith(nsPrefix) ? item.name.slice(nsPrefix.length) : item.name
          );
        }
        
        return result.keys.map((item: any) => item.name);
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        if (this.namespace) params.set('scope', this.namespace);
        if (prefix) params.set('prefix', prefix);
        
        const response = await this.httpRequest<{ keys: Array<{ name: string }> }>(
          `/kv/list?${params.toString()}`
        );
        
        if (!response.success || !response.data?.keys) {
          return [];
        }
        
        // Strip namespace prefix the same way native mode does
        if (this.namespace) {
          const nsPrefix = `${this.namespace}:`;
          return response.data.keys.map(item =>
            item.name.startsWith(nsPrefix) ? item.name.slice(nsPrefix.length) : item.name
          );
        }

        return response.data.keys.map(item => item.name);
      }
    } catch (error) {
      console.error('[CloudflareKVAdapter] Error getting keys:', error);
      return [];
    }
  }

  /**
   * Paged keys — uses CF KV's native `list({ limit, cursor, prefix })`.
   * `cursor` round-trips CF's token; `offset` (numeric) is honored
   * best-effort by walking forward (O(offset) calls) — prefer cursor.
   */
  async listKeys(options: KeysPageOptions = {}): Promise<KeysPage> {
    const { prefix } = options;
    let listPrefix = '';
    if (this.namespace && prefix) listPrefix = `${this.namespace}:${prefix}`;
    else if (this.namespace) listPrefix = `${this.namespace}:`;
    else if (prefix) listPrefix = prefix;

    const nsPrefix = this.namespace ? `${this.namespace}:` : '';
    const stripNs = (name: string) =>
      nsPrefix && name.startsWith(nsPrefix) ? name.slice(nsPrefix.length) : name;

    const out: string[] = [];
    let cursor = options.cursor;
    const targetOffset = options.offset ?? 0;
    let skipped = 0;

    try {
      while (options.limit === undefined || out.length < options.limit) {
        let names: string[] = [];
        let nextCursor: string | undefined;
        let listComplete = false;

        if (this.mode === 'native' && this.binding) {
          const listOpts: any = {};
          if (listPrefix) listOpts.prefix = listPrefix;
          if (options.limit !== undefined) listOpts.limit = Math.min(1000, options.limit);
          if (cursor) listOpts.cursor = cursor;
          // CF's native binding returns { keys, list_complete, cursor } but
          // the .d.ts shim is minimal — cast to access the full shape.
          const result = await this.binding.list(listOpts) as {
            keys: Array<{ name: string }>;
            list_complete?: boolean;
            cursor?: string;
          };
          names = result.keys.map((k) => k.name);
          nextCursor = result.list_complete ? undefined : result.cursor;
          listComplete = result.list_complete === true;
        } else {
          const params = new URLSearchParams();
          if (this.namespace) params.set('scope', this.namespace);
          if (prefix) params.set('prefix', prefix);
          if (options.limit !== undefined) params.set('limit', String(Math.min(1000, options.limit)));
          if (cursor) params.set('cursor', cursor);
          const response = await this.httpRequest<{ keys: Array<{ name: string }>; cursor?: string; list_complete?: boolean }>(
            `/kv/list?${params.toString()}`,
          );
          if (!response.success || !response.data?.keys) break;
          names = response.data.keys.map(k => k.name);
          nextCursor = response.data.cursor;
          listComplete = response.data.list_complete === true || !nextCursor;
        }

        for (const raw of names) {
          const key = stripNs(raw);
          if (skipped < targetOffset && !options.cursor) {
            skipped++;
            continue;
          }
          out.push(key);
          if (options.limit !== undefined && out.length >= options.limit) break;
        }

        cursor = nextCursor;
        if (listComplete || !cursor) break;
      }

      return {
        keys: out,
        hasMore: !!cursor,
        ...(cursor ? { cursor } : {}),
      };
    } catch (error) {
      console.error('[CloudflareKVAdapter] Error in listKeys:', error);
      return { keys: [], hasMore: false };
    }
  }

  /**
   * Clear all data (for testing)
   *
   * @param prefix - Optional prefix to clear only specific namespace
   */
  async clear(prefix?: string): Promise<void> {
    const keys = await this.keys(prefix);
    
    if (keys.length === 0) return;
    
    // Delete in batches of 100
    const batchSize = 100;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      await Promise.all(batch.map((key) => this.delete(key)));
    }
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
      ttl?: number;
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
      keyGenerator: options?.keyGenerator,
      ttl: options?.ttl
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
   * Basic in-memory filtering
   * 
   * @param prefix - Key prefix to search
   * @param filter - Filter function
   * @returns Filtered items
   */
  async query(params: {
    prefix?: string;
    filter?: (item: any) => boolean;
    limit?: number;
  }): Promise<{ data: any[]; totalCount: number }> {
    const keys = await this.keys(params.prefix);
    const results: any[] = [];

    for (const key of keys) {
      const value = await this.get(key);

      if (value !== null) {
        if (!params.filter || params.filter(value)) {
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
 * Create a new Cloudflare KV adapter instance
 * 
 * @param config - Cloudflare KV configuration
 * @returns CloudflareKVAdapter
 * 
 * @example HTTP Mode
 * const adapter = createCloudflareKVAdapter({
 *   baseUrl: "https://your-workers.your-subdomain.workers.dev",
 *   namespace: "my-app"
 * });
 *
 * @example Native Mode (inside Workers)
 * const adapter = createCloudflareKVAdapter({
 *   binding: env.SM_KV,
 *   namespace: "my-app"
 * });
 */
export function createCloudflareKVAdapter(config: CloudflareKVConfig): CloudflareKVAdapter {
  return new CloudflareKVAdapter(config);
}

