/**
 * Structured SQLite Adapter
 *
 * Phase 4: Collections map to real SQL tables with typed columns.
 *
 * Unlike the KV SQLite adapter (which stores everything as key→JSON blob),
 * this adapter creates proper SQL tables with real columns, enabling:
 * - Typed column definitions
 * - Real SQL indexes
 * - Native queries on actual columns (no json_extract)
 * - Auto-migration (CREATE TABLE IF NOT EXISTS)
 *
 * @example
 * ```typescript
 * const adapter = createStructuredSQLiteAdapter({
 *   path: './data/structured.db',
 *   schema: {
 *     users: {
 *       columns: {
 *         id: { type: 'text', primaryKey: true },
 *         name: { type: 'text', notNull: true },
 *         email: { type: 'text', unique: true },
 *         age: { type: 'integer' },
 *         active: { type: 'integer' },  // boolean as 0/1
 *       },
 *     },
 *     posts: {
 *       columns: {
 *         id: { type: 'integer', primaryKey: true, autoIncrement: true },
 *         user_id: { type: 'text', notNull: true },
 *         title: { type: 'text', notNull: true },
 *         body: { type: 'text' },
 *         published: { type: 'integer', default: 0 },
 *       },
 *       indexes: [
 *         { columns: ['user_id'] },
 *         { columns: ['published', 'user_id'] },
 *       ],
 *     },
 *   },
 * });
 * ```
 */

import { Database } from 'jsr:@db/sqlite@0.12';
import type { StorageAdapter, AdapterQueryOptions, AdapterQueryResult } from './adapter.ts';
import type { AdapterCapabilities, SearchProvider } from '../types.ts';
import { SqliteFtsSearchProvider } from '../search/sqlite-fts-provider.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Schema Types
// ============================================================================

export type ColumnType = 'text' | 'integer' | 'real' | 'blob';

export interface ColumnDef {
  type: ColumnType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
}

export interface IndexDef {
  columns: string[];
  unique?: boolean;
  name?: string;
}

export interface TableSchema {
  columns: Record<string, ColumnDef>;
  indexes?: IndexDef[];
}

export interface StructuredSQLiteConfig {
  /** Database file path or `:memory:` */
  path?: string;

  /**
   * Schema definitions: table name → column definitions.
   * Tables are auto-created on first access.
   */
  schema: Record<string, TableSchema>;
}

// ============================================================================
// Adapter
// ============================================================================

export class StructuredSQLiteAdapter implements StorageAdapter {
  private db: Database;
  private schema: Record<string, TableSchema>;
  private tablesCreated = new Set<string>();
  private _searchProvider: SqliteFtsSearchProvider;

  readonly capabilities: AdapterCapabilities = {
    name: 'structured-sqlite',
    supportedTypes: ['object', 'kv'],
    maxItemSize: 1 * 1024 * 1024 * 1024,
    cost: { tier: 'free', perGB: 'Free (local)', perOperation: 'Free (local)' },
    performance: { readLatency: 'low', writeLatency: 'low', throughput: 'high' },
    features: { ttl: false, transactions: true, query: true, search: true },
  };

  get searchProvider(): SearchProvider {
    return this._searchProvider;
  }

  constructor(config: StructuredSQLiteConfig) {
    const dbPath = config.path || ':memory:';
    this.schema = config.schema;

    if (dbPath !== ':memory:') {
      try {
        const dir = dbPath.includes('/')
          ? dbPath.substring(0, dbPath.lastIndexOf('/'))
          : '.';
        Deno.mkdirSync(dir, { recursive: true });
      } catch { /* may exist */ }
    }

    this.db = new Database(dbPath);

    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    }

