/**
 * Deno Filesystem Adapter for Smallstore
 *
 * Maps a real directory to a smallstore adapter — keys are file paths,
 * values are native content. Text files return strings, binary files
 * return Uint8Array, JSON files auto-parse.
 *
 * This enables the LLM/VFS "bash-like" interface to work against real
 * files on disk, with the same API used for KV, R2, D1, etc.
 *
 * Key mapping:
 *   store.get('docs/readme.md')  → reads ./docs/readme.md as string
 *   store.set('data.json', obj)  → writes pretty-printed JSON
 *   store.keys('src/')           → lists all files under ./src/
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities, SearchProvider } from '../types.ts';
import { UnsupportedOperationError } from './errors.ts';
import { MemoryBm25SearchProvider } from '../search/memory-bm25-provider.ts';

// ============================================================================
// Config
// ============================================================================

export interface DenoFsConfig {
  /** Base directory (default: '.') */
  baseDir?: string;
  /** Auto-create directories on write (default: true) */
  autoCreateDirs?: boolean;
  /** Refuse all writes (default: false) */
  readOnly?: boolean;
  /** Glob patterns to exclude from keys() (default: node_modules, .git, etc.) */
  exclude?: string[];
}

// ============================================================================
// Text Extension Detection
// ============================================================================

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonl', 'yaml', 'yml', 'toml',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'csv', 'tsv',
  'env', 'sh', 'bash', 'zsh', 'fish',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cpp', 'h',
  'sql', 'graphql', 'gql',
  'ini', 'cfg', 'conf', 'properties',
  'gitignore', 'dockerignore', 'editorconfig',
  'lock', 'log',
]);

