/**
 * Cloudflare D1 Storage Adapter
 * 
 * SQLite database storage via Cloudflare D1.
 * - Cheap (generous free tier)
 * - Persistent
 * - KV-style tables
 * - Dynamic table creation (table-per-collection)
 * - 1MB per row limit
 * 
 * Dual Mode:
 * - HTTP Mode: External access via Cloudflare Workers HTTP API
 * - Native Mode: Direct binding access (inside Workers)
 * 
 * Use cases:
 * - Structured data storage
 * - Collections with multiple tables
 * - KV storage with SQL queries
 * - Small-medium objects (<1MB)
 */

// Minimal type stubs for Cloudflare Workers bindings (only used in native mode inside Workers)
// deno-lint-ignore no-empty-interface
interface D1Database { [key: string]: any; }

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import type { RetryOptions } from '../utils/retry.ts';
import { retryFetch, type RetryFetchOptions } from '../utils/retry-fetch.ts';
import { debug } from '../utils/debug.ts';
import { CorruptValueError } from './errors.ts';
import {
  applyMessagingMigrations,
  buildDeleteByIdSql,
  buildFtsSql,
  buildKeysSql,
  buildListSql,
  buildSelectByIdSql,
  buildUpsertSql,
  decodeItemRow,
  encodeItemRow,
  MESSAGING_COLUMNS,
  type MessagingRowInput,
} from './cloudflare-d1-messaging-schema.ts';

// ============================================================================
// Cloudflare D1 Config
// ============================================================================

export interface CloudflareD1Config {
  /**
   * HTTP Mode: Base URL of smallstore-workers service
   * Example: "https://your-workers.your-subdomain.workers.dev"
   */
  baseUrl?: string;

  /**
   * Native Mode: Direct D1 binding (inside Workers)
   * Example: env.SM_D1
   */
  binding?: D1Database;
  
  /** Optional table name (defaults to 'kv_store') */
  table?: string;
  
  /** HTTP Mode: Optional API key for authentication */
  apiKey?: string;

  /** HTTP Mode: Retry options for transient failures (false to disable) */
  retry?: RetryOptions | false;

  /**
   * Opt into the messaging-mode schema (native mode only).
   *
   * When truthy, `ensureTable()` migrates to an `InboxItem`-shaped table
   * (denormalized columns + FTS5 virtual table + mirror triggers) instead
   * of the generic `{key, value, metadata}` KV schema.
   *
   * In messaging mode:
   * - `set(id, item)` upserts by `id` into the denormalized columns
   * - `get(id)` returns the reconstructed `InboxItem` (null if missing)
   * - `delete(id)` removes the row (FTS stays in sync via triggers)
   * - `query({ fts: "text" })` runs an FTS5 MATCH against
   *   summary/body/from_display/subject
   * - `query({ prefix, filter, limit })` still works (fallback to generic
   *   in-memory filter over the decoded items)
   *
   * HTTP mode rejects `messaging: true` because the HTTP surface is the
   * generic k/v endpoint; the messaging pipeline is expected to run inside
   * a Worker with a native D1 binding.
   *
   * See `.brief/mailroom-pipeline.md` § FTS5 for product-level rationale.
   */
  messaging?: boolean;

  /**
   * Maximum number of concurrent deletes per batch in `clear()`.
   *
   * `clear()` paginates the key list into batches of 100 and issues
   * deletes for each batch. Previous behaviour ran every key in a batch
   * via `Promise.all` (i.e. fully unbounded fan-out per batch). On large
   * tables that swamps D1 with parallel statements. This knob caps the
   * in-flight delete count per batch.
   *
   * Default: 4.
   */
  clearConcurrency?: number;
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// Default table name
const DEFAULT_TABLE = 'kv_store';

// ============================================================================
// Cloudflare D1 Adapter
// ============================================================================

/**
 * Cloudflare D1 storage adapter
 * 
 * Uses either HTTP API or native D1 binding for storage.
 */
export class CloudflareD1Adapter implements StorageAdapter {
  private baseUrl?: string;
  private binding?: D1Database;
  private table: string;
  private apiKey?: string;
  private mode: 'http' | 'native';
  private retryOpts?: RetryFetchOptions;
  private messaging: boolean;
  private clearConcurrency: number;
  /**
   * Memoized in-flight (or completed) `ensureTable()` run.
   *
   * Stored as `Promise<void>` rather than a boolean flag so two concurrent
   * first writes share the same migration run instead of racing it
   * (TOCTOU on a `migrated` flag would let both pass the guard, both call
   * `applyMessagingMigrations`, and both insert into `d1_migrations` with
   * the same name — the second insert collides on PK).
   *
   * If the migration rejects, we clear the cache so the next call retries
   * (treating the failure as transient — better than permanently latching
   * the adapter into a broken state).
   */
  private ensureTablePromise: Promise<void> | null = null;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'cloudflare-d1',
    supportedTypes: [
      'kv',           // Primitives
      'object',       // Objects/arrays (<1MB)
    ],
    maxItemSize: 1 * 1024 * 1024, // 1MB per row
    cost: {
      perGB: '$0.75/GB',
      perOperation: 'Free tier: 5M reads/day, 100k writes/day',
      tier: 'cheap',
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'medium',
      throughput: 'medium',
    },
    features: {
      ttl: false,
      transactions: true,  // SQLite transactions
    },
  };
  
