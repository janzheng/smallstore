/**
 * SQLite Storage Adapter
 *
 * Local SQLite database storage via Deno-native @db/sqlite.
 *
 * Uses the same KV-table pattern as the Cloudflare D1 adapter:
 *   key TEXT PRIMARY KEY, value TEXT, metadata TEXT, timestamps
 *
 * Use cases:
 * - Local persistent storage (single-file database)
 * - Queryable KV store with SQL performance
 * - Testing with in-memory databases
 * - Multiple databases (one adapter per .db file)
 */

import { Database } from 'jsr:@db/sqlite@0.12';
import type { StorageAdapter, AdapterQueryOptions, AdapterQueryResult } from './adapter.ts';
import type { AdapterCapabilities, SearchProvider, KeysPageOptions, KeysPage } from '../types.ts';
import { SqliteFtsSearchProvider } from '../search/sqlite-fts-provider.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Config
// ============================================================================

export interface SQLiteAdapterConfig {
  /**
   * Database file path or `:memory:` for in-memory.
   *
   * - `:memory:` — ephemeral in-memory database (default, good for testing)
   * - `./data/store.db` — persistent local file
   * - `/absolute/path/to/db.sqlite` — absolute path
   *
   * Default: `:memory:`
   */
  path?: string;

  /** Table name for KV storage (default: 'kv_store') */
  table?: string;
}

// ============================================================================
// SQLite Adapter
// ============================================================================

export class SQLiteAdapter implements StorageAdapter {
  private db: Database;
  private table: string;
  private initialized = false;
  private _searchProvider: SqliteFtsSearchProvider;

  readonly capabilities: AdapterCapabilities = {
    name: 'sqlite',
    supportedTypes: ['kv', 'object'],
    maxItemSize: 1 * 1024 * 1024 * 1024, // 1GB theoretical
    cost: {
      tier: 'free',
      perGB: 'Free (local)',
      perOperation: 'Free (local)',
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'low',
      throughput: 'high',
    },
    features: {
      ttl: false,
      transactions: true,
      query: true,
      search: true,
    },
  };

  get searchProvider(): SearchProvider {
    return this._searchProvider;
  }

  constructor(config: SQLiteAdapterConfig = {}) {
    const dbPath = config.path || ':memory:';
    this.table = config.table || 'kv_store';

    // Ensure parent directory exists for file-based databases
    if (dbPath !== ':memory:') {
      try {
        const dir = dbPath.includes('/')
          ? dbPath.substring(0, dbPath.lastIndexOf('/'))
          : '.';
        Deno.mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist or path is relative without slashes
      }
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    }

    this._searchProvider = new SqliteFtsSearchProvider(this.db, this.table);
  }

