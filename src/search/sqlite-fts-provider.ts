/**
 * SQLite FTS5 Search Provider
 *
 * Implements SearchProvider using SQLite's FTS5 full-text search engine
 * with porter stemmer tokenization and BM25 scoring.
 */

import type { SearchProvider, SearchProviderOptions, SearchProviderResult } from '../types.ts';
import { extractSearchableText } from './text-extractor.ts';
import { isInternalKey } from '../utils/path.ts';

export class SqliteFtsSearchProvider implements SearchProvider {
  readonly name = 'sqlite-fts5';
  readonly supportedTypes = ['bm25'] as const;
  private ftsInitialized = false;

  constructor(
    private db: any,
    private table: string,
  ) {}

  /** Ensure FTS5 virtual table exists (lazy init) */
  private ensureFTS(): void {
    if (this.ftsInitialized) return;

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS "${this.table}_fts" USING fts5(
        key, content,
        tokenize='porter unicode61'
      )
    `);
    this.ftsInitialized = true;
  }

  /** Index a single key/value for search */
  index(key: string, value: any): void {
    if (isInternalKey(key)) return;
    const text = extractSearchableText(value);
    if (!text) return;

    this.ensureFTS();
    // Upsert: remove existing then insert, wrapped in transaction for atomicity
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM "${this.table}_fts" WHERE key = ?`).run(key);
      this.db.prepare(`INSERT INTO "${this.table}_fts" (key, content) VALUES (?, ?)`).run(key, text);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Remove a key from the search index */
  remove(key: string): void {
    this.ensureFTS();
    this.db.prepare(`DELETE FROM "${this.table}_fts" WHERE key = ?`).run(key);
  }

  /**
   * BM25 full-text search via FTS5.
   * Returns results with normalized scores (0-1 via sigmoid).
   */
  search(query: string, options?: SearchProviderOptions): SearchProviderResult[] {
    this.ensureFTS();
    const limit = options?.limit ?? 20;

    if (!query || query.trim().length === 0) return [];

    try {
      let sql = `
        SELECT key, rank AS score, snippet("${this.table}_fts", 1, '<b>', '</b>', '...', 32) AS snippet
        FROM "${this.table}_fts"
        WHERE "${this.table}_fts" MATCH ?
          AND key NOT LIKE 'smallstore:meta:%'
          AND key NOT LIKE 'smallstore:index:%'
      `;
      const params: any[] = [query];

      if (options?.collection) {
        // Strict prefix match — accepts `coll/...`, `coll:...`, or
        // `smallstore:coll:...`. Must NOT match `old-coll` substring.
        sql += ` AND (
          key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key = ?
        )`;
        const c = options.collection;
        params.push(`${c}/%`, `${c}:%`, `smallstore:${c}:%`, `smallstore:${c}/%`, c);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as Array<{ key: string; score: number; snippet: string }>;

      // Normalize BM25 scores to 0-1 via sigmoid
      const results = rows.map(row => ({
        key: row.key,
        score: 1 / (1 + Math.exp(-(Math.abs(row.score) - 5) / 3)),
        snippet: row.snippet || '',
      }));

      // Apply threshold filter if specified
      if (options?.threshold !== undefined) {
        return results.filter(r => r.score >= options.threshold!);
      }

      return results;
    } catch (error) {
      // FTS5 MATCH can fail on malformed queries
      console.error(`[SqliteFtsSearchProvider] FTS search error:`, error);
      return [];
    }
  }

  /**
   * Rebuild FTS index from all stored data.
   * Clears existing FTS entries and re-indexes everything.
   */
  rebuild(prefix?: string): { indexed: number; skipped: number } {
    this.ensureFTS();

    // Clear existing FTS entries
    if (prefix) {
      this.db.prepare(`DELETE FROM "${this.table}_fts" WHERE key LIKE ?`).run(`${prefix}%`);
    } else {
      this.db.prepare(`DELETE FROM "${this.table}_fts"`).run();
    }

    // Re-index all matching keys
    const whereClause = prefix ? `WHERE key LIKE ?` : '';
    const params = prefix ? [`${prefix}%`] : [];
    const rows = this.db.prepare(
      `SELECT key, value FROM "${this.table}" ${whereClause}`
    ).all(...params) as Array<{ key: string; value: string }>;

    let indexed = 0;
    let skipped = 0;

    for (const row of rows) {
      let parsed: any;
      try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
      const text = extractSearchableText(parsed);
      if (text) {
        this.ensureFTS();
        this.db.prepare(`DELETE FROM "${this.table}_fts" WHERE key = ?`).run(row.key);
        this.db.prepare(`INSERT INTO "${this.table}_fts" (key, content) VALUES (?, ?)`).run(row.key, text);
        indexed++;
      } else {
        skipped++;
      }
    }

    return { indexed, skipped };
  }
}
