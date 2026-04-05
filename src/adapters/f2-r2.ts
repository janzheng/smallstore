/**
 * F2-R2 Storage Adapter
 *
 * Uses Fuzzyfile (F2) service as a proxy to Cloudflare R2.
 * F2 is a Cloudflare Worker that wraps R2 with presigned URLs.
 *
 * Uses **deterministic mode** (nanoid: "", useVersioning: false) so keys
 * are always `scope/filename` — no in-memory key tracking needed.
 *
 * - JSON values use `cmd: "data"` (single POST, no presigned URL)
 * - Binary values use `cmd: "presign"` + PUT
 * - Listing uses `cmd: "list"` with pagination
 * - Delete uses `cmd: "delete"` with authKey (single, bulk, or prefix)
 *
 * Key namespace: smallstore:collection/path → scope=collection, filename=path
 */

import type { StorageAdapter, AdapterCapabilities } from './adapter.ts';
import type { RetryOptions } from '../utils/retry.ts';
import { type RetryFetchOptions, retryFetch } from '../utils/retry-fetch.ts';
import { resolveF2Env } from '../../config.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Configuration
// ============================================================================

export interface F2R2AdapterConfig {
  /**
   * F2 service URL
   * Falls back to F2_DEFAULT_URL env var
   * Default: https://f2.phage.directory
   */
  f2Url?: string;

  /**
   * Authorization token for read requests (Bearer header)
   */
  token?: string;

  /**
   * Auth key for destructive operations (delete, rename)
   * Must match DELETE_AUTH_KEY on the F2 worker
   * Falls back to F2_AUTH_KEY env var
   */
  authKey?: string;

  /**
   * Default scope for uploads
   * Used when key doesn't contain a scope
   * Default: "smallstore"
   */
  defaultScope?: string;

  /** Retry options for transient failures. Set to false to disable. */
  retry?: RetryOptions | false;
}

// ============================================================================
// Adapter Implementation
// ============================================================================

