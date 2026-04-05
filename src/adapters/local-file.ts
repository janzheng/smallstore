/**
 * Local File Storage Adapter for Smallstore
 *
 * Stores raw files on disk — images, PDFs, audio, or any binary data.
 * Keys map directly to file paths: `set('media/photo.jpg', bytes)` writes
 * to `{baseDir}/media/photo.jpg`.
 *
 * For JSON/text data, use LocalJsonAdapter instead.
 * This adapter is designed for binary blobs that should be stored as-is.
 *
 * Storage Layout:
 *   baseDir/{key} — raw file bytes
 *
 * Value handling:
 *   - Uint8Array / ArrayBuffer → written as raw bytes
 *   - string → written as UTF-8 text
 *   - object / other → JSON-serialized and written as .json
 *
 * Reading always returns Uint8Array (raw bytes).
 * Use TextDecoder or JSON.parse on the result as needed.
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';

// ============================================================================
// Config
// ============================================================================

export interface LocalFileConfig {
  /** Base directory for storing files (default: './data/files') */
  baseDir?: string;
  /** Auto-create directories on write (default: true) */
  autoCreateDirs?: boolean;
}

// ============================================================================
// Local File Adapter
// ============================================================================

export class LocalFileAdapter implements StorageAdapter {
  private baseDir: string;
  private autoCreateDirs: boolean;

  readonly capabilities: AdapterCapabilities = {
    name: 'local-file',
    supportedTypes: ['blob', 'kv'],
    maxItemSize: undefined,
    maxTotalSize: undefined,
    cost: { tier: 'free' },
    performance: {
      readLatency: 'medium',
      writeLatency: 'medium',
      throughput: 'medium',
    },
    features: {
      ttl: false,
    },
  };

  constructor(config: LocalFileConfig = {}) {
    this.baseDir = config.baseDir || './data/files';
    this.autoCreateDirs = config.autoCreateDirs ?? true;
  }

  // --------------------------------------------------------------------------
  // Core operations
  // --------------------------------------------------------------------------

  async get(key: string): Promise<Uint8Array | null> {
    const filePath = this.resolvePath(key);
    try {
      return await Deno.readFile(filePath);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, _ttl?: number): Promise<void> {
    const filePath = this.resolvePath(key);

    if (this.autoCreateDirs) {
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dir) {
        try { await Deno.mkdir(dir, { recursive: true }); } catch { /* exists */ }
      }
    }

    if (value instanceof Uint8Array) {
      await Deno.writeFile(filePath, value);
    } else if (value instanceof ArrayBuffer) {
      await Deno.writeFile(filePath, new Uint8Array(value));
    } else if (typeof value === 'string') {
      await Deno.writeTextFile(filePath, value);
    } else {
      // JSON-serialize anything else
      await Deno.writeTextFile(filePath, JSON.stringify(value, null, 2));
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await Deno.remove(filePath);
    } catch {
      // File doesn't exist — that's fine
    }
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await Deno.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    const scanDir = prefix
      ? `${this.baseDir}/${this.sanitize(prefix)}`
      : this.baseDir;

    try {
      await this.scanDirectory(scanDir, '', keys);
    } catch {
      // Directory doesn't exist
    }

    // Prepend prefix if scanning a subdirectory
    if (prefix) {
      return keys.map(k => `${prefix}${k}`);
    }
    return keys;
  }

  async clear(prefix?: string): Promise<void> {
    const targetDir = prefix
      ? `${this.baseDir}/${this.sanitize(prefix)}`
      : this.baseDir;

    try {
      await Deno.remove(targetDir, { recursive: true });
    } catch {
      // Directory doesn't exist
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private resolvePath(key: string): string {
    return `${this.baseDir}/${this.sanitize(key)}`;
  }

  private sanitize(key: string): string {
    // Strip dangerous path traversal but allow forward slashes for directories
    return key.replace(/\.\./g, '').replace(/[<>:"|?*]/g, '_');
  }

  private async scanDirectory(
    basePath: string,
    prefix: string,
    keys: string[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(basePath)) {
        const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await this.scanDirectory(`${basePath}/${entry.name}`, currentPath, keys);
        } else {
          keys.push(currentPath);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
}

/**
 * Factory function to create a local file adapter
 */
export function createLocalFileAdapter(config?: LocalFileConfig): LocalFileAdapter {
  return new LocalFileAdapter(config);
}
