/**
 * Cloudflare D1 Storage Adapter
 * 
 * SQLite database storage via Cloudflare D1.
 * - Cheap (generous free tier)
 * - Persistent
 * - KV-style tables
 * - Dynamic table creation (table-per-collection)
 * - 1MB per row limit
 * 
 * Dual Mode:
 * - HTTP Mode: External access via Cloudflare Workers HTTP API
 * - Native Mode: Direct binding access (inside Workers)
 * 
 * Use cases:
 * - Structured data storage
 * - Collections with multiple tables
 * - KV storage with SQL queries
 * - Small-medium objects (<1MB)
 */

// Minimal type stubs for Cloudflare Workers bindings (only used in native mode inside Workers)
// deno-lint-ignore no-empty-interface
interface D1Database { [key: string]: any; }

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import type { RetryOptions } from '../utils/retry.ts';
import { retryFetch, type RetryFetchOptions } from '../utils/retry-fetch.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Cloudflare D1 Config
// ============================================================================

export interface CloudflareD1Config {
  /**
   * HTTP Mode: Base URL of smallstore-workers service
   * Example: "https://your-workers.your-subdomain.workers.dev"
   */
  baseUrl?: string;

  /**
   * Native Mode: Direct D1 binding (inside Workers)
   * Example: env.SM_D1
   */
  binding?: D1Database;
  
  /** Optional table name (defaults to 'kv_store') */
  table?: string;
  
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

// Default table name
const DEFAULT_TABLE = 'kv_store';

// ============================================================================
// Cloudflare D1 Adapter
// ============================================================================

/**
 * Cloudflare D1 storage adapter
 * 
 * Uses either HTTP API or native D1 binding for storage.
 */
export class CloudflareD1Adapter implements StorageAdapter {
  private baseUrl?: string;
  private binding?: D1Database;
  private table: string;
  private apiKey?: string;
  private mode: 'http' | 'native';
  private retryOpts?: RetryFetchOptions;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'cloudflare-d1',
    supportedTypes: [
      'kv',           // Primitives
      'object',       // Objects/arrays (<1MB)
    ],
    maxItemSize: 1 * 1024 * 1024, // 1MB per row
    cost: {
      perGB: '$0.75/GB',
      perOperation: 'Free tier: 5M reads/day, 100k writes/day',
      tier: 'cheap',
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'medium',
      throughput: 'medium',
    },
    features: {
      ttl: false,
      transactions: true,  // SQLite transactions
    },
  };
  
  constructor(config: CloudflareD1Config = {}) {
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
        'CloudflareD1Adapter requires either baseUrl (HTTP mode) or binding (native mode)'
      );
    }
    
    this.table = config.table || DEFAULT_TABLE;
    this.retryOpts = config.retry === false ? { enabled: false } : config.retry ? { ...config.retry } : undefined;
  }
  
  // ============================================================================
  // Helper: Sanitize table name
  // ============================================================================
  
  private sanitizeTableName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  
  // ============================================================================
  // Helper: Ensure table exists
  // ============================================================================
  
  private async ensureTable(): Promise<void> {
    if (this.mode === 'native' && this.binding) {
      // D1 `binding.exec()` splits on newlines and requires each line to be a
      // complete statement. Use prepare()/run() for multi-statement DDL, OR
      // collapse to a single line. Single-line is simpler and works with both
      // exec and prepare. (Bug fixed 2026-04-23: previous multi-line template
      // tripped `Error in line 1: CREATE TABLE ... incomplete input`.)
      const sql = `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, created_at INTEGER DEFAULT (strftime('%s', 'now')), updated_at INTEGER DEFAULT (strftime('%s', 'now')))`;
      await this.binding.prepare(sql).run();
    } else {
      // HTTP mode - table creation is handled by the API
      await this.httpRequest('/d1/table/create', {
        method: 'POST',
        body: JSON.stringify({ table: this.table }),
      });
    }
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
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        await this.ensureTable();
        
        const sql = `SELECT value FROM ${this.table} WHERE key = ?`;
        const result = await this.binding.prepare(sql).bind(key).first();
        
        if (!result) {
          return null;
        }
        
        // Parse value
        try {
          return JSON.parse(result.value as string);
        } catch {
          return result.value;
        }
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('key', key);
        params.set('table', this.table);
        
        const response = await this.httpRequest<{ key: string; value: any }>(
          `/d1/kv?${params.toString()}`
        );
        
        if (!response.success) {
          return null;
        }
        
        return response.data?.value ?? null;
      }
    } catch (error) {
      console.error(`[CloudflareD1Adapter] Error getting ${key}:`, error);
      return null;
    }
  }
  
  /**
   * Set value by key
   * 
   * @param key - Storage key
   * @param value - Value to store
   */
  async set(key: string, value: any): Promise<void> {
    // Serialize value to JSON string
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    
    if (this.mode === 'native' && this.binding) {
      // Native mode
      await this.ensureTable();
      
      const sql = `
        INSERT INTO ${this.table} (key, value, updated_at)
        VALUES (?, ?, strftime('%s', 'now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `;
      
      await this.binding.prepare(sql).bind(key, serialized).run();
    } else {
      // HTTP mode
      await this.httpRequest('/d1/kv', {
        method: 'POST',
        body: JSON.stringify({
          key,
          value,
          table: this.table,
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
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        await this.ensureTable();
        
        const sql = `DELETE FROM ${this.table} WHERE key = ?`;
        await this.binding.prepare(sql).bind(key).run();
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('key', key);
        params.set('table', this.table);
        
        await this.httpRequest(`/d1/kv?${params.toString()}`, {
          method: 'DELETE',
        });
      }
    } catch (error) {
      console.error(`[CloudflareD1Adapter] Error removing ${key}:`, error);
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
        await this.ensureTable();
        
        let sql = `SELECT key FROM ${this.table}`;
        const bindings: any[] = [];
        
        if (prefix) {
          sql += ` WHERE key LIKE ?`;
          bindings.push(`${prefix}%`);
        }
        
        sql += ` ORDER BY key ASC`;
        
        const result = await this.binding.prepare(sql).bind(...bindings).all();
        
        return result.results.map((row: any) => row.key);
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('table', this.table);
        if (prefix) params.set('prefix', prefix);
        
        const response = await this.httpRequest<{ keys: Array<{ key: string }> }>(
          `/d1/list?${params.toString()}`
        );
        
        if (!response.success || !response.data?.keys) {
          return [];
        }
        
        return response.data.keys.map(item => item.key);
      }
    } catch (error) {
      console.error('[CloudflareD1Adapter] Error getting keys:', error);
      return [];
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
      
      await this.set(key, item);
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
      keyGenerator: options?.keyGenerator,
    });
    
    return { ...result, idField };
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
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new Cloudflare D1 adapter instance
 * 
 * @param config - Cloudflare D1 configuration
 * @returns CloudflareD1Adapter
 * 
 * @example HTTP Mode
 * const adapter = createCloudflareD1Adapter({
 *   baseUrl: "https://your-workers.your-subdomain.workers.dev",
 *   table: "my_collection"
 * });
 *
 * @example Native Mode (inside Workers)
 * const adapter = createCloudflareD1Adapter({
 *   binding: env.SM_D1,
 *   table: "my_collection"
 * });
 */
export function createCloudflareD1Adapter(config: CloudflareD1Config): CloudflareD1Adapter {
  return new CloudflareD1Adapter(config);
}

