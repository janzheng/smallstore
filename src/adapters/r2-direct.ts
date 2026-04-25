/**
 * Direct R2 Adapter for Smallstore (Phase 3.6g-a)
 * 
 * Direct Cloudflare R2 access using S3-compatible API.
 * 
 * Features:
 * - Simple set/get with auto-parsing
 * - Signed upload URLs
 * - S3-compatible API
 * - Large dataset support (no size limits)
 * - MIME type detection
 * 
 * Use Cases:
 * - Large JSON/CSV datasets (>1MB)
 * - Direct client uploads
 * - S3-compatible tools
 * - Blob storage without F2 service
 */

import type { StorageAdapter, AdapterCapabilities } from './adapter.ts';
import type { DataType } from '../types.ts';
import { getEnv, requireEnv } from '../utils/env.ts';
import { retry, type RetryOptions } from '../utils/retry.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// AWS SDK lazy-load
// ============================================================================
//
// Same recipe as `src/messaging/channels/cf-email.ts` for postal-mime
// and `src/blob-middleware/resolver.ts` for the r2-direct backend:
// dynamic `await import` + module-level cache + helpful "install"
// error if the dep is missing. Lets the npm `dist/` declare aws-sdk
// as an OPTIONAL peerDep — consumers using only Memory/D1/R2-binding/
// Notion/etc. don't pay for the SDK install.
//
// `any` typing on the cache slots is intentional — `typeof import(...)`
// looks like a static import to dnt and would re-pin aws-sdk into
// `dependencies` regardless of the peerDeps override.

let _S3Module: any | undefined;
let _S3PresignerModule: any | undefined;

