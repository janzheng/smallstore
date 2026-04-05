/**
 * Local JSON File Storage Adapter for Smallstore
 * 
 * Persists data to local JSON files using Deno's file system.
 * Perfect for development, testing, and inspecting ACO state.
 * 
 * Features:
 * - Data stored as pretty-printed JSON for easy inspection
 * - Namespace-based file organization
 * - Automatic directory creation
 * - Compatible with Smallstore's adapter interface
 * 
 * Storage Layout:
 * - baseDir/{collection}/{key}.json
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities, SearchProvider } from '../types.ts';
import { MemoryBm25SearchProvider } from '../search/memory-bm25-provider.ts';

export interface LocalJsonConfig {
  /**
   * Base directory for storing JSON files
   * Default: './data' (relative to cwd)
   */
  baseDir?: string;

  /**
   * Whether to pretty-print JSON (indented)
   * Default: true
   */
  prettyPrint?: boolean;

  /**
   * Whether to auto-create directories
   * Default: true
   */
  autoCreateDirs?: boolean;
}

/**
 * Local JSON File Storage Adapter
 * 
 * Stores each key as a separate JSON file.
 */
export class LocalJsonAdapter implements StorageAdapter {
  private config: Required<LocalJsonConfig>;
  private cache: Map<string, unknown> = new Map();
  private pendingWrites: Set<string> = new Set();
  private writeTimer: number | null = null;
  private debounceMs = 50; // Debounce writes
  private _searchProvider = new MemoryBm25SearchProvider();

  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'local-json',
    supportedTypes: [
      'object',  // JSON objects
      'kv',      // Primitives (stored as JSON)
    ],
    maxItemSize: undefined, // No limit
    maxTotalSize: undefined, // No limit
    cost: {
      tier: 'free',
    },
    performance: {
      readLatency: 'medium',   // File I/O
      writeLatency: 'medium',  // File I/O (debounced)
      throughput: 'medium',    // Disk-bound
    },
    features: {
      ttl: false, // No TTL support (files don't expire)
      search: true,
    },
  };

  get searchProvider(): SearchProvider {
    return this._searchProvider;
  }

  private _unloadHandler: (() => void) | null = null;

  constructor(config: LocalJsonConfig = {}) {
    this.config = {
      baseDir: config.baseDir || './data',
      prettyPrint: config.prettyPrint ?? true,
      autoCreateDirs: config.autoCreateDirs ?? true,
    };

    // Register beforeunload handler to flush pending writes on process exit
    this._unloadHandler = () => { this.flush(); };
    addEventListener("beforeunload", this._unloadHandler);
  }

  // ============================================================================
  // Core Operations
  // ============================================================================

  async get(key: string): Promise<unknown | null> {
    // Check cache first
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      // Return a clone for object/array values to prevent cache corruption
      return (cached !== null && typeof cached === 'object') ? structuredClone(cached) : cached;
    }

    // Load from file
    const filePath = this.getFilePath(key);
    try {
      const content = await Deno.readTextFile(filePath);
      const value = JSON.parse(content);
      this.cache.set(key, value);
      // Return a clone for object/array values to prevent cache corruption
      return (value !== null && typeof value === 'object') ? structuredClone(value) : value;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, _ttl?: number): Promise<void> {
    // Update cache
    this.cache.set(key, value);

    // Auto-index for search
    this._searchProvider.index(key, value);

    // Schedule debounced write
    this.pendingWrites.add(key);
    this.scheduleWrite();
  }

  async delete(key: string): Promise<void> {
    // Remove from cache and search index
    this.cache.delete(key);
    this._searchProvider.remove(key);
    this.pendingWrites.delete(key);

    // Delete file
    const filePath = this.getFilePath(key);
    try {
      await Deno.remove(filePath);
    } catch {
      // File doesn't exist
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.cache.has(key)) {
      return true;
    }

    const filePath = this.getFilePath(key);
    try {
      await Deno.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    const keys: string[] = [];

    try {
      await this.scanDirectory(this.config.baseDir, '', keys);
    } catch {
      // Directory doesn't exist
    }

    // scanDirectory returns path-based keys (e.g., "smallstore/coll/key")
    // Convert back to colon-separated internal keys (e.g., "smallstore:coll:key")
    const colonKeys = keys.map(k => k.replace(/\//g, ':'));

    if (prefix) {
      return colonKeys.filter(k => k.startsWith(prefix));
    }
    return colonKeys;
  }

  async clear(prefix?: string): Promise<void> {
    if (prefix) {
      // Delete specific prefix
      const parts = prefix.split('/');
      const dir = `${this.config.baseDir}/${parts[0]}`;
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {
        // Directory doesn't exist
      }
      // Clear cache
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      // Clear everything
      this.cache.clear();
      this.pendingWrites.clear();
      try {
        await Deno.remove(this.config.baseDir, { recursive: true });
      } catch {
        // Directory doesn't exist
      }
    }
  }

  async getMany(keys: string[]): Promise<Map<string, unknown>> {
    const results = new Map<string, unknown>();
    for (const key of keys) {
      const value = await this.get(key);
      if (value !== null) {
        results.set(key, value);
      }
    }
    return results;
  }

  async setMany(entries: Map<string, unknown>, ttl?: number): Promise<void> {
    for (const [key, value] of entries) {
      await this.set(key, value, ttl);
    }
    // Force immediate write for batch operations
    await this.flushPendingWrites();
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  private getFilePath(key: string): string {
    // Use ":" as directory separator for organized file layout,
    // sanitize remaining unsafe filename characters
    const pathKey = key
      .replace(/:/g, '/')
      .replace(/[<>"|?*]/g, '_');
    return `${this.config.baseDir}/${pathKey}.json`;
  }

  private async ensureDir(filePath: string): Promise<void> {
    if (!this.config.autoCreateDirs) return;
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch {
      // Directory exists
    }
  }

  private async scanDirectory(basePath: string, prefix: string, keys: string[]): Promise<void> {
    try {
      for await (const entry of Deno.readDir(basePath)) {
        const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        
        if (entry.isDirectory) {
          await this.scanDirectory(`${basePath}/${entry.name}`, currentPath, keys);
        } else if (entry.name.endsWith('.json')) {
          // Remove .json extension to get key
          const key = currentPath.replace(/\.json$/, '');
          keys.push(key);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // ============================================================================
  // Write Debouncing
  // ============================================================================

  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.flushPendingWrites().catch(err => {
        console.error('[LocalJSON] Flush failed:', err);
      });
    }, this.debounceMs);
  }

  private async flushPendingWrites(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    const keysToWrite = Array.from(this.pendingWrites);

    for (const key of keysToWrite) {
      if (this.cache.has(key)) {
        const filePath = this.getFilePath(key);
        await this.ensureDir(filePath);
        const content = this.config.prettyPrint
          ? JSON.stringify(this.cache.get(key), null, 2)
          : JSON.stringify(this.cache.get(key));
        try {
          await Deno.writeTextFile(filePath, content);
          this.pendingWrites.delete(key);
        } catch (error) {
          console.error(`[LocalJSON] Failed to flush write for key "${key}" to ${filePath}:`, error);
          // Don't remove from pendingWrites — retry on next flush
          this.scheduleWrite();
        }
      } else {
        this.pendingWrites.delete(key);
      }
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Force all pending writes to disk immediately.
   * Cancels any pending debounce timer.
   */
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.pendingWrites.size > 0) {
      await this.flushPendingWrites();
    }
  }

  /**
   * Dispose the adapter: flush pending writes and remove event listeners.
   * Call this when the adapter is no longer needed to avoid leaking listeners.
   */
  async dispose(): Promise<void> {
    await this.flush();
    if (this._unloadHandler) {
      removeEventListener("beforeunload", this._unloadHandler);
      this._unloadHandler = null;
    }
  }

  /**
   * Get storage statistics
   */
  getStats() {
    return {
      baseDir: this.config.baseDir,
      cacheSize: this.cache.size,
      pendingWrites: this.pendingWrites.size,
    };
  }

  /**
   * Dump all data (useful for debugging)
   */
  async dump(): Promise<Record<string, unknown>> {
    await this.flush();
    
    const result: Record<string, unknown> = {};
    const keys = await this.keys();
    for (const key of keys) {
      result[key] = await this.get(key);
    }
    return result;
  }
}

/**
 * Factory function to create local JSON storage adapter
 */
export function createLocalJsonAdapter(config?: LocalJsonConfig): LocalJsonAdapter {
  return new LocalJsonAdapter(config);
}