  /**
   * Ensure the KV table exists (lazy init on first operation)
   */
  private ensureTable(): void {
    if (this.initialized) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.table}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);

    this.initialized = true;
  }

  // ============================================================================
  // StorageAdapter Implementation
  // ============================================================================

  async get(key: string): Promise<any> {
    try {
      this.ensureTable();

      const stmt = this.db.prepare(
        `SELECT value FROM "${this.table}" WHERE key = ?`
      );
      const row = stmt.get(key) as { value: string } | undefined;

      if (!row) {
        return null;
      }

      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    } catch (error) {
      console.error(`[SQLiteAdapter] Error getting ${key}:`, error);
      return null;
    }
  }

  async set(key: string, value: any, _ttl?: number): Promise<void> {
    this.ensureTable();

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    const stmt = this.db.prepare(`
      INSERT INTO "${this.table}" (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run(key, serialized);

    // Auto-index for FTS (best-effort)
    try { this._searchProvider.index(key, value); } catch { /* FTS indexing is best-effort */ }
  }

  async delete(key: string): Promise<void> {
    try {
      this.ensureTable();

      const stmt = this.db.prepare(
        `DELETE FROM "${this.table}" WHERE key = ?`
      );
      stmt.run(key);

      // Remove from FTS index (best-effort)
      try { this._searchProvider.remove(key); } catch { /* ignore */ }
    } catch (error) {
      console.error(`[SQLiteAdapter] Error deleting ${key}:`, error);
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      this.ensureTable();

      const stmt = this.db.prepare(
        `SELECT 1 FROM "${this.table}" WHERE key = ? LIMIT 1`
      );
      const row = stmt.get(key);
      return row !== undefined;
    } catch (error) {
      console.error(`[SQLiteAdapter] Error checking ${key}:`, error);
      return false;
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    try {
      this.ensureTable();

      let rows: Array<{ key: string }>;
      if (prefix) {
        const stmt = this.db.prepare(
          `SELECT key FROM "${this.table}" WHERE key LIKE ? ORDER BY key`
        );
        rows = stmt.all(`${prefix}%`) as Array<{ key: string }>;
      } else {
        const stmt = this.db.prepare(
          `SELECT key FROM "${this.table}" ORDER BY key`
        );
        rows = stmt.all() as Array<{ key: string }>;
      }

      return rows.map((r) => r.key);
    } catch (error) {
      console.error(`[SQLiteAdapter] Error listing keys:`, error);
      return [];
    }
  }

  /**
   * Paged keys — uses SQLite's native LIMIT/OFFSET plus a COUNT(*) so the
   * router can return `total` + `hasMore` without a full key scan.
   */
  async listKeys(options: KeysPageOptions = {}): Promise<KeysPage> {
    try {
      this.ensureTable();
      const { prefix, limit, offset } = options;

      // Total matching count (cheap on indexed key column)
      const totalRow = prefix
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM "${this.table}" WHERE key LIKE ?`).get(`${prefix}%`) as { n: number }
        : this.db.prepare(`SELECT COUNT(*) AS n FROM "${this.table}"`).get() as { n: number };
      const total = totalRow?.n ?? 0;

      const off = Math.max(0, offset ?? 0);
      // SQLite requires LIMIT when using OFFSET — use -1 for "no limit" semantics.
      const lim = limit !== undefined ? limit : -1;
      const rows = prefix
        ? this.db.prepare(
            `SELECT key FROM "${this.table}" WHERE key LIKE ? ORDER BY key LIMIT ? OFFSET ?`
          ).all(`${prefix}%`, lim, off) as Array<{ key: string }>
        : this.db.prepare(
            `SELECT key FROM "${this.table}" ORDER BY key LIMIT ? OFFSET ?`
          ).all(lim, off) as Array<{ key: string }>;

      const keys = rows.map(r => r.key);
      return {
        keys,
        hasMore: off + keys.length < total,
        total,
      };
    } catch (error) {
      console.error(`[SQLiteAdapter] Error in listKeys:`, error);
      return { keys: [], hasMore: false, total: 0 };
    }
  }

  async clear(prefix?: string): Promise<void> {
    try {
      this.ensureTable();

      if (prefix) {
        const stmt = this.db.prepare(
          `DELETE FROM "${this.table}" WHERE key LIKE ?`
        );
        stmt.run(`${prefix}%`);
      } else {
        this.db.exec(`DELETE FROM "${this.table}"`);
      }
    } catch (error) {
      console.error(`[SQLiteAdapter] Error clearing:`, error);
      throw error;
    }
  }

  // ============================================================================
  // Native Query (optional StorageAdapter method)
  // ============================================================================

  /**
   * Native SQL query using json_extract() for filtering.
   *
   * Translates MongoDB-style filters to SQL WHERE clauses,
   * executing filtering, sorting, and pagination directly in SQLite.
   */
  async query(options: AdapterQueryOptions): Promise<AdapterQueryResult> {
    this.ensureTable();

    const conditions: string[] = [];
    const params: any[] = [];

    // Prefix filter
    if (options.prefix) {
      conditions.push('key LIKE ?');
      params.push(`${options.prefix}%`);
    }

    // Translate MongoDB-style filter to SQL
    // Guard: skip non-JSON rows when using json_extract filters
    let needsJsonGuard = false;
    if (options.filter) {
      needsJsonGuard = true;
      for (const [field, value] of Object.entries(options.filter)) {
        if (value === null) {
          conditions.push(`json_extract(value, '$.${field}') IS NULL`);
        } else if (typeof value === 'object' && !Array.isArray(value)) {
          // Operator object: { $gt: 100, $in: ['a', 'b'] }
          for (const [op, operand] of Object.entries(value as Record<string, any>)) {
            const sqlOp = MONGO_TO_SQL_OPS[op];
            if (sqlOp) {
              conditions.push(`json_extract(value, '$.${field}') ${sqlOp} ?`);
              params.push(operand);
            } else if (op === '$in' && Array.isArray(operand)) {
              const placeholders = operand.map(() => '?').join(', ');
              conditions.push(`json_extract(value, '$.${field}') IN (${placeholders})`);
              params.push(...operand);
            } else if (op === '$nin' && Array.isArray(operand)) {
              const placeholders = operand.map(() => '?').join(', ');
              conditions.push(`json_extract(value, '$.${field}') NOT IN (${placeholders})`);
              params.push(...operand);
            } else if (op === '$exists') {
              if (operand) {
                conditions.push(`json_extract(value, '$.${field}') IS NOT NULL`);
              } else {
                conditions.push(`json_extract(value, '$.${field}') IS NULL`);
              }
            } else if (op === '$contains') {
              conditions.push(`json_extract(value, '$.${field}') LIKE ?`);
              params.push(`%${operand}%`);
            } else if (op === '$startsWith') {
              conditions.push(`json_extract(value, '$.${field}') LIKE ?`);
              params.push(`${operand}%`);
            } else if (op === '$endsWith') {
              conditions.push(`json_extract(value, '$.${field}') LIKE ?`);
              params.push(`%${operand}`);
            }
          }
        } else {
          // Direct equality: { name: "foo" }
          conditions.push(`json_extract(value, '$.${field}') = ?`);
          params.push(value);
        }
      }
    }

    // Sort
    let orderClause = '';
    if (options.sort) {
      needsJsonGuard = true;
      const sortParts = Object.entries(options.sort).map(([field, dir]) =>
        `json_extract(value, '$.${field}') ${dir === -1 ? 'DESC' : 'ASC'}`
      );
      orderClause = `ORDER BY ${sortParts.join(', ')}`;
    }

    // Guard: skip non-JSON rows when using json_extract (filters or sort)
    if (needsJsonGuard) {
      conditions.unshift('json_valid(value)');
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Count total matching rows (before limit/offset)
    const countSql = `SELECT COUNT(*) as count FROM "${this.table}" ${whereClause}`;
    const countStmt = this.db.prepare(countSql);
    const countRow = countStmt.get(...params) as { count: number } | undefined;
    const totalCount = countRow?.count ?? 0;

    // Fetch filtered data
    let limitClause = '';
    const dataParams = [...params];
    if (options.limit) {
      limitClause = 'LIMIT ?';
      dataParams.push(options.limit);
      if (options.skip) {
        limitClause += ' OFFSET ?';
        dataParams.push(options.skip);
      }
    } else if (options.skip) {
      // Skip without limit: use a very large limit
      limitClause = 'LIMIT -1 OFFSET ?';
      dataParams.push(options.skip);
    }

    const dataSql = `SELECT value FROM "${this.table}" ${whereClause} ${orderClause} ${limitClause}`;
    const dataStmt = this.db.prepare(dataSql);
    const rows = dataStmt.all(...dataParams) as Array<{ value: string }>;

    const data = rows.map((r) => {
      try { return JSON.parse(r.value); } catch { return r.value; }
    });

    return { data, totalCount };
  }

  // ============================================================================
  // FTS5 Full-Text Search (delegated to SearchProvider)
  // ============================================================================

  /** @deprecated Use searchProvider.index() instead */
  ftsIndex(key: string, text: string): void {
    this._searchProvider.index(key, text);
  }

  /** @deprecated Use searchProvider.rebuild() instead */
  ftsRebuild(prefix?: string): { indexed: number; skipped: number } {
    return this._searchProvider.rebuild(prefix);
  }

  /** @deprecated Use searchProvider.remove() instead */
  ftsRemove(key: string): void {
    this._searchProvider.remove(key);
  }

  /** @deprecated Use searchProvider.search() instead */
  ftsSearch(query: string, options?: { limit?: number; collection?: string }): Array<{ key: string; score: number; snippet: string }> {
    return this._searchProvider.search(query, options);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// MongoDB → SQL Operator Mapping
// ============================================================================

const MONGO_TO_SQL_OPS: Record<string, string> = {
  '$eq': '=',
  '$ne': '!=',
  '$gt': '>',
  '$gte': '>=',
  '$lt': '<',
  '$lte': '<=',
};

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a SQLite storage adapter
 *
 * @param config - SQLite adapter configuration
 * @returns SQLite storage adapter
 *
 * @example
 * ```typescript
 * // In-memory (testing)
 * const adapter = createSQLiteAdapter();
 *
 * // Local file
 * const adapter = createSQLiteAdapter({ path: './data/store.db' });
 *
 * // Multiple databases
 * const users = createSQLiteAdapter({ path: './data/users.db' });
 * const content = createSQLiteAdapter({ path: './data/content.db' });
 * ```
 */
export function createSQLiteAdapter(
  config?: SQLiteAdapterConfig
): SQLiteAdapter {
  return new SQLiteAdapter(config);
}
