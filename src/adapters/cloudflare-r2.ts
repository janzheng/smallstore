/**
 * Cloudflare R2 Storage Adapter
 * 
 * S3-compatible object storage via Cloudflare R2.
 * - Unlimited size (5TB per object)
 * - Cheap (no egress fees)
 * - Persistent
 * - Auto-parsing for JSON/CSV
 * - MIME type detection
 * 
 * Dual Mode:
 * - HTTP Mode: External access via Cloudflare Workers HTTP API
 * - Native Mode: Direct binding access (inside Workers)
 * 
 * Use cases:
 * - File storage (images, videos, documents)
 * - Large datasets (JSON, CSV)
 * - Binary blobs
 * - Media streaming
 */

// Minimal type stubs for Cloudflare Workers bindings (only used in native mode inside Workers)
// deno-lint-ignore no-empty-interface
interface R2Bucket { [key: string]: any; }

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import type { RetryOptions } from '../utils/retry.ts';
import { retryFetch, type RetryFetchOptions } from '../utils/retry-fetch.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Cloudflare R2 Config
// ============================================================================

export interface CloudflareR2Config {
  /**
   * HTTP Mode: Base URL of smallstore-workers service
   * Example: "https://your-workers.your-subdomain.workers.dev"
   */
  baseUrl?: string;

  /**
   * Native Mode: Direct R2 binding (inside Workers)
   * Example: env.SM_R2
   */
  binding?: R2Bucket;
  
  /** Optional scope/prefix for all keys */
  scope?: string;
  
  /** HTTP Mode: Optional API key for authentication */
  apiKey?: string;
  
  /** Auto-parse content (default: true) */
  autoParse?: boolean;

  /** HTTP Mode: Retry options for transient failures (false to disable) */
  retry?: RetryOptions | false;
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

interface FileMetadata {
  key: string;
  filename?: string;
  contentType: string;
  size: number;
  uploaded: string;
  etag?: string;
  scope?: string;
}

// ============================================================================
// Cloudflare R2 Adapter
// ============================================================================

/**
 * Cloudflare R2 storage adapter
 * 
 * Uses either HTTP API or native R2 binding for storage.
 */
export class CloudflareR2Adapter implements StorageAdapter {
  private baseUrl?: string;
  private binding?: R2Bucket;
  private scope: string;
  private apiKey?: string;
  private mode: 'http' | 'native';
  private autoParse: boolean;
  private retryOpts?: RetryFetchOptions;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'cloudflare-r2',
    supportedTypes: [
      'blob',         // Binary files (images, videos, etc.)
      'object',       // JSON/CSV objects
    ],
    maxItemSize: undefined, // Unlimited (5TB per object)
    cost: {
      perGB: '$0.015/GB/month storage, $0 egress',
      perOperation: '$4.50 per million Class A ops',
      tier: 'cheap',
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'low',
      throughput: 'high',
    },
    features: {
      ttl: false,
      transactions: false,
    },
  };
  
