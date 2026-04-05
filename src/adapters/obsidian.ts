/**
 * Obsidian Vault Storage Adapter for Smallstore
 *
 * Uses VaultGraph to treat an Obsidian vault as a storage backend.
 * Keys are vault-relative paths without .md extension (e.g., "folder/My Note").
 * Values returned by get() are Note JSON objects with resolved wikilinks.
 * Values accepted by set() can be raw markdown strings or Note objects.
 *
 * Features:
 * - Bidirectional markdown <-> JSON conversion
 * - Wikilink resolution
 * - Full-text search via FTS5
 * - Frontmatter property filtering
 * - File watching for live index updates
 */

import type { StorageAdapter, AdapterQueryOptions, AdapterQueryResult } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import { VaultGraph } from '../vault-graph/vault.ts';
import { decodeMarkdown, encodeMarkdown, pathToId } from '../vault-graph/codec.ts';
import type { Note } from '../vault-graph/note-types.ts';
import type { VaultOptions } from '../vault-graph/types.ts';
import { join } from '@std/path';
import { ensureDir } from '@std/fs/ensure-dir';

// ── Config ───────────────────────────────────────────────────────

export interface ObsidianAdapterConfig {
  /** Path to the Obsidian vault directory */
  vaultDir: string;
  /** Directory for VaultGraph cache (default: ".vault-graph") */
  cacheDir?: string;
  /** Watch for file changes (default: false) */
  watch?: boolean;
  /** Glob patterns to exclude from indexing */
  exclude?: string[];
}

// ── Adapter ──────────────────────────────────────────────────────

export class ObsidianAdapter implements StorageAdapter {
  private config: ObsidianAdapterConfig;
  private vault: VaultGraph | null = null;
  private initPromise: Promise<void> | null = null;

  readonly capabilities: AdapterCapabilities = {
    name: 'obsidian',
    supportedTypes: ['object', 'kv'],
    maxItemSize: undefined,
    maxTotalSize: undefined,
    cost: {
      tier: 'free',
    },
    performance: {
      readLatency: 'low',     // SQLite-backed
      writeLatency: 'medium', // File I/O + reindex
      throughput: 'medium',
    },
    features: {
      query: true,
      search: true,
    },
  };

  constructor(config: ObsidianAdapterConfig) {
    this.config = config;
  }

  // ── Lazy init ──────────────────────────────────────────────────

