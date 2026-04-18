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
   * Request timeout in ms. A hung fetch would otherwise stall every coalesced
   * caller indefinitely. Default: 30_000 (30s). Set to 0 to disable.
   */
  timeoutMs?: number;

  /**
   * Optional custom fetch implementation — used by tests to stub the network.
   * Intended for testing only; leaving this set in production swaps the real
   * network for the stub.
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
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  private cache: CachedRows | null = null;
  private inFlight: Promise<CachedRows> | null = null;
  private inFlightController: AbortController | null = null;

  constructor(config: GoogleSheetsCsvConfig) {
    if (!config || typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error('GoogleSheetsCsvAdapter requires a `url` option');
    }
    // Require an absolute http(s) URL. Accepting relative or file:/ URLs
    // would defer the error until first fetch and produce a confusing stack.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.url);
    } catch {
      throw new Error(`GoogleSheetsCsvAdapter: invalid url "${config.url}"`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        `GoogleSheetsCsvAdapter: url must be http(s), got "${parsedUrl.protocol}"`,
      );
    }
    this.url = config.url;
    this.keyColumn = config.keyColumn;
    this.refreshMs = config.refreshMs ?? 60_000;
    this.timeoutMs = config.timeoutMs ?? 30_000;
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
   * Returns plain row objects in source order. Only returns rows that
   * `keys()` would also surface — i.e. rows with a valid key under the
   * configured keyColumn. This keeps list() and keys() in agreement so
   * callers can round-trip (list → get by key) without gaps.
   */
  async list(options?: {
    prefix?: string;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, any>[]> {
    const { keyed } = await this.loadRows();

    let entries = Array.from(keyed.entries());
    if (options?.prefix) {
      const prefix = options.prefix;
      entries = entries.filter(([k]) => k.startsWith(prefix));
    }

    const start = options?.offset ?? 0;
    const end = options?.limit !== undefined ? start + options.limit : entries.length;
    return entries.slice(start, end).map(([, row]) => ({ ...row }));
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
    // Abort the in-flight fetch so it can't repopulate cache after clear().
    if (this.inFlightController) {
      try { this.inFlightController.abort(); } catch { /* ignore */ }
    }
    this.inFlight = null;
    this.inFlightController = null;
  }

  // --------------------------------------------------------------------------
  // Internal — fetch + parse + cache
  // --------------------------------------------------------------------------

  private async loadRows(): Promise<CachedRows> {
    // Cache hit?
    if (this.refreshMs > 0 && this.cache) {
      const age = Date.now() - this.cache.fetchedAt;
      // Negative age = wall clock went backwards (NTP correction); treat as
      // expired so we don't trap a stale cache until the clock catches up.
      if (age >= 0 && age <= this.refreshMs) return this.cache;
    }

    // Coalesce concurrent fetches
    if (this.inFlight) return this.inFlight;

    // Generation counter so clear() can invalidate a result that lands after
    // the abort — the aborted fetch will reject, but we also guard here.
    const controller = new AbortController();
    this.inFlightController = controller;
    const fetchPromise = this.fetchAndParse(controller.signal).finally(() => {
      if (this.inFlightController === controller) {
        this.inFlight = null;
        this.inFlightController = null;
      }
    });
    this.inFlight = fetchPromise;

    const result = await fetchPromise;
    // If clear() swapped the controller while we were waiting, don't cache.
    if (this.inFlightController === null && controller.signal.aborted) {
      return result;
    }
    if (this.refreshMs > 0) {
      this.cache = result;
    } else {
      this.cache = null;
    }
    return result;
  }

  private async fetchAndParse(signal: AbortSignal): Promise<CachedRows> {
    const timeoutSignal = this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : null;
    const combinedSignal = timeoutSignal ? anySignal(signal, timeoutSignal) : signal;
    const res = await this.fetchImpl(this.url, {
      method: 'GET',
      redirect: 'follow',
      signal: combinedSignal,
    });
    if (!res.ok) {
      // Redact query string — Google Sheets export URLs can include auth
      // fragments that shouldn't leak into error logs.
      const safeUrl = this.url.split('?')[0];
      throw new Error(
        `[google-sheets-csv] Fetch failed: ${res.status} ${res.statusText} (${safeUrl})`,
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

/** Compose two AbortSignals — the returned signal aborts when either does. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onAbortA = () => ctrl.abort(a.reason);
  const onAbortB = () => ctrl.abort(b.reason);
  a.addEventListener('abort', onAbortA, { once: true });
  b.addEventListener('abort', onAbortB, { once: true });
  return ctrl.signal;
}

function parseRows(text: string): Record<string, any>[] {
  if (!text || text.trim().length === 0) return [];

  // Google Sheets CSV exports commonly include a UTF-8 BOM. @std/csv does
  // not strip it, which corrupts the first header (e.g. "\uFEFFid"),
  // breaking keyColumn matching silently.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  // Parse raw first to detect duplicate header columns — @std/csv with
  // skipFirstRow collapses duplicates into a single key (later wins)
  // without any signal. Surface a clear error so callers can rename.
  const raw = parseCsv(text) as string[][];
  if (raw.length > 0) {
    const header = raw[0];
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const col of header) {
      if (seen.has(col)) dups.push(col);
      else seen.add(col);
    }
    if (dups.length > 0) {
      throw new Error(
        `[google-sheets-csv] CSV header has duplicate column names: ${
          dups.map(d => JSON.stringify(d)).join(', ')
        }. Rename the columns in the source sheet to avoid silent data loss.`,
      );
    }
  }

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
  // Fail loudly if keyColumn was specified but missing from the header —
  // otherwise every row is silently skipped and the user gets [] with no
  // signal that their config is wrong (common typo / wrong sheet).
  if (keyColumn !== undefined && rows.length > 0) {
    const headerKeys = Object.keys(rows[0]);
    if (!headerKeys.includes(keyColumn)) {
      throw new Error(
        `[GoogleSheetsCsvAdapter] keyColumn "${keyColumn}" not found in CSV header. ` +
        `Available columns: ${headerKeys.map(k => JSON.stringify(k)).join(', ')}`,
      );
    }
  }

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
