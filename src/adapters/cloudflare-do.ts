/**
 * Cloudflare Durable Objects Storage Adapter
 * 
 * Strongly consistent storage via Cloudflare Durable Objects.
 * - Strong consistency (per-instance)
 * - Unlimited storage (per-instance)
 * - Persistent
 * - Isolated coordination primitives
 * - Medium cost (more expensive than KV/D1)
 * 
 * Dual Mode:
 * - HTTP Mode: External access via Cloudflare Workers HTTP API
 * - Native Mode: Direct binding access (inside Workers)
 * 
 * Use cases:
 * - Distributed coordination
 * - Strong consistency requirements
 * - Per-instance stateful storage
 * - Real-time collaboration
 */

// Minimal type stubs for Cloudflare Workers bindings (only used in native mode inside Workers)
// deno-lint-ignore no-empty-interface
interface DurableObjectNamespace { [key: string]: any; }
// deno-lint-ignore no-empty-interface
interface DurableObjectStub { [key: string]: any; }

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Cloudflare DO Config
// ============================================================================

export interface CloudflareDOConfig {
  /**
   * HTTP Mode: Base URL of smallstore-workers service
   * Example: "https://your-workers.your-subdomain.workers.dev"
   */
  baseUrl?: string;

  /**
   * Native Mode: Direct DO binding (inside Workers)
   * Example: env.SM_DO
   */
  binding?: DurableObjectNamespace;
  
  /** DO namespace (default: 'storage') */
  namespace?: string;
  
  /** DO instance ID */
  instanceId: string;
  
  /** HTTP Mode: Optional API key for authentication */
  apiKey?: string;
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// Cloudflare DO Adapter
// ============================================================================

/**
 * Cloudflare Durable Objects storage adapter
 * 
 * Uses either HTTP API or native DO binding for storage.
 */
export class CloudflareDOAdapter implements StorageAdapter {
  private baseUrl?: string;
  private binding?: DurableObjectNamespace;
  private namespace: string;
  private instanceId: string;
  private apiKey?: string;
  private mode: 'http' | 'native';
  private stub?: DurableObjectStub;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'cloudflare-do',
    supportedTypes: [
      'kv',           // Primitives
      'object',       // Objects/arrays
    ],
    maxItemSize: undefined, // Unlimited per-instance
    cost: {
      perGB: '$1.00/million requests',
      perOperation: '$0.15 per GB-second of duration',
      tier: 'moderate',
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'low',
      throughput: 'high',
    },
    features: {
      ttl: false,
      transactions: true,  // Strong consistency
    },
  };
  
  constructor(config: CloudflareDOConfig) {
    if (!config.instanceId) {
      throw new Error('CloudflareDOAdapter requires instanceId');
    }
    
    // Determine mode
    if (config.binding) {
      this.mode = 'native';
      this.binding = config.binding;
      
      // Get DO stub
      const doId = config.binding.idFromName(config.instanceId);
      this.stub = config.binding.get(doId);
    } else if (config.baseUrl) {
      this.mode = 'http';
      this.baseUrl = config.baseUrl;
      this.apiKey = config.apiKey;
    } else {
      throw new Error(
        'CloudflareDOAdapter requires either baseUrl (HTTP mode) or binding (native mode)'
      );
    }
    
    this.namespace = config.namespace || 'storage';
    this.instanceId = config.instanceId;
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
    
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });
    
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
      if (this.mode === 'native' && this.stub) {
        // Native mode
        const doUrl = new URL('https://fake-host');
        doUrl.searchParams.set('cmd', 'get');
        doUrl.searchParams.set('key', key);
        
        const response = await this.stub.fetch(doUrl.toString());
        const result = await response.json() as ApiResponse<{ key: string; value: any }>;
        
        if (!result.success) {
          return null;
        }
        
        return result.data?.value ?? null;
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('cmd', 'get');
        params.set('key', key);
        
        const response = await this.httpRequest<{ key: string; value: any }>(
          `/do/${this.namespace}/${this.instanceId}?${params.toString()}`
        );
        
        if (!response.success) {
          return null;
        }
        
        return response.data?.value ?? null;
      }
    } catch (error) {
      console.error(`[CloudflareDOAdapter] Error getting ${key}:`, error);
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
    if (this.mode === 'native' && this.stub) {
      // Native mode
      const doUrl = new URL('https://fake-host');
      doUrl.searchParams.set('cmd', 'set');
      
      await this.stub.fetch(doUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
    } else {
      // HTTP mode
      await this.httpRequest(`/do/${this.namespace}/${this.instanceId}`, {
        method: 'POST',
        body: JSON.stringify({
          command: 'set',
          params: { key, value },
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
      if (this.mode === 'native' && this.stub) {
        // Native mode
        const doUrl = new URL('https://fake-host');
        doUrl.searchParams.set('cmd', 'delete');
        doUrl.searchParams.set('key', key);
        
        await this.stub.fetch(doUrl.toString());
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('key', key);
        
        await this.httpRequest(
          `/do/${this.namespace}/${this.instanceId}?${params.toString()}`,
          { method: 'DELETE' }
        );
      }
    } catch (error) {
      console.error(`[CloudflareDOAdapter] Error removing ${key}:`, error);
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
      if (this.mode === 'native' && this.stub) {
        // Native mode
        const doUrl = new URL('https://fake-host');
        doUrl.searchParams.set('cmd', 'list');
        if (prefix) doUrl.searchParams.set('prefix', prefix);
        
        const response = await this.stub.fetch(doUrl.toString());
        const result = await response.json() as ApiResponse<{ keys: string[] }>;
        
        return result.data?.keys || [];
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('cmd', 'list');
        if (prefix) params.set('prefix', prefix);
        
        const response = await this.httpRequest<{ keys: string[] }>(
          `/do/${this.namespace}/${this.instanceId}?${params.toString()}`
        );
        
        return response.data?.keys || [];
      }
    } catch (error) {
      console.error('[CloudflareDOAdapter] Error getting keys:', error);
      return [];
    }
  }
  
  /**
   * Clear all data (for testing)
   * 
   * @param prefix - Optional prefix to clear only specific namespace
   */
  async clear(prefix?: string): Promise<void> {
    if (prefix) {
      // Delete by prefix
      const keys = await this.keys(prefix);
      await Promise.all(keys.map(key => this.delete(key)));
    } else {
      // Clear all
      if (this.mode === 'native' && this.stub) {
        const doUrl = new URL('https://fake-host');
        doUrl.searchParams.set('cmd', 'clear');
        await this.stub.fetch(doUrl.toString(), { method: 'POST' });
      } else {
        await this.httpRequest(`/do/${this.namespace}/${this.instanceId}`, {
          method: 'POST',
          body: JSON.stringify({
            command: 'clear',
          }),
        });
      }
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
 * Create a new Cloudflare DO adapter instance
 * 
 * @param config - Cloudflare DO configuration
 * @returns CloudflareDOAdapter
 * 
 * @example HTTP Mode
 * const adapter = createCloudflareDOAdapter({
 *   baseUrl: "https://your-workers.your-subdomain.workers.dev",
 *   instanceId: "user-123"
 * });
 *
 * @example Native Mode (inside Workers)
 * const adapter = createCloudflareDOAdapter({
 *   binding: env.SM_DO,
 *   instanceId: "user-123"
 * });
 */
export function createCloudflareDOAdapter(config: CloudflareDOConfig): CloudflareDOAdapter {
  return new CloudflareDOAdapter(config);
}