async function loadS3(): Promise<any> {
  if (_S3Module) return _S3Module;
  try {
    _S3Module = await import('@aws-sdk/client-s3');
    return _S3Module;
  } catch (err) {
    throw new Error(
      "The r2-direct adapter requires '@aws-sdk/client-s3'. Install it:\n" +
        "  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner\n" +
        `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

async function loadS3Presigner(): Promise<any> {
  if (_S3PresignerModule) return _S3PresignerModule;
  try {
    _S3PresignerModule = await import('@aws-sdk/s3-request-presigner');
    return _S3PresignerModule;
  } catch (err) {
    throw new Error(
      "The r2-direct adapter signed-URL feature requires '@aws-sdk/s3-request-presigner'. Install it:\n" +
        "  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner\n" +
        `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

export interface R2DirectAdapterConfig {
  /** Cloudflare Account ID */
  accountId: string;
  
  /** R2 Access Key ID */
  accessKeyId: string;
  
  /** R2 Secret Access Key */
  secretAccessKey: string;
  
  /** R2 Bucket Name */
  bucketName: string;
  
  /** Optional: Custom endpoint (defaults to R2 endpoint) */
  endpoint?: string;
  
  /** Optional: Region (defaults to 'auto') */
  region?: string;
  
  /** Auto-parse content (default: true) */
  autoParse?: boolean;

  /** Retry options for transient S3/R2 failures (false to disable) */
  retry?: RetryOptions | false;
}

/**
 * Direct R2 Adapter
 * 
 * Stores data directly in Cloudflare R2 using S3-compatible API.
 * 
 * @example
 * const adapter = new R2DirectAdapter({
 *   accountId: process.env.R2_ACCOUNT_ID!,
 *   accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *   bucketName: process.env.R2_BUCKET_NAME!
 * });
 */
export class R2DirectAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'r2-direct',
    supportedTypes: ['blob', 'object', 'kv'],
    maxItemSize: undefined, // Unlimited (5TB per object!)
    maxTotalSize: undefined, // Unlimited
    cost: {
      tier: 'cheap',
      perGB: '$0.015/GB/month',
      perOperation: '$4.50 per million Class A operations'
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'low',
      throughput: 'high'
    },
    features: {
      ttl: false,
      transactions: false,
      query: false,
      search: false
    }
  };
  
  // S3Client is built lazily on first command — `await loadS3()` can't run
  // in a synchronous constructor. The cached client persists for the
  // lifetime of the adapter; concurrent first-calls race-build harmlessly
  // (the JS module system dedups the dynamic import).
  private s3Client?: any;
  private config: R2DirectAdapterConfig;
  private retryOpts?: RetryOptions;

  constructor(config: R2DirectAdapterConfig) {
    this.config = {
      region: 'auto',
      autoParse: true,
      ...config
    };

    this.retryOpts = config.retry === false ? undefined : config.retry ? { ...config.retry } : { maxRetries: 3 };

    debug(`[R2Direct] Initialized with bucket: ${config.bucketName}`);
  }

  /** Build the S3 client on first call; reused thereafter. */
  private async getClient(): Promise<any> {
    if (this.s3Client) return this.s3Client;
    const { S3Client } = await loadS3();
    const endpoint = this.config.endpoint ||
      `https://${this.config.accountId}.r2.cloudflarestorage.com`;
    this.s3Client = new S3Client({
      region: this.config.region,
      endpoint,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
    return this.s3Client;
  }

  /**
   * Send an S3 command, optionally with retry logic.
   */
  private async sendCommand<T>(command: any): Promise<T> {
    const client = await this.getClient();
    if (!this.retryOpts) {
      return await client.send(command) as T;
    }
    return await retry(
      () => client.send(command) as Promise<T>,
      {
        ...this.retryOpts,
        isRetryable: this.retryOpts.isRetryable ?? ((err: any) => {
          // S3 SDK errors carry httpStatusCode in $metadata
          const status = err?.$metadata?.httpStatusCode;
          if (status === 429 || (status >= 500 && status < 600)) return true;
          // Network-level errors
          if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
          if (err instanceof TypeError) return true;
          // Don't retry missing resources
          if (err.name === 'NoSuchKey' || err.name === 'NotFound') return false;
          return false;
        }),
      },
    );
  }
  
  /**
   * Store data in R2
   * 
   * @param key - Storage key
   * @param data - Data to store (any type)
   */
  async set(key: string, data: any): Promise<void> {
    const { body, contentType } = this.serializeData(key, data);
    const { PutObjectCommand } = await loadS3();
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      Body: body,
      ContentType: contentType
    });

    await this.sendCommand(command);
    debug(`[R2Direct] Stored: ${key} (${contentType})`);
  }
  
  /**
   * Get data from R2
   * 
   * @param key - Storage key
   * @param options - Get options (raw: return unparsed data)
   * @returns Data or null if not found
   */
  async get(key: string, options?: { raw?: boolean }): Promise<any> {
    try {
      const { GetObjectCommand } = await loadS3();
      const command = new GetObjectCommand({
        Bucket: this.config.bucketName,
        Key: key
      });

      const response = await this.sendCommand<any>(command);

      if (!response.Body) {
        return null;
      }

      // Read stream to string/buffer
      const bodyString = await response.Body.transformToString();

      // Return raw if requested
      if (options?.raw) {
        return bodyString;
      }

      // Auto-parse based on content type
      if (this.config.autoParse && response.ContentType) {
        return this.parseData(bodyString, response.ContentType, key);
      }
      
      return bodyString;
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }
  
  /**
   * Delete data from R2
   */
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await loadS3();
    const command = new DeleteObjectCommand({
      Bucket: this.config.bucketName,
      Key: key
    });

    await this.sendCommand(command);
    debug(`[R2Direct] Deleted: ${key}`);
  }

  /**
   * Check if key exists in R2
   */
  async has(key: string): Promise<boolean> {
    try {
      const { HeadObjectCommand } = await loadS3();
      const command = new HeadObjectCommand({
        Bucket: this.config.bucketName,
        Key: key
      });

      await this.sendCommand(command);
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        return false;
      }
      throw error;
    }
  }

  /**
   * List keys with prefix
   */
  async keys(prefix?: string): Promise<string[]> {
    const { ListObjectsV2Command } = await loadS3();
    const command = new ListObjectsV2Command({
      Bucket: this.config.bucketName,
      Prefix: prefix
    });

    const response = await this.sendCommand<any>(command);

    return response.Contents?.map((obj: any) => obj.Key!) || [];
  }
  
  /**
   * Clear all keys with prefix
   */
  async clear(prefix?: string): Promise<void> {
    const keysToDelete = await this.keys(prefix);
    
    await Promise.all(
      keysToDelete.map(key => this.delete(key))
    );
    
    debug(`[R2Direct] Cleared ${keysToDelete.length} keys with prefix: ${prefix}`);
  }
  
  // ============================================================================
  // Phase 3.6g-a: Advanced Features
  // ============================================================================
  
  /**
   * Generate signed upload URL for direct client uploads
   * 
   * @param key - Storage key
   * @param options - Upload options
   * @returns Signed URL that client can PUT to
   * 
   * @example
   * const url = await adapter.getSignedUploadUrl("uploads/file.pdf", {
   *   expiresIn: 3600,
   *   maxSize: 10 * 1024 * 1024
   * });
   * 
   * // Client uploads directly:
   * await fetch(url, { method: 'PUT', body: fileData });
   */
  async getSignedUploadUrl(
    key: string,
    options?: {
      expiresIn?: number;  // Seconds (default: 3600)
      maxSize?: number;    // Bytes
      contentType?: string;
    }
  ): Promise<string> {
    const { PutObjectCommand } = await loadS3();
    const { getSignedUrl } = await loadS3Presigner();
    const client = await this.getClient();
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      ContentType: options?.contentType
    });

    const url = await getSignedUrl(client, command, {
      expiresIn: options?.expiresIn || 3600
    });

    debug(`[R2Direct] Generated signed upload URL for: ${key}`);
    return url;
  }
  
  /**
   * Generate signed download URL
   * 
   * @param key - Storage key
   * @param options - Download options
   * @returns Signed URL that client can GET from
   */
  async getSignedDownloadUrl(
    key: string,
    options?: {
      expiresIn?: number;  // Seconds (default: 3600)
      filename?: string;   // Force download with filename
    }
  ): Promise<string> {
    const { GetObjectCommand } = await loadS3();
    const { getSignedUrl } = await loadS3Presigner();
    const client = await this.getClient();
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      ResponseContentDisposition: options?.filename
        ? `attachment; filename="${options.filename}"`
        : undefined
    });

    const url = await getSignedUrl(client, command, {
      expiresIn: options?.expiresIn || 3600
    });

    debug(`[R2Direct] Generated signed download URL for: ${key}`);
    return url;
  }
  
  // ============================================================================
  // Phase 3.6g-b: Smart Content Parsing
  // ============================================================================
  
  /**
   * Serialize data for storage
   */
  private serializeData(key: string, data: any): {
    body: string | Uint8Array;
    contentType: string;
  } {
    // Detect content type from key extension
    const contentType = this.detectContentType(key);
    
    // Handle different data types
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      return {
        body: data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        contentType: contentType || 'application/octet-stream'
      };
    }
    
    // Handle JSON
    if (contentType === 'application/json' || typeof data === 'object') {
      return {
        body: JSON.stringify(data),
        contentType: 'application/json'
      };
    }
    
    // Handle CSV (if data is array of objects)
    if (contentType === 'text/csv' && Array.isArray(data)) {
      return {
        body: this.serializeCSV(data),
        contentType: 'text/csv'
      };
    }
    
    // Handle string
    return {
      body: String(data),
      contentType: contentType || 'text/plain'
    };
  }
  
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
   * Detect content type from key
   */
  private detectContentType(key: string): string | null {
    if (key.endsWith('.json')) return 'application/json';
    if (key.endsWith('.csv')) return 'text/csv';
    if (key.endsWith('.txt')) return 'text/plain';
    if (key.endsWith('.html')) return 'text/html';
    if (key.endsWith('.pdf')) return 'application/pdf';
    if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
    if (key.endsWith('.png')) return 'image/png';
    if (key.endsWith('.gif')) return 'image/gif';
    if (key.endsWith('.svg')) return 'image/svg+xml';
    if (key.endsWith('.mp3')) return 'audio/mpeg';
    if (key.endsWith('.mp4')) return 'video/mp4';
    if (key.endsWith('.zip')) return 'application/zip';
    return null;
  }
  
  /**
   * Parse a single CSV line per RFC 4180 (handles quoted fields, escaped quotes)
   */
  private parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { fields.push(current); current = ''; }
        else { current += ch; }
      }
    }
    fields.push(current);
    return fields;
  }

  /**
   * Parse CSV to array of objects
   */
  private parseCSV(data: string): any[] {
    const lines = data.trim().split('\n');
    if (lines.length === 0) return [];

    const headers = this.parseCSVLine(lines[0]).map(h => h.trim());

    return lines.slice(1).map(line => {
      const values = this.parseCSVLine(line).map(v => v.trim());
      return headers.reduce((obj: any, header, i) => {
        obj[header] = values[i] || '';
        return obj;
      }, {});
    });
  }
  
  /**
   * Serialize array of objects to CSV
   */
  private serializeCSV(data: any[]): string {
    if (!Array.isArray(data) || data.length === 0) {
      return '';
    }
    
    const headers = Object.keys(data[0]);
    const rows = data.map(item =>
      headers.map(h => {
        const value = String(item[h] || '');
        // Escape commas and quotes
        return value.includes(',') || value.includes('"')
          ? `"${value.replace(/"/g, '""')}"`
          : value;
      }).join(',')
    );
    
    return [headers.join(','), ...rows].join('\n');
  }
}

/**
 * Create R2 Direct adapter from environment variables
 */
export function createR2DirectAdapter(): R2DirectAdapter {
  return new R2DirectAdapter({
    accountId: requireEnv('R2_ACCOUNT_ID'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucketName: requireEnv('R2_BUCKET_NAME'),
  });
}

