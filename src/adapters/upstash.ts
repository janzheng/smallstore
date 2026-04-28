/**
 * Upstash Storage Adapter
 * 
 * Redis-based persistent storage via Upstash REST API.
 * - Fast (Redis backend)
 * - Cheap (serverless pricing)
 * - Persistent (survives restarts)
 * - Limited size (1MB per item, suitable for KV, small JSON/arrays)
 * - Supports TTL natively
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
import { type RetryFetchOptions, retryFetch } from '../utils/retry-fetch.ts';
import { resolveUpstashEnv } from '../../config.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Upstash Config
// ============================================================================

export interface UpstashConfig {
  /** 
   * Upstash REST URL (e.g., https://your-redis.upstash.io)
   * Falls back to UPSTASH_REDIS_REST_URL env var if not provided
   */
  url?: string;
  
  /** 
   * Upstash REST token
   * Falls back to UPSTASH_REDIS_REST_TOKEN env var if not provided
   */
  token?: string;
  
  /** Optional namespace for all keys */
  namespace?: string;

  /** Retry options for transient failures. Set to false to disable. */
  retry?: RetryOptions | false;
}

// ============================================================================
// Upstash Adapter
// ============================================================================

/**
 * Upstash storage adapter
 * 
 * Uses Upstash Redis REST API for persistent KV storage.
 */
