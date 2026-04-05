/**
 * VaultGraph — headless, Obsidian-compatible vault indexer.
 *
 * Usage:
 *   const vault = await VaultGraph.open("/path/to/vault");
 *   console.log(vault.stats());
 *   vault.close();
 *
 * Adapted for smallstore: dropped Obsidian-app-specific methods
 * (getBookmarks, getConfig, getCorePlugins, getBaseSchema),
 * added reindexFile() and removeFile() for adapter write support.
 */

import { walk } from "@std/fs/walk";
import { relative, join } from "@std/path";
import { parseFile } from "./parser.ts";
import { buildLookups, resolveAllLinks, resolveLink as resolveLinkFn, basenameNoExt } from "./resolver.ts";
import { SqliteStore } from "./store.ts";
import { VaultWatcher } from "./watcher.ts";
import type { EventHandler } from "./watcher.ts";
import type {
  FileMetadata,
  VaultOptions,
  VaultHealth,
  VaultStats,
  Lookups,
  PropertyInfo,
  PropertyType,
} from "./types.ts";

type VaultEventCallback = (path: string) => void;
type VaultLinkCallback = () => void;

export class VaultGraph {
  private store: SqliteStore;
  private _vaultDir: string;
  private _lookups: Lookups | null = null;
  private _metadataMap: Map<string, FileMetadata> = new Map();
  private _watcher: VaultWatcher | null = null;
  private _opts: VaultOptions = {};

  // Event listeners
  private _onMetadataChanged: VaultEventCallback[] = [];
  private _onResolvedLinksChanged: VaultLinkCallback[] = [];
  private _onFileCreated: VaultEventCallback[] = [];
  private _onFileDeleted: VaultEventCallback[] = [];
  private _onIndexError: VaultEventCallback[] = [];

