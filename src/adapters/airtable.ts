/**
 * Airtable Adapter for Smallstore
 * 
 * Provides full CRUD operations for Airtable tables using the existing
 * AirtableClient.
 * 
 * Features:
 * - Automatic schema mapping
 * - Field type transformation
 * - Nested field support (dot notation)
 * - Formula-based queries
 * - Rate limiting and retry logic
 */

import type { StorageAdapter, AdapterCapabilities } from './adapter.ts';
import type { SearchProvider, KeysPageOptions, KeysPage } from '../types.ts';
import { MemoryBm25SearchProvider } from '../search/memory-bm25-provider.ts';
import { createAirtable, type Airtable } from '../clients/airtable/index.ts';
import { resolveAirtableEnv } from '../../config.ts';
import type {
  AirtableRecord,
  RecordFields,
  ListRecordsOptions,
  TableSchema,
} from '../clients/airtable/index.ts';
import {
  throwUnsupportedOperation,
  throwValidationError,
  type AdapterError,
} from './errors.ts';
import { debug } from '../utils/debug.ts';

/**
 * Schema mapping configuration
 */
export interface AirtableSchemaMapping {
  /** Target field name in Airtable table */
  airtableField: string;
  
  /** Source field path in Smallstore data (dot notation) */
  sourcePath: string;
  
  /** Airtable field type */
  airtableType: 'singleLineText' | 'multilineText' | 'number' | 'checkbox' | 
                 'singleSelect' | 'multipleSelects' | 'date' | 'dateTime' | 
                 'url' | 'email' | 'phoneNumber' | 'attachment' | 'multipleAttachments' | 'barcode' |
                 'button' | 'rating' | 'duration' | 'currency' | 'percent' | 
                 'formula' | 'rollup' | 'count' | 'lookup' | 'multipleLookupValues' | 
                 'autoNumber' | 'createdTime' | 'lastModifiedTime' | 
                 'createdBy' | 'lastModifiedBy' | 'multipleRecordLinks';
  
  /** Is this field required? */
  required?: boolean;
  
  /** Default value if source is missing */
  defaultValue?: any;
  
  /** Custom transformation function */
  transform?: (value: any) => any;
}

export interface AirtableAdapterConfig {
  /** Airtable API key */
  apiKey: string;
  
  /** Airtable base ID */
  baseId: string;
  
  /** Airtable table ID or name */
  tableIdOrName: string;
  
  /** Schema mappings for this table (optional if introspectSchema: true) */
  mappings?: AirtableSchemaMapping[];
  
  /** Introspect schema from Airtable table on init (Phase 3.6b) */
  introspectSchema?: boolean;
  
  /** Cache introspected schema for performance (default: true if introspecting) */
  cacheSchema?: boolean;
  
  /** Where to cache schema in metadata (default: auto-generated key) */
  cacheSchemaKey?: string;
  
  /** Field to store Smallstore key (default: '_smallstore_key') */
  keyField?: string;
  
  /** How to handle fields not in mappings (default: 'error') */
  unmappedStrategy?: 'error' | 'ignore' | 'store-as-json' | 'auto-create';
  
  /** Field to store unmapped fields as JSON (default: '_extra_data') */
  unmappedField?: string;
  
  /** Type inference strategy for auto-created fields (Phase 3.6d) */
  typeInference?: 'strict' | 'flexible';
  
  /** KeyResolver for credential resolution */
  keyResolver?: any;
  
  /** Timeout for requests (ms, default: 30000) */
  timeout?: number;
  
  /** Enable retry on rate limit (default: true) */
  retryOnRateLimit?: boolean;
}

/**
 * Escape a value for safe use in Airtable formula strings.
 * Handles backslashes and single quotes to prevent formula injection.
 */
