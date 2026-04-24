/**
 * Sheetlog Storage Adapter
 * 
 * Google Sheets as database via Sheetlog (Apps Script proxy).
 * - Persistent (Google Sheets backend)
 * - Free (within Google API limits)
 * - Hybrid pattern: Sheet = Array OR per-row upserts
 * - Dynamic schema (automatic column creation)
 * - Rate limited (Google Sheets API constraints)
 * 
 * Use cases:
 * - Small datasets (<10k rows)
 * - Manual data management (edit in Sheets UI)
 * - Logging and tracking
 * - Prototyping and MVPs
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';
import { Sheetlog } from '../clients/sheetlog/mod.ts';
import type { SheetlogConfig as BaseSheetlogConfig } from '../clients/sheetlog/mod.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Sheetlog Config
// ============================================================================

export interface SheetlogConfig extends BaseSheetlogConfig {
  /** 
   * Sheetlog Apps Script URL (required)
   * Example: https://script.google.com/macros/s/.../exec
   */
  sheetUrl: string;
  
  /** 
   * Sheet tab name (required)
   * Example: "Demo", "Movies", "Logs"
   */
  sheet: string;
}

// ============================================================================
// Sheetlog Adapter
// ============================================================================

/**
 * Sheetlog storage adapter
 * 
 * Uses Google Sheets via Sheetlog Apps Script as storage backend.
 * Hybrid pattern: Sheet as array (default) OR per-row upserts.
 */
export class SheetlogAdapter implements StorageAdapter {
  private client: Sheetlog;
  private config: SheetlogConfig;
  
  // Adapter capabilities
  readonly capabilities: AdapterCapabilities = {
    name: 'sheetlog',
    supportedTypes: [
      'object',      // Rows as objects (spread fields → columns)
      'kv',          // Single values
    ],
    // Google Sheets limits: 200k cells, ~10M cells total
    // Practical limit: ~10k rows with 20 columns
    maxItemSize: undefined, // No strict byte limit
    cost: {
      tier: 'free',  // Within Google API limits
    },
    performance: {
      readLatency: 'high',   // Google Sheets API + Apps Script
      writeLatency: 'high',  // Google Sheets API + Apps Script
      throughput: 'low',     // Rate limited
    },
    features: {
      ttl: false,  // No TTL support
    },
  };
  
  constructor(config: SheetlogConfig) {
    // Validation
    if (!config.sheetUrl) {
      throw new Error('SheetlogAdapter requires sheetUrl');
    }
    if (!config.sheet) {
      throw new Error('SheetlogAdapter requires sheet (tab name)');
    }
    
    this.config = config;
    this.client = new Sheetlog(config);
  }
  
  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  /**
   * Get value by key
   * 
   * In Sheetlog adapter, the key is ignored (sheet = single collection).
   * Returns entire sheet as array.
   * 
   * @param key - Storage key (ignored for sheet-as-array pattern)
   * @returns Array of rows, or null if sheet is empty
   */
  async get(key: string): Promise<any> {
    try {
      const response = await this.client.get(null, { limit: 100000 });
      
      if (!response || !response.data || response.data.length === 0) {
        return null;
      }
      
      // Return array of rows
      return response.data;
    } catch (error: any) {
      console.error('[SheetlogAdapter] Error getting data:', error);
      return null;
    }
  }
  
  /**
   * Refuses to run — `set()` on sheetlog used to silently wipe the
   * entire sheet (bulkDelete every row, then insert). Callers hitting
   * this via `sm_write("sheet/Tab", key, data)` lost every existing row
   * on the tab. The `key` arg was ignored, so per-row scoping was a
   * fiction.
   *
   * Three right answers, depending on intent:
   *   - Appending a new row (the 99% case) → `append(items)` / `sm_append`
   *   - Upserting by a stable id column      → `upsert(data, { idField })`
   *   - Genuinely wiping + reseeding the tab → `replace(items)` (explicit)
   *
   * We throw instead of silently choosing one so existing code surfaces
   * the intent before data loss. To migrate: `sm_write` → `sm_append`.
   */
  async set(_key: string, _value: any, _ttl?: number): Promise<void> {
    throw new Error(
      '[SheetlogAdapter] set() is disabled because it wipes the entire sheet. ' +
        'Use append(items) / sm_append to add rows, upsert() for keyed updates, ' +
        'or replace(items) for an explicit wipe-and-reseed.',
    );
  }