  constructor(config: CloudflareR2Config = {}) {
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
        'CloudflareR2Adapter requires either baseUrl (HTTP mode) or binding (native mode)'
      );
    }
    
    this.scope = config.scope || '';
    this.autoParse = config.autoParse !== false;
    this.retryOpts = config.retry === false ? { enabled: false } : config.retry ? { ...config.retry } : undefined;
  }
  
  // ============================================================================
  // Helper: Full Key with Scope
  // ============================================================================
  
  private getFullKey(key: string): string {
    return this.scope ? `${this.scope}/${key}` : key;
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
      ...(options.headers as Record<string, string>),
    };
    
    // Only set Content-Type for JSON bodies
    if (options.body && typeof options.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    const response = await retryFetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    }, this.retryOpts);

    // For file downloads, return the response directly wrapped
    if (path.startsWith('/r2/') && !path.includes('/list') && !path.includes('/details') && options.method !== 'DELETE') {
      if (response.ok) {
        return {
          success: true,
          data: response as any,
        };
      }
    }
    
    return await response.json() as ApiResponse<T>;
  }
  
  // ============================================================================
  // Content Type Detection
  // ============================================================================
  
  private detectContentType(key: string): string {
    const ext = key.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      'json': 'application/json',
      'csv': 'text/csv',
      'txt': 'text/plain',
      'html': 'text/html',
      'pdf': 'application/pdf',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'mp3': 'audio/mpeg',
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'zip': 'application/zip',
    };
    return (ext && map[ext]) || 'application/octet-stream';
  }
  
  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  /**
   * Store data in R2
   * 
   * @param key - Storage key
   * @param data - Data to store (any type)
   */
  async set(key: string, data: any): Promise<void> {
    const fullKey = this.getFullKey(key);
    const contentType = this.detectContentType(key);
    
    if (this.mode === 'native' && this.binding) {
      // Native mode
      let body: ArrayBuffer | string;
      let finalContentType = contentType;
      
      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        body = data instanceof Uint8Array ? (data.buffer as ArrayBuffer) : data;
      } else if (typeof data === 'string') {
        body = data;
        if (contentType === 'application/octet-stream') {
          finalContentType = 'text/plain';
        }
      } else {
        // Serialize objects to JSON
        body = JSON.stringify(data);
        finalContentType = 'application/json';
      }
      
      await this.binding.put(fullKey, body, {
        httpMetadata: {
          contentType: finalContentType,
        },
        customMetadata: {
          uploaded: new Date().toISOString(),
        },
      });
    } else {
      // HTTP mode
      let requestData: any;
      let finalContentType = contentType;
      
      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        // Convert to base64 for JSON transport
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
        requestData = btoa(binary);
        finalContentType = contentType;
      } else if (typeof data === 'string') {
        requestData = data;
      } else {
        requestData = data;
        finalContentType = 'application/json';
      }
      
      await this.httpRequest('/r2', {
        method: 'POST',
        body: JSON.stringify({
          filename: key,
          data: requestData,
          scope: this.scope || undefined,
          contentType: finalContentType,
        }),
      });
    }
  }
  
  /**
   * Get data from R2
   * 
   * @param key - Storage key
   * @param options - Get options (raw: return unparsed data)
   * @returns Data or null if not found
   */
  async get(key: string, options?: { raw?: boolean }): Promise<any> {
    const fullKey = this.getFullKey(key);
    
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        const object = await this.binding.get(fullKey);
        
        if (!object) {
          return null;
        }
        
        const bodyText = await object.text();
        
        // Return raw if requested
        if (options?.raw) {
          return bodyText;
        }
        
        // Auto-parse based on content type
        if (this.autoParse && object.httpMetadata?.contentType) {
          return this.parseData(bodyText, object.httpMetadata.contentType, fullKey);
        }
        
        return bodyText;
      } else {
        // HTTP mode
        const response = await this.httpRequest<Response>(
          `/r2/${fullKey}`
        );
        
        if (!response.success) {
          return null;
        }
        
        // Response.data is the raw fetch Response object wrapped in our ApiResponse.
        // The double cast is needed because httpRequest types data as T (generic)
        // but for file GET requests it returns the raw Response (not parsed JSON).
        const fetchResponse = response.data as unknown as Response;
        if (!fetchResponse || typeof fetchResponse.text !== 'function') {
          return null;
        }
        const bodyText = await fetchResponse.text();
        
        // Return raw if requested
        if (options?.raw) {
          return bodyText;
        }
        
        // Auto-parse based on content type
        if (this.autoParse) {
          const contentType = fetchResponse.headers.get('content-type') || '';
          return this.parseData(bodyText, contentType, fullKey);
        }
        
        return bodyText;
      }
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('404')) {
        return null;
      }
      throw error;
    }
  }
  
  /**
   * Delete data from R2
   */
  async delete(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    
    if (this.mode === 'native' && this.binding) {
      // Native mode
      await this.binding.delete(fullKey);
    } else {
      // HTTP mode
      await this.httpRequest(`/r2/${fullKey}`, {
        method: 'DELETE',
      });
    }
  }
  
  /**
   * Check if key exists in R2
   */
  async has(key: string): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        const object = await this.binding.head(fullKey);
        return object !== null;
      } else {
        // HTTP mode
        const response = await this.httpRequest<{ key: string; size: number }>(
          `/r2/details/${fullKey}`
        );
        return response.success;
      }
    } catch (error: any) {
      return false;
    }
  }
  
  /**
   * List keys with prefix
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        let listPrefix = '';
        if (this.scope && prefix) {
          listPrefix = `${this.scope}/${prefix}`;
        } else if (this.scope) {
          listPrefix = `${this.scope}/`;
        } else if (prefix) {
          listPrefix = prefix;
        }
        
        const options: any = {};
        if (listPrefix) {
          options.prefix = listPrefix;
        }
        
        const result = await this.binding.list(options);
        
        // Remove scope prefix if present
        if (this.scope) {
          const scopePrefix = `${this.scope}/`;
          return result.objects.map((obj: any) =>
            obj.key.startsWith(scopePrefix) ? obj.key.slice(scopePrefix.length) : obj.key
          );
        }
        
        return result.objects.map((obj: any) => obj.key);
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        if (this.scope) params.set('scope', this.scope);
        if (prefix) params.set('prefix', prefix);
        
        const response = await this.httpRequest<{ files: Array<{ key: string }> }>(
          `/r2/list?${params.toString()}`
        );
        
        if (!response.success || !response.data?.files) {
          return [];
        }
        
        // Strip scope from keys
        return response.data.files.map(file => {
          if (this.scope) {
            const scopePrefix = `${this.scope}/`;
            return file.key.startsWith(scopePrefix) ? file.key.slice(scopePrefix.length) : file.key;
          }
          return file.key;
        });
      }
    } catch (error) {
      console.error('[CloudflareR2Adapter] Error getting keys:', error);
      return [];
    }
  }
  
  /**
   * Clear all keys with prefix
   */
  async clear(prefix?: string): Promise<void> {
    const keysToDelete = await this.keys(prefix);
    
    await Promise.all(
      keysToDelete.map(key => this.delete(key))
    );
  }
  
  // ============================================================================
  // Smart Content Parsing
  // ============================================================================
  
  /**
   * Parse data based on content type
   */
  private parseData(data: string, contentType: string, key: string): any {
    // JSON
    if (contentType.includes('application/json') || key.endsWith('.json')) {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
    
    // CSV
    if (contentType.includes('text/csv') || key.endsWith('.csv')) {
      return this.parseCSV(data);
    }
    
    // Plain text
    return data;
  }
  
  /**
   * Parse CSV to array of objects
   */
  private parseCSV(data: string): any[] {
    const lines = data.trim().split('\n');
    if (lines.length === 0) return [];
    
    const headers = lines[0].split(',').map(h => h.trim());
    
    return lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim());
      return headers.reduce((obj: any, header, i) => {
        obj[header] = values[i] || '';
        return obj;
      }, {});
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new Cloudflare R2 adapter instance
 * 
 * @param config - Cloudflare R2 configuration
 * @returns CloudflareR2Adapter
 * 
 * @example HTTP Mode
 * const adapter = createCloudflareR2Adapter({
 *   baseUrl: "https://your-workers.your-subdomain.workers.dev",
 *   scope: "my-app"
 * });
 *
 * @example Native Mode (inside Workers)
 * const adapter = createCloudflareR2Adapter({
 *   binding: env.SM_R2,
 *   scope: "my-app"
 * });
 */
export function createCloudflareR2Adapter(config: CloudflareR2Config): CloudflareR2Adapter {
  return new CloudflareR2Adapter(config);
}