function isTextFile(key: string): boolean {
  const dotIdx = key.lastIndexOf('.');
  if (dotIdx < 0) return true; // No extension → assume text
  const ext = key.slice(dotIdx + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.DS_Store', '__pycache__',
  '.deno', '.cache', 'thumbs.db',
];

function shouldExclude(name: string, excludes: string[]): boolean {
  return excludes.includes(name);
}

// ============================================================================
// Deno FS Adapter
// ============================================================================

export class DenoFsAdapter implements StorageAdapter {
  private baseDir: string;
  private autoCreateDirs: boolean;
  private readOnly: boolean;
  private excludes: string[];
  private _searchProvider = new MemoryBm25SearchProvider();
  private _hydratePromise: Promise<void> | null = null;
  private _hydrated = false;
  private _searchProviderWrapper: SearchProvider | null = null;

  readonly capabilities: AdapterCapabilities = {
    name: 'deno-fs',
    supportedTypes: ['object', 'blob', 'kv'],
    cost: { tier: 'free' },
    performance: {
      readLatency: 'low',
      writeLatency: 'low',
      throughput: 'high',
    },
    features: {
      ttl: false,
      search: true,
    },
  };

  get searchProvider(): SearchProvider {
    // Same lazy-hydrate pattern as LocalJsonAdapter: a fresh DenoFsAdapter
    // over an existing directory has an empty BM25 index until every key is
    // re-set. Hydrate on first search; stay sync afterwards.
    if (this._searchProviderWrapper) return this._searchProviderWrapper;

    const provider = this._searchProvider;
    const hydrate = (): Promise<void> => {
      if (!this._hydratePromise) {
        this._hydratePromise = (async () => {
          try {
            const keys = await this.keys();
            for (const k of keys) {
              const v = await this.get(k);
              if (v !== null) provider.index(k, v);
            }
            this._hydrated = true;
          } catch (err) {
            this._hydratePromise = null;
            throw err;
          }
        })();
      }
      return this._hydratePromise;
    };

    this._searchProviderWrapper = {
      get name() { return provider.name; },
      get supportedTypes() { return provider.supportedTypes; },
      index: (key, value) => provider.index(key, value),
      remove: (key) => provider.remove(key),
      search: (query, options) => {
        if (this._hydrated) return provider.search(query, options);
        return hydrate().then(() => provider.search(query, options));
      },
      rebuild: (prefix) => provider.rebuild?.(prefix),
    } as SearchProvider;
    return this._searchProviderWrapper;
  }

  constructor(config: DenoFsConfig = {}) {
    this.baseDir = (config.baseDir || '.').replace(/\/+$/, '');
    this.autoCreateDirs = config.autoCreateDirs ?? true;
    this.readOnly = config.readOnly ?? false;
    this.excludes = config.exclude ?? DEFAULT_EXCLUDES;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  async get(key: string): Promise<any> {
    const filePath = this.resolvePath(key);
    try {
      const bytes = await Deno.readFile(filePath);

      if (isTextFile(key)) {
        const text = new TextDecoder().decode(bytes);
        // Auto-parse JSON files
        if (key.endsWith('.json')) {
          try { return JSON.parse(text); } catch { return text; }
        }
        return text;
      }
      return bytes;
    } catch {
      return null;
    }
  }

  async set(key: string, value: any, _ttl?: number): Promise<void> {
    if (this.readOnly) {
      throw new UnsupportedOperationError(
        'deno-fs', 'set',
        'Adapter is in read-only mode.',
        'Create adapter with readOnly: false',
      );
    }

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
      // Objects → JSON-serialize
      const json = key.endsWith('.json')
        ? JSON.stringify(value, null, 2)
        : JSON.stringify(value);
      await Deno.writeTextFile(filePath, json);
    }

    // Auto-index text files for search (best-effort)
    if (isTextFile(key)) {
      try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        this._searchProvider.index(key, text);
      } catch { /* best-effort */ }
    }
  }

  async delete(key: string): Promise<void> {
    if (this.readOnly) {
      throw new UnsupportedOperationError(
        'deno-fs', 'delete',
        'Adapter is in read-only mode.',
      );
    }

    const filePath = this.resolvePath(key);
    try {
      await Deno.remove(filePath);
    } catch { /* file doesn't exist */ }

    try { this._searchProvider.remove(key); } catch { /* best-effort */ }
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
    } catch { /* directory doesn't exist */ }

    if (prefix) {
      return keys.map(k => `${prefix}${k}`);
    }
    return keys;
  }

  async clear(prefix?: string): Promise<void> {
    if (this.readOnly) {
      throw new UnsupportedOperationError(
        'deno-fs', 'clear',
        'Adapter is in read-only mode.',
      );
    }

    if (!prefix) {
      // Don't nuke the entire baseDir — just clear the search index
      // Deleting all files in a mounted directory is too dangerous
      this._searchProvider.clear();
      return;
    }

    const targetDir = `${this.baseDir}/${this.sanitize(prefix)}`;
    try {
      await Deno.remove(targetDir, { recursive: true });
    } catch { /* doesn't exist */ }

    // Rebuild search index since we removed files
    this._searchProvider.clear();
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private resolvePath(key: string): string {
    const sanitized = this.sanitize(key);
    const resolved = `${this.baseDir}/${sanitized}`;
    // Containment check: ensure resolved path stays within baseDir
    // Normalize both paths to remove any remaining traversal tricks
    const normalizedBase = this.baseDir.replace(/\/+$/, '');
    const normalizedResolved = resolved.replace(/\/+/g, '/');
    if (!normalizedResolved.startsWith(normalizedBase + '/') && normalizedResolved !== normalizedBase) {
      throw new Error(`Path traversal detected: key "${key}" resolves outside base directory`);
    }
    return resolved;
  }

  private sanitize(key: string): string {
    // Remove path traversal attempts
    let clean = key.replace(/\.\./g, '').replace(/[<>:"|?*]/g, '_');
    // Remove leading slashes (absolute path prevention)
    clean = clean.replace(/^[/\\]+/, '');
    // Remove unicode dot sequences that could bypass traversal checks
    clean = clean.replace(/[\u2024\u2025\u2026]/g, '.');
    return clean;
  }

  private async scanDirectory(
    basePath: string,
    prefix: string,
    keys: string[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(basePath)) {
        if (shouldExclude(entry.name, this.excludes)) continue;

        const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await this.scanDirectory(`${basePath}/${entry.name}`, currentPath, keys);
        } else {
          keys.push(currentPath);
        }
      }
    } catch { /* directory doesn't exist */ }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createDenoFsAdapter(config?: DenoFsConfig): DenoFsAdapter {
  return new DenoFsAdapter(config);
}