  /**
   * Explicit wipe-and-reseed — the old `set()` semantics, renamed so the
   * destructive behavior is visible at the call site. Deletes every row
   * on the tab via `bulkDelete`, then inserts the given items.
   *
   * Only reach for this when you really mean "replace the whole sheet's
   * contents" — e.g. a full refresh from a source of truth. For adding
   * rows, use `append()`.
   */
  async replace(value: any): Promise<void> {
    try {
      const existing = await this.get('');
      if (existing && Array.isArray(existing)) {
        const ids = existing.map((row: any) => row._id).filter(Boolean);
        if (ids.length > 0) {
          await this.client.bulkDelete(ids);
        }
      }
    } catch (error) {
      console.warn('[SheetlogAdapter] Failed to clear existing data:', error);
    }

    const items = Array.isArray(value) ? value : [value];
    if (items.length === 0) return;
    await this.client.dynamicPost(items);
  }

  /**
   * Append rows without overwriting the rest of the sheet.
   *
   * This is the non-destructive alternative to `set()`. While `set()` is
   * forced into "replace whole collection" semantics by the KV shape of
   * the adapter interface, `append()` maps directly to sheetlog's
   * `DYNAMIC_POST` primitive — the same primitive the bookmarklet uses.
   *
   * @param items - Array of row objects to append (or a single object)
   * @returns The raw sheetlog response, including any auto-generated `_id`s
   *          (from sheetlog v0.1.17+ — older deploys return just `{status: 201}`)
   */
  async append(items: any[] | Record<string, any>): Promise<any> {
    const payload = Array.isArray(items) ? items : [items];
    if (payload.length === 0) {
      return { status: 200, data: { message: "No items to append", count: 0 } };
    }
    return await this.client.dynamicPost(payload);
  }

  /**
   * Refuses to run — `delete(key)` on sheetlog used to silently wipe the
   * entire sheet (the `key` arg was ignored, same bug as `set()`). This
   * was especially dangerous via `sm_delete`: callers expected per-key
   * deletion, got a whole-sheet wipe.
   *
   * For per-row delete, delete by `_id` through the Sheetlog client
   * directly (`adapter.client.bulkDelete([id])`). For full-sheet wipe,
   * call `clear()` — the name is loud enough that the destructive
   * intent is visible at the call site.
   */
  async delete(_key: string): Promise<void> {
    throw new Error(
      '[SheetlogAdapter] delete(key) is disabled because it wipes the entire sheet. ' +
        'Use clear() for an explicit whole-sheet wipe, or delete by _id through the ' +
        'Sheetlog client (adapter.client.bulkDelete([id])) for per-row removal.',
    );
  }
  