export class F2R2Adapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'f2-r2',
    supportedTypes: ['object', 'blob', 'kv'],
    maxItemSize: undefined,  // R2 has no size limit
    cost: {
      tier: 'cheap',
      perOperation: '$0.36 per million reads',
      perGB: '$0.015 per GB/month',
    },
    performance: {
      readLatency: 'medium',   // ~50-100ms (HTTP → F2 → R2)
      writeLatency: 'medium',  // ~100-200ms
      throughput: 'high',
    },
  };

  private f2Url: string;
  private token?: string;
  private authKey?: string;
  private defaultScope: string;
  private retryOpts?: RetryFetchOptions;

  constructor(config: F2R2AdapterConfig = {}) {
    const env = resolveF2Env();
    this.f2Url = config.f2Url || env.f2Url || 'https://f2.phage.directory';
    this.token = config.token;
    this.authKey = config.authKey || env.authKey;
    this.defaultScope = config.defaultScope || 'smallstore';
    this.retryOpts = config.retry === false ? { enabled: false } : config.retry ? { ...config.retry } : undefined;

    debug(`[F2R2Adapter] Initialized with F2 URL: ${this.f2Url} (deterministic mode)`);
  }

  // ==========================================================================
  // Key Parsing
  // ==========================================================================

  /**
   * Parse Smallstore key into F2 scope/filename
   *
   * Examples:
   *   "smallstore:generated/image-123.png" → { scope: "generated", filename: "image-123.png" }
   *   "generated/image-123.png" → { scope: "generated", filename: "image-123.png" }
   *   "image.png" → { scope: "smallstore", filename: "image.png" }
   */
  private parseKey(key: string): { scope: string; filename: string } {
    // Remove "smallstore:" prefix if present
    const cleanKey = key.replace(/^smallstore:/, '');

    // Split on first slash
    const slashIndex = cleanKey.indexOf('/');
    if (slashIndex === -1) {
      return { scope: this.defaultScope, filename: cleanKey };
    }

    return {
      scope: cleanKey.substring(0, slashIndex),
      filename: cleanKey.substring(slashIndex + 1)
    };
  }

  /**
   * Build the deterministic F2 GET URL for a key: {f2Url}/{scope}/{filename}
   */
  private resolveUrl(key: string): string {
    const { scope, filename } = this.parseKey(key);
    return `${this.f2Url}/${scope}/${filename}`;
  }

  /**
   * Build common headers (auth if configured)
   */
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /**
   * POST a JSON command to F2
   */
  private async postCommand(body: Record<string, unknown>): Promise<Response> {
    return retryFetch(this.f2Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    }, this.retryOpts);
  }

  // ==========================================================================
  // Storage Adapter Methods
  // ==========================================================================

  /**
   * Get value from R2 via F2
   *
   * Deterministic mode: GET {f2Url}/{scope}/{filename}
   */
  async get(key: string): Promise<any> {
    const url = this.resolveUrl(key);

    try {
      const response = await retryFetch(url, { headers: this.authHeaders() }, this.retryOpts);

      if (response.status === 404 || response.status === 403) {
        await response.body?.cancel();
        return null;
      }

      if (!response.ok) {
        throw new Error(`F2 GET failed: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        return await response.json();
      }

      // Return as Uint8Array for blobs
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);

    } catch (error) {
      console.error(`[F2R2Adapter] GET error for ${key}:`, error);
      throw error;
    }
  }

  /**
   * Set value in R2 via F2 (deterministic mode)
   *
   * - JSON/text values: `cmd: "data"` (single POST, stored directly)
   * - Binary values: `cmd: "presign"` + PUT to presigned URL
   *
   * All uploads use nanoid: "" and useVersioning: false for deterministic keys.
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const { scope, filename } = this.parseKey(key);

    if (ttl) {
      console.warn('[F2R2Adapter] TTL not supported - use R2 lifecycle rules instead');
    }

    try {
      // JSON objects: use cmd: "data" (single request, no presigned URL needed)
      if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !(value instanceof Blob)) {
        const response = await this.postCommand({
          cmd: 'data',
          data: value,
          key: filename,
          scope,
          nanoid: '',
          useVersioning: false,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`F2 data upload failed: ${response.status} - ${errorText}`);
        }
        await response.body?.cancel();
        return;
      }

      // Text values: also use cmd: "data"
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const response = await this.postCommand({
          cmd: 'data',
          data: String(value),
          key: filename,
          scope,
          nanoid: '',
          useVersioning: false,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`F2 data upload failed: ${response.status} - ${errorText}`);
        }
        await response.body?.cancel();
        return;
      }

      // Binary data (Uint8Array, Blob): use presigned URL upload
      let binaryData: Uint8Array;
      let contentType: string;

      if (value instanceof Blob) {
        binaryData = new Uint8Array(await value.arrayBuffer());
        contentType = value.type || this.detectMimeType(filename);
      } else {
        // Uint8Array
        binaryData = value;
        contentType = this.detectMimeType(filename);
      }

      // Step 1: Get presigned URL (deterministic mode)
      const presignResponse = await this.postCommand({
        cmd: 'presign',
        key: filename,
        scope,
        nanoid: '',
        useVersioning: false,
        expiresIn: 3600,
      });

      if (!presignResponse.ok) {
        const errorText = await presignResponse.text();
        throw new Error(`F2 presign failed: ${presignResponse.status} - ${errorText}`);
      }

      const presignData = await presignResponse.json();
      if (!presignData?.url) {
        throw new Error('No presigned URL returned from F2');
      }

      // Step 2: Upload to R2 via presigned URL
      // Validate that binaryData is a type compatible with fetch's BodyInit
      if (!(binaryData instanceof Uint8Array) && typeof binaryData !== 'string') {
        throw new Error(`[F2R2Adapter] Unexpected binary data type: ${typeof binaryData}`);
      }
      const uploadResponse = await retryFetch(presignData.url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: binaryData as unknown as BodyInit,
      }, this.retryOpts);

      if (!uploadResponse.ok) {
        throw new Error(`R2 upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
      }
      await uploadResponse.body?.cancel();

    } catch (error) {
      console.error(`[F2R2Adapter] SET error for ${key}:`, error);
      throw error;
    }
  }

  /**
   * Delete value from R2 via F2 using `cmd: "delete"`
   *
   * Requires authKey (matching DELETE_AUTH_KEY on the F2 worker).
   */
  async delete(key: string): Promise<void> {
    const { scope, filename } = this.parseKey(key);
    const r2Key = `${scope}/${filename}`;

    if (!this.authKey) {
      console.warn('[F2R2Adapter] delete requires authKey (F2_AUTH_KEY env var). Skipping.');
      return;
    }

    try {
      const response = await this.postCommand({
        cmd: 'delete',
        authKey: this.authKey,
        key: r2Key,
      });

      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        throw new Error(`F2 DELETE failed: ${response.status} - ${errorText}`);
      }
      await response.body?.cancel();

    } catch (error) {
      console.error(`[F2R2Adapter] DELETE error for ${key}:`, error);
      throw error;
    }
  }

  /**
   * Check if key exists in R2 via F2
   */
  async has(key: string): Promise<boolean> {
    const url = this.resolveUrl(key);

    try {
      const response = await retryFetch(url, {
        method: 'HEAD',
        headers: this.authHeaders(),
      }, this.retryOpts);

      return response.status === 200;

    } catch (error) {
      console.error(`[F2R2Adapter] HAS error for ${key}:`, error);
      return false;
    }
  }

  /**
   * List keys with optional prefix
   *
   * Uses F2's `cmd: "list"` endpoint. Returns keys as `smallstore:scope/filename`.
   */
  async keys(prefix?: string): Promise<string[]> {
    const { scope } = this.parseKey(prefix || '');

    try {
      const response = await this.postCommand({
        cmd: 'list',
        scope: prefix ? scope : this.defaultScope,
        limit: 1000,
      });

      if (!response.ok) {
        console.warn(`[F2R2Adapter] list failed: ${response.status}`);
        return [];
      }

      const data = await response.json();
      const items = data?.items || [];

      // Convert R2 keys back to smallstore keys
      return items.map((item: { key: string }) => `smallstore:${item.key}`);

    } catch (error) {
      console.error(`[F2R2Adapter] KEYS error:`, error);
      return [];
    }
  }

  /**
   * Clear all keys with optional prefix
   *
   * Uses F2's prefix delete (`cmd: "delete"` with `prefix`) for a single request.
   */
  async clear(prefix?: string): Promise<void> {
    if (!this.authKey) {
      console.warn('[F2R2Adapter] clear requires authKey (F2_AUTH_KEY env var). Skipping.');
      return;
    }

    const { scope } = this.parseKey(prefix || '');
    const r2Prefix = prefix ? scope : this.defaultScope;

    try {
      const response = await this.postCommand({
        cmd: 'delete',
        authKey: this.authKey,
        prefix: r2Prefix,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`F2 CLEAR failed: ${response.status} - ${errorText}`);
      }
      await response.body?.cancel();

    } catch (error) {
      console.error(`[F2R2Adapter] CLEAR error:`, error);
      throw error;
    }
  }

  // ==========================================================================
  // MIME Type Detection
  // ==========================================================================

  private detectMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();

    const mimeTypes: Record<string, string> = {
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
      'ico': 'image/x-icon',
      'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
      'm4a': 'audio/mp4', 'flac': 'audio/flac',
      'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'pdf': 'application/pdf', 'zip': 'application/zip',
      'json': 'application/json', 'xml': 'application/xml',
      'txt': 'text/plain', 'html': 'text/html', 'css': 'text/css',
      'js': 'text/javascript', 'ts': 'text/typescript', 'md': 'text/markdown',
    };

    return ext ? (mimeTypes[ext] || 'application/octet-stream') : 'application/octet-stream';
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create F2-R2 storage adapter (deterministic mode)
 *
 * @param config Optional configuration (falls back to env vars)
 * @returns F2R2Adapter instance
 *
 * @example
 * const adapter = createF2R2Adapter({
 *   f2Url: 'https://f2.example.com',
 *   token: 'secret-token'
 * });
 *
 * @example
 * // With env fallback (F2_DEFAULT_URL)
 * const adapter = createF2R2Adapter();
 */
export function createF2R2Adapter(config: F2R2AdapterConfig = {}): StorageAdapter {
  return new F2R2Adapter(config);
}