  private async ensureVault(): Promise<VaultGraph> {
    if (this.vault) return this.vault;

    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.config.vaultDir);
        const opts: VaultOptions = {
          cacheDir: this.config.cacheDir,
          watch: this.config.watch,
          exclude: this.config.exclude,
        };
        this.vault = await VaultGraph.open(this.config.vaultDir, opts);
      })();
    }

    await this.initPromise;
    return this.vault!;
  }

  // ── Key <-> Path helpers ───────────────────────────────────────

  /** Convert a storage key to a vault-relative file path */
  private keyToPath(key: string): string {
    // If key already has a recognized extension, use as-is
    if (/\.\w+$/.test(key) && !key.endsWith('.md')) {
      return key;
    }
    // Strip .md if someone passes it, then add it back
    const base = key.replace(/\.md$/, '');
    return `${base}.md`;
  }

  /** Convert a vault-relative file path to a storage key */
  private pathToKey(path: string): string {
    if (path.endsWith('.md')) {
      return path.slice(0, -3);
    }
    return path;
  }

  // ── CRUD ───────────────────────────────────────────────────────

  async get(key: string): Promise<Note | null> {
    const vault = await this.ensureVault();
    const path = this.keyToPath(key);

    if (!vault.fileExists(path)) return null;

    try {
      const raw = await vault.readFile(path);
      // Pass file timestamps for stable hashing across reads
      const absPath = join(this.config.vaultDir, path);
      let tsOpts: { createdAt?: string; modifiedAt?: string } | undefined;
      try {
        const stat = await Deno.stat(absPath);
        tsOpts = {
          createdAt: stat.birthtime?.toISOString(),
          modifiedAt: stat.mtime?.toISOString(),
        };
      } catch { /* use defaults */ }
      const note = await decodeMarkdown(raw, path, tsOpts);

      // Mark resolved wikilinks
      if (note.links) {
        for (const link of note.links) {
          const resolved = vault.resolveLink(link.target, path);
          if (resolved) {
            link.resolved = true;
          }
        }
      }

      return note;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string | Note | Record<string, unknown>): Promise<void> {
    const vault = await this.ensureVault();
    const path = this.keyToPath(key);
    const absPath = join(this.config.vaultDir, path);

    // Ensure parent directory exists
    const dir = absPath.substring(0, absPath.lastIndexOf('/'));
    if (dir) await ensureDir(dir);

    let markdown: string;

    if (typeof value === 'string') {
      // Raw markdown string
      markdown = value;
    } else if (value && typeof value === 'object' && 'raw' in value && typeof (value as Note).raw === 'string') {
      // Note object with raw — use the raw markdown directly
      markdown = (value as Note).raw;
    } else if (value && typeof value === 'object') {
      // Note-like object or plain object — encode to markdown
      markdown = encodeMarkdown({ ...value, path } as Note);
    } else {
      // Fallback: stringify as frontmatter-only note
      markdown = `---\nvalue: ${JSON.stringify(value)}\n---\n`;
    }

    await Deno.writeTextFile(absPath, markdown);
    await vault.reindexFile(path);
  }

  async delete(key: string): Promise<void> {
    const vault = await this.ensureVault();
    const path = this.keyToPath(key);
    const absPath = join(this.config.vaultDir, path);

    try {
      await Deno.remove(absPath);
      vault.removeFile(path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  async has(key: string): Promise<boolean> {
    const vault = await this.ensureVault();
    const path = this.keyToPath(key);
    return vault.fileExists(path);
  }

  async keys(prefix?: string): Promise<string[]> {
    const vault = await this.ensureVault();
    const mdFiles = vault.getMarkdownFiles();
    let keys = mdFiles.map((p) => this.pathToKey(p));

    if (prefix) {
      keys = keys.filter((k) => k.startsWith(prefix));
    }

    return keys;
  }

  async clear(prefix?: string): Promise<void> {
    const vault = await this.ensureVault();
    const allKeys = await this.keys(prefix);

    for (const key of allKeys) {
      await this.delete(key);
    }
  }

  // ── Query (FTS + frontmatter filtering) ────────────────────────

  async query(options: AdapterQueryOptions): Promise<AdapterQueryResult> {
    const vault = await this.ensureVault();
    const { filter, sort, limit, skip, prefix } = options;

    let paths: string[];

    // If filter has $search, use FTS
    if (filter?.$search && typeof filter.$search === 'string') {
      const results = vault.search(filter.$search, { limit: 1000 });
      paths = results.map((r) => r.path);
    } else if (filter?.$tag && typeof filter.$tag === 'string') {
      // Tag search
      paths = vault.searchByTag(filter.$tag);
    } else {
      // Start with all markdown files
      paths = vault.getMarkdownFiles();
    }

    // Apply prefix filter
    if (prefix) {
      paths = paths.filter((p) => this.pathToKey(p).startsWith(prefix));
    }

    // Load notes and apply frontmatter filters
    const notes: Note[] = [];
    for (const path of paths) {
      const key = this.pathToKey(path);
      const note = await this.get(key);
      if (!note) continue;

      // Apply frontmatter property filters (skip $search and $tag which are special)
      if (filter) {
        let match = true;
        for (const [k, v] of Object.entries(filter)) {
          if (k === '$search' || k === '$tag') continue;
          const propValue = note.properties?.[k];
          if (propValue !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      notes.push(note);
    }

    // Sort
    if (sort) {
      const [sortKey, sortDir] = Object.entries(sort)[0] ?? [];
      if (sortKey) {
        notes.sort((a, b) => {
          const aVal = a.properties?.[sortKey] ?? '';
          const bVal = b.properties?.[sortKey] ?? '';
          const cmp = String(aVal).localeCompare(String(bVal));
          return sortDir === -1 ? -cmp : cmp;
        });
      }
    }

    const totalCount = notes.length;

    // Apply skip and limit
    const start = skip ?? 0;
    const end = limit ? start + limit : undefined;
    const data = notes.slice(start, end);

    return { data, totalCount };
  }

  // ── Vault access (for advanced usage) ──────────────────────────

  /** Get the underlying VaultGraph instance (lazy-initializes if needed) */
  async getVault(): Promise<VaultGraph> {
    return this.ensureVault();
  }

  /** Close the vault and release resources */
  close(): void {
    if (this.vault) {
      this.vault.close();
      this.vault = null;
      this.initPromise = null;
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────

export function createObsidianAdapter(config: ObsidianAdapterConfig): ObsidianAdapter {
  return new ObsidianAdapter(config);
}