  /**
   * Check if key exists (sheet has data)
   * 
   * @param key - Storage key (ignored)
   * @returns true if sheet has data
   */
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null && Array.isArray(value) && value.length > 0;
  }
  
  /**
   * List keys with optional prefix
   * 
   * Not applicable for Sheetlog (sheet = single collection).
   * Returns empty array.
   * 
   * @param prefix - Optional prefix filter (ignored)
   * @returns Empty array
   */
  async keys(prefix?: string): Promise<string[]> {
    return [];
  }
  
  /**
   * Wipe the whole sheet — the explicit destructive-intent surface.
   * `prefix` is ignored; a sheetlog tab is one collection, there are
   * no prefixes to scope to.
   */
  async clear(_prefix?: string): Promise<void> {
    try {
      const existing = await this.get('');
      if (existing && Array.isArray(existing)) {
        const ids = existing.map((row: any) => row._id).filter(Boolean);
        if (ids.length > 0) {
          await this.client.bulkDelete(ids);
        }
      }
    } catch (error) {
      console.error('[SheetlogAdapter] Error wiping sheet:', error);
      throw error;
    }
  }
  
  // ============================================================================
  // High-Level Operations
  // ============================================================================
  
  /**
   * Upsert objects by key field
   * 
   * Uses Sheetlog's BATCH_UPSERT for efficient batch operations.
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
      ttl?: number;
    }
  ): Promise<{ count: number; keys: string[] }> {
    const items = Array.isArray(data) ? data : [data];
    
    if (items.length === 0) {
      return { count: 0, keys: [] };
    }
    
    // Validate items are objects
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`upsert() requires object(s), got ${typeof item}`);
      }
    }
    
    // Auto-detect ID field if not provided
    let idField: string | undefined = options?.idField;
    if (!idField && !options?.keyGenerator) {
      const detected = this.autoDetectIdField(items);
      if (!detected) {
        throw new Error(
          'Could not auto-detect ID field. Specify idField or keyGenerator.'
        );
      }
      idField = detected;
    }
    
    // If keyGenerator provided, map items to include the generated key
    let processedItems = items;
    if (options?.keyGenerator) {
      processedItems = items.map(item => ({
        ...item,
        __generatedKey: options.keyGenerator!(item),
      }));
      idField = '__generatedKey';
    }
    
    // Use Sheetlog's BATCH_UPSERT
    const result = await this.client.batchUpsert(idField!, processedItems);
    
    const keys = processedItems.map(item => String(item[idField!]));
    
    return {
      count: (result.data?.inserted ?? 0) + (result.data?.updated ?? 0) || items.length,
      keys,
    };
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
    
    let idField: string | undefined = options?.idField;
    
    if (!idField && !options?.keyGenerator && options?.autoDetect !== false) {
      const detected = this.autoDetectIdField(items);
      if (!detected) {
        throw new Error(
          'Could not auto-detect ID field. Specify idField or keyGenerator.'
        );
      }
      idField = detected;
    }
    
    const result = await this.upsert(data, {
      idField,
      keyGenerator: options?.keyGenerator
    });
    
    return { ...result, idField };
  }
  
  /**
   * Merge arrays with deduplication
   * 
   * @param key - Storage key (ignored, uses sheet)
   * @param newItems - New items to merge
   * @param options - Merge options
   * @returns Result with total items, added, and skipped counts
   */
  async merge(
    key: string,
    newItems: any[],
    options?: {
      strategy?: 'id' | 'hash' | 'fields';
      idField?: string;
      hashFields?: string[];
      compareFields?: string[];
    }
  ): Promise<{ totalItems: number; added: number; skipped: number }> {
    if (!Array.isArray(newItems)) {
      throw new Error(`merge() requires an array, got ${typeof newItems}`);
    }
    
    // Get existing data
    const existing = await this.get(key);
    const existingItems = Array.isArray(existing) ? existing : [];
    
    const strategy = options?.strategy || 'id';
    const idField = options?.idField || this.autoDetectIdField(newItems) || 'id';
    
    // Build deduplication index
    const existingIndex = new Set<string>();
    
    if (strategy === 'id') {
      for (const item of existingItems) {
        if (typeof item === 'object' && item !== null) {
          const id = item[idField];
          if (id !== undefined && id !== null) {
            existingIndex.add(String(id));
          }
        }
      }
    } else if (strategy === 'hash') {
      for (const item of existingItems) {
        const hash = await this.generateContentHash(item, options?.hashFields);
        existingIndex.add(hash);
      }
    }
    
    // Filter new items
    let added = 0;
    let skipped = 0;
    const itemsToAdd: any[] = [];
    
    for (const newItem of newItems) {
      let isDuplicate = false;
      
      if (strategy === 'id' && typeof newItem === 'object' && newItem !== null) {
        const id = newItem[idField];
        if (id !== undefined && id !== null) {
          isDuplicate = existingIndex.has(String(id));
        }
      } else if (strategy === 'hash') {
        const hash = await this.generateContentHash(newItem, options?.hashFields);
        isDuplicate = existingIndex.has(hash);
      } else if (strategy === 'fields' && options?.compareFields) {
        isDuplicate = existingItems.some(existing =>
          this.objectsMatch(existing, newItem, options.compareFields!)
        );
      }
      
      if (isDuplicate) {
        skipped++;
      } else {
        itemsToAdd.push(newItem);
        added++;
      }
    }
    
    // Append new items to sheet
    if (itemsToAdd.length > 0) {
      await this.client.dynamicPost(itemsToAdd);
    }
    
    const totalItems = existingItems.length + added;
    
    return {
      totalItems,
      added,
      skipped
    };
  }
  
  /**
   * Query items with filtering
   * 
   * Fetches all data and filters in-memory.
   * 
   * @param params - Query parameters
   * @returns Filtered items
   */
  async query(params: {
    prefix?: string;
    filter?: (item: any) => boolean;
    limit?: number;
  }): Promise<{ data: any[]; totalCount: number }> {
    const allItems = await this.get('');

    if (!allItems || !Array.isArray(allItems)) {
      return { data: [], totalCount: 0 };
    }

    let results = allItems;

    // Apply filter
    if (params.filter) {
      results = results.filter(params.filter);
    }

    const totalCount = results.length;

    // Apply limit
    if (params.limit) {
      results = results.slice(0, params.limit);
    }

    return { data: results, totalCount };
  }
  
  /**
   * List all items with optional pagination
   * 
   * @param options - List options
   * @returns Array of items
   */
  async list(options?: {
    prefix?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const allItems = await this.get('');
    
    if (!allItems || !Array.isArray(allItems)) {
      return [];
    }
    
    const startIdx = options?.offset || 0;
    const endIdx = options?.limit ? startIdx + options.limit : allItems.length;
    
    return allItems.slice(startIdx, endIdx);
  }
  
  // ============================================================================
  // Private Helpers
  // ============================================================================
  
  /**
   * Auto-detect ID field from array of objects
   * 
   * Strategy:
   * 1. First key in first object (user's preference)
   * 2. Common ID field names
   * 
   * @param items - Array of objects
   * @returns Detected ID field or null
   */
  private autoDetectIdField(items: any[]): string | null {
    if (items.length === 0) return null;
    
    const firstItem = items[0];
    if (typeof firstItem !== 'object' || firstItem === null) {
      return null;
    }
    
    // Strategy 1: First key in object (user's default preference)
    const firstKey = Object.keys(firstItem)[0];
    if (firstKey) {
      // Check if it's unique across sample
      const sampleSize = Math.min(5, items.length);
      const values = new Set();
      let isUnique = true;
      
      for (let i = 0; i < sampleSize; i++) {
        const value = items[i][firstKey];
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
        return firstKey;
      }
    }
    
    // Strategy 2: Common ID field names (fallback)
    const commonIdFields = [
      'id', '_id', 'pmid', 'doi', 'uuid', 'key', 'uid', 'recordId',
      'userId', 'email', 'objectId', 'entityId', 'title', 'name'
    ];
    
    for (const field of commonIdFields) {
      if (firstItem[field] !== undefined) {
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
  
  private async generateContentHash(obj: any, fields?: string[]): Promise<string> {
    let content: any;
    
    if (fields && fields.length > 0) {
      content = {};
      for (const field of fields) {
        if (obj[field] !== undefined) {
          content[field] = obj[field];
        }
      }
    } else {
      content = obj;
    }
    
    const jsonStr = JSON.stringify(content, Object.keys(content).sort());
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex.substring(0, 16);
  }
  
  private objectsMatch(obj1: any, obj2: any, fields: string[]): boolean {
    for (const field of fields) {
      if (obj1[field] !== obj2[field]) {
        return false;
      }
    }
    return true;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new Sheetlog adapter instance
 * 
 * @param config - Sheetlog configuration
 * @returns SheetlogAdapter
 * 
 * @example
 * const adapter = createSheetlogAdapter({
 *   sheetUrl: "https://script.google.com/macros/s/.../exec",
 *   sheet: "Demo"
 * });
 */
export function createSheetlogAdapter(config: SheetlogConfig): SheetlogAdapter {
  return new SheetlogAdapter(config);
}