function escapeAirtableFormula(value: string): string {
  // Limit length to prevent oversized formula strings
  const maxLength = 1000;
  const truncated = value.length > maxLength ? value.slice(0, maxLength) : value;
  return truncated.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Airtable Adapter
 *
 * Bridges Smallstore's schemaless data model with Airtable's structured tables.
 */
export class AirtableAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'airtable',
    supportedTypes: ['object'],  // Only structured data
    maxItemSize: 100 * 1024,  // ~100KB per cell
    cost: {
      tier: 'free',
      perOperation: 'Free tier: 5 requests/sec',
      perGB: 'Free tier: 1,200 records/base',
    },
    performance: {
      readLatency: 'medium',   // ~200-500ms
      writeLatency: 'medium',  // ~200-500ms
      throughput: 'low',       // 5 req/sec rate limit
    },
    features: {
      query: true,  // Airtable supports formula-based queries
      search: true, // Client-side BM25 search
    },
  };

  private _searchProvider = new MemoryBm25SearchProvider();

  get searchProvider(): SearchProvider {
    return this._searchProvider;
  }

  private airtable: Airtable;
  private baseId: string;
  private tableIdOrName: string;
  private resolvedTableId?: string; // Resolved table ID (set during introspection)
  private mappings: AirtableSchemaMapping[];
  private keyField: string;
  private unmappedStrategy: 'error' | 'ignore' | 'store-as-json' | 'auto-create';
  private unmappedField: string;
  private typeInference: 'strict' | 'flexible';
  private shouldIntrospectSchema: boolean;
  private cacheSchema: boolean;
  private cacheSchemaKey: string;
  private schemaInitialized: boolean = false;
  
  constructor(config: AirtableAdapterConfig) {
    // Resolve API key (prefer explicit, then keyResolver, then shared env resolver)
    const apiKey = config.apiKey ||
                   config.keyResolver?.getKey?.('AIRTABLE_PRIVATE_API') ||
                   config.keyResolver?.getKey?.('AIRTABLE_API_KEY') ||
                   resolveAirtableEnv().apiKey;
    
    if (!apiKey) {
      throw new Error(
        '[AirtableAdapter] API key required. Set AIRTABLE_PRIVATE_API env var ' +
        'or pass apiKey in config.'
      );
    }
    
    this.airtable = createAirtable({
      apiKey,
      timeout: config.timeout,
    });
    
    this.baseId = config.baseId;
    this.tableIdOrName = config.tableIdOrName;
    this.keyField = config.keyField || '_smallstore_key';
    this.unmappedStrategy = config.unmappedStrategy || 'error';
    this.unmappedField = config.unmappedField || '_extra_data';
    this.typeInference = config.typeInference || 'flexible';
    
    // Schema introspection config
    this.shouldIntrospectSchema = config.introspectSchema || false;
    this.cacheSchema = config.cacheSchema !== false; // Default true
    this.cacheSchemaKey = config.cacheSchemaKey || `airtable:schema:${this.baseId}:${this.tableIdOrName}`;
    
    // Mappings: explicit or will be introspected
    if (config.mappings) {
      this.mappings = config.mappings;
      this.schemaInitialized = true;
    } else if (this.shouldIntrospectSchema) {
      this.mappings = []; // Will be populated by introspection
      // Note: Introspection happens lazily on first operation
    } else if (this.unmappedStrategy === 'auto-create' || this.unmappedStrategy === 'store-as-json') {
      // Allow dynamic operation without pre-defined mappings when using auto-create or store-as-json
      this.mappings = [];
      this.schemaInitialized = false; // Schema will be built dynamically
    } else {
      throw new Error(
        '[AirtableAdapter] Either provide "mappings", set "introspectSchema: true", or use unmappedStrategy: "auto-create"'
      );
    }
  }
  
  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  async get(key: string): Promise<any> {
    try {
      const record = await this.findRecordByKey(key);
      if (!record) return null;
      
      // Transform Airtable fields → Smallstore data
      const data = this.transformFromAirtable(record.fields);
      
      // If we have extra data stored, merge it back in
      const extraDataField = record.fields[this.unmappedField];
      if (extraDataField && typeof extraDataField === 'string') {
        try {
          const extraData = JSON.parse(extraDataField);
          return { ...data, ...extraData };
        } catch (e) {
          // JSON parse failed, ignore
        }
      }
      
      return data;
    } catch (error) {
      console.error(`[AirtableAdapter] Error getting key ${key}:`, error);
      return null;
    }
  }
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      // Ensure schema is initialized
      await this.ensureSchemaInitialized();
      
      // TTL not supported by Airtable (log warning)
      if (ttl) {
        console.warn(`[AirtableAdapter] TTL not supported, ignoring ttl=${ttl}`);
      }
      
      // Detect and handle unmapped fields
      const unmapped = this.detectUnmappedFields(value);
      
      // Auto-create fields if strategy is 'auto-create'
      if (this.unmappedStrategy === 'auto-create') {
        // Check if metadata fields need to be created
        const metadataFields: Record<string, any> = {};
        
        // Check if keyField exists in schema
        const hasKeyField = this.mappings.some(m => m.airtableField.trim() === this.keyField.trim());
        if (!hasKeyField) {
          metadataFields[this.keyField] = key; // Sample value for type inference
        }
        
        // Combine metadata fields with unmapped data fields
        const fieldsToCreate: Record<string, any> = { ...metadataFields };
        
        if (unmapped.length > 0) {
          // Extract unmapped field values for type inference
          for (const field of unmapped) {
            fieldsToCreate[field] = value[field];
          }
        }
        
        // Create missing fields (both metadata and data fields)
        if (Object.keys(fieldsToCreate).length > 0) {
          await this.createMissingFields(fieldsToCreate);
        }
        
        // Fields now exist, proceed normally
      }
      
      const { processedData, extraData } = this.handleUnmappedFields(value, unmapped);
      
      // Transform Smallstore data → Airtable fields
      const fields = this.transformToAirtable(processedData);
      
      // Add key field
      fields[this.keyField] = key;
      
      // If we have extra data, store it in the unmapped field
      if (extraData && Object.keys(extraData).length > 0) {
        fields[this.unmappedField] = JSON.stringify(extraData);
      }
      
      // Check if record exists
      const existing = await this.findRecordByKey(key);
      
      if (existing) {
        // Update existing record
        await this.airtable.records.update(
          this.baseId,
          this.tableIdOrName,
          {
            records: [
              {
                id: existing.id,
                fields,
              },
            ],
          }
        );
      } else {
        // Create new record
        await this.airtable.records.create(
          this.baseId,
          this.tableIdOrName,
          {
            records: [{ fields }],
          }
        );
      }
      // Index for BM25 search (best-effort)
      try { this._searchProvider.index(key, value); } catch (indexError) { console.warn('[AirtableAdapter] Search index update failed:', indexError); }
    } catch (error) {
      console.error(`[AirtableAdapter] Error setting key ${key}:`, error);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const record = await this.findRecordByKey(key);
      if (!record) return;

      // Delete record
      await this.airtable.records.delete(
        this.baseId,
        this.tableIdOrName,
        [record.id]
      );
      try { this._searchProvider.remove(key); } catch { /* ignore */ }
    } catch (error: any) {
      // Idempotent: if record already deleted/not found, that's fine
      if (error?.statusCode === 404 || error?.error === 'NOT_FOUND' ||
          (error?.message && /not found/i.test(error.message))) {
        return;
      }
      throw error;
    }
  }
  
  /**
   * Delete a specific record by ID (Phase 3.6e)
   * 
   * @param recordId - Airtable record ID
   */
  async deleteRecord(recordId: string): Promise<void> {
    try {
      // Delete record via Airtable API
      await this.airtable.records.delete(
        this.baseId,
        this.tableIdOrName,
        [recordId]
      );
      
      debug(`[AirtableAdapter] ✅ Deleted record: ${recordId}`);
    } catch (error) {
      console.error('[AirtableAdapter] Failed to delete record:', error);
      throw new Error(
        `Failed to delete Airtable record: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  async has(key: string): Promise<boolean> {
    try {
      const record = await this.findRecordByKey(key);
      return !!record;
    } catch (error) {
      console.error(`[AirtableAdapter] Error checking key ${key}:`, error);
      return false;
    }
  }
  
  async keys(prefix?: string): Promise<string[]> {
    try {
      const allKeys: string[] = [];
      let offset: string | undefined = undefined;
      let prevOffset: string | undefined;

      do {
        const options: ListRecordsOptions = {
          pageSize: 100,
          offset,
          fields: [this.keyField],
        };

        const response = await this.airtable.records.list(
          this.baseId,
          this.tableIdOrName,
          options
        );

        // Extract keys from records
        for (const record of response.records) {
          const key = record.fields[this.keyField];
          if (typeof key === 'string' && (!prefix || key.startsWith(prefix))) {
            allKeys.push(key);
          }
        }

        offset = response.offset;
        // Infinite-loop protection: break if Airtable returns the same offset twice
        if (offset && offset === prevOffset) {
          console.warn('[Airtable] Pagination returned same offset, breaking');
          break;
        }
        prevOffset = offset;
      } while (offset);
      
      return allKeys;
    } catch (error) {
      console.error('[AirtableAdapter] Error listing keys:', error);
      return [];
    }
  }

  /**
   * Paged keys — wraps Airtable's native `offset` continuation token
   * (which is confusingly NOT a numeric offset — it's an opaque pointer
   * returned in each page's response). `options.cursor` round-trips it
   * opaquely. `options.offset` (numeric) walks forward from the start;
   * safe but O(offset) in Airtable API calls, so prefer cursor.
   */
  async listKeys(options: KeysPageOptions = {}): Promise<KeysPage> {
    const prefix = options.prefix;
    const pageSize = Math.min(100, options.limit ?? 100); // Airtable max 100
    const out: string[] = [];
    let atCursor = options.cursor;
    const targetOffset = options.offset ?? 0;
    let skipped = 0;

    try {
      while (options.limit === undefined || out.length < options.limit) {
        const listOpts: ListRecordsOptions = {
          pageSize,
          offset: atCursor,
          fields: [this.keyField],
        };
        const response = await this.airtable.records.list(
          this.baseId,
          this.tableIdOrName,
          listOpts,
        );

        for (const record of response.records) {
          const key = record.fields[this.keyField];
          if (typeof key !== 'string') continue;
          if (prefix && !key.startsWith(prefix)) continue;
          if (skipped < targetOffset && !options.cursor) {
            skipped++;
            continue;
          }
          out.push(key);
          if (options.limit !== undefined && out.length >= options.limit) break;
        }

        atCursor = response.offset;
        if (!atCursor) break; // no more pages
        if (options.limit !== undefined && out.length >= options.limit) break;
      }

      return {
        keys: out,
        hasMore: !!atCursor,
        ...(atCursor ? { cursor: atCursor } : {}),
      };
    } catch (error) {
      console.error('[AirtableAdapter] Error in listKeys:', error);
      return { keys: [], hasMore: false };
    }
  }

  async clear(prefix?: string): Promise<void> {
    try {
      const keys = await this.keys(prefix);
      
      // Find all matching records
      const recordIds: string[] = [];
      
      for (const key of keys) {
        const record = await this.findRecordByKey(key);
        if (record) {
          recordIds.push(record.id);
        }
      }
      
      // Delete in batches of 10 (Airtable limit)
      const batchSize = 10;
      for (let i = 0; i < recordIds.length; i += batchSize) {
        const batch = recordIds.slice(i, i + batchSize);
        await this.airtable.records.delete(
          this.baseId,
          this.tableIdOrName,
          batch
        );
      }
    } catch (error) {
      console.error('[AirtableAdapter] Error clearing:', error);
      throw error;
    }
  }
  
  // ============================================================================
  // Schema Transformation
  // ============================================================================
  
  /**
   * Transform Smallstore data → Airtable fields
   */
  private transformToAirtable(data: any): RecordFields {
    const fields: RecordFields = {};
    
    for (const mapping of this.mappings) {
      // Extract value from source data using dot notation
      const value = this.getValueByPath(data, mapping.sourcePath);
      
      if (value === undefined) {
        if (mapping.required) {
          throw new Error(
            `[AirtableAdapter] Required field "${mapping.sourcePath}" is missing`
          );
        }
        if (mapping.defaultValue !== undefined) {
          fields[mapping.airtableField] = this.valueToAirtableCell(
            mapping.defaultValue,
            mapping.airtableType
          );
        }
        continue;
      }
      
      // Apply custom transformation if provided
      const transformedValue = mapping.transform ? mapping.transform(value) : value;
      
      // Convert to Airtable cell format
      fields[mapping.airtableField] = this.valueToAirtableCell(
        transformedValue,
        mapping.airtableType
      );
    }
    
    return fields;
  }
  
  /**
   * Transform Airtable fields → Smallstore data
   */
  private transformFromAirtable(fields: RecordFields): any {
    const data: any = {};
    
    for (const mapping of this.mappings) {
      const value = fields[mapping.airtableField];
      
      if (value === undefined || value === null) continue;
      
      // Set value using dot notation path
      this.setValueByPath(data, mapping.sourcePath, value);
    }
    
    return data;
  }
  
  /**
   * Convert value to Airtable cell format
   */
  private valueToAirtableCell(value: any, type: string): any {
    switch (type) {
      case 'singleLineText':
      case 'multilineText':
      case 'email':
      case 'url':
      case 'phoneNumber':
        return String(value || '');
      
      case 'number':
      case 'rating':
      case 'duration':
      case 'currency':
      case 'percent':
        const num = Number(value);
        return isNaN(num) ? null : num;
      
      case 'checkbox':
        return Boolean(value);
      
      case 'singleSelect':
        return String(value);
      
      case 'multipleSelects':
        if (Array.isArray(value)) {
          return value.map(String);
        }
        return [String(value)];
      
      case 'date':
      case 'dateTime':
        // Airtable expects ISO 8601 date strings
        if (value instanceof Date) {
          return value.toISOString();
        }
        return String(value);
      
      case 'attachment':
      case 'multipleAttachments':
        // Attachments are complex objects with url, filename, etc.
        if (Array.isArray(value)) {
          return value;
        }
        return [value];
      
      case 'multipleRecordLinks':
        // Links to other records (array of record IDs)
        if (Array.isArray(value)) {
          return value.map(String);
        }
        return [String(value)];
      
      case 'barcode':
        // Barcode is an object with text property
        return { text: String(value) };
      
      // Read-only fields (should not be set)
      case 'formula':
      case 'rollup':
      case 'count':
      case 'lookup':
      case 'multipleLookupValues':
      case 'autoNumber':
      case 'createdTime':
      case 'lastModifiedTime':
      case 'createdBy':
      case 'lastModifiedBy':
      case 'button':
        console.warn(`[AirtableAdapter] Cannot set read-only field type: ${type}`);
        return undefined;
      
      default:
        console.warn(`[AirtableAdapter] Unknown field type: ${type}, storing as-is`);
        return value;
    }
  }
  
  // ============================================================================
  // Helpers
  // ============================================================================
  
  /**
   * Find record by Smallstore key using Airtable formula
   */
  private async findRecordByKey(key: string): Promise<AirtableRecord | null> {
    try {
      // Use filterByFormula to find record by key
      // Escape backslashes and single quotes in key for formula safety
      const escapedKey = escapeAirtableFormula(key);
      
      const options: ListRecordsOptions = {
        filterByFormula: `{${this.keyField}} = '${escapedKey}'`,
        maxRecords: 1,
      };
      
      const response = await this.airtable.records.list(
        this.baseId,
        this.tableIdOrName,
        options
      );
      
      return response.records[0] || null;
    } catch (error) {
      console.error(`[AirtableAdapter] Error finding record by key ${key}:`, error);
      return null;
    }
  }
  
  /**
   * Get nested value using dot notation
   */
  private getValueByPath(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  /**
   * Set nested value using dot notation
   */
  private setValueByPath(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    if (keys.length === 0) throw new Error('Empty path');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
      if (!(key in current)) current[key] = {};
      return current[key];
    }, obj);
    target[lastKey] = value;
  }
  
  // ============================================================================
  // High-Level Operations (Composition-Compatible)
  // ============================================================================
  
  /**
   * Upsert objects into Airtable by key field
   * 
   * This is the natural way to work with Airtable - each object
   * becomes a record, keyed by a unique identifier.
   * 
   * @param data - Single object or array of objects to upsert
   * @param options - Upsert options
   * 
   * @example
   * await airtableAdapter.upsert(
   *   [{ id: '123', name: 'Alice' }, { id: '456', name: 'Bob' }],
   *   { idField: 'id' }
   * );
   */
  async upsert(
    data: any | any[],
    options?: {
      idField?: string;
      keyGenerator?: (obj: any) => string;
      ttl?: number;
    }
  ): Promise<{ count: number; keys: string[] }> {
    const idField = options?.idField || 'id';
    const keyGenerator = options?.keyGenerator;
    const items = Array.isArray(data) ? data : [data];
    
    // Validate inputs
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throwValidationError(
          this.capabilities.name,
          'upsert',
          `Expected object(s), got ${typeof item}`,
          { item }
        );
      }
    }
    
    const keys: string[] = [];
    
    // Upsert each item
    for (const item of items) {
      let key: string;
      
      if (keyGenerator) {
        key = keyGenerator(item);
      } else {
        const id = item[idField];
        if (id === undefined || id === null) {
          throwValidationError(
            this.capabilities.name,
            'upsert',
            `Missing required field '${idField}' in object`,
            { item, idField }
          );
        }
        key = String(id);
      }
      
      await this.set(key, item, options?.ttl);
      keys.push(key);
    }
    
    return {
      count: items.length,
      keys
    };
  }
  
  /**
   * Insert objects into Airtable with auto-key detection
   * 
   * Like upsert(), but with smart ID field detection.
   * 
   * @param data - Single object or array of objects
   * @param options - Insert options
   * 
   * @example
   * // Auto-detects 'id' field
   * await airtableAdapter.insert([
   *   { id: '123', name: 'Alice' },
   *   { id: '456', name: 'Bob' }
   * ]);
   * 
   * @example
   * // Custom ID field
   * await airtableAdapter.insert(
   *   [{ email: 'alice@example.com', name: 'Alice' }],
   *   { idField: 'email' }
   * );
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
    
    // Validate inputs
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throwValidationError(
          this.capabilities.name,
          'insert',
          `Expected object(s), got ${typeof item}`,
          { item }
        );
      }
    }
    
    // Determine ID field
    let idField = options?.idField;
    
    if (!idField && !options?.keyGenerator && options?.autoDetect !== false) {
      // Auto-detect ID field
      idField = this.autoDetectIdField(items) ?? undefined;
      if (!idField) {
        throwValidationError(
          this.capabilities.name,
          'insert',
          'Could not auto-detect ID field. Specify idField or keyGenerator.',
          { 
            suggestion: 'Common ID fields: id, _id, email, recordId',
            firstObject: items[0]
          }
        );
      }
    }
    
    // Perform upsert
    const result = await this.upsert(data, {
      idField,
      keyGenerator: options?.keyGenerator
    });
    
    return {
      ...result,
      idField
    };
  }
  
  /**
   * Merge arrays - NOT SUPPORTED by Airtable
   * 
   * Airtable stores individual records, not arrays.
   * Use insert() or upsert() to add records to your table.
   * 
   * @throws UnsupportedOperationError
   */
  async merge(
    _collection: string,
    _data: any[],
    _options?: any
  ): Promise<never> {
    throwUnsupportedOperation(
      this.capabilities.name,
      'merge',
      'Airtable tables store individual records, not arrays.',
      'insert() or upsert()'
    );
  }
  
  /**
   * Query Airtable table with formula filters
   * 
   * Wraps Airtable's formula-based filtering for advanced queries.
   * 
   * @param query - Query parameters
   * @returns Array of transformed objects
   * 
   * @example
   * const activeUsers = await airtableAdapter.query({
   *   filterByFormula: '{Status} = "Active"',
   *   sort: [{ field: 'Created', direction: 'desc' }]
   * });
   */
  async query(query: any): Promise<{ data: any[]; totalCount: number }> {
    try {
      const options: ListRecordsOptions = {
        filterByFormula: query.filterByFormula,
        sort: query.sort,
        maxRecords: query.maxRecords,
        pageSize: query.pageSize,
        offset: query.offset,
      };

      const response = await this.airtable.records.list(
        this.baseId,
        this.tableIdOrName,
        options
      );

      // Transform all records to Smallstore format
      const data = response.records.map((record: AirtableRecord) => this.transformFromAirtable(record.fields));
      return { data, totalCount: data.length };
    } catch (error) {
      console.error('[AirtableAdapter] Error querying table:', error);
      throw error;
    }
  }
  
  /**
   * List all items in table
   * 
   * Convenience method that fetches all records and transforms them.
   * 
   * @param options - Pagination options
   * @returns Array of objects
   * 
   * @example
   * const allItems = await airtableAdapter.list();
   * const firstPage = await airtableAdapter.list({ limit: 10 });
   */
  async list(options?: {
    limit?: number;
    offset?: string;
  }): Promise<any[]> {
    const items: any[] = [];
    let hasMore = true;
    let offset = options?.offset;
    const limit = options?.limit;
    
    while (hasMore && (!limit || items.length < limit)) {
      const listOptions: ListRecordsOptions = {
        pageSize: limit ? Math.min(100, limit - items.length) : 100,
        offset,
      };
      
      const response = await this.airtable.records.list(
        this.baseId,
        this.tableIdOrName,
        listOptions
      );
      
      for (const record of response.records) {
        items.push(this.transformFromAirtable(record.fields));
        if (limit && items.length >= limit) break;
      }
      
      hasMore = !!response.offset;
      offset = response.offset;
      
      if (!hasMore || (limit && items.length >= limit)) break;
    }
    
    return items;
  }
  
  // ============================================================================
  // Private Helpers for High-Level Operations
  // ============================================================================
  
  /**
   * Auto-detect ID field from array of objects
   */
  private autoDetectIdField(items: any[]): string | null {
    if (items.length === 0) return null;
    
    // Common ID field names (in priority order)
    const commonIdFields = [
      'id', '_id', 'recordId', 'uuid', 'key', 'uid',
      'userId', 'email', 'objectId', 'entityId'
    ];
    
    // Check each common field
    for (const field of commonIdFields) {
      if (items[0][field] !== undefined) {
        // Check if unique across sample
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
          debug(`[AirtableAdapter] Auto-detected ID field: '${field}'`);
          return field;
        }
      }
    }
    
    return null;
  }
  
  // ============================================================================
  // Schema Introspection (Phase 3.6b)
  // ============================================================================
  
  /**
   * Introspect table schema from Airtable API
   * 
   * Queries the table to get all fields and their types,
   * then auto-generates mappings.
   * 
   * @returns Map of field name → field type
   */
  public async introspectSchema(): Promise<Map<string, string>> {
    try {
      debug(`[AirtableAdapter] Introspecting schema for table ${this.tableIdOrName}...`);
      
      // Fetch table schema using Airtable Meta API
      const response = await this.airtable.bases.getSchema(this.baseId);
      
      // Find our table
      const table = response.tables.find(
        (t: TableSchema) => t.id === this.tableIdOrName || t.name === this.tableIdOrName
      );
      
      if (!table) {
        throw new Error(`Table "${this.tableIdOrName}" not found in base`);
      }
      
      // Store the resolved table ID for field creation
      this.resolvedTableId = table.id;
      
      const schema = new Map<string, string>();
      
      // Extract field types
      for (const field of table.fields) {
        schema.set(field.name, field.type);
      }
      
      debug(`[AirtableAdapter] Found ${schema.size} fields in table ${table.name} (${table.id})`);
      
      return schema;
    } catch (error) {
      console.error('[AirtableAdapter] Error introspecting schema:', error);
      throw new Error(
        `Failed to introspect Airtable table schema: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  /**
   * Generate mappings from introspected schema
   * 
   * Converts Airtable field definitions to AirtableSchemaMapping format.
   * Uses sensible defaults (sourcePath = lowercase field name).
   * 
   * @param schema - Introspected schema
   * @returns Generated mappings
   */
  private generateMappingsFromSchema(schema: Map<string, string>): AirtableSchemaMapping[] {
    const mappings: AirtableSchemaMapping[] = [];
    
    for (const [fieldName, fieldType] of schema.entries()) {
      // Skip system fields
      if (fieldName === this.keyField) continue;
      if (fieldName === this.unmappedField) continue;
      
      // Use the field name as-is for source path so data keys match
      // (e.g., data.Name maps to Airtable field "Name" without casing issues)
      const sourcePath = fieldName;
      
      mappings.push({
        airtableField: fieldName,
        sourcePath,
        airtableType: fieldType as any,
        required: false, // Can't determine this from schema
      });
    }
    
    debug(`[AirtableAdapter] Generated ${mappings.length} mappings`);
    
    return mappings;
  }
  
  /**
   * Initialize schema from platform
   * 
   * Called automatically on first operation if introspectSchema: true
   * and schema hasn't been initialized yet.
   */
  private async initializeSchemaFromPlatform(): Promise<void> {
    if (this.schemaInitialized) return;
    
    debug('[AirtableAdapter] Initializing schema from Airtable...');
    
    try {
      // Introspect schema (this also sets resolvedTableId)
      const schema = await this.introspectSchema();
      
      // Generate mappings
      this.mappings = this.generateMappingsFromSchema(schema);
      
      this.schemaInitialized = true;
      
      debug('[AirtableAdapter] Schema initialization complete');
    } catch (error) {
      console.error('[AirtableAdapter] Schema initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Ensure we have the resolved table ID
   * 
   * For auto-create strategy, we need the table ID to create fields.
   * This method resolves the table ID if not already set.
   * 
   * **IMPORTANT**: Table name resolution requires a Personal Access Token (PAT) 
   * with `schema.bases:read` scope. Regular API keys will NOT work.
   * 
   * **AVAILABLE ON ALL PLANS**: The Meta API schema reading is available on all 
   * Airtable plans (Free, Plus, Pro, Enterprise).
   * 
   * **PERFORMANCE TIP**: Pass table IDs (starting with "tbl...") instead of table names
   * to avoid this Meta API call. Table IDs can be found in your Airtable URL:
   * https://airtable.com/{baseId}/{tableId}/...
   */
  private async ensureTableIdResolved(): Promise<void> {
    // If tableIdOrName is already a table ID (starts with "tbl"), use it directly
    if (this.tableIdOrName.startsWith('tbl')) {
      this.resolvedTableId = this.tableIdOrName;
      debug(`[AirtableAdapter] Using provided table ID: ${this.resolvedTableId}`);
      return;
    }
    
    // Already resolved
    if (this.resolvedTableId) return;
    
    debug(`[AirtableAdapter] Resolving table ID for table name "${this.tableIdOrName}"...`);
    debug(`[AirtableAdapter] TIP: Pass table ID (starts with "tbl...") for better performance`);
    
    try {
      // Fetch table schema via Meta API (available on all plans!)
      // NOTE: Requires Personal Access Token with schema.bases:read scope
      const response = await this.airtable.bases.getSchema(this.baseId);
      
      // Find our table by name (we already know it's not an ID)
      const table = response.tables.find((t: TableSchema) => t.name === this.tableIdOrName);
      
      if (!table) {
        throw new Error(
          `Table "${this.tableIdOrName}" not found in base. ` +
          `Available tables: ${response.tables.map((t: TableSchema) => t.name).join(', ')}. ` +
          `TIP: You can also pass the table ID directly (starts with "tbl...").`
        );
      }
      
      this.resolvedTableId = table.id;
      
      debug(`[AirtableAdapter] ✅ Resolved table "${table.name}" → ID: ${table.id}`);
      debug(`[AirtableAdapter] TIP: Use ID "${table.id}" in your config to skip this lookup`);
    } catch (error) {
      console.error('[AirtableAdapter] Failed to resolve table ID:', error);
      
      // Provide helpful error message for auth issues
      if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 401) {
        throw new Error(
          'Airtable Meta API authentication failed. The Meta API requires a Personal Access Token (PAT) ' +
          'with "schema.bases:read" scope. Regular API keys (starting with "key...") will NOT work. ' +
          'Create a PAT at https://airtable.com/create/tokens with the required scopes. ' +
          '\n\nALTERNATIVE: Pass the table ID directly (starts with "tbl...") instead of the table name ' +
          'to avoid needing Meta API access. Find your table ID in the Airtable URL.'
        );
      }
      
      throw new Error(
        `Failed to resolve table ID: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  /**
   * Ensure schema is initialized
   * 
   * Helper that runs before operations that need schema.
   */
  private async ensureSchemaInitialized(): Promise<void> {
    if (!this.schemaInitialized && this.shouldIntrospectSchema) {
      await this.initializeSchemaFromPlatform();
    }
    
    // Only require mappings if NOT using auto-create or store-as-json strategies
    if (this.mappings.length === 0 && 
        this.unmappedStrategy !== 'auto-create' && 
        this.unmappedStrategy !== 'store-as-json') {
      throw new Error(
        '[AirtableAdapter] No schema mappings available. ' +
        'Either provide mappings in config, enable introspectSchema, or use unmappedStrategy: "auto-create"'
      );
    }
  }
  
  // ============================================================================
  // Schema Update Methods (Phase 3.6c)
  // ============================================================================
  
  /**
   * Sync schema from platform
   * 
   * Re-introspects the table and updates internal mappings.
   * Use this after schema changes in Airtable (added/removed fields).
   * 
   * @param options - Sync options
   */
  async syncSchema(options?: {
    merge?: boolean;              // Merge with existing or replace (default: true)
    preserveCustomTransforms?: boolean;  // Keep custom transform functions (default: true)
  }): Promise<void> {
    const merge = options?.merge !== false;
    const preserveCustomTransforms = options?.preserveCustomTransforms !== false;
    
    debug(`[AirtableAdapter] Syncing schema from Airtable (merge: ${merge})...`);
    
    try {
      // Introspect current schema
      const schema = await this.introspectSchema();
      const newMappings = this.generateMappingsFromSchema(schema);
      
      if (merge && preserveCustomTransforms) {
        // Merge: Keep existing mappings with custom logic, add new ones
        const existingMap = new Map(
          this.mappings.map(m => [m.airtableField, m])
        );
        
        const mergedMappings: AirtableSchemaMapping[] = [];
        
        // Add existing mappings (preserving custom transforms)
        for (const existing of this.mappings) {
          if (schema.has(existing.airtableField)) {
            mergedMappings.push(existing);
          } else {
            console.warn(`[AirtableAdapter] Field "${existing.airtableField}" no longer exists in table`);
          }
        }
        
        // Add new mappings
        for (const newMapping of newMappings) {
          if (!existingMap.has(newMapping.airtableField)) {
            mergedMappings.push(newMapping);
            debug(`[AirtableAdapter] Added new field: ${newMapping.airtableField}`);
          }
        }
        
        this.mappings = mergedMappings;
      } else {
        // Replace: Use new mappings entirely
        this.mappings = newMappings;
      }
      
      this.schemaInitialized = true;
      
      debug(`[AirtableAdapter] Schema synced (${this.mappings.length} fields)`);
    } catch (error) {
      console.error('[AirtableAdapter] Schema sync failed:', error);
      throw error;
    }
  }
  
  /**
   * Update schema mappings
   * 
   * Modify the adapter's schema without re-introspecting.
   * Use this to add/remove/modify mappings programmatically.
   * 
   * @param updates - Schema updates
   */
  async updateSchema(updates: {
    add?: AirtableSchemaMapping[];
    remove?: string[];  // Field names to remove
    modify?: Record<string, Partial<AirtableSchemaMapping>>;
  }): Promise<void> {
    debug('[AirtableAdapter] Updating schema...');
    
    // Remove mappings
    if (updates.remove && updates.remove.length > 0) {
      this.mappings = this.mappings.filter(
        m => !updates.remove!.includes(m.airtableField)
      );
      debug(`[AirtableAdapter] Removed ${updates.remove.length} fields`);
    }
    
    // Modify existing mappings
    if (updates.modify) {
      for (const [fieldName, changes] of Object.entries(updates.modify)) {
        const existing = this.mappings.find(m => m.airtableField.trim() === fieldName.trim());
        if (existing) {
          Object.assign(existing, changes);
          debug(`[AirtableAdapter] Modified field: ${fieldName}`);
        } else {
          console.warn(`[AirtableAdapter] Field "${fieldName}" not found, cannot modify`);
        }
      }
    }
    
    // Add new mappings
    if (updates.add && updates.add.length > 0) {
      this.mappings.push(...updates.add);
      debug(`[AirtableAdapter] Added ${updates.add.length} fields`);
    }
    
    debug(`[AirtableAdapter] Schema updated (${this.mappings.length} fields)`);
  }
  
  /**
   * Introspect and update schema
   * 
   * Combines introspection with smart merging.
   * Detects added/removed/changed fields and updates mappings accordingly.
   * 
   * @param options - Update options
   * @returns Summary of changes
   */
  async introspectAndUpdate(options?: {
    mode?: 'merge' | 'replace';  // Merge or replace mappings (default: 'merge')
    createMissing?: boolean;      // Auto-create local-only fields on the platform
    removeObsolete?: boolean;     // Remove mappings for deleted fields (default: false)
  }): Promise<{
    added: string[];
    removed: string[];
    modified: string[];
  }> {
    const mode = options?.mode || 'merge';
    const removeObsolete = options?.removeObsolete !== false;
    
    debug(`[AirtableAdapter] Introspecting and updating schema (mode: ${mode})...`);
    
    try {
      // Get current schema from platform
      const schema = await this.introspectSchema();
      const newMappings = this.generateMappingsFromSchema(schema);
      
      // Track changes
      const added: string[] = [];
      const removed: string[] = [];
      const modified: string[] = [];
      
      if (mode === 'merge') {
        // Build maps for comparison
        const existingMap = new Map(
          this.mappings.map(m => [m.airtableField, m])
        );
        const newMap = new Map(
          newMappings.map(m => [m.airtableField, m])
        );
        
        // Find added fields
        for (const [fieldName] of newMap) {
          if (!existingMap.has(fieldName)) {
            added.push(fieldName);
          }
        }
        
        // Find removed fields
        for (const [fieldName] of existingMap) {
          if (!newMap.has(fieldName)) {
            removed.push(fieldName);
          }
        }
        
        // Update mappings
        const updatedMappings: AirtableSchemaMapping[] = [];
        
        // Keep existing (if still in platform schema)
        for (const existing of this.mappings) {
          if (newMap.has(existing.airtableField)) {
            updatedMappings.push(existing);
          } else if (!removeObsolete) {
            // Keep even if removed from platform
            updatedMappings.push(existing);
          }
        }
        
        // Add new
        for (const newMapping of newMappings) {
          if (!existingMap.has(newMapping.airtableField)) {
            updatedMappings.push(newMapping);
          }
        }
        
        this.mappings = updatedMappings;
      } else {
        // Replace mode
        added.push(...newMappings.map(m => m.airtableField));
        removed.push(...this.mappings.map(m => m.airtableField));
        this.mappings = newMappings;
      }
      
      // Create missing fields on platform if requested
      if (options?.createMissing && removed.length > 0) {
        const fieldsToCreate: Record<string, any> = {};
        for (const fieldName of removed) {
          fieldsToCreate[fieldName] = ''; // Use empty string for type inference (defaults to singleLineText)
        }
        const created = await this.createMissingFields(fieldsToCreate);
        debug(`[AirtableAdapter] Created ${created.length} missing fields on platform`);
        // Fields that were successfully created are no longer "removed"
        const createdSet = new Set(created);
        const stillRemoved = removed.filter(k => !createdSet.has(k));
        removed.length = 0;
        removed.push(...stillRemoved);
      }

      this.schemaInitialized = true;

      debug('[AirtableAdapter] Schema update complete:');
      debug(`  Added: ${added.length}`);
      debug(`  Removed: ${removed.length}`);
      debug(`  Total: ${this.mappings.length}`);

      return { added, removed, modified };
    } catch (error) {
      console.error('[AirtableAdapter] Introspect and update failed:', error);
      throw error;
    }
  }
  
  /**
   * Replace entire schema
   * 
   * Completely replaces the current schema mappings.
   * Use with caution - this will discard all existing mappings.
   * 
   * @param mappings - New mappings
   * @param options - Replace options
   */
  async replaceSchema(
    mappings: AirtableSchemaMapping[],
    options?: { validate?: boolean }
  ): Promise<void> {
    const validate = options?.validate !== false;
    
    debug(`[AirtableAdapter] Replacing schema (${mappings.length} fields)...`);
    
    if (validate) {
      // Basic validation
      if (mappings.length === 0) {
        console.warn('[AirtableAdapter] Warning: Replacing with empty schema');
      }
    }
    
    this.mappings = mappings;
    this.schemaInitialized = true;
    
    debug('[AirtableAdapter] Schema replaced');
  }
  
  /**
   * Get current schema info
   * 
   * Returns information about the current schema state.
   * 
   * @returns Schema info
   */
  getSchemaInfo(): {
    fieldCount: number;
    fields: Array<{ name: string; type: string; sourcePath: string }>;
    initialized: boolean;
    introspectionEnabled: boolean;
  } {
    return {
      fieldCount: this.mappings.length,
      fields: this.mappings.map(m => ({
        name: m.airtableField,
        type: m.airtableType,
        sourcePath: m.sourcePath
      })),
      initialized: this.schemaInitialized,
      introspectionEnabled: this.shouldIntrospectSchema
    };
  }
  
  // ============================================================================
  // Auto-Field Creation (Phase 3.6d)
  // ============================================================================
  
  /**
   * Infer Airtable field type from JavaScript value
   * 
   * @param fieldName - Field name (for context)
   * @param value - Value to infer type from
   * @returns Airtable field type
   */
  private inferAirtableFieldType(fieldName: string, value: any): string {
    // null/undefined → singleLineText (default)
    if (value === null || value === undefined) {
      return 'singleLineText';
    }
    
    // Array → detect attachments vs multipleSelects
    if (Array.isArray(value)) {
      // Detect Airtable attachment format: [{ url, filename }] or [{ url }]
      if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        const first = value[0];
        if (first.url && typeof first.url === 'string') {
          return 'multipleAttachments';
        }
      }
      return 'multipleSelects';
    }
    
    // Boolean → checkbox
    if (typeof value === 'boolean') {
      return 'checkbox';
    }
    
    // Number → number
    if (typeof value === 'number') {
      return 'number';
    }
    
    // Date → dateTime (Date objects have time info)
    if (value instanceof Date) {
      return 'dateTime';
    }
    
    // String - infer based on strategy
    if (typeof value === 'string') {
      if (this.typeInference === 'flexible') {
        // Email pattern
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return 'email';
        }
        
        // URL pattern
        if (/^https?:\/\/.+/.test(value)) {
          return 'url';
        }
        
        // Long text (> 200 chars)
        if (value.length > 200) {
          return 'multilineText';
        }
        
        // DateTime string pattern (ISO with time component)
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
          return 'dateTime';
        }

        // Date string pattern (date only)
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return 'date';
        }
      }
      
      // Default: singleLineText
      return 'singleLineText';
    }
    
    // Fallback
    return 'singleLineText';
  }
  
  /**
   * Create missing fields in Airtable table
   * 
   * @param fields - Map of field name → value (for type inference)
   * @returns Array of created field names
   */
  async createMissingFields(fields: Record<string, any>): Promise<string[]> {
    const createdFields: string[] = [];
    
    debug(`[AirtableAdapter] Creating ${Object.keys(fields).length} missing fields...`);
    
    // Ensure we have the resolved table ID (required for Meta API)
    await this.ensureTableIdResolved();
    
    try {
      // Airtable requires creating fields one by one via the Meta API
      for (const [fieldName, value] of Object.entries(fields)) {
        // Sanitize field name
        const sanitizedName = this.sanitizeFieldName(fieldName);
        
        // Infer type
        const inferredType = this.inferAirtableFieldType(sanitizedName, value);
        
        debug(`[AirtableAdapter]   - Creating field: ${sanitizedName} (${inferredType})`);
        
        try {
          // Build field creation payload — some types require options
          const fieldPayload: Record<string, any> = {
            name: sanitizedName,
            type: inferredType,
          };

          // Add required options for types that need them
          if (inferredType === 'number') {
            fieldPayload.options = { precision: 0 };
          } else if (inferredType === 'currency') {
            fieldPayload.options = { precision: 2, symbol: '$' };
          } else if (inferredType === 'percent') {
            fieldPayload.options = { precision: 0 };
          } else if (inferredType === 'rating') {
            fieldPayload.options = { max: 5, icon: 'star', color: 'yellowBright' };
          } else if (inferredType === 'duration') {
            fieldPayload.options = { durationFormat: 'h:mm' };
          } else if (inferredType === 'checkbox') {
            fieldPayload.options = { icon: 'check', color: 'greenBright' };
          } else if (inferredType === 'date') {
            fieldPayload.options = { dateFormat: { name: 'iso' } };
          } else if (inferredType === 'dateTime') {
            fieldPayload.options = {
              dateFormat: { name: 'iso' },
              timeFormat: { name: '24hour' },
              timeZone: 'utc',
            };
          } else if (inferredType === 'singleSelect' || inferredType === 'multipleSelects') {
            fieldPayload.options = { choices: [] };
          }

          // Create field via Meta API using resolved table ID
          await this.airtable.fields.create(
            this.baseId,
            this.resolvedTableId!,
            fieldPayload as any
          );
          
          // Add to mappings — use original field name as sourcePath
          // so data lookup matches the keys in the incoming object
          this.mappings.push({
            airtableField: sanitizedName,
            sourcePath: fieldName,
            airtableType: inferredType as any
          });

          createdFields.push(sanitizedName);
          debug(`[AirtableAdapter]   ✅ Created field: ${sanitizedName}`);
        } catch (fieldError: any) {
          // If field already exists (duplicate), just skip it and continue
          if (fieldError.type === 'DUPLICATE_OR_EMPTY_FIELD_NAME') {
            debug(`[AirtableAdapter]   ⚠️  Field ${sanitizedName} already exists, skipping`);
            
            // Add to mappings if not already there — use original field name
            const exists = this.mappings.some(m => m.airtableField.trim() === sanitizedName.trim());
            if (!exists) {
              this.mappings.push({
                airtableField: sanitizedName,
                sourcePath: fieldName,
                airtableType: inferredType as any
              });
            }
            
            continue; // Skip this field and continue with next
          }
          
          // For other errors, log and rethrow
          console.error(`[AirtableAdapter]   ❌ Failed to create field ${sanitizedName}:`, fieldError);
          console.error(`[AirtableAdapter]   Error details:`, JSON.stringify(fieldError, null, 2));
          throw fieldError;
        }
      }
      
      debug(`[AirtableAdapter] ✅ Created ${createdFields.length} fields total`);
    } catch (error: any) {
      console.error('[AirtableAdapter] Failed to create fields:', error);
      console.error('[AirtableAdapter] Error type:', error.constructor?.name);
      console.error('[AirtableAdapter] Error message:', error.message);
      if (error.response) {
        console.error('[AirtableAdapter] API response:', JSON.stringify(error.response, null, 2));
      }
      
      // Provide helpful error message for auth issues
      if (error && error.statusCode === 401) {
        throw new Error(
          'Airtable Meta API authentication failed. The Meta API requires a Personal Access Token (PAT) ' +
          'with "schema.bases:write" scope to create fields. Regular API keys (starting with "key...") will NOT work. ' +
          'Create a PAT at https://airtable.com/create/tokens with the required scopes.'
        );
      }
      
      throw new Error(
        `Failed to create fields in Airtable: ${error.message || String(error)}`
      );
    }
    
    return createdFields;
  }
  
  /**
   * Sanitize field name for Airtable
   * 
   * @param name - Raw field name
   * @returns Sanitized field name
   */
  private sanitizeFieldName(name: string): string {
    // Airtable: No special restrictions, just trim
    return name.trim();
  }
  
  // ============================================================================
  // Unmapped Field Handling (Phase 3.6a)
  // ============================================================================
  
  /**
   * Detect fields in data that aren't in schema mappings
   * 
   * @param data - Data object to check
   * @returns Array of unmapped field names
   */
  private detectUnmappedFields(data: any): string[] {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return [];
    }
    
    // Get all mapped source paths (trimmed for consistent comparison)
    const mappedPaths = new Set(this.mappings.map(m => m.sourcePath.trim()));

    // Find fields in data that aren't mapped
    const unmapped: string[] = [];
    for (const field of Object.keys(data)) {
      if (!mappedPaths.has(field.trim())) {
        unmapped.push(field);
      }
    }
    
    return unmapped;
  }
  
  /**
   * Handle unmapped fields based on strategy
   * 
   * @param data - Original data
   * @param unmapped - Unmapped field names
   * @returns Modified data (with unmapped fields handled) and extra data
   */
  private handleUnmappedFields(
    data: any,
    unmapped: string[]
  ): { processedData: any; extraData?: Record<string, any> } {
    if (unmapped.length === 0) {
      return { processedData: data };
    }
    
    switch (this.unmappedStrategy) {
      case 'error': {
        throwValidationError(
          this.capabilities.name,
          'set',
          `Unmapped fields detected: ${unmapped.join(', ')}`,
          {
            unmappedFields: unmapped,
            data,
            suggestions: [
              'Add fields to schema mappings',
              'Set unmappedStrategy to "ignore"',
              'Set unmappedStrategy to "store-as-json"'
            ]
          }
        );
        break;
      }
      
      case 'ignore': {
        // Remove unmapped fields from data
        const processedData = { ...data };
        for (const field of unmapped) {
          delete processedData[field];
        }
        return { processedData };
      }
      
      case 'store-as-json': {
        // Extract unmapped fields to separate object
        const processedData = { ...data };
        const extraData: Record<string, any> = {};
        
        for (const field of unmapped) {
          extraData[field] = data[field];
          delete processedData[field];
        }
        
        return { processedData, extraData };
      }
      
      default:
        return { processedData: data };
    }
  }
}

/**
 * Create Airtable adapter
 * 
 * @param config - Adapter configuration
 * @returns AirtableAdapter
 * 
 * @example
 * ```typescript
 * const airtable = createAirtableAdapter({
 *   apiKey: 'your-api-key',
 *   baseId: 'appXXXXXXXXXXXXXX',
 *   tableIdOrName: 'Contacts',
 *   mappings: [
 *     {
 *       airtableField: 'Name',
 *       sourcePath: 'name',
 *       airtableType: 'singleLineText',
 *       required: true,
 *     },
 *     {
 *       airtableField: 'Email',
 *       sourcePath: 'contact.email',
 *       airtableType: 'email',
 *     },
 *     {
 *       airtableField: 'Tags',
 *       sourcePath: 'tags',
 *       airtableType: 'multipleSelects',
 *     },
 *   ],
 * });
 * ```
 */
export function createAirtableAdapter(config: AirtableAdapterConfig): AirtableAdapter {
  return new AirtableAdapter(config);
}