  constructor(config: CloudflareD1Config = {}) {
    // Determine mode
    if (config.binding) {
      this.mode = 'native';
      this.binding = config.binding;
    } else if (config.baseUrl) {
      this.mode = 'http';
      this.baseUrl = config.baseUrl;
      this.apiKey = config.apiKey;
    } else {
      throw new Error(
        'CloudflareD1Adapter requires either baseUrl (HTTP mode) or binding (native mode)'
      );
    }
    
    this.table = config.table || DEFAULT_TABLE;
    this.retryOpts = config.retry === false ? { enabled: false } : config.retry ? { ...config.retry } : undefined;
    this.messaging = config.messaging === true;
    this.clearConcurrency = Math.max(1, config.clearConcurrency ?? 4);

    if (this.messaging && this.mode !== 'native') {
      throw new Error(
        'CloudflareD1Adapter: messaging mode requires native D1 binding (got HTTP mode). ' +
        'Pass { binding: env.SM_D1, messaging: true } from inside a Worker.',
      );
    }
  }
  
  // ============================================================================
  // Helper: Sanitize table name
  // ============================================================================
  
  private sanitizeTableName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  
  // ============================================================================
  // Helper: Ensure table exists
  // ============================================================================
  
  private ensureTable(): Promise<void> {
    // Memoize the migration as a Promise so concurrent first writes share
    // the same in-flight run (B035). On rejection, clear the cache so the
    // next caller retries — a transient migration failure shouldn't latch
    // the adapter shut.
    if (this.ensureTablePromise) return this.ensureTablePromise;

    this.ensureTablePromise = this.runMigration().catch((err) => {
      this.ensureTablePromise = null;
      throw err;
    });
    return this.ensureTablePromise;
  }

  private async runMigration(): Promise<void> {
    if (this.mode === 'native' && this.binding) {
      if (this.messaging) {
        // Messaging mode — denormalized InboxItem columns + FTS5 + triggers.
        // Each migration step is a single-line statement so it's safe for
        // both `exec()` and `prepare().run()`. Idempotent via the
        // `d1_migrations` tracking table (see migration helper comments).
        await applyMessagingMigrations(this.binding as any, this.table);
      } else {
        // D1 `binding.exec()` splits on newlines and requires each line to be a
        // complete statement. Use prepare()/run() for multi-statement DDL, OR
        // collapse to a single line. Single-line is simpler and works with both
        // exec and prepare. (Bug fixed 2026-04-23: previous multi-line template
        // tripped `Error in line 1: CREATE TABLE ... incomplete input`.)
        const sql = `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, created_at INTEGER DEFAULT (strftime('%s', 'now')), updated_at INTEGER DEFAULT (strftime('%s', 'now')))`;
        await this.binding.prepare(sql).run();
      }
    } else {
      // HTTP mode - table creation is handled by the API
      // (messaging mode is rejected at construction time)
      await this.httpRequest('/d1/table/create', {
        method: 'POST',
        body: JSON.stringify({ table: this.table }),
      });
    }
  }
  
  // ============================================================================
  // HTTP Mode Helpers
  // ============================================================================
  
