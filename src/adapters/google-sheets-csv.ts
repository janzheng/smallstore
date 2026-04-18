/**
 * Google Sheets CSV Adapter (read-only)
 *
 * Reads public/shared Google Sheets via their CSV export URL.
 * No OAuth, no Apps Script, no credentials — just a URL of the form:
 *   https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv
 *
 * Rows are parsed into key/value records. The adapter is read-only:
 *   - get()/has()/keys()/list() work as expected
 *   - set()/delete()/patch() throw UnsupportedOperationError immediately
 *
 * Contrast with SheetlogAdapter (src/adapters/sheetlog.ts) which uses a
 * Google Apps Script proxy and supports writes.
 */

import { parse as parseCsv } from 'jsr:@std/csv@^1.0.0';
import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import { throwUnsupportedOperation } from './errors.ts';

// ============================================================================
// Config
// ============================================================================

export interface GoogleSheetsCsvConfig {
  /**
   * CSV export URL for the sheet.
   * Example: https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv
   */
  url: string;

  /**
   * Column name to use as the record key. Defaults to the 0-based row index
   * stringified (e.g. "0", "1", "2"). When provided, rows with missing or
   * duplicate key values keep the last-seen row.
   */
  keyColumn?: string;

  /**
   * TTL for the in-memory cache of the fetched CSV, in ms. Defaults to
   * 60_000 (1 minute). Set to 0 to disable caching (fetch on every call).
   */
  refreshMs?: number;

  /**
   * Optional custom fetch implementation — used by tests to stub the network.
   */
  fetchImpl?: typeof fetch;
}

// ============================================================================
// Adapter
// ============================================================================

interface CachedRows {
  rows: Record<string, any>[];
  keyed: Map<string, Record<string, any>>;
  fetchedAt: number;
}