    // Use first table name as FTS table prefix, or 'structured' as fallback
    const ftsTable = Object.keys(config.schema)[0] || 'structured';
    this._searchProvider = new SqliteFtsSearchProvider(this.db, ftsTable);
  }

  // --------------------------------------------------------------------------
  // Table management
  // --------------------------------------------------------------------------

  /** Ensure table exists (auto-migrate) */
  private ensureTable(tableName: string): void {
    if (this.tablesCreated.has(tableName)) return;

    const tableSchema = this.schema[tableName];
    if (!tableSchema) {
      throw new Error(`[StructuredSQLiteAdapter] No schema for table "${tableName}"`);
    }

    const colDefs: string[] = [];
    for (const [name, col] of Object.entries(tableSchema.columns)) {
      let def = `"${name}" ${col.type.toUpperCase()}`;
      if (col.primaryKey) {
        def += ' PRIMARY KEY';
        if (col.autoIncrement) def += ' AUTOINCREMENT';
      }
      if (col.notNull) def += ' NOT NULL';
      if (col.unique) def += ' UNIQUE';
      if (col.default !== undefined) {
        const val = typeof col.default === 'string'
          ? `'${col.default}'`
          : col.default === null ? 'NULL' : String(col.default);
        def += ` DEFAULT ${val}`;
      }
      colDefs.push(def);
    }

    this.db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')})`);

    // Create indexes
    if (tableSchema.indexes) {
      for (const idx of tableSchema.indexes) {
        const idxName = idx.name || `idx_${tableName}_${idx.columns.join('_')}`;
        const unique = idx.unique ? 'UNIQUE ' : '';
        const cols = idx.columns.map(c => `"${c}"`).join(', ');
        this.db.exec(`CREATE ${unique}INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${cols})`);
      }
    }

    this.tablesCreated.add(tableName);
  }

  // --------------------------------------------------------------------------
  // Key convention: "tableName:primaryKeyValue"
  // --------------------------------------------------------------------------

  private parseKey(key: string): { table: string; id: string } {
    // Keys arrive as "smallstore:collection:path" from the router.
    // We extract the table name from the collection, and the row ID from the path.
    // For structured adapter, the last segment before the ID is the table name.
    // Simplest: split by ":" — last two parts are table:id
    const parts = key.split(':');
    if (parts.length >= 3) {
      // "smallstore:collection:subpath" → table = collection, id = subpath
      return { table: parts[1], id: parts.slice(2).join(':') };
    }
    if (parts.length === 2) {
      return { table: parts[0], id: parts[1] };
    }
    return { table: 'default', id: key };
  }

  private getPrimaryKeyCol(table: string): string {
    const schema = this.schema[table];
    if (!schema) return 'id';
    for (const [name, col] of Object.entries(schema.columns)) {
      if (col.primaryKey) return name;
    }
    return 'id';
  }

  // --------------------------------------------------------------------------
  // StorageAdapter interface
  // --------------------------------------------------------------------------

  async get(key: string): Promise<any> {
    try {
      const { table, id } = this.parseKey(key);
      if (!this.schema[table]) {
        // Fall back: treat key as table-less KV (shouldn't happen in normal use)
        return null;
      }
      this.ensureTable(table);

      const pkCol = this.getPrimaryKeyCol(table);
      const stmt = this.db.prepare(`SELECT * FROM "${table}" WHERE "${pkCol}" = ?`);
      const row = stmt.get(id) as Record<string, any> | undefined;
      return row ?? null;
    } catch (error) {
      console.error(`[StructuredSQLiteAdapter] Error getting ${key}:`, error);
      return null;
    }
  }

  async set(key: string, value: any, _ttl?: number): Promise<void> {
    const { table, id } = this.parseKey(key);
    if (!this.schema[table]) {
      throw new Error(`[StructuredSQLiteAdapter] No schema for table "${table}"`);
    }
    this.ensureTable(table);

    const pkCol = this.getPrimaryKeyCol(table);
    const cols = Object.keys(this.schema[table].columns);

    // Build row from value (which should be an object with column names as keys)
    const row: Record<string, any> = typeof value === 'object' && value !== null
      ? { ...value }
      : {};

    // Ensure primary key is set
    if (row[pkCol] === undefined) {
      row[pkCol] = id;
    }

    const presentCols = cols.filter(c => row[c] !== undefined);
    const placeholders = presentCols.map(() => '?').join(', ');
    const colNames = presentCols.map(c => `"${c}"`).join(', ');
    const values = presentCols.map(c => row[c]);

    // UPSERT: insert or replace on conflict
    const updateSet = presentCols
      .filter(c => c !== pkCol)
      .map(c => `"${c}" = excluded."${c}"`)
      .join(', ');

    const sql = updateSet
      ? `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT("${pkCol}") DO UPDATE SET ${updateSet}`
      : `INSERT OR REPLACE INTO "${table}" (${colNames}) VALUES (${placeholders})`;

    this.db.prepare(sql).run(...values);

    // Auto-index for FTS search (best-effort)
    try { this._searchProvider.index(key, value); } catch (err) { console.warn('[StructuredSQLite] FTS indexing failed:', err); }
  }

  async delete(key: string): Promise<void> {
    try {
      const { table, id } = this.parseKey(key);
      if (!this.schema[table]) return;
      this.ensureTable(table);

      const pkCol = this.getPrimaryKeyCol(table);
      this.db.prepare(`DELETE FROM "${table}" WHERE "${pkCol}" = ?`).run(id);

      // Remove from FTS index (best-effort)
      try { this._searchProvider.remove(key); } catch (err) { console.warn('[StructuredSQLite] FTS removal failed:', err); }
    } catch (error) {
      console.error(`[StructuredSQLiteAdapter] Error deleting ${key}:`, error);
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const { table, id } = this.parseKey(key);
      if (!this.schema[table]) return false;
      this.ensureTable(table);

      const pkCol = this.getPrimaryKeyCol(table);
      const row = this.db.prepare(
        `SELECT 1 FROM "${table}" WHERE "${pkCol}" = ? LIMIT 1`
      ).get(id);
      return row !== undefined;
    } catch {
      return false;
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    try {
      const allKeys: string[] = [];
      for (const tableName of Object.keys(this.schema)) {
        this.ensureTable(tableName);
        const pkCol = this.getPrimaryKeyCol(tableName);
        let rows: Array<Record<string, any>>;

        if (prefix) {
          rows = this.db.prepare(
            `SELECT "${pkCol}" as pk FROM "${tableName}" WHERE "${pkCol}" LIKE ? ORDER BY "${pkCol}"`
          ).all(`${prefix}%`) as Array<Record<string, any>>;
        } else {
          rows = this.db.prepare(
            `SELECT "${pkCol}" as pk FROM "${tableName}" ORDER BY "${pkCol}"`
          ).all() as Array<Record<string, any>>;
        }

        for (const row of rows) {
          allKeys.push(`${tableName}:${row.pk}`);
        }
      }
      return allKeys;
    } catch (error) {
      console.error('[StructuredSQLite] keys() failed:', error);
      throw error;
    }
  }

  async clear(prefix?: string): Promise<void> {
    try {
      for (const tableName of Object.keys(this.schema)) {
        this.ensureTable(tableName);
        if (prefix) {
          const pkCol = this.getPrimaryKeyCol(tableName);
          this.db.prepare(
            `DELETE FROM "${tableName}" WHERE "${pkCol}" LIKE ?`
          ).run(`${prefix}%`);
        } else {
          this.db.exec(`DELETE FROM "${tableName}"`);
        }
      }
    } catch (error) {
      console.error(`[StructuredSQLiteAdapter] Error clearing:`, error);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Native query — real columns, no json_extract
  // --------------------------------------------------------------------------

  async query(options: AdapterQueryOptions): Promise<AdapterQueryResult> {
    // Determine target table from prefix
    // prefix is like "smallstore:collection:" — extract table name
    let tableName: string | undefined;
    if (options.prefix) {
      const parts = options.prefix.replace(/:\s*$/, '').split(':');
      tableName = parts.length >= 2 ? parts[1] : parts[0];
    }

    if (!tableName || !this.schema[tableName]) {
      // If no valid table, query all tables
      const allData: any[] = [];
      for (const tbl of Object.keys(this.schema)) {
        this.ensureTable(tbl);
        const rows = this.db.prepare(`SELECT * FROM "${tbl}"`).all() as any[];
        allData.push(...rows);
      }
      return { data: allData, totalCount: allData.length };
    }

    this.ensureTable(tableName);

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.filter) {
      for (const [field, value] of Object.entries(options.filter)) {
        if (value === null) {
          conditions.push(`"${field}" IS NULL`);
        } else if (typeof value === 'object' && !Array.isArray(value)) {
          for (const [op, operand] of Object.entries(value as Record<string, any>)) {
            const sqlOp = MONGO_TO_SQL[op];
            if (sqlOp) {
              conditions.push(`"${field}" ${sqlOp} ?`);
              params.push(operand);
            } else if (op === '$in' && Array.isArray(operand)) {
              const ph = operand.map(() => '?').join(', ');
              conditions.push(`"${field}" IN (${ph})`);
              params.push(...operand);
            } else if (op === '$nin' && Array.isArray(operand)) {
              const ph = operand.map(() => '?').join(', ');
              conditions.push(`"${field}" NOT IN (${ph})`);
              params.push(...operand);
            } else if (op === '$contains') {
              conditions.push(`"${field}" LIKE ?`);
              params.push(`%${operand}%`);
            } else if (op === '$startsWith') {
              conditions.push(`"${field}" LIKE ?`);
              params.push(`${operand}%`);
            }
          }
        } else {
          conditions.push(`"${field}" = ?`);
          params.push(value);
        }
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderClause = '';
    if (options.sort) {
      const parts = Object.entries(options.sort).map(([f, d]) =>
        `"${f}" ${d === -1 ? 'DESC' : 'ASC'}`
      );
      orderClause = `ORDER BY ${parts.join(', ')}`;
    }

    // Count
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM "${tableName}" ${where}`
    ).get(...params) as { count: number } | undefined;
    const totalCount = countRow?.count ?? 0;

    // Data
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
      limitClause = 'LIMIT -1 OFFSET ?';
      dataParams.push(options.skip);
    }

    const rows = this.db.prepare(
      `SELECT * FROM "${tableName}" ${where} ${orderClause} ${limitClause}`
    ).all(...dataParams) as any[];

    return { data: rows, totalCount };
  }

  // --------------------------------------------------------------------------
  // Extra: direct table access for structured operations
  // --------------------------------------------------------------------------

  /** Get the raw Database instance for advanced use */
  getDatabase(): Database { return this.db; }

  /** Get schema for a table */
  getTableSchema(table: string): TableSchema | undefined { return this.schema[table]; }

  /** List all configured tables */
  listTables(): string[] { return Object.keys(this.schema); }

  /** Insert multiple rows in a transaction */
  insertMany(table: string, rows: Record<string, any>[]): void {
    this.ensureTable(table);
    const cols = Object.keys(this.schema[table].columns);

    this.db.exec('BEGIN');
    let i = 0;
    try {
      for (const row of rows) {
        const presentCols = cols.filter(c => row[c] !== undefined);
        const placeholders = presentCols.map(() => '?').join(', ');
        const colNames = presentCols.map(c => `"${c}"`).join(', ');
        const values = presentCols.map(c => row[c]);

        this.db.prepare(
          `INSERT OR REPLACE INTO "${table}" (${colNames}) VALUES (${placeholders})`
        ).run(...values);
        i++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new Error(`insertMany failed at item ${i}: ${error}`, { cause: error });
    }
  }

  /** Close database */
  close(): void { this.db.close(); }
}

// ============================================================================
// Operator mapping
// ============================================================================

const MONGO_TO_SQL: Record<string, string> = {
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

export function createStructuredSQLiteAdapter(
  config: StructuredSQLiteConfig
): StructuredSQLiteAdapter {
  return new StructuredSQLiteAdapter(config);
}
