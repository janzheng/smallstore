/**
 * Sheetlog Client - Universal Google Sheets Interface
 * 
 * A unified Sheetlog driver that works across Deno, Node, and browsers.
 * Provides a consistent API for interacting with Google Sheets via Sheetlog Apps Script.
 * 
 * Based on @yawnxyz/sheetlog npm package
 * Reference: https://github.com/yawnxyz/sheetlog
 */

import { resolveSheetlogEnv } from "../../../config.ts";
import { debug } from '../../utils/debug.ts';
import { retryFetch } from '../../utils/retry-fetch.ts';
import type { RetryFetchOptions } from '../../utils/retry-fetch.ts';

// ============================================================================
// Types
// ============================================================================

export interface SheetlogConfig {
  /** Sheetlog Apps Script URL */
  sheetUrl?: string;
  /** Default sheet name */
  sheet?: string;
  /** Default HTTP method */
  method?: string;
  /** Whether to log payloads to console */
  logPayload?: boolean;
  /** Optional authentication key */
  key?: string;
  /** Retry options for fetch calls (default: 2 retries). Set to false to disable. */
  retry?: RetryFetchOptions | false;
}

export interface SheetlogOptions {
  sheet?: string;
  sheetUrl?: string;
  method?: string;
  key?: string;
  [key: string]: any;
}

// ============================================================================
// Sheetlog Client
// ============================================================================

/**
 * Universal Sheetlog client for Google Sheets operations
 * 
 * @example
 * ```ts
 * const client = new Sheetlog({
 *   sheetUrl: "https://script.google.com/macros/s/.../exec",
 *   sheet: "Demo"
 * });
 * 
 * // Get all rows
 * const data = await client.get();
 * 
 * // Add a row
 * await client.post({ name: "John", age: 30 });
 * ```
 */
export class Sheetlog {
  private loud: boolean = false;
  private logPayload: boolean;
  private contentType: string = 'application/json';
  private SHEET_URL?: string;
  private sheet: string;
  private method: string;
  private key?: string;
  private retryConfig: RetryFetchOptions | false;

  constructor(config: SheetlogConfig = {}) {
    this.logPayload = config.logPayload ?? false;
    this.sheet = config.sheet ?? "Logs";
    this.method = config.method ?? "POST";
    this.key = config.key;
    this.retryConfig = config.retry ?? { maxRetries: 2 };

    // If sheetUrl is provided, use it. Otherwise, try to load from environment
    if (config.sheetUrl) {
      this.SHEET_URL = config.sheetUrl;
    } else {
      this.loadFromEnv();
    }
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(): void {
    try {
      // Cross-runtime environment access
      this.SHEET_URL = resolveSheetlogEnv().sheetUrl;
    } catch (error) {
      // Silent fail - environment loading is optional
      if (this.loud) {
        console.warn('Could not load SHEET_URL from environment');
      }
    }
  }

  /**
   * Update client configuration
   */
  setup(config: SheetlogConfig): void {
    if (config.sheetUrl !== undefined) this.SHEET_URL = config.sheetUrl;
    if (config.logPayload !== undefined) this.logPayload = config.logPayload;
    if (config.sheet !== undefined) this.sheet = config.sheet;
    if (config.method !== undefined) this.method = config.method;
    if (config.key !== undefined) this.key = config.key;
  }

  /**
   * Core method to make requests to Sheetlog Apps Script
   */
  async log(payload: any, options: SheetlogOptions = {}): Promise<any> {
    const sheet = options.sheet || this.sheet;
    const sheetUrl = options.sheetUrl || this.SHEET_URL;
    const key = options.key || this.key || '';

    if (!sheetUrl) {
      throw new Error('SHEET_URL not set');
    }

    const { method, id, idColumn, ...rest } = options;

    const bodyObject: any = {
      method: method || this.method,
      sheet,
      payload,
      key,
      ...rest
    };

    if (id !== undefined) bodyObject.id = id;
    if (idColumn !== undefined) bodyObject.idColumn = idColumn;

    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': this.contentType
        },
        body: JSON.stringify(bodyObject)
      };
      const response = this.retryConfig === false
        ? await fetch(sheetUrl, init)
        : await retryFetch(sheetUrl, init, this.retryConfig);