export class GoogleSheetsCsvAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'google-sheets-csv',
    supportedTypes: ['object'],
    maxItemSize: undefined,
    maxTotalSize: undefined,
    cost: { tier: 'free' },
    performance: {
      readLatency: 'high',    // network fetch + parse
      writeLatency: 'high',   // writes throw, but conceptually unavailable
      throughput: 'low',
    },
    features: {
      ttl: false,
      query: false,
      search: false,
    },
  };

  private url: string;
  private keyColumn: string | undefined;
  private refreshMs: number;
  private fetchImpl: typeof fetch;

  private cache: CachedRows | null = null;
  private inFlight: Promise<CachedRows> | null = null;

  constructor(config: GoogleSheetsCsvConfig) {
    if (!config || typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error('GoogleSheetsCsvAdapter requires a `url` option');
    }
    this.url = config.url;
    this.keyColumn = config.keyColumn;
    this.refreshMs = config.refreshMs ?? 60_000;
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  // --------------------------------------------------------------------------
  // Core read operations
  // --------------------------------------------------------------------------

  async get(key: string): Promise<Record<string, any> | null> {
    const { keyed } = await this.loadRows();
    const row = keyed.get(String(key));
    return row ? { ...row } : null;
  }

  async has(key: string): Promise<boolean> {
    const { keyed } = await this.loadRows();
    return keyed.has(String(key));
  }

  async keys(prefix?: string): Promise<string[]> {
    const { keyed } = await this.loadRows();
    const allKeys = Array.from(keyed.keys());
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  /**
   * List all rows (optionally with prefix/limit/offset).
   * Returns plain row objects in source order.
   */
  async list(options?: {
    prefix?: string;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, any>[]> {
    const { rows, keyed } = await this.loadRows();

    let items = rows.map((r) => ({ ...r }));

    if (options?.prefix) {
      const prefix = options.prefix;
      const keyByRef = new Map<Record<string, any>, string>();
      for (const [k, row] of keyed.entries()) keyByRef.set(row, k);
      items = rows
        .filter((row) => {
          const k = keyByRef.get(row);
          return k !== undefined && k.startsWith(prefix);
        })
        .map((r) => ({ ...r }));
    }

    const start = options?.offset ?? 0;
    const end = options?.limit !== undefined ? start + options.limit : items.length;
    return items.slice(start, end);
  }

  // --------------------------------------------------------------------------
  // Write operations — all throw
  // --------------------------------------------------------------------------

  // Using `async` so these reject the returned Promise (matches the
  // StorageAdapter interface ergonomics) rather than throwing synchronously
  // from a function that advertises Promise<void>.
  async set(_key: string, _value: unknown, _ttl?: number): Promise<void> {
    throwUnsupportedOperation(
      'google-sheets-csv',
      'set',
      'This adapter is read-only. Public CSV export URLs cannot be written to.',
      'the sheetlog adapter (Apps Script-backed) if you need writes',
    );
  }

  async delete(_key: string): Promise<void> {
    throwUnsupportedOperation(
      'google-sheets-csv',
      'delete',
      'This adapter is read-only. Public CSV export URLs cannot be written to.',
      'the sheetlog adapter (Apps Script-backed) if you need writes',
    );
  }

  async patch(_key: string, _patch: Record<string, any>): Promise<void> {
    throwUnsupportedOperation(
      'google-sheets-csv',
      'patch',
      'This adapter is read-only. Public CSV export URLs cannot be written to.',
      'the sheetlog adapter (Apps Script-backed) if you need writes',
    );
  }

  /**
   * Clear on a read-only adapter just drops the in-memory cache so the next
   * read refetches. It does NOT modify the remote sheet (which isn't possible).
   */
  async clear(_prefix?: string): Promise<void> {
    this.cache = null;
    this.inFlight = null;
  }

  // --------------------------------------------------------------------------
  // Internal — fetch + parse + cache
  // --------------------------------------------------------------------------

  private async loadRows(): Promise<CachedRows> {
    // Cache hit?
    if (this.refreshMs > 0 && this.cache) {
      const age = Date.now() - this.cache.fetchedAt;
      if (age <= this.refreshMs) return this.cache;
    }

    // Coalesce concurrent fetches
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchAndParse().finally(() => {
      this.inFlight = null;
    });

    const result = await this.inFlight;
    if (this.refreshMs > 0) {
      this.cache = result;
    } else {
      this.cache = null;
    }
    return result;
  }

  private async fetchAndParse(): Promise<CachedRows> {
    const res = await this.fetchImpl(this.url, {
      method: 'GET',
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(
        `[google-sheets-csv] Fetch failed: ${res.status} ${res.statusText} (${this.url})`,
      );
    }
    const text = await res.text();
    const rows = parseRows(text);
    const keyed = keyRows(rows, this.keyColumn);
    return { rows, keyed, fetchedAt: Date.now() };
  }
}

// ============================================================================
// Parse helpers
// ============================================================================

function parseRows(text: string): Record<string, any>[] {
  if (!text || text.trim().length === 0) return [];

  // @std/csv's skipFirstRow uses the header row as object keys — exactly
  // what we want. Returns Record<string, string>[].
  const parsed = parseCsv(text, {
    skipFirstRow: true,
    trimLeadingSpace: false,
  }) as Record<string, string>[];

  return parsed;
}

function keyRows(
  rows: Record<string, any>[],
  keyColumn: string | undefined,
): Map<string, Record<string, any>> {
  const keyed = new Map<string, Record<string, any>>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let key: string;
    if (keyColumn !== undefined) {
      const raw = row[keyColumn];
      // Skip rows with missing/empty key values when a keyColumn is specified
      if (raw === undefined || raw === null || raw === '') continue;
      key = String(raw);
    } else {
      key = String(i);
    }
    keyed.set(key, row);
  }
  return keyed;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new Google Sheets CSV adapter instance.
 *
 * @example
 * const adapter = createGoogleSheetsCsvAdapter({
 *   url: 'https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv',
 *   keyColumn: 'id',
 *   refreshMs: 60_000,
 * });
 * const row = await adapter.get('abc-123');
 */
export function createGoogleSheetsCsvAdapter(
  config: GoogleSheetsCsvConfig,
): GoogleSheetsCsvAdapter {
  return new GoogleSheetsCsvAdapter(config);
}