  private constructor(store: SqliteStore, vaultDir: string) {
    this.store = store;
    this._vaultDir = vaultDir;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  static async open(
    vaultDir: string,
    opts?: VaultOptions,
  ): Promise<VaultGraph> {
    const cacheDir = opts?.cacheDir ?? ".vault-graph";
    const cachePath = join(vaultDir, cacheDir);

    // Ensure cache directory exists
    await Deno.mkdir(cachePath, { recursive: true });

    const dbPath = join(cachePath, "cache.db");
    const store = new SqliteStore(dbPath);

    // Check if schema is valid
    let needsColdStart = !store.validateSchemaVersion();

    if (needsColdStart) {
      store.createSchema();
    }

    const vault = new VaultGraph(store, vaultDir);
    vault._opts = opts ?? {};

    if (needsColdStart) {
      await vault.fullIndex(opts?.exclude);
    } else {
      await vault.warmStart(opts?.exclude);
    }

    // Start file watcher if requested
    if (opts?.watch) {
      await vault.startWatching();
    }

    return vault;
  }

  close(): void {
    this._watcher?.close();
    this.store.close();
  }

  get vaultDir(): string {
    return this._vaultDir;
  }

  // ── Indexing ───────────────────────────────────────────────────

  /** Discover all files in the vault */
  private async discoverFiles(exclude?: string[]): Promise<string[]> {
    const files: string[] = [];
    const excludeSet = new Set(exclude ?? []);

    for await (
      const entry of walk(this._vaultDir, {
        includeDirs: false,
        followSymlinks: false,
      })
    ) {
      const relPath = relative(this._vaultDir, entry.path);

      // Skip hidden directories and .obsidian config
      if (relPath.startsWith(".")) continue;
      if (relPath.includes("/.")) continue;

      // Skip our own cache
      if (relPath.startsWith(".vault-graph")) continue;

      // Skip excluded patterns
      if (excludeSet.has(relPath)) continue;

      files.push(relPath);
    }

    return files;
  }

  /** Cold start: parse all files and build the full index */
  private async fullIndex(exclude?: string[]): Promise<void> {
    const files = await this.discoverFiles(exclude);
    const metadataMap = new Map<string, FileMetadata>();

    // Parse all files
    for (const relPath of files) {
      const absPath = join(this._vaultDir, relPath);
      try {
        const content = await Deno.readTextFile(absPath);
        const hash = await this.computeHash(content);
        const stat = await Deno.stat(absPath);

        const metadata = parseFile(content, relPath);
        metadataMap.set(relPath, metadata);

        // Store file cache and metadata
        this.store.upsertFileCache(relPath, {
          mtime: stat.mtime?.getTime() ?? Date.now(),
          size: stat.size,
          hash,
        });
        this.store.upsertFileMetadata(relPath, metadata);
      } catch {
        // Binary or unreadable file — still register in file_cache
        try {
          const stat = await Deno.stat(absPath);
          this.store.upsertFileCache(relPath, {
            mtime: stat.mtime?.getTime() ?? Date.now(),
            size: stat.size,
            hash: "",
          });
          // Empty metadata for non-text files
          const emptyMeta: FileMetadata = {
            path: relPath,
            frontmatter: null,
            frontmatterPosition: null,
            links: [],
            embeds: [],
            externalLinks: [],
            headings: [],
            sections: [],
            tags: [],
            blockIds: [],
            listItems: [],
            footnotes: [],
          };
          metadataMap.set(relPath, emptyMeta);
          this.store.upsertFileMetadata(relPath, emptyMeta);
        } catch {
          // Skip completely unreadable files
        }
      }
    }

    // Build lookups and resolve links
    const lookups = buildLookups(files, metadataMap);
    this._lookups = lookups;
    this._metadataMap = metadataMap;

    const { resolved, unresolved } = resolveAllLinks(metadataMap, lookups);

    // Build full-text search index
    this.buildFTSIndex();

    // Persist resolved links
    this.store.transaction(() => {
      for (const [source, targets] of resolved) {
        this.store.upsertResolvedLinks(source, targets);
      }
      for (const [source, targets] of unresolved) {
        this.store.upsertUnresolvedLinks(source, targets);
      }

      // Persist file lookups
      for (const [basename, path] of lookups.uniqueFileLookup) {
        this.store.upsertFileLookup(basename, path);
      }

      // Persist alias lookups
      for (const [alias, path] of lookups.aliasLookup) {
        this.store.upsertAlias(alias, path);
      }
    });
  }

  /** Warm start: load cache, diff, reparse changed files */
  private async warmStart(exclude?: string[]): Promise<void> {
    const files = await this.discoverFiles(exclude);
    const cachedFiles = this.store.getAllFileCaches();
    const currentFileSet = new Set(files);

    let hasChanges = false;

    // Check for deleted files
    for (const [path] of cachedFiles) {
      if (!currentFileSet.has(path)) {
        this.store.deleteFileCache(path);
        this.store.deleteFileMetadata(path);
        this.store.deleteResolvedLinksFromSource(path);
        this.store.deleteUnresolvedLinksFromSource(path);
        hasChanges = true;
      }
    }

    // Check for new or modified files
    for (const relPath of files) {
      const absPath = join(this._vaultDir, relPath);
      const cached = cachedFiles.get(relPath);

      try {
        const stat = await Deno.stat(absPath);
        const mtime = stat.mtime?.getTime() ?? Date.now();

        if (cached && cached.mtime === mtime) {
          // If metadata is missing despite having cache, recover it
          if (!this.store.getFileMetadata(relPath)) {
            const content = await Deno.readTextFile(absPath);
            const metadata = parseFile(content, relPath);
            this.store.upsertFileMetadata(relPath, metadata);
            hasChanges = true;
          }
          continue;
        }

        // File is new or modified — reparse
        const content = await Deno.readTextFile(absPath);
        const hash = await this.computeHash(content);

        if (cached && cached.hash === hash) {
          // Content unchanged — update mtime cache
          this.store.upsertFileCache(relPath, { mtime, size: stat.size, hash });
          // If metadata is missing (e.g. previous incomplete index), reparse it
          if (!this.store.getFileMetadata(relPath)) {
            const metadata = parseFile(content, relPath);
            this.store.upsertFileMetadata(relPath, metadata);
            hasChanges = true;
          }
          continue;
        }

        const metadata = parseFile(content, relPath);
        this.store.upsertFileCache(relPath, { mtime, size: stat.size, hash });
        this.store.upsertFileMetadata(relPath, metadata);
        hasChanges = true;
      } catch {
        // Binary or unreadable — register with empty metadata
        if (!cached) {
          try {
            const stat = await Deno.stat(absPath);
            this.store.upsertFileCache(relPath, {
              mtime: stat.mtime?.getTime() ?? Date.now(),
              size: stat.size,
              hash: "",
            });
            hasChanges = true;
          } catch { /* skip */ }
        }
      }
    }

    if (hasChanges) {
      // Rebuild lookups and re-resolve all links
      await this.rebuildLookups(files);
      // Rebuild FTS index
      this.buildFTSIndex();
    } else {
      // Load metadata from store and rebuild lookups (in-memory only, not persisted)
      this.loadMetadataFromStore(files);
      this._lookups = buildLookups(files, this._metadataMap);
      // Rebuild FTS index (contentless FTS tables don't persist content)
      this.buildFTSIndex();
    }
  }

  /** Rebuild lookup tables and re-resolve all links */
  private async rebuildLookups(files: string[]): Promise<void> {
    this.loadMetadataFromStore(files);
    const lookups = buildLookups(files, this._metadataMap);
    this._lookups = lookups;

    const { resolved, unresolved } = resolveAllLinks(this._metadataMap, lookups);

    this.store.transaction(() => {
      // Clear existing links
      for (const path of files) {
        this.store.deleteResolvedLinksFromSource(path);
        this.store.deleteUnresolvedLinksFromSource(path);
      }

      for (const [source, targets] of resolved) {
        this.store.upsertResolvedLinks(source, targets);
      }
      for (const [source, targets] of unresolved) {
        this.store.upsertUnresolvedLinks(source, targets);
      }
    });
  }

  /** Load all file metadata from the SQLite store */
  private loadMetadataFromStore(files: string[]): void {
    this._metadataMap.clear();
    for (const path of files) {
      const meta = this.store.getFileMetadata(path);
      if (meta) {
        this._metadataMap.set(path, meta);
      }
    }
  }

  // ── Hashing ────────────────────────────────────────────────────

  private async computeHash(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ── Graph: Resolved & Unresolved Links ─────────────────────────

  get resolvedLinks(): ReadonlyMap<string, ReadonlyMap<string, number>> {
    return this.store.getResolvedLinks();
  }

  get unresolvedLinks(): ReadonlyMap<string, ReadonlyMap<string, number>> {
    return this.store.getUnresolvedLinks();
  }

  getBacklinksFor(path: string): Map<string, number> {
    return this.store.getBacklinksFor(path);
  }

  getOrphans(): string[] {
    return this.store.getOrphans();
  }

  getDeadends(): string[] {
    return this.store.getDeadends();
  }

  // ── Per-File Metadata ──────────────────────────────────────────

  getCache(path: string): FileMetadata | null {
    return this.store.getFileMetadata(path);
  }

  getFrontmatter(path: string): Record<string, unknown> | null {
    const meta = this.store.getFileMetadata(path);
    return meta?.frontmatter ?? null;
  }

  // ── Tags ───────────────────────────────────────────────────────

  getTags(): Map<string, number> {
    const tagCounts = new Map<string, number>();

    // Collect inline tags from all files
    for (const [, meta] of this._metadataMap) {
      for (const tag of meta.tags) {
        tagCounts.set(tag.tag, (tagCounts.get(tag.tag) ?? 0) + 1);
      }

      // Also collect frontmatter tags
      const fmTags = meta.frontmatter?.tags;
      if (Array.isArray(fmTags)) {
        for (const t of fmTags) {
          if (typeof t === "string") {
            const tag = t.startsWith("#") ? t : `#${t}`;
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      }
    }

    // Add parent tag counts (hierarchical)
    const withParents = new Map<string, number>(tagCounts);
    for (const [tag, count] of tagCounts) {
      const parts = tag.replace(/^#/, "").split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = `#${parts.slice(0, i).join("/")}`;
        withParents.set(parent, (withParents.get(parent) ?? 0) + count);
      }
    }

    return withParents;
  }

  getFilesWithTag(tag: string): string[] {
    const normalizedQuery = tag.replace(/^#/, "").toLowerCase();
    const results: string[] = [];

    for (const [path, meta] of this._metadataMap) {
      // Check inline tags
      for (const t of meta.tags) {
        const normalizedTag = t.tag.replace(/^#/, "").toLowerCase();
        if (
          normalizedTag === normalizedQuery ||
          normalizedTag.startsWith(normalizedQuery + "/")
        ) {
          results.push(path);
          break;
        }
      }

      // Check frontmatter tags
      const fmTags = meta.frontmatter?.tags;
      if (Array.isArray(fmTags) && !results.includes(path)) {
        for (const t of fmTags) {
          if (typeof t === "string") {
            const normalized = t.toLowerCase();
            if (
              normalized === normalizedQuery ||
              normalized.startsWith(normalizedQuery + "/")
            ) {
              results.push(path);
              break;
            }
          }
        }
      }
    }

    return results;
  }

  // ── Files ──────────────────────────────────────────────────────

  getFiles(): string[] {
    return [...this._metadataMap.keys()];
  }

  getMarkdownFiles(): string[] {
    return [...this._metadataMap.keys()].filter((p) => p.endsWith(".md"));
  }

  async readFile(path: string): Promise<string> {
    return await Deno.readTextFile(join(this._vaultDir, path));
  }

  fileExists(path: string): boolean {
    return this._metadataMap.has(path);
  }

  // ── Link Resolution ────────────────────────────────────────────

  resolveLink(linkText: string, sourcePath: string): string | null {
    if (!this._lookups) return null;

    // Split heading/block subpath from link text: "File#heading" → target="File", subpath="#heading"
    let target = linkText;
    let subpath: string | null = null;
    const hashIdx = linkText.indexOf("#");
    if (hashIdx >= 0) {
      target = linkText.slice(0, hashIdx);
      subpath = linkText.slice(hashIdx);
    }

    const result = resolveLinkFn(target, subpath, sourcePath, this._lookups);
    return result?.path ?? null;
  }

  getAliases(): Map<string, string> {
    return this.store.getAllAliases();
  }

  // ── Health & Stats ─────────────────────────────────────────────

  health(): VaultHealth {
    const nodeCount = this.store.getFileCount();
    const edgeCount = this.store.getLinkCount();
    const orphans = this.store.getOrphans();
    const deadends = this.store.getDeadends();
    const unresolvedCount = this.store.getUnresolvedLinkCount();
    const hubNodes = this.store.getHubNodes(10);

    const maxEdges = nodeCount * (nodeCount - 1);
    const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

    return {
      nodeCount,
      edgeCount,
      density,
      orphans,
      deadends,
      unresolvedCount,
      hubNodes,
    };
  }

  stats(): VaultStats {
    const tags = this.getTags();
    return {
      fileCount: this.store.getFileCount(),
      markdownFileCount: this.store.getMarkdownFileCount(),
      linkCount: this.store.getLinkCount(),
      unresolvedLinkCount: this.store.getUnresolvedLinkCount(),
      tagCount: tags.size,
      aliasCount: this.store.getAliasCount(),
    };
  }

  // ── Property Types ─────────────────────────────────────────────

  /** Infer property types from all frontmatter across the vault */
  getPropertyTypes(): PropertyInfo[] {
    const propMap = new Map<string, { type: PropertyType; count: number }>();

    for (const [, meta] of this._metadataMap) {
      if (!meta.frontmatter) continue;
      for (const [key, value] of Object.entries(meta.frontmatter)) {
        if (key === "position") continue; // skip internal position key
        const existing = propMap.get(key);
        const inferredType = this.inferPropertyType(key, value);
        if (existing) {
          existing.count++;
        } else {
          propMap.set(key, { type: inferredType, count: 1 });
        }
      }
    }

    // Obsidian tracks certain built-in property names even when count is 0
    const builtins: [string, PropertyType][] = [["cssclasses", "multitext"]];
    for (const [name, type] of builtins) {
      if (!propMap.has(name)) propMap.set(name, { type, count: 0 });
    }

    return Array.from(propMap.entries())
      .map(([name, info]) => ({ name, type: info.type, count: info.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private inferPropertyType(key: string, value: unknown): PropertyType {
    if (key === "aliases") return "aliases";
    if (key === "tags") return "tags";
    if (typeof value === "boolean") return "checkbox";
    if (typeof value === "number") return "number";
    if (Array.isArray(value)) return "multitext";
    if (typeof value === "string") {
      // Check for date pattern YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
      // Check for datetime pattern
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "datetime";
    }
    return "text";
  }

  // ── Search ─────────────────────────────────────────────────────

  /** Full-text search across vault content */
  search(
    query: string,
    opts?: { limit?: number },
  ): { path: string; rank: number; snippet: string }[] {
    return this.store.searchFTS(query, opts?.limit ?? 20);
  }

  /** Search files by tag with hierarchical prefix matching */
  searchByTag(tag: string): string[] {
    return this.store.searchByTag(tag).map((r) => r.path);
  }

  // ── FTS Index ─────────────────────────────────────────────────

  /** Build full-text search index from all metadata */
  private buildFTSIndex(): void {
    this.store.clearFTSIndex();
    this.store.transaction(() => {
      for (const [path, meta] of this._metadataMap) {
        if (!path.endsWith(".md")) continue;
        const title = basenameNoExt(path);
        const tags = meta.tags.map((t) => t.tag.replace("#", "")).join(" ");
        // Get file content for FTS indexing
        const contentParts: string[] = [];
        for (const h of meta.headings) {
          contentParts.push(h.heading);
        }
        // Include frontmatter description if available
        if (meta.frontmatter?.description && typeof meta.frontmatter.description === "string") {
          contentParts.push(meta.frontmatter.description);
        }
        // Include frontmatter tags
        const fmTags = meta.frontmatter?.tags;
        if (Array.isArray(fmTags)) {
          for (const t of fmTags) {
            if (typeof t === "string") contentParts.push(t);
          }
        }
        this.store.indexFileForSearch(path, title, contentParts.join(" "), tags);
      }
    });
  }

  /** Index a single file for FTS (used in incremental updates) */
  private indexSingleFileForSearch(path: string): void {
    if (!path.endsWith(".md")) return;
    const meta = this._metadataMap.get(path);
    if (!meta) return;
    const title = basenameNoExt(path);
    const tags = meta.tags.map((t) => t.tag.replace("#", "")).join(" ");
    const contentParts: string[] = [];
    for (const h of meta.headings) {
      contentParts.push(h.heading);
    }
    if (meta.frontmatter?.description && typeof meta.frontmatter.description === "string") {
      contentParts.push(meta.frontmatter.description);
    }
    const fmTags = meta.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string") contentParts.push(t);
      }
    }
    this.store.indexFileForSearch(path, title, contentParts.join(" "), tags);
  }

  // ── Adapter Write Support ──────────────────────────────────────

  /**
   * Re-index a single file after it has been written externally.
   * Used by the Obsidian adapter after set() writes a file.
   */
  async reindexFile(relPath: string): Promise<void> {
    const absPath = join(this._vaultDir, relPath);

    try {
      const content = await Deno.readTextFile(absPath);
      const hash = await this.computeHash(content);
      const metadata = parseFile(content, relPath);
      const stat = await Deno.stat(absPath);

      this.store.upsertFileCache(relPath, {
        mtime: stat.mtime?.getTime() ?? Date.now(),
        size: stat.size,
        hash,
      });
      this.store.upsertFileMetadata(relPath, metadata);
      this._metadataMap.set(relPath, metadata);

      // Rebuild lookups AFTER upsert so the new file is included
      const files = [...this._metadataMap.keys()];
      this._lookups = buildLookups(files, this._metadataMap);

      // Resolve this file's links
      await this.resolveFileAndUpdate(relPath);

      // Check if previously-unresolved links now resolve to this file
      const basename = basenameNoExt(relPath).toLowerCase();
      const aliases = (metadata.frontmatter?.aliases as string[]) ?? [];
      this.resolveNewlyMatchingLinks(basename, relPath, aliases);

      // Update FTS index
      this.indexSingleFileForSearch(relPath);

      this.emit("metadata-changed", relPath);
      this.emit("resolved-links-changed");
    } catch (error) {
      console.warn(`[VaultGraph] Failed to parse ${relPath}:`, error);
      this.emit("index-error", relPath);
      // Binary file — register with empty metadata
      try {
        const stat = await Deno.stat(absPath);
        this.store.upsertFileCache(relPath, {
          mtime: stat.mtime?.getTime() ?? Date.now(),
          size: stat.size,
          hash: "",
        });
        const emptyMeta: FileMetadata = {
          path: relPath,
          frontmatter: null,
          frontmatterPosition: null,
          links: [],
          embeds: [],
          externalLinks: [],
          headings: [],
          sections: [],
          tags: [],
          blockIds: [],
          listItems: [],
          footnotes: [],
        };
        this._metadataMap.set(relPath, emptyMeta);
        this.store.upsertFileMetadata(relPath, emptyMeta);
      } catch { /* skip */ }
    }
  }

  /**
   * Remove a file from the index after it has been deleted externally.
   * Used by the Obsidian adapter after delete() removes a file.
   */
  removeFile(path: string): void {
    // Move resolved links TO this file into unresolved
    const incomingLinks = this.store.getResolvedLinksToTarget(path);
    for (const { source, count } of incomingLinks) {
      const targetName = basenameNoExt(path).toLowerCase();
      const existing = this.store.getUnresolvedLinks();
      const sourceUnresolved = existing.get(source) ?? new Map();
      this.store.deleteResolvedLink(source, path);
      // Add to unresolved
      const uTargets = new Map(sourceUnresolved);
      uTargets.set(targetName, (sourceUnresolved.get(targetName) ?? 0) + count);
      this.store.upsertUnresolvedLinks(source, uTargets);
    }

    // Remove all links FROM this file
    this.store.deleteResolvedLinksFromSource(path);
    this.store.deleteUnresolvedLinksFromSource(path);

    // Remove from lookups
    this.store.deleteFileLookup(basenameNoExt(path).toLowerCase());
    this.store.deleteAliasesForPath(path);
    this.store.deleteFileCache(path);
    this.store.deleteFileMetadata(path);
    this._metadataMap.delete(path);

    // Rebuild lookups without this file
    const files = [...this._metadataMap.keys()];
    this._lookups = buildLookups(files, this._metadataMap);

    this.emit("file-deleted", path);
    this.emit("resolved-links-changed");
  }

  // ── File Watching ─────────────────────────────────────────────

  /** Start watching for file changes */
  async startWatching(): Promise<void> {
    if (this._watcher) return;

    const handler: EventHandler = {
      onModify: (path) => this.handleModify(path),
      onCreate: (path) => this.handleCreate(path),
      onDelete: (path) => this.handleDelete(path),
      onRename: (oldPath, newPath) => this.handleRename(oldPath, newPath),
    };

    this._watcher = new VaultWatcher(
      this._vaultDir,
      handler,
      (path: string) => this.store.getFileCache(path)?.hash ?? null,
    );
    await this._watcher.start();
  }

  /** Stop watching for file changes */
  stopWatching(): void {
    this._watcher?.close();
    this._watcher = null;
  }

  /** Pause watching (for bulk operations) */
  pauseWatcher(): void {
    this._watcher?.pause();
  }

  /** Resume watching — triggers warm-start catch-up */
  async resumeWatcher(): Promise<void> {
    this._watcher?.resume();
    // Catch-up: re-diff to find changes made while paused
    await this.warmStart(this._opts.exclude);
  }

  get isWatching(): boolean {
    return this._watcher !== null && !this._watcher.isPaused;
  }

  // ── Event Handlers ──────────────────────────────────────────────

  private async handleModify(path: string): Promise<void> {
    // If file isn't known yet, treat as a create (macOS fires modify after create)
    if (!this._metadataMap.has(path)) {
      return this.handleCreate(path);
    }

    const absPath = join(this._vaultDir, path);
    try {
      const content = await Deno.readTextFile(absPath);
      const hash = await this.computeHash(content);

      // Check if content actually changed
      const cached = this.store.getFileCache(path);
      if (cached && cached.hash === hash) {
        const stat = await Deno.stat(absPath);
        this.store.upsertFileCache(path, {
          mtime: stat.mtime?.getTime() ?? Date.now(),
          size: stat.size,
          hash,
        });
        return;
      }

      // Reparse the file
      const metadata = parseFile(content, path);
      const stat = await Deno.stat(absPath);
      this.store.upsertFileCache(path, {
        mtime: stat.mtime?.getTime() ?? Date.now(),
        size: stat.size,
        hash,
      });
      this.store.upsertFileMetadata(path, metadata);
      this._metadataMap.set(path, metadata);

      // Re-resolve this file's links
      await this.resolveFileAndUpdate(path);

      // Update FTS index
      this.indexSingleFileForSearch(path);

      this.emit("metadata-changed", path);
    } catch {
      // File might have been deleted between event and handling
    }
  }

  private async handleCreate(path: string): Promise<void> {
    // Delegate to reindexFile which handles all the same logic
    await this.reindexFile(path);
  }

  private async handleDelete(path: string): Promise<void> {
    this.removeFile(path);
  }

  private async handleRename(oldPath: string, newPath: string): Promise<void> {
    // Attempt store updates first — if they fail, metadata stays consistent
    try {
      // Update DB entries
      this.store.renameFileEntries(oldPath, newPath);
      this.store.renameResolvedLinkPaths(oldPath, newPath);
      this.store.updateAliasPath(oldPath, newPath);

      // Update lookup tables
      this.store.deleteFileLookup(basenameNoExt(oldPath).toLowerCase());
      this.store.upsertFileLookup(basenameNoExt(newPath).toLowerCase(), newPath);
    } catch (err) {
      // Store update failed — metadata unchanged, safe to re-throw
      throw err;
    }

    // Only update in-memory metadata after successful store operation
    const meta = this._metadataMap.get(oldPath);
    if (meta) {
      this._metadataMap.delete(oldPath);
      meta.path = newPath;
      this._metadataMap.set(newPath, meta);
    }

    // Rebuild lookups
    const files = [...this._metadataMap.keys()];
    this._lookups = buildLookups(files, this._metadataMap);

    this.emit("metadata-changed", newPath);
    this.emit("resolved-links-changed");
  }

  /** Resolve a single file's outgoing links and update the store */
  private async resolveFileAndUpdate(path: string): Promise<void> {
    const meta = this._metadataMap.get(path);
    if (!meta || !this._lookups) return;

    const sourceResolved = new Map<string, number>();
    const sourceUnresolved = new Map<string, number>();

    for (const ref of [...meta.links, ...meta.embeds]) {
      const result = resolveLinkFn(ref.link, ref.subpath, path, this._lookups);
      if (result) {
        sourceResolved.set(result.path, (sourceResolved.get(result.path) ?? 0) + 1);
      } else {
        // Obsidian strips .md extension from unresolved link keys
        let linkName = ref.link.toLowerCase().trim();
        if (linkName.endsWith(".md")) linkName = linkName.slice(0, -3);
        if (linkName) {
          sourceUnresolved.set(linkName, (sourceUnresolved.get(linkName) ?? 0) + 1);
        }
      }
    }

    this.store.deleteResolvedLinksFromSource(path);
    this.store.deleteUnresolvedLinksFromSource(path);
    if (sourceResolved.size > 0) {
      this.store.upsertResolvedLinks(path, sourceResolved);
    }
    if (sourceUnresolved.size > 0) {
      this.store.upsertUnresolvedLinks(path, sourceUnresolved);
    }
  }

  /** Check if previously-unresolved links now resolve to a new file */
  private resolveNewlyMatchingLinks(
    basename: string,
    newPath: string,
    aliases: string[],
  ): void {
    const names = [basename, ...aliases.map((a) => a.toLowerCase())];

    for (const name of names) {
      const unresolvedSources = this.store.getUnresolvedLinksByTarget(name);
      for (const { source, count } of unresolvedSources) {
        this.store.deleteUnresolvedLink(source, name);
        this.store.upsertResolvedLink(source, newPath, count);
      }
    }
  }

  // ── Event Emission ──────────────────────────────────────────────

  on(
    event: "metadata-changed" | "file-created" | "file-deleted" | "index-error",
    callback: VaultEventCallback,
  ): void;
  on(event: "resolved-links-changed", callback: VaultLinkCallback): void;
  on(
    event: "metadata-changed" | "resolved-links-changed" | "file-created" | "file-deleted" | "index-error",
    // deno-lint-ignore no-explicit-any
    callback: any,
  ): void {
    switch (event) {
      case "metadata-changed": this._onMetadataChanged.push(callback); break;
      case "resolved-links-changed": this._onResolvedLinksChanged.push(callback); break;
      case "file-created": this._onFileCreated.push(callback); break;
      case "file-deleted": this._onFileDeleted.push(callback); break;
      case "index-error": this._onIndexError.push(callback); break;
    }
  }

  private emit(event: "metadata-changed" | "file-created" | "file-deleted" | "index-error", path: string): void;
  private emit(event: "resolved-links-changed"): void;
  private emit(
    event: "metadata-changed" | "resolved-links-changed" | "file-created" | "file-deleted" | "index-error",
    path?: string,
  ): void {
    switch (event) {
      case "metadata-changed": this._onMetadataChanged.forEach((cb) => cb(path!)); break;
      case "resolved-links-changed": this._onResolvedLinksChanged.forEach((cb) => cb()); break;
      case "file-created": this._onFileCreated.forEach((cb) => cb(path!)); break;
      case "file-deleted": this._onFileDeleted.forEach((cb) => cb(path!)); break;
      case "index-error": this._onIndexError?.forEach((cb) => cb(path!)); break;
    }
  }
}
