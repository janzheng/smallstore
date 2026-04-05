/**
 * SQLite persistence layer for VaultGraph.
 * Uses @db/sqlite (native Deno FFI) — rewritten from WASM deno.land/x/sqlite.
 */

import { Database } from '@db/sqlite';
import type { FileCacheEntry, FileMetadata } from "./types.ts";

const SCHEMA_VERSION = 2;

export class SqliteStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
  }

  // ── Schema ─────────────────────────────────────────────────────

  createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS file_cache (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_metadata (
        path TEXT PRIMARY KEY,
        frontmatter TEXT,
        frontmatter_position TEXT,
        links TEXT NOT NULL DEFAULT '[]',
        embeds TEXT NOT NULL DEFAULT '[]',
        external_links TEXT NOT NULL DEFAULT '[]',
        headings TEXT NOT NULL DEFAULT '[]',
        sections TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        block_ids TEXT NOT NULL DEFAULT '[]',
        list_items TEXT NOT NULL DEFAULT '[]',
        footnotes TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (path) REFERENCES file_cache(path) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS resolved_links (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (source, target)
      );

      CREATE INDEX IF NOT EXISTS idx_resolved_target ON resolved_links(target);

      CREATE TABLE IF NOT EXISTS unresolved_links (
        source TEXT NOT NULL,
        target_name TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (source, target_name)
      );

      CREATE TABLE IF NOT EXISTS file_lookup (
        basename TEXT PRIMARY KEY,
        path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alias_lookup (
        alias TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (alias, path)
      );

      CREATE INDEX IF NOT EXISTS idx_alias_path ON alias_lookup(path);

      CREATE TABLE IF NOT EXISTS property_types (
        name TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        occurrences INTEGER DEFAULT 0
      );
    `);

    // FTS5 must be created in a separate exec call
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
        path,
        title,
        content,
        tags,
        tokenize='porter unicode61'
      );
    `);

    // Insert schema version if not present
    const row = this.db.prepare(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
    ).get() as { version: number } | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        SCHEMA_VERSION,
      );
    }
  }

  // ── Schema validation ──────────────────────────────────────────

  validateSchemaVersion(): boolean {
    try {
      const row = this.db.prepare(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
      ).get() as { version: number } | undefined;
      return row !== undefined && row.version === SCHEMA_VERSION;
    } catch {
      return false;
    }
  }

  // ── File cache operations ──────────────────────────────────────

  upsertFileCache(path: string, entry: FileCacheEntry): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO file_cache (path, mtime, size, hash) VALUES (?, ?, ?, ?)`,
    ).run(path, entry.mtime, entry.size, entry.hash);
  }

  getFileCache(path: string): FileCacheEntry | null {
    const row = this.db.prepare(
      "SELECT mtime, size, hash FROM file_cache WHERE path = ?",
    ).get(path) as { mtime: number; size: number; hash: string } | undefined;
    if (!row) return null;
    return { mtime: row.mtime, size: row.size, hash: row.hash };
  }

  getAllFileCaches(): Map<string, FileCacheEntry> {
    const result = new Map<string, FileCacheEntry>();
    const rows = this.db.prepare(
      "SELECT path, mtime, size, hash FROM file_cache",
    ).all() as { path: string; mtime: number; size: number; hash: string }[];
    for (const row of rows) {
      result.set(row.path, { mtime: row.mtime, size: row.size, hash: row.hash });
    }
    return result;
  }

  deleteFileCache(path: string): void {
    this.db.prepare("DELETE FROM file_cache WHERE path = ?").run(path);
  }

  // ── File metadata operations ───────────────────────────────────

  upsertFileMetadata(path: string, meta: FileMetadata): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO file_metadata
        (path, frontmatter, frontmatter_position, links, embeds, external_links, headings, sections, tags, block_ids, list_items, footnotes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      path,
      meta.frontmatter ? JSON.stringify(meta.frontmatter) : null,
      meta.frontmatterPosition
        ? JSON.stringify(meta.frontmatterPosition)
        : null,
      JSON.stringify(meta.links),
      JSON.stringify(meta.embeds),
      JSON.stringify(meta.externalLinks),
      JSON.stringify(meta.headings),
      JSON.stringify(meta.sections),
      JSON.stringify(meta.tags),
      JSON.stringify(meta.blockIds),
      JSON.stringify(meta.listItems),
      JSON.stringify(meta.footnotes),
    );
  }

  getFileMetadata(path: string): FileMetadata | null {
    const row = this.db.prepare(
      `SELECT frontmatter, frontmatter_position, links, embeds, external_links, headings, sections, tags, block_ids, list_items, footnotes
       FROM file_metadata WHERE path = ?`,
    ).get(path) as {
      frontmatter: string | null;
      frontmatter_position: string | null;
      links: string;
      embeds: string;
      external_links: string;
      headings: string;
      sections: string;
      tags: string;
      block_ids: string;
      list_items: string;
      footnotes: string;
    } | undefined;
    if (!row) return null;

    return {
      path,
      frontmatter: row.frontmatter ? JSON.parse(row.frontmatter) : null,
      frontmatterPosition: row.frontmatter_position ? JSON.parse(row.frontmatter_position) : null,
      links: JSON.parse(row.links),
      embeds: JSON.parse(row.embeds),
      externalLinks: JSON.parse(row.external_links),
      headings: JSON.parse(row.headings),
      sections: JSON.parse(row.sections),
      tags: JSON.parse(row.tags),
      blockIds: JSON.parse(row.block_ids),
      listItems: JSON.parse(row.list_items),
      footnotes: JSON.parse(row.footnotes),
    };
  }

  deleteFileMetadata(path: string): void {
    this.db.prepare("DELETE FROM file_metadata WHERE path = ?").run(path);
  }

  // ── Resolved links operations ──────────────────────────────────

  upsertResolvedLinks(
    source: string,
    targets: Map<string, number>,
  ): void {
    // Clear existing links from this source
    this.db.prepare("DELETE FROM resolved_links WHERE source = ?").run(source);
    // Insert new
    const stmt = this.db.prepare(
      "INSERT INTO resolved_links (source, target, count) VALUES (?, ?, ?)",
    );
    for (const [target, count] of targets) {
      stmt.run(source, target, count);
    }
  }

  getResolvedLinks(): Map<string, Map<string, number>> {
    const result = new Map<string, Map<string, number>>();
    const rows = this.db.prepare(
      "SELECT source, target, count FROM resolved_links",
    ).all() as { source: string; target: string; count: number }[];
    for (const row of rows) {
      if (!result.has(row.source)) result.set(row.source, new Map());
      result.get(row.source)!.set(row.target, row.count);
    }
    return result;
  }

  getBacklinksFor(path: string): Map<string, number> {
    const result = new Map<string, number>();
    const rows = this.db.prepare(
      "SELECT source, count FROM resolved_links WHERE target = ?",
    ).all(path) as { source: string; count: number }[];
    for (const row of rows) {
      result.set(row.source, row.count);
    }
    return result;
  }

  upsertResolvedLink(source: string, target: string, count: number): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO resolved_links (source, target, count) VALUES (?, ?, ?)`,
    ).run(source, target, count);
  }

  deleteResolvedLink(source: string, target: string): void {
    this.db.prepare(
      "DELETE FROM resolved_links WHERE source = ? AND target = ?",
    ).run(source, target);
  }

  deleteResolvedLinksFromSource(source: string): void {
    this.db.prepare("DELETE FROM resolved_links WHERE source = ?").run(source);
  }

  getResolvedLinksToTarget(
    target: string,
  ): { source: string; count: number }[] {
    return this.db.prepare(
      "SELECT source, count FROM resolved_links WHERE target = ?",
    ).all(target) as { source: string; count: number }[];
  }

  renameResolvedLinkPaths(oldPath: string, newPath: string): void {
    this.db.prepare(
      "UPDATE resolved_links SET source = ? WHERE source = ?",
    ).run(newPath, oldPath);
    this.db.prepare(
      "UPDATE resolved_links SET target = ? WHERE target = ?",
    ).run(newPath, oldPath);
  }

  // ── Unresolved links operations ────────────────────────────────

  upsertUnresolvedLinks(
    source: string,
    targets: Map<string, number>,
  ): void {
    this.db.prepare("DELETE FROM unresolved_links WHERE source = ?").run(source);
    const stmt = this.db.prepare(
      "INSERT INTO unresolved_links (source, target_name, count) VALUES (?, ?, ?)",
    );
    for (const [targetName, count] of targets) {
      stmt.run(source, targetName, count);
    }
  }

  getUnresolvedLinks(): Map<string, Map<string, number>> {
    const result = new Map<string, Map<string, number>>();
    const rows = this.db.prepare(
      "SELECT source, target_name, count FROM unresolved_links",
    ).all() as { source: string; target_name: string; count: number }[];
    for (const row of rows) {
      if (!result.has(row.source)) result.set(row.source, new Map());
      result.get(row.source)!.set(row.target_name, row.count);
    }
    return result;
  }

  deleteUnresolvedLinksFromSource(source: string): void {
    this.db.prepare("DELETE FROM unresolved_links WHERE source = ?").run(source);
  }

  deleteUnresolvedLink(source: string, targetName: string): void {
    this.db.prepare(
      "DELETE FROM unresolved_links WHERE source = ? AND target_name = ?",
    ).run(source, targetName);
  }

  getUnresolvedLinksByTarget(
    targetName: string,
  ): { source: string; count: number }[] {
    return this.db.prepare(
      "SELECT source, count FROM unresolved_links WHERE target_name = ?",
    ).all(targetName) as { source: string; count: number }[];
  }

  renameFileEntries(oldPath: string, newPath: string): void {
    this.db.prepare("UPDATE file_cache SET path = ? WHERE path = ?").run(newPath, oldPath);
    this.db.prepare("UPDATE file_metadata SET path = ? WHERE path = ?").run(newPath, oldPath);
  }

  updateAliasPath(oldPath: string, newPath: string): void {
    this.db.prepare("UPDATE alias_lookup SET path = ? WHERE path = ?").run(newPath, oldPath);
  }

  // ── File lookup operations ─────────────────────────────────────

  upsertFileLookup(basename: string, path: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO file_lookup (basename, path) VALUES (?, ?)",
    ).run(basename, path);
  }

  deleteFileLookup(basename: string): void {
    this.db.prepare("DELETE FROM file_lookup WHERE basename = ?").run(basename);
  }

  // ── Alias lookup operations ────────────────────────────────────

  upsertAlias(alias: string, path: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO alias_lookup (alias, path) VALUES (?, ?)",
    ).run(alias, path);
  }

  deleteAliasesForPath(path: string): void {
    this.db.prepare("DELETE FROM alias_lookup WHERE path = ?").run(path);
  }

  getAliasesForPath(path: string): string[] {
    const rows = this.db.prepare(
      "SELECT alias FROM alias_lookup WHERE path = ?",
    ).all(path) as { alias: string }[];
    return rows.map((r) => r.alias);
  }

  getAllAliases(): Map<string, string> {
    const result = new Map<string, string>();
    const rows = this.db.prepare(
      "SELECT alias, path FROM alias_lookup",
    ).all() as { alias: string; path: string }[];
    for (const row of rows) {
      result.set(row.alias, row.path);
    }
    return result;
  }

  // ── Orphans query ──────────────────────────────────────────────

  getOrphans(): string[] {
    const rows = this.db.prepare(
      `SELECT fc.path FROM file_cache fc
       WHERE fc.path NOT IN (SELECT DISTINCT target FROM resolved_links)`,
    ).all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  // ── Deadends query ─────────────────────────────────────────────

  getDeadends(): string[] {
    const rows = this.db.prepare(
      `SELECT fc.path FROM file_cache fc
       WHERE fc.path NOT IN (SELECT DISTINCT source FROM resolved_links)
       AND fc.path LIKE '%.md'`,
    ).all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getFileCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM file_cache").get() as { cnt: number };
    return row.cnt;
  }

  getMarkdownFileCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM file_cache WHERE path LIKE '%.md'",
    ).get() as { cnt: number };
    return row.cnt;
  }

  getLinkCount(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(count), 0) as total FROM resolved_links",
    ).get() as { total: number };
    return row.total;
  }

  getUnresolvedLinkCount(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(count), 0) as total FROM unresolved_links",
    ).get() as { total: number };
    return row.total;
  }

  getAliasCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM alias_lookup").get() as { cnt: number };
    return row.cnt;
  }

  getHubNodes(limit: number = 10): { path: string; inLinks: number }[] {
    const rows = this.db.prepare(
      `SELECT target as path, COUNT(*) as inLinks
       FROM resolved_links GROUP BY target
       ORDER BY inLinks DESC LIMIT ?`,
    ).all(limit) as { path: string; inLinks: number }[];
    return rows;
  }

  // ── FTS operations ──────────────────────────────────────────────

  /** Index a file for full-text search */
  indexFileForSearch(
    path: string,
    title: string,
    content: string,
    tags: string,
  ): void {
    // Delete old entry first (FTS5 doesn't support ON CONFLICT)
    this.db.prepare("DELETE FROM fts_content WHERE path = ?").run(path);
    this.db.prepare(
      "INSERT INTO fts_content (path, title, content, tags) VALUES (?, ?, ?, ?)",
    ).run(path, title, content, tags);
  }

  /** Clear all FTS entries */
  clearFTSIndex(): void {
    this.db.exec("DELETE FROM fts_content");
  }

  /** Full-text search with BM25 ranking */
  searchFTS(
    query: string,
    limit: number = 20,
  ): { path: string; rank: number; snippet: string }[] {
    try {
      const rows = this.db.prepare(
        `SELECT path, rank, snippet(fts_content, 2, '<mark>', '</mark>', '...', 32) as snippet
         FROM fts_content
         WHERE fts_content MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(query, limit) as { path: string; rank: number; snippet: string }[];
      return rows;
    } catch {
      return [];
    }
  }

  /** Search by tag with hierarchical prefix matching */
  searchByTag(
    tagQuery: string,
  ): { path: string; tag: string }[] {
    const normalized = tagQuery.replace(/^#/, "").toLowerCase();
    const results: { path: string; tag: string }[] = [];

    const rows = this.db.prepare(
      "SELECT path, tags FROM file_metadata",
    ).all() as { path: string; tags: string }[];

    for (const row of rows) {
      const tags = JSON.parse(row.tags) as { tag: string }[];
      for (const t of tags) {
        const tagNorm = t.tag.replace(/^#/, "").toLowerCase();
        if (tagNorm === normalized || tagNorm.startsWith(normalized + "/")) {
          results.push({ path: row.path, tag: t.tag });
          break;
        }
      }
    }

    return results;
  }

  // ── Transaction helpers ────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