export class UpstashAdapter implements StorageAdapter {
  private baseUrl: string;
  private token: string;
  private namespace: string;
  private retryOpts?: RetryFetchOptions;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'upstash',
    supportedTypes: [
      'object',      // Small-medium objects/arrays (<1MB)
      'kv',          // Primitives (ideal for Redis)
    ],
    // Note: NOT 'blob' - binary data should go to R2/S3
    maxItemSize: 1 * 1024 * 1024, // 1MB (Upstash limit)
    cost: {
      perGB: '$0.20/GB',
      perOperation: '$0.0001/request',
      tier: 'cheap',
    },
    performance: {
      readLatency: 'low',      // Redis is fast
      writeLatency: 'low',
      throughput: 'high',
    },
    features: {
      ttl: true,              // Native Redis TTL
      transactions: false,    // Phase 1: Not implemented
    },
  };
  
  constructor(config: UpstashConfig = {}) {
    // Config-first, env fallback via shared resolver
    this.baseUrl = config.url || resolveUpstashEnv().url || '';
    this.token = config.token || resolveUpstashEnv().token || '';
    this.namespace = config.namespace || '';
    this.retryOpts = config.retry === false ? { enabled: false } : config.retry ? { ...config.retry } : undefined;

    // Validation
    if (!this.baseUrl || !this.token) {
      throw new Error(
        'UpstashAdapter requires url and token (via constructor or env vars UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)'
      );
    }
  }
  
  // ============================================================================
  // Helper: Full Key with Namespace
  // ============================================================================
  
  private getFullKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
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
      const response = await retryFetch(
        `${this.baseUrl}/get/${encodeURIComponent(fullKey)}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
        },
        this.retryOpts,
      );
      
      if (!response.ok) {
        if (response.status === 404) return null;
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Upstash GET failed: ${response.status}: ${response.statusText} - ${errorBody}`);
      }

      const data = await response.json() as any;
      
      // Upstash returns { result: value }
      const result = data.result;
      
      if (result === null || result === undefined) {
        return null;
      }
      
      // Try to parse JSON if it's a string
      if (typeof result === 'string') {
        try {
          let parsed = JSON.parse(result);
          
          // Handle double-stringification (defensive - parse again if still a string)
          if (typeof parsed === 'string') {
            try {
              parsed = JSON.parse(parsed);
            } catch (e) {
              // Not double-stringified, return first parse
            }
          }
          
          return parsed;
        } catch (e) {
          return result; // Plain text
        }
      }
      
      return result;
    } catch (error) {
      // Network errors, auth errors, etc. should propagate — not be silently swallowed
      throw error;
    }
  }
  
  /**
   * Set value by key
   * 
   * @param key - Storage key
   * @param value - Value to store
   * @param ttl - Optional TTL in seconds (Redis native TTL)
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const fullKey = this.getFullKey(key);
    
    // Serialize value to JSON string (this is what will be stored in Redis)
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    
    // Use SETEX if TTL provided, otherwise SET  
    const command = ttl ? 'setex' : 'set';
    const url = ttl
      ? `${this.baseUrl}/${command}/${encodeURIComponent(fullKey)}/${ttl}`
      : `${this.baseUrl}/${command}/${encodeURIComponent(fullKey)}`;
    
    // Send as plain text/json string to avoid double-stringification
    // The Upstash REST API will store this string directly in Redis
    const response = await retryFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'text/plain',  // Changed from application/json
      },
      body: serialized,  // Send the string directly, not JSON.stringify(serialized)
    }, this.retryOpts);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Upstash SET failed: ${response.status}: ${response.statusText} - ${errorBody}`);
    }

    // Consume the response body to prevent resource leaks
    await response.text();
  }
  
  /**
   * Delete value by key
   * 
   * @param key - Storage key
   */
  async delete(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    
    try {
      const response = await retryFetch(
        `${this.baseUrl}/del/${encodeURIComponent(fullKey)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        },
        this.retryOpts,
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Upstash DEL failed: ${response.status}: ${response.statusText} - ${errorBody}`);
      }

      // Consume the response body to prevent resource leaks
      await response.text();
    } catch (error) {
      console.error(`[UpstashAdapter] Error removing ${key}:`, error);
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
    const fullKey = this.getFullKey(key);
    
    try {
      const response = await retryFetch(
        `${this.baseUrl}/exists/${encodeURIComponent(fullKey)}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
        },
        this.retryOpts,
      );

      if (!response.ok) {
        throw new Error(`Upstash EXISTS failed: ${response.statusText}`);
      }

      const data = await response.json() as any;
      return data.result === 1;
    } catch (error) {
      // Network errors, auth errors, etc. should propagate — not be silently swallowed
      throw error;
    }
  }
  
  /**
   * List keys with optional prefix
   * 
   * @param prefix - Optional prefix filter
   * @returns Array of keys
   */
  async keys(prefix?: string): Promise<string[]> {
    // Build pattern: namespace:prefix* or namespace:* or prefix* or *
    let pattern: string;
    if (this.namespace && prefix) {
      pattern = `${this.namespace}:${prefix}*`;
    } else if (this.namespace) {
      pattern = `${this.namespace}:*`;
    } else if (prefix) {
      pattern = `${prefix}*`;
    } else {
      pattern = '*';
    }
    
    try {
      const response = await retryFetch(
        `${this.baseUrl}/keys/${encodeURIComponent(pattern)}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
        },
        this.retryOpts,
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Upstash KEYS failed: ${response.status}: ${response.statusText} - ${errorBody}`);
      }

      const data = await response.json() as any;
      const keys = data.result || [];
      
      // Remove namespace prefix if present
      if (this.namespace) {
        const nsPrefix = `${this.namespace}:`;
        return keys.map((key: string) =>
          key.startsWith(nsPrefix) ? key.slice(nsPrefix.length) : key
        );
      }
      
      return keys;
    } catch (error) {
      // Network errors, auth errors, etc. should propagate — not be silently swallowed
      throw error;
    }
  }

  /**
   * Paged keys — uses Upstash's native SCAN cursor (non-blocking, safe on
   * large DBs). `cursor` round-trips Redis's cursor token. `offset` is
   * honored best-effort by skipping; prefer cursor when possible.
   * SCAN's `count` is a hint, not a hard limit — Redis may return fewer or
   * slightly more; we keep iterating until `limit` is reached or cursor is 0.
   *
   * **A220 — cursor + offset precedence:** `cursor` wins when both are
   * supplied. The skip-counter that implements `offset` only fires when
   * `!options.cursor`, so passing both silently ignores `offset` (resumes
   * from where the previous SCAN page left off). This matches the
   * resume-from-cursor mental model — but callers passing both should
   * pick one explicitly.
   */
  async listKeys(options: KeysPageOptions = {}): Promise<KeysPage> {
    const prefix = options.prefix;
    // Build MATCH pattern the same way keys() does, but stripped in output.
    let pattern: string;
    if (this.namespace && prefix) {
      pattern = `${this.namespace}:${prefix}*`;
    } else if (this.namespace) {
      pattern = `${this.namespace}:*`;
    } else if (prefix) {
      pattern = `${prefix}*`;
    } else {
      pattern = '*';
    }

    const out: string[] = [];
    let cursor = options.cursor ?? '0';
    const targetOffset = options.offset ?? 0;
    let skipped = 0;
    const nsPrefix = this.namespace ? `${this.namespace}:` : '';
    // Ask Redis for ~limit per round-trip, clamped to a sensible window.
    const count = Math.min(1000, Math.max(10, options.limit ?? 100));

    do {
      const url = new URL(`${this.baseUrl}/scan/${encodeURIComponent(cursor)}`);
      url.searchParams.set('match', pattern);
      url.searchParams.set('count', String(count));
      const response = await retryFetch(
        url.toString(),
        { headers: { Authorization: `Bearer ${this.token}` } },
        this.retryOpts,
      );
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Upstash SCAN failed: ${response.status}: ${response.statusText} - ${errorBody}`);
      }
      const data = await response.json() as { result: [string, string[]] };
      const [nextCursor, batch] = data.result;
      cursor = nextCursor;

      for (const raw of batch) {
        const key = nsPrefix && raw.startsWith(nsPrefix) ? raw.slice(nsPrefix.length) : raw;
        if (skipped < targetOffset && !options.cursor) {
          skipped++;
          continue;
        }
        out.push(key);
        if (options.limit !== undefined && out.length >= options.limit) break;
      }
    } while (cursor !== '0' && (options.limit === undefined || out.length < options.limit));

    return {
      keys: out,
      hasMore: cursor !== '0',
      ...(cursor !== '0' ? { cursor } : {}),
    };
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
 * Create a new Upstash adapter instance
 * 
 * @param config - Upstash configuration
 * @returns UpstashAdapter
 * 
 * @example
 * const adapter = createUpstashAdapter({
 *   url: "https://your-redis.upstash.io",
 *   token: "your-token",
 *   namespace: "smallstore"
 * });
 */
export function createUpstashAdapter(config: UpstashConfig): UpstashAdapter {
  return new UpstashAdapter(config);
}