  private async httpRequest<T = any>(
    path: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    if (!this.baseUrl) {
      throw new Error('HTTP mode requires baseUrl');
    }
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    const response = await retryFetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    }, this.retryOpts);

    const data = await response.json();
    if (!data || typeof data !== 'object') {
      throw new Error('Unexpected API response format from Cloudflare');
    }
    return data as ApiResponse<T>;
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  /**
   * Get value by key
   * 
   * @param key - Storage key
   * @returns Value, or null if not found
   */
  async get(key: string): Promise<any> {
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        await this.ensureTable();

        if (this.messaging) {
          // Messaging mode: key is the InboxItem id; reconstruct the item
          // from denormalized columns + JSON blob.
          const row = await this.binding
            .prepare(buildSelectByIdSql(this.table))
            .bind(key)
            .first();
          return row ? decodeItemRow(row) : null;
        }

        const sql = `SELECT value FROM ${this.table} WHERE key = ?`;
        const result = await this.binding.prepare(sql).bind(key).first();

        if (!result) {
          return null;
        }

        // Parse value. B005: previously this fell through to `return result.value`
        // (the raw string) on any JSON.parse failure, which masked corruption —
        // callers got back a string when they expected an object. Now we throw
        // a typed CorruptValueError so the caller can decide whether to repair,
        // skip, or alert.
        return this.decodeStoredValue(key, result.value as string);
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('key', key);
        params.set('table', this.table);

        const response = await this.httpRequest<{ key: string; value: any }>(
          `/d1/kv?${params.toString()}`
        );

        if (!response.success) {
          return null;
        }

        return response.data?.value ?? null;
      }
    } catch (error) {
      // CorruptValueError is intentionally surfaced — masking it as `null`
      // would just push the bug downstream.
      if (error instanceof CorruptValueError) throw error;
      console.error(`[CloudflareD1Adapter] Error getting ${key}:`, error);
      return null;
    }
  }

  /**
   * Decode a stored generic-mode value.
   *
   * - String inputs are JSON-parsed; non-JSON strings throw `CorruptValueError`.
   * - The exception: a value that was set as a literal string (no JSON encoding
   *   was applied because it was already a string at write time) cannot be
   *   distinguished from a corrupt blob at the storage layer. Callers in
   *   generic mode should pass objects/arrays through `set()` (which JSON-
   *   stringifies) so reads can round-trip cleanly. Strings written via
   *   `set()` are stored as-is; this matches the prior behavior for any
   *   value that *did* parse, but corrupt-or-string-typed-value is now an
   *   explicit error rather than a silent fallback.
   */
  private decodeStoredValue(key: string, raw: string): any {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new CorruptValueError(
        'cloudflare-d1',
        'get',
        `Stored value for key "${key}" is not valid JSON; row may be corrupt or was written outside the adapter`,
        err instanceof Error ? err : undefined,
      );
    }
  }
  
  /**
   * Set value by key
   * 
   * @param key - Storage key
   * @param value - Value to store
   */
  async set(key: string, value: any): Promise<void> {
    if (this.mode === 'native' && this.binding && this.messaging) {
      // Messaging mode: value must be InboxItem-shaped. Denormalize into
      // columns + JSON blob so FTS5 + indexes work. The `key` argument is
      // expected to equal `value.id` — we don't force it, but callers that
      // pass a mismatched key will get a surprising lookup miss later.
      await this.ensureTable();

      if (!value || typeof value !== 'object') {
        throw new Error(
          `CloudflareD1Adapter(messaging): set() expects an InboxItem-shaped object, got ${typeof value}`,
        );
      }

      const item = value as MessagingRowInput;
      // Prefer the explicit key when callers pass one; otherwise use item.id.
      const rowId = key ?? item.id;
      if (!rowId) {
        throw new Error('CloudflareD1Adapter(messaging): missing id — pass key or value.id');
      }
      const row = encodeItemRow({ ...item, id: rowId });

      const sql = buildUpsertSql(this.table);
      const params = MESSAGING_COLUMNS.map(c => row[c]);
      await this.binding.prepare(sql).bind(...params).run();
      return;
    }

    // Serialize value to JSON string
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (this.mode === 'native' && this.binding) {
      // Native mode
      await this.ensureTable();

      const sql = `
        INSERT INTO ${this.table} (key, value, updated_at)
        VALUES (?, ?, strftime('%s', 'now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `;

      await this.binding.prepare(sql).bind(key, serialized).run();
    } else {
      // HTTP mode
      await this.httpRequest('/d1/kv', {
        method: 'POST',
        body: JSON.stringify({
          key,
          value,
          table: this.table,
        }),
      });
    }
  }
  
  /**
   * Delete value by key
   * 
   * @param key - Storage key
   */
  async delete(key: string): Promise<void> {
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        await this.ensureTable();

        const sql = this.messaging
          ? buildDeleteByIdSql(this.table)
          : `DELETE FROM ${this.table} WHERE key = ?`;
        await this.binding.prepare(sql).bind(key).run();
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('key', key);
        params.set('table', this.table);
        
        await this.httpRequest(`/d1/kv?${params.toString()}`, {
          method: 'DELETE',
        });
      }
    } catch (error) {
      console.error(`[CloudflareD1Adapter] Error removing ${key}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if key exists
   * 
   * @param key - Storage key
   * @returns true if exists
   */
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }
  
  /**
   * List keys with optional prefix
   * 
   * @param prefix - Optional prefix filter
   * @returns Array of keys
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      if (this.mode === 'native' && this.binding) {
        // Native mode
        await this.ensureTable();

        if (this.messaging) {
          // Messaging mode: the PK column is `id`, not `key`.
          const sql = buildKeysSql(this.table, prefix);
          const stmt = this.binding.prepare(sql);
          const result = prefix !== undefined
            ? await stmt.bind(`${prefix}%`).all()
            : await stmt.all();
          return result.results.map((row: any) => row.id);
        }

        let sql = `SELECT key FROM ${this.table}`;
        const bindings: any[] = [];

        if (prefix) {
          sql += ` WHERE key LIKE ?`;
          bindings.push(`${prefix}%`);
        }

        sql += ` ORDER BY key ASC`;

        const result = await this.binding.prepare(sql).bind(...bindings).all();

        return result.results.map((row: any) => row.key);
      } else {
        // HTTP mode
        const params = new URLSearchParams();
        params.set('table', this.table);
        if (prefix) params.set('prefix', prefix);
        
        const response = await this.httpRequest<{ keys: Array<{ key: string }> }>(
          `/d1/list?${params.toString()}`
        );
        
        if (!response.success || !response.data?.keys) {
          return [];
        }
        
        return response.data.keys.map(item => item.key);
      }
    } catch (error) {
      console.error('[CloudflareD1Adapter] Error getting keys:', error);
      return [];
    }
  }
  
  /**
   * Clear all data (for testing)
   *
   * @param prefix - Optional prefix to clear only specific namespace
   *
   * B034: Previous behaviour ran every key in a batch through `Promise.all`
   * (i.e. unbounded fan-out per batch — 100 simultaneous deletes). This
   * fans out enough parallel D1 statements to swamp the binding on large
   * tables. We now run sequential batches with at most `clearConcurrency`
   * deletes in flight at any time inside a batch. Default 4. Tunable via
   * the constructor's `clearConcurrency` config.
   */
  async clear(prefix?: string): Promise<void> {
    const keys = await this.keys(prefix);

    if (keys.length === 0) return;

    const batchSize = 100;
    const concurrency = this.clearConcurrency;

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      // Sequential sub-batches inside the batch — at most `concurrency`
      // deletes in flight at any time.
      for (let j = 0; j < batch.length; j += concurrency) {
        const slice = batch.slice(j, j + concurrency);
        await Promise.all(slice.map((key) => this.delete(key)));
      }
    }
  }
  
  // ============================================================================
  // High-Level Operations
  // ============================================================================
  
  /**
   * Upsert objects by key field
   * 
   * @param data - Single object or array of objects
   * @param options - Upsert options
   * @returns Result with count and keys
   */
  async upsert(
    data: any | any[],
    options?: {
      idField?: string;
      keyGenerator?: (obj: any) => string;
    }
  ): Promise<{ count: number; keys: string[] }> {
    const idField = options?.idField || 'id';
    const keyGenerator = options?.keyGenerator;
    const items = Array.isArray(data) ? data : [data];
    
    const keys: string[] = [];
    
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`upsert() requires object(s), got ${typeof item}`);
      }
      
      let key: string;
      if (keyGenerator) {
        key = keyGenerator(item);
      } else {
        const id = item[idField];
        if (id === undefined || id === null) {
          throw new Error(`Missing required field '${idField}' in object`);
        }
        key = String(id);
      }
      
      await this.set(key, item);
      keys.push(key);
    }
    
    return { count: items.length, keys };
  }
  
  /**
   * Insert objects with auto-ID detection
   * 
   * @param data - Single object or array of objects
   * @param options - Insert options
   * @returns Result with count, keys, and detected idField
   */
  async insert(
    data: any | any[],
    options?: {
      idField?: string;
      keyGenerator?: (obj: any) => string;
      autoDetect?: boolean;
    }
  ): Promise<{ count: number; keys: string[]; idField?: string }> {
    const items = Array.isArray(data) ? data : [data];
    
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`insert() requires object(s), got ${typeof item}`);
      }
    }
    
    let idField = options?.idField;
    
    if (!idField && !options?.keyGenerator && options?.autoDetect !== false) {
      idField = this.autoDetectIdField(items) ?? undefined;
      if (!idField) {
        throw new Error(
          'Could not auto-detect ID field. Specify idField or keyGenerator.'
        );
      }
    }
    
    const result = await this.upsert(data, {
      idField,
      keyGenerator: options?.keyGenerator,
    });
    
    return { ...result, idField };
  }
  
  /**
   * Query items with filtering
   *
   * Basic in-memory filtering. In messaging mode, additionally supports:
   * - `fts: "query"` — run an FTS5 MATCH against summary/body/from_display/subject
   *   and return decoded items, newest-first. Post-filtered by `filter`/`limit`
   *   if provided.
   *
   * Non-messaging mode ignores `fts` (no FTS index exists in the generic
   * k/v schema).
   *
   * @param params - Query params
   * @returns Filtered items
   */
  async query(params: {
    prefix?: string;
    filter?: (item: any) => boolean;
    limit?: number;
    /**
     * Messaging-mode only: FTS5 MATCH query string. Falls through to the
     * scan path when omitted, or when the adapter isn't in messaging mode.
     */
    fts?: string;
  }): Promise<{ data: any[]; totalCount: number }> {
    // FTS5 path (messaging mode only).
    if (params.fts && this.mode === 'native' && this.binding && this.messaging) {
      await this.ensureTable();

      const sql = buildFtsSql(this.table);
      const result = await this.binding.prepare(sql).bind(params.fts).all();

      const results: any[] = [];
      for (const row of result.results ?? []) {
        const item = decodeItemRow(row);
        if (!params.filter || params.filter(item)) {
          results.push(item);
          if (params.limit && results.length >= params.limit) break;
        }
      }

      return { data: results, totalCount: results.length };
    }

    // Messaging-mode non-FTS path: use column-based list scan instead of
    // the get()-per-key loop. Cheaper (one round trip) and preserves the
    // received_at DESC ordering callers expect.
    if (this.mode === 'native' && this.binding && this.messaging) {
      await this.ensureTable();

      const sql = buildListSql(this.table, params.prefix);
      const stmt = this.binding.prepare(sql);
      const result = params.prefix !== undefined
        ? await stmt.bind(`${params.prefix}%`).all()
        : await stmt.all();

      const results: any[] = [];
      for (const row of result.results ?? []) {
        const item = decodeItemRow(row);
        if (!params.filter || params.filter(item)) {
          results.push(item);
          if (params.limit && results.length >= params.limit) break;
        }
      }

      return { data: results, totalCount: results.length };
    }

    // Fallback: generic k/v keys-and-get loop.
    const keys = await this.keys(params.prefix);
    const results: any[] = [];

    for (const key of keys) {
      const value = await this.get(key);

      if (value !== null) {
        if (!params.filter || params.filter(value)) {
          results.push(value);

          if (params.limit && results.length >= params.limit) {
            break;
          }
        }
      }
    }

    return { data: results, totalCount: results.length };
  }

  /**
   * List all items with optional pagination
   *
   * @param options - List options
   * @returns Array of items
   *
   * B036: Native mode now pushes the offset/limit window down to SQL via
   * `LIMIT ? OFFSET ?` instead of full-scanning keys + slicing in JS, then
   * making `limit` extra `get()` round-trips. Single round trip, decode
   * each row's value with the same JSON-parse semantics as `get()` (i.e.
   * a corrupt row throws `CorruptValueError` rather than getting silently
   * coerced to a raw string).
   *
   * Messaging mode reuses `buildListSql` with the same window applied at
   * the SQL layer.
   *
   * HTTP mode falls back to keys-then-get (no equivalent windowed
   * endpoint exists in the smallstore-workers HTTP API today).
   */
  async list(options?: {
    prefix?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const offset = Math.max(0, options?.offset ?? 0);
    // Use a sentinel for "no limit" — D1 doesn't accept undefined here.
    // When unset, ask SQLite for everything (-1 == unbounded in SQLite syntax).
    const limit = options?.limit !== undefined ? Math.max(0, options.limit) : -1;

    if (this.mode === 'native' && this.binding) {
      await this.ensureTable();

      if (this.messaging) {
        // Messaging mode: SELECT * with received_at ordering, then decode rows.
        const baseSql = options?.prefix !== undefined
          ? `SELECT * FROM ${this.table} WHERE id LIKE ? ORDER BY received_at DESC`
          : `SELECT * FROM ${this.table} ORDER BY received_at DESC`;
        const sql = `${baseSql} LIMIT ? OFFSET ?`;

        const stmt = this.binding.prepare(sql);
        const result = options?.prefix !== undefined
          ? await stmt.bind(`${options.prefix}%`, limit, offset).all()
          : await stmt.bind(limit, offset).all();

        return (result.results ?? []).map((row: any) => decodeItemRow(row));
      }

      // Generic k/v mode: pull (key, value) directly with LIMIT/OFFSET.
      const baseSql = options?.prefix !== undefined
        ? `SELECT key, value FROM ${this.table} WHERE key LIKE ? ORDER BY key ASC`
        : `SELECT key, value FROM ${this.table} ORDER BY key ASC`;
      const sql = `${baseSql} LIMIT ? OFFSET ?`;

      const stmt = this.binding.prepare(sql);
      const result = options?.prefix !== undefined
        ? await stmt.bind(`${options.prefix}%`, limit, offset).all()
        : await stmt.bind(limit, offset).all();

      const items: any[] = [];
      for (const row of result.results ?? []) {
        const raw = (row as any).value as string;
        if (raw === null || raw === undefined) continue;
        // Same decode semantics as get() — corrupt rows throw rather than
        // returning the raw string and masking the corruption.
        items.push(this.decodeStoredValue((row as any).key as string, raw));
      }
      return items;
    }

    // HTTP mode: no equivalent windowed endpoint, keep keys-then-get.
    const keys = await this.keys(options?.prefix);
    const startIdx = offset;
    const endIdx = options?.limit ? startIdx + options.limit : keys.length;
    const keysSlice = keys.slice(startIdx, endIdx);

    const items: any[] = [];
    for (const key of keysSlice) {
      const value = await this.get(key);
      if (value !== null) {
        items.push(value);
      }
    }

    return items;
  }
  
  // ============================================================================
  // Private Helpers
  // ============================================================================
  
  private autoDetectIdField(items: any[]): string | null {
    if (items.length === 0) return null;
    
    const commonIdFields = [
      'id', '_id', 'pmid', 'doi', 'uuid', 'key', 'uid', 'recordId',
      'userId', 'email', 'objectId', 'entityId'
    ];
    
    for (const field of commonIdFields) {
      if (items[0][field] !== undefined) {
        const sampleSize = Math.min(5, items.length);
        const values = new Set();
        let isUnique = true;
        
        for (let i = 0; i < sampleSize; i++) {
          const value = items[i][field];
          if (value === undefined || value === null) {
            isUnique = false;
            break;
          }
          if (values.has(value)) {
            isUnique = false;
            break;
          }
          values.add(value);
        }
        
        if (isUnique) {
          return field;
        }
      }
    }
    
    return null;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new Cloudflare D1 adapter instance
 * 
 * @param config - Cloudflare D1 configuration
 * @returns CloudflareD1Adapter
 * 
 * @example HTTP Mode
 * const adapter = createCloudflareD1Adapter({
 *   baseUrl: "https://your-workers.your-subdomain.workers.dev",
 *   table: "my_collection"
 * });
 *
 * @example Native Mode (inside Workers)
 * const adapter = createCloudflareD1Adapter({
 *   binding: env.SM_D1,
 *   table: "my_collection"
 * });
 *
 * @example Messaging Mode (InboxItem schema + FTS5)
 * const adapter = createCloudflareD1Adapter({
 *   binding: env.MAILROOM_D1,
 *   table: "mailroom_items",
 *   messaging: true,
 * });
 * await adapter.set(item.id, item);
 * const { data } = await adapter.query({ fts: "newsletter stripe" });
 */
export function createCloudflareD1Adapter(config: CloudflareD1Config): CloudflareD1Adapter {
  return new CloudflareD1Adapter(config);
}

