/**
 * Unstorage Adapter Wrapper
 * 
 * Integrates unstorage drivers as Smallstore adapters.
 * Allows any unstorage driver to work with Smallstore's interface.
 * 
 * Phase 3.1: Config Routing & Unstorage Integration
 */

import { createStorage } from 'npm:unstorage@^1.17.0';
import upstashDriver from 'npm:unstorage@^1.17.0/drivers/upstash';
import type { StorageAdapter, AdapterCapabilities } from './adapter.ts';
import { resolveUpstashEnv } from '../../config.ts';
import { debug } from '../utils/debug.ts';

/**
 * Supported unstorage drivers
 */
export type UnstorageDriver = 
  | 'upstash'          // Upstash Redis (REST API)
  | 'cloudflare-kv'    // Cloudflare KV (binding)
  | 'cloudflare-r2';   // Cloudflare R2 (binding)

/**
 * Configuration for unstorage adapter
 */
export interface UnstorageAdapterConfig {
  /** Unstorage driver to use */
  driver: UnstorageDriver;
  
  /** Driver-specific options */
  options?: Record<string, any>;
}

/**
 * Unstorage Adapter
 * 
 * Wraps unstorage drivers to implement Smallstore's StorageAdapter interface.
 */
export class UnstorageAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities;
  private _storage: any = null;  // Resolved unstorage instance
  private _storageReady: Promise<any>;  // Resolves when storage is ready

  constructor(config: UnstorageAdapterConfig) {
    // IMPORTANT: Storage init may be sync (upstash) or async (cloudflare dynamic imports).
    // Normalize to always-async via _storageReady promise.
    // All public methods MUST await getStorage() before accessing _storage.
    // Do NOT add methods that skip getStorage() — they will break cloudflare drivers.
    const result = this.createUnstorageInstance(config);
    this._storageReady = Promise.resolve(result).then(s => {
      this._storage = s;
      return s;
    });
    this.capabilities = this.getCapabilitiesForDriver(config.driver);
  }

  /** Await this to ensure storage is initialized before use */
  private getStorage(): Promise<any> {
    if (this._storage) return Promise.resolve(this._storage);
    return this._storageReady;
  }
  
  /**
   * Create unstorage instance based on driver
   */
  private createUnstorageInstance(config: UnstorageAdapterConfig): any {
    switch (config.driver) {
      case 'upstash': {
        // Auto-read from env vars if not provided - using shared resolver
        const env = resolveUpstashEnv();
        const upstashConfig: Record<string, any> = {};

        // Use provided options or read from shared resolver
        upstashConfig.url = config.options?.url || env.url;
        upstashConfig.token = config.options?.token || env.token;
        
        // Support base (namespace) option
        if (config.options?.base) {
          upstashConfig.base = config.options.base;
        }
        
        // Support default TTL
        if (config.options?.ttl) {
          upstashConfig.ttl = config.options.ttl;
        }
        
        // Validate credentials
        if (!upstashConfig.url || !upstashConfig.token) {
          throw new Error(
            'Upstash credentials required. Set UPSTASH_REDIS_REST_URL and ' +
            'UPSTASH_REDIS_REST_TOKEN env vars, or pass url/token in options.'
          );
        }
        
        return createStorage({
          driver: (upstashDriver as any)(upstashConfig),
        });
      }
      
      case 'cloudflare-kv': {
        if (!config.options?.binding) {
          throw new Error('Cloudflare KV requires binding in options');
        }
        
        // Dynamic import for Cloudflare Workers environment
        return (async () => {
          try {
            const { default: cloudflareKVDriver } = await import(
              'unstorage/drivers/cloudflare-kv-binding'
            );
            return createStorage({
              driver: (cloudflareKVDriver as any)({
                binding: config.options!.binding,
              }),
            });
          } catch (error) {
            throw new Error(
              `Cloudflare KV driver not available: ${(error as Error).message}. ` +
              `Ensure you're running in Cloudflare Workers environment.`
            );
          }
        })();
      }
      
      case 'cloudflare-r2': {
        if (!config.options?.binding) {
          throw new Error('Cloudflare R2 requires binding in options');
        }
        
        // Dynamic import for Cloudflare Workers environment
        return (async () => {
          try {
            const { default: cloudflareR2Driver } = await import(
              'unstorage/drivers/cloudflare-r2-binding'
            );
            return createStorage({
              driver: (cloudflareR2Driver as any)({
                binding: config.options!.binding,
              }),
            });
          } catch (error) {
            throw new Error(
              `Cloudflare R2 driver not available: ${(error as Error).message}. ` +
              `Ensure you're running in Cloudflare Workers environment.`
            );
          }
        })();
      }
      
      default:
        throw new Error(`Unsupported driver: ${config.driver}`);
    }
  }
  
  /**
   * Get adapter capabilities based on driver
   */
  private getCapabilitiesForDriver(driver: UnstorageDriver): AdapterCapabilities {
    const capabilities: Record<UnstorageDriver, AdapterCapabilities> = {
      upstash: {
        name: 'unstorage-upstash',
        supportedTypes: ['object', 'kv'],  // No blobs (size limit)
        maxItemSize: 1024 * 1024,  // 1MB limit
        cost: {
          tier: 'cheap',
          perOperation: '$0.20 per 100k requests',
          perGB: '$0.25 per GB/month',
        },
        performance: {
          readLatency: 'low',      // ~10-50ms
          writeLatency: 'low',     // ~10-50ms
          throughput: 'high',
        },
      },
      
      'cloudflare-kv': {
        name: 'unstorage-cloudflare-kv',
        supportedTypes: ['object', 'kv'],
        maxItemSize: 25 * 1024 * 1024,  // 25MB limit
        cost: {
          tier: 'cheap',
          perOperation: '$0.50 per million reads',
          perGB: '$0.50 per GB/month',
        },
        performance: {
          readLatency: 'low',       // ~10-20ms globally
          writeLatency: 'medium',   // ~60s eventual consistency
          throughput: 'high',
        },
      },
      
      'cloudflare-r2': {
        name: 'unstorage-cloudflare-r2',
        supportedTypes: ['blob', 'object', 'kv'],  // All types!
        maxItemSize: undefined,  // No limit (5TB max per object)
        cost: {
          tier: 'cheap',
          perOperation: '$0.36 per million reads',
          perGB: '$0.015 per GB/month',
        },
        performance: {
          readLatency: 'medium',    // ~50-100ms
          writeLatency: 'medium',   // ~50-100ms
          throughput: 'medium',
        },
      },
    };
    
    return capabilities[driver];
  }
  
  /**
   * Get value by key
   */
  async get(key: string): Promise<any> {
    try {
      // Handle async storage initialization (for dynamic imports)
      const storage = await this.getStorage();
      const value = await storage.getItem(key);
      return value;
    } catch (error) {
      console.error(`[UnstorageAdapter] Error getting key ${key}:`, error);
      return null;
    }
  }
  
  /**
   * Set value by key
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const storage = await this.getStorage();
      await storage.setItem(key, value, { ttl });
    } catch (error) {
      console.error(`[UnstorageAdapter] Error setting key ${key}:`, error);
      throw error;
    }
  }
  
  /**
   * Delete value by key
   */
  async delete(key: string): Promise<void> {
    try {
      const storage = await this.getStorage();
      await storage.removeItem(key);
    } catch (error) {
      console.error(`[UnstorageAdapter] Error deleting key ${key}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    try {
      const storage = await this.getStorage();
      const value = await storage.getItem(key);
      return value !== null && value !== undefined;
    } catch (error) {
      console.error(`[UnstorageAdapter] Error checking key ${key}:`, error);
      return false;
    }
  }
  
  /**
   * List keys with optional prefix
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      const storage = await this.getStorage();
      const keys = await storage.getKeys(prefix);
      return keys;
    } catch (error) {
      console.error(`[UnstorageAdapter] Error listing keys:`, error);
      return [];
    }
  }
  
  /**
   * Clear all data (or with prefix)
   */
  async clear(prefix?: string): Promise<void> {
    try {
      const storage = await this.getStorage();
      if (prefix) {
        const keys = await this.keys(prefix);
        await Promise.all(keys.map(key => this.delete(key)));
      } else {
        await storage.clear();
      }
    } catch (error) {
      console.error(`[UnstorageAdapter] Error clearing:`, error);
      throw error;
    }
  }
}

/**
 * Create unstorage adapter instance
 * 
 * @param driver - Unstorage driver to use
 * @param options - Driver-specific options
 * @returns Unstorage adapter
 * 
 * @example
 * ```typescript
 * // Upstash (auto-reads env vars)
 * const upstash = createUnstorageAdapter('upstash');
 * 
 * // Upstash (explicit credentials)
 * const upstash = createUnstorageAdapter('upstash', {
 *   url: 'https://...',
 *   token: '...'
 * });
 * 
 * // Cloudflare KV (requires binding)
 * const kv = createUnstorageAdapter('cloudflare-kv', {
 *   binding: env.MY_KV_NAMESPACE
 * });
 * 
 * // Cloudflare R2 (requires binding)
 * const r2 = createUnstorageAdapter('cloudflare-r2', {
 *   binding: env.MY_R2_BUCKET
 * });
 * ```
 */
export function createUnstorageAdapter(
  driver: UnstorageDriver,
  options?: Record<string, any>
): StorageAdapter {
  return new UnstorageAdapter({ driver, options });
}