      if (!response.ok) {
        const text = await response.text().catch(() => "No response body");
        console.error("Sheetlog fetch error:", response.status, response.statusText, text);
        throw new Error(`HTTP error! status: ${response.status} - ${text.substring(0, 100)}...`);
      }

      const text = await response.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn("Sheetlog: Response was not JSON", text.substring(0, 200));
        data = { error: "invalid_json", raw: text };
      }

      if (this.logPayload) {
        debug('[Sheetlog Request]', bodyObject);
      }

      return data;
    } catch (error) {
      console.error('[Sheetlog] Request failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // Convenience Methods
  // ============================================================================

  /**
   * GET - Fetch rows from sheet
   */
  async get(id?: number | null, options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "GET", id: id ?? undefined });
  }

  /**
   * LIST - Get all rows (alias for get with no id)
   */
  async list(options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "GET" });
  }

  /**
   * POST - Create new row(s)
   */
  async post(payload: any, options: SheetlogOptions = {}): Promise<any> {
    return this.log(payload, { ...options, method: "POST" });
  }

  /**
   * PUT - Update existing row
   */
  async put(id: number, payload: any, options: SheetlogOptions = {}): Promise<any> {
    return this.log(payload, { ...options, method: "PUT", id });
  }

  /**
   * DELETE - Remove row
   */
  async delete(id: number, options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "DELETE", id });
  }

  /**
   * UPSERT - Create or update based on ID column
   */
  async upsert(idColumn: string, id: any, payload: any, options: SheetlogOptions = {}): Promise<any> {
    return this.log(payload, { ...options, method: "UPSERT", idColumn, id });
  }

  /**
   * BATCH_UPSERT - Batch create/update
   */
  async batchUpsert(idColumn: string, payload: any[], options: SheetlogOptions = {}): Promise<any> {
    return this.log(payload, { ...options, method: "BATCH_UPSERT", idColumn });
  }

  /**
   * FIND - Search for rows by column value
   */
  async find(idColumn: string, id: any, returnAllMatches = false, options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "FIND", idColumn, id, returnAllMatches });
  }

  /**
   * DYNAMIC_POST - Create row(s) with automatic column creation
   */
  async dynamicPost(payload: any, options: SheetlogOptions = {}): Promise<any> {
    return this.log(payload, { ...options, method: "DYNAMIC_POST" });
  }

  /**
   * BULK_DELETE - Delete multiple rows
   */
  async bulkDelete(ids: number[], options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "BULK_DELETE", ids });
  }

  /**
   * ADD_COLUMN - Add new column to sheet
   */
  async addColumn(columnName: string, options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "ADD_COLUMN", columnName });
  }

  /**
   * EDIT_COLUMN - Rename column
   */
  async editColumn(oldColumnName: string, newColumnName: string, options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "EDIT_COLUMN", oldColumnName, newColumnName });
  }

  /**
   * REMOVE_COLUMN - Delete column
   */
  async removeColumn(columnName: string, options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "REMOVE_COLUMN", columnName });
  }

  /**
   * RANGE_UPDATE - Update a range of cells with 2D array
   */
  async rangeUpdate(data: any[][], options: SheetlogOptions & { startRow?: number; startCol?: number } = {}): Promise<any> {
    const { startRow = 1, startCol = 1, ...rest } = options;
    return this.log(data, { ...rest, method: "RANGE_UPDATE", startRow, startCol });
  }

  /**
   * GET_ROWS - Get multiple rows with filters
   */
  async getRows(options: SheetlogOptions & { startRow?: number; endRow?: number } = {}): Promise<any> {
    const { startRow = 1, endRow = 100, ...rest } = options;
    return this.log({}, { ...rest, method: "GET_ROWS", startRow, endRow });
  }

  /**
   * GET_COLUMNS - Get specific columns
   */
  async getColumns(options: SheetlogOptions & { startColumn?: string | number; endColumn?: string | number } = {}): Promise<any> {
    const { startColumn = 1, endColumn = 100, ...rest } = options;
    return this.log({}, { ...rest, method: "GET_COLUMNS", startColumn, endColumn });
  }

  /**
   * GET_ALL_CELLS - Get all cells as raw data
   */
  async getAllCells(options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "GET_ALL_CELLS" });
  }

  /**
   * EXPORT - Export sheet to various formats
   */
  async export(options: SheetlogOptions & { format?: 'json' | 'csv' | 'tsv' } = {}): Promise<any> {
    const { format = 'json', ...rest } = options;
    return this.log({}, { ...rest, method: "EXPORT", format });
  }

  /**
   * AGGREGATE - Perform aggregation operations
   */
  async aggregate(
    column: string,
    operation: 'sum' | 'avg' | 'count' | 'min' | 'max',
    options: SheetlogOptions & { where?: Record<string, any> } = {}
  ): Promise<any> {
    const { where, ...rest } = options;
    return this.log({}, { ...rest, method: "AGGREGATE", column, operation, where });
  }

  /**
   * PAGINATED_GET - Get paginated results
   */
  async paginatedGet(options: SheetlogOptions & {
    cursor?: string | number;
    limit?: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  } = {}): Promise<any> {
    const { cursor = 1, limit = 10, sortBy = 'Date Modified', sortDir = 'desc', ...rest } = options;
    return this.log({}, { ...rest, method: "PAGINATED_GET", cursor, limit, sortBy, sortDir });
  }

  /**
   * BATCH_UPDATE - Update multiple rows
   */
  async batchUpdate(updates: any[], options: SheetlogOptions = {}): Promise<any> {
    return this.log(updates, { ...options, method: "BATCH_UPDATE" });
  }

  /**
   * GET_SHEETS - Get all sheets in spreadsheet
   */
  async getSheets(options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "GET_SHEETS" });
  }

  /**
   * GET_CSV - Get sheet data as CSV string
   */
  async getCsv(options: SheetlogOptions = {}): Promise<any> {
    return this.log({}, { ...options, method: "GET_CSV" });
  }

  /**
   * GET_RANGE - Get a range of cells with flexible options
   */
  async getRange(options: SheetlogOptions & {
    startRow?: number;
    startCol?: number;
    stopAtEmptyRow?: boolean;
    stopAtEmptyColumn?: boolean;
    skipEmptyRows?: boolean;
    skipEmptyColumns?: boolean;
  } = {}): Promise<any> {
    const {
      startRow = 1,
      startCol = 1,
      stopAtEmptyRow,
      stopAtEmptyColumn,
      skipEmptyRows,
      skipEmptyColumns,
      ...rest
    } = options;
    return this.log({}, {
      ...rest,
      method: "GET_RANGE",
      startRow,
      startCol,
      stopAtEmptyRow,
      stopAtEmptyColumn,
      skipEmptyRows,
      skipEmptyColumns
    });
  }

  /**
   * GET_DATA_BLOCK - Find and get the first data block in a search range
   */
  async getDataBlock(options: SheetlogOptions & {
    searchRange?: {
      startRow?: number;
      startCol?: number;
      endRow?: number;
      endCol?: number;
    };
  } = {}): Promise<any> {
    const { searchRange, ...rest } = options;
    return this.log({}, {
      ...rest,
      method: "GET_DATA_BLOCK",
      searchRange: searchRange || {
        startRow: 1,
        startCol: 1,
        endRow: 99,
        endCol: 26
      }
    });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Sheetlog client instance
 * 
 * @param config - Sheetlog configuration
 * @returns Sheetlog client
 * 
 * @example
 * ```ts
 * const client = createSheetlog({
 *   sheetUrl: "https://script.google.com/macros/s/.../exec",
 *   sheet: "Demo"
 * });
 * ```
 */
export function createSheetlog(config: SheetlogConfig = {}): Sheetlog {
  return new Sheetlog(config);
}

// ============================================================================
// Default Export
// ============================================================================

export default Sheetlog;

