/**
 * Notion Database Adapter for Smallstore
 * 
 * Provides full CRUD operations for Notion databases using the existing
 * NotionModernClient and transformation system.
 * 
 * Features:
 * - Automatic schema mapping
 * - Property type transformation
 * - Nested field support (dot notation)
 * - Query support (Notion database queries)
 * - Auto-transform using notionTransformers
 */

// NOTE: Retry for Notion API calls is handled by the @notionhq/client SDK internally.
// Do not wrap Notion SDK calls with retry() — it would double the retry time.

import type { StorageAdapter, AdapterCapabilities } from './adapter.ts';
import type { SearchProvider, KeysPageOptions, KeysPage } from '../types.ts';
import { MemoryBm25SearchProvider } from '../search/memory-bm25-provider.ts';
import { NotionModernClient } from '../clients/notion/notionModern.ts';
import type {
  PageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints.d.ts';
import {
  throwUnsupportedOperation,
  throwValidationError,
  type AdapterError,
} from './errors.ts';
import { blocksToMarkdown, markdownToBlocks } from '../clients/notion/notionBlocks.ts';
import { debug } from '../utils/debug.ts';

// Notion SDK doesn't properly type page.properties — add helper
type NotionPageWithProperties = { properties: Record<string, any>; [key: string]: any };

/** Notion API limit: max blocks per appendBlockChildren call */
const NOTION_BLOCK_BATCH_LIMIT = 100;

/** Rate-limit delay (ms) between batch delete requests to avoid Notion 429 errors.
 *  Notion doesn't expose Retry-After headers on block deletes, so we use a conservative fixed delay. */
const NOTION_RATE_LIMIT_DELAY_MS = 50;

/**
 * Schema mapping configuration
 */
export interface NotionSchemaMapping {
  /** Target property name in Notion database */
  notionProperty: string;
  
  /** Source field path in Smallstore data (dot notation) */
  sourcePath: string;
  
  /** Notion property type */
  notionType: 'title' | 'rich_text' | 'number' | 'checkbox' | 'select' | 
                'multi_select' | 'date' | 'url' | 'email' | 'phone_number' | 
                'files' | 'status' | 'relation' | 'formula' | 'rollup';
  
  /** Is this field required? */
  required?: boolean;
  
  /** Default value if source is missing */
  defaultValue?: any;
  
  /** Custom transformation function */
  transform?: (value: any) => any;
}

export interface NotionAdapterConfig {
  /** Notion API key (or will use env/keyResolver) */
  notionSecret?: string;
  
  /** Notion database ID */
  databaseId: string;
  
  /** Schema mappings for this database (optional if introspectSchema: true) */
  mappings?: NotionSchemaMapping[];
  
  /** Introspect schema from Notion database on init (Phase 3.6b) */
  introspectSchema?: boolean;
  
  /** Cache introspected schema for performance (default: true if introspecting) */
  cacheSchema?: boolean;
  
  /** Where to cache schema in metadata (default: auto-generated key) */
  cacheSchemaKey?: string;
  
  /** Property to store Smallstore key (default: '_smallstore_key') */
  keyProperty?: string;
  
  /** How to handle fields not in mappings (default: 'error') */
  unmappedStrategy?: 'error' | 'ignore' | 'store-as-json' | 'auto-create';
  
  /** Property to store unmapped fields as JSON (default: '_extra_data') */
  unmappedProperty?: string;
  
  /** Type inference strategy for auto-created fields (Phase 3.6d) */
  typeInference?: 'strict' | 'flexible';
  
  /** Enable auto-transform (default: true) */
  autoTransform?: boolean;

  /** KeyResolver for credential resolution */
  keyResolver?: any;

  /** Property name whose value is stored in page body (blocks) instead of DB property */
  contentProperty?: string;

  /** Format for contentProperty: 'markdown' (default) or 'blocks' (raw Notion blocks) */
  contentFormat?: 'markdown' | 'blocks';
}

/**
 * Notion Database Adapter
 * 
 * Bridges Smallstore's schemaless data model with Notion's structured database.
 */
export class NotionDatabaseAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'notion-database',
    supportedTypes: ['object'],  // Only structured data
    maxItemSize: 2000,  // Notion's limit per property (characters)
    cost: {
      tier: 'free',
      perOperation: 'Free tier: 5 requests/sec',
    },
    performance: {
      readLatency: 'medium',   // ~200-500ms
      writeLatency: 'medium',  // ~200-500ms
      throughput: 'low',       // 5 req/sec rate limit
    },
    features: {
      query: true,  // Notion supports database queries
      search: true, // Client-side BM25 search
    },
  };

  private _searchProvider = new MemoryBm25SearchProvider();

  get searchProvider(): SearchProvider {
    return this._searchProvider;
  }

  private client: NotionModernClient;
  private notionSecret: string | undefined;
  private databaseId: string;
  private mappings: NotionSchemaMapping[];
  private keyProperty: string;
  private unmappedStrategy: 'error' | 'ignore' | 'store-as-json' | 'auto-create';
  private unmappedProperty: string;
  private typeInference: 'strict' | 'flexible';
  private shouldIntrospectSchema: boolean;
  private cacheSchema: boolean;
  private cacheSchemaKey: string;
  private schemaInitialized: boolean = false;
  private contentProperty?: string;
  private contentFormat: 'markdown' | 'blocks';

  constructor(config: NotionAdapterConfig) {
    this.notionSecret = config.notionSecret;
    this.client = new NotionModernClient({
      notionSecret: config.notionSecret,
      notionVersion: '2025-09-03', // v5 API with data source support
      keyResolver: config.keyResolver,
      autoTransform: config.autoTransform !== false,
    });
    
    this.databaseId = this.cleanNotionId(config.databaseId);
    this.keyProperty = config.keyProperty || '_smallstore_key';
    this.unmappedStrategy = config.unmappedStrategy || 'error';
    this.unmappedProperty = config.unmappedProperty || '_extra_data';
    this.typeInference = config.typeInference || 'flexible';
    
    // Schema introspection config
    this.shouldIntrospectSchema = config.introspectSchema || false;
    this.cacheSchema = config.cacheSchema !== false; // Default true
    this.cacheSchemaKey = config.cacheSchemaKey || `notion:schema:${this.databaseId}`;
    
    // Page body content config
    this.contentProperty = config.contentProperty;
    this.contentFormat = config.contentFormat || 'markdown';

    // Mappings: explicit or will be introspected
    if (config.mappings) {
      this.mappings = config.mappings;
      this.schemaInitialized = true;
    } else if (this.shouldIntrospectSchema) {
      this.mappings = []; // Will be populated by introspection
      // Note: Introspection happens lazily on first operation
    } else {
      throw new Error(
        '[NotionAdapter] Either provide "mappings" or set "introspectSchema: true"'
      );
    }
  }
  
  // ============================================================================
  // CRUD Operations
  // ============================================================================
  
  async get(key: string): Promise<any> {
    try {
      // Ensure schema mappings are loaded before transforming
      await this.ensureSchemaInitialized();

      const page = await this.findPageByKey(key);
      if (!page) return null;

      // Transform Notion properties → Smallstore data
      const data = this.transformFromNotion(page);

      // If we have extra data stored, merge it back in
      const properties = (page as NotionPageWithProperties).properties;
      const extraDataProp = properties[this.unmappedProperty];

      if (extraDataProp && extraDataProp.rich_text && extraDataProp.rich_text[0]) {
        try {
          const extraData = JSON.parse(extraDataProp.rich_text[0].text.content);
          Object.assign(data, extraData);
        } catch (_e) {
          // JSON parse failed, ignore
        }
      }

      // Read page body content if contentProperty is configured
      if (this.contentProperty) {
        const bodyContent = await this.readPageContent(page.id);
        if (bodyContent) {
          data[this.contentProperty] = bodyContent;
        }
      }

      return data;
    } catch (error) {
      console.error(`[NotionAdapter] Error getting key ${key}:`, error);
      return null;
    }
  }
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      // Ensure schema is initialized
      await this.ensureSchemaInitialized();

      // TTL not supported by Notion (log warning)
      if (ttl) {
        console.warn(`[NotionAdapter] TTL not supported, ignoring ttl=${ttl}`);
      }

      // Extract page body content before processing properties
      let bodyContent: string | undefined;
      let valueForProperties = value;
      if (this.contentProperty && value && typeof value === 'object' && this.contentProperty in value) {
        bodyContent = value[this.contentProperty];
        // Remove contentProperty from the value sent to DB properties
        const { [this.contentProperty]: _removed, ...rest } = value;
        valueForProperties = rest;
      }

      // Detect and handle unmapped fields
      const unmapped = this.detectUnmappedFields(valueForProperties);

      // Auto-create fields if strategy is 'auto-create'
      if (unmapped.length > 0 && this.unmappedStrategy === 'auto-create') {
        const unmappedData: Record<string, any> = {};
        for (const field of unmapped) {
          unmappedData[field] = valueForProperties[field];
        }
        await this.createMissingFields(unmappedData);
      }

      const { processedData, extraData } = this.handleUnmappedFields(valueForProperties, unmapped);

      // Transform Smallstore data → Notion properties
      const properties = this.transformToNotion(processedData);

      // Add key property
      properties[this.keyProperty] = {
        rich_text: [{ text: { content: key } }],
      };

      // If we have extra data, store it in the unmapped property
      if (extraData && Object.keys(extraData).length > 0) {
        properties[this.unmappedProperty] = {
          rich_text: [{ text: { content: JSON.stringify(extraData) } }],
        };
      }

      // Check if page exists
      const existing = await this.findPageByKey(key);
      let pageId: string;

      if (existing) {
        // Update existing page
        await this.client.updatePage({
          page_id: existing.id,
          properties,
        });
        pageId = existing.id;
      } else {
        // Create new page
        const created = await this.client.createPage({
          parent: { database_id: this.databaseId },
          properties,
        }) as any;
        pageId = created.id;
      }

      // Write page body content if configured
      if (this.contentProperty && bodyContent != null) {
        await this.writePageContent(pageId, String(bodyContent));
      }

      // Index for BM25 search (best-effort)
      try { this._searchProvider.index(key, value); } catch (indexError) { console.warn('[NotionAdapter] Search index update failed:', indexError); }
    } catch (error) {
      console.error(`[NotionAdapter] Error setting key ${key}:`, error);
      throw error;
    }
  }
  
  async delete(key: string): Promise<void> {
    try {
      const page = await this.findPageByKey(key);
      if (!page) return;
      
      // Trash page (Notion doesn't support hard delete)
      await this.client.updatePage({
        page_id: page.id,
        in_trash: true,
      });
      try { this._searchProvider.remove(key); } catch { /* ignore */ }
    } catch (error: any) {
      // Idempotent: if page already trashed/deleted, that's fine
      if (error?.code === 'object_not_found' || error?.status === 404) {
        return;
      }
      throw error;
    }
  }
  
  /**
   * Delete a specific record by ID (Phase 3.6e)
   * 
   * @param recordId - Notion page ID
   */
  async deleteRecord(recordId: string): Promise<void> {
    try {
      // Clean and format the ID
      const cleanId = this.cleanNotionId(recordId);
      
      // Trash the page (Notion doesn't support hard delete)
      await this.client.updatePage({
        page_id: cleanId,
        in_trash: true,
      });
      
      debug(`[NotionAdapter] ✅ Archived record: ${cleanId}`);
    } catch (error) {
      console.error('[NotionAdapter] Failed to delete record:', error);
      throw new Error(
        `Failed to delete Notion record: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  async has(key: string): Promise<boolean> {
    try {
      const page = await this.findPageByKey(key);
      return !!page;
    } catch (error) {
      console.error(`[NotionAdapter] Error checking key ${key}:`, error);
      return false;
    }
  }
  
  async keys(prefix?: string): Promise<string[]> {
    try {
      const allKeys: string[] = [];
      let hasMore = true;
      let startCursor: string | undefined = undefined;

      while (hasMore) {
        const response = await this.client.queryDatabase({
          database_id: this.databaseId,
          start_cursor: startCursor,
          page_size: 100,
        });

        // Extract keys from pages
        for (const page of response.results) {
          const key = this.extractKeyFromPage(page as PageObjectResponse);
          if (key && (!prefix || key.startsWith(prefix))) {
            allKeys.push(key);
          }
        }

        hasMore = response.has_more;
        startCursor = response.next_cursor || undefined;
      }

      return allKeys;
    } catch (error) {
      console.error('[NotionAdapter] Error listing keys:', error);
      return [];
    }
  }

  /**
   * Paged keys — wraps Notion's native `start_cursor` / `next_cursor`
   * pagination so callers can stream keys one page at a time instead of
   * round-tripping the whole database. `cursor` round-trips Notion's
   * `next_cursor` opaquely. If `offset` is used instead of `cursor`, we
   * walk forward from the start — safe but O(offset).
   */
  async listKeys(options: KeysPageOptions = {}): Promise<KeysPage> {
    const prefix = options.prefix;
    const pageSize = Math.min(100, options.limit ?? 100); // Notion max 100
    const out: string[] = [];
    let cursor = options.cursor;
    let hasMore = true;
    let skipped = 0;
    const targetOffset = options.offset ?? 0;

    try {
      while (hasMore && (options.limit === undefined || out.length < options.limit)) {
        const response = await this.client.queryDatabase({
          database_id: this.databaseId,
          start_cursor: cursor,
          page_size: pageSize,
        });

        for (const page of response.results) {
          const key = this.extractKeyFromPage(page as PageObjectResponse);
          if (!key) continue;
          if (prefix && !key.startsWith(prefix)) continue;
          if (skipped < targetOffset && !options.cursor) {
            skipped++;
            continue;
          }
          out.push(key);
          if (options.limit !== undefined && out.length >= options.limit) break;
        }

        hasMore = response.has_more;
        cursor = response.next_cursor || undefined;
      }
      return {
        keys: out,
        hasMore: hasMore || (options.limit !== undefined && out.length >= options.limit && !!cursor),
        ...(cursor ? { cursor } : {}),
      };
    } catch (error) {
      console.error('[NotionAdapter] Error in listKeys:', error);
      return { keys: [], hasMore: false };
    }
  }
  
  async clear(prefix?: string): Promise<void> {
    try {
      const keys = await this.keys(prefix);
      
      // Archive all matching pages
      await Promise.all(keys.map(key => this.delete(key)));
    } catch (error) {
      console.error('[NotionAdapter] Error clearing:', error);
      throw error;
    }
  }
  
  // ============================================================================
  // Schema Transformation
  // ============================================================================
  
  /**
   * Transform Smallstore data → Notion properties
   * 
   * Uses schema mappings to convert schemaless data to structured Notion format.
   * Leverages notionTransformers for automatic type conversion.
   */
  private transformToNotion(data: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    for (const mapping of this.mappings) {
      // Extract value from source data using dot notation
      const value = this.getValueByPath(data, mapping.sourcePath);
      
      if (value === undefined) {
        if (mapping.required) {
          throw new Error(
            `[NotionAdapter] Required field "${mapping.sourcePath}" is missing`
          );
        }
        if (mapping.defaultValue !== undefined) {
          const defaultVal = mapping.defaultValue;
          properties[mapping.notionProperty] = this.valueToNotionProperty(
            defaultVal,
            mapping.notionType
          );
        }
        continue;
      }
      
      // Apply custom transformation if provided
      const transformedValue = mapping.transform ? mapping.transform(value) : value;
      
      // Convert to Notion property format
      properties[mapping.notionProperty] = this.valueToNotionProperty(
        transformedValue,
        mapping.notionType
      );
    }
    
    return properties;
  }
  
  /**
   * Transform Notion properties → Smallstore data
   */
  private transformFromNotion(page: PageObjectResponse): any {
    const data: any = {};
    
    for (const mapping of this.mappings) {
      const properties = (page as NotionPageWithProperties).properties;
      const notionValue = properties[mapping.notionProperty];
      
      if (!notionValue) continue;
      
      // Extract value from Notion property
      const value = this.notionPropertyToValue(notionValue, mapping.notionType);
      
      if (value !== null && value !== undefined) {
        // Set value using dot notation path
        this.setValueByPath(data, mapping.sourcePath, value);
      }
    }
    
    return data;
  }
  
  /**
   * Convert value to Notion property format
   * 
   * Note: NotionModernClient with autoTransform will handle final conversion
   */
  private valueToNotionProperty(value: any, type: string): any {
    // The notionTransformers will handle these automatically via autoTransform
    // We just need to provide the right structure
    
    switch (type) {
      case 'title':
        return { title: [{ text: { content: String(value || '') } }] };
      
      case 'rich_text':
        return { rich_text: [{ text: { content: String(value || '') } }] };
      
      case 'number':
        const num = Number(value);
        return { number: isNaN(num) ? null : num };
      
      case 'checkbox':
        return { checkbox: Boolean(value) };
      
      case 'select':
        return { select: value ? { name: String(value) } : null };
      
      case 'multi_select':
        const items = Array.isArray(value) ? value : [value];
        return { multi_select: items.map(v => ({ name: String(v) })) };
      
      case 'date':
        return { date: value ? { start: String(value) } : null };
      
      case 'url':
        return { url: value ? String(value) : null };
      
      case 'email':
        return { email: value ? String(value) : null };
      
      case 'phone_number':
        return { phone_number: value ? String(value) : null };
      
      case 'files':
        // Files/attachments are complex - handle as array of objects
        if (Array.isArray(value)) {
          return { files: value };
        }
        return { files: [] };
      
      case 'status':
        return { status: value ? { name: String(value) } : null };
      
      case 'relation':
        // Relations are array of page IDs
        const ids = Array.isArray(value) ? value : [value];
        return { relation: ids.map(id => ({ id: String(id) })) };
      
      default:
        console.warn(`[NotionAdapter] Unsupported property type: ${type}`);
        return null;
    }
  }
  
  /**
   * Extract value from Notion property
   */
  private notionPropertyToValue(property: any, type: string): any {
    switch (type) {
      case 'title':
        return property.title?.[0]?.text?.content || '';
      
      case 'rich_text':
        return property.rich_text?.[0]?.text?.content || '';
      
      case 'number':
        return property.number;
      
      case 'checkbox':
        return property.checkbox;
      
      case 'select':
        return property.select?.name || null;
      
      case 'multi_select':
        return property.multi_select?.map((item: any) => item.name) || [];
      
      case 'date':
        return property.date?.start || null;
      
      case 'url':
        return property.url || null;
      
      case 'email':
        return property.email || null;
      
      case 'phone_number':
        return property.phone_number || null;
      
      case 'files':
        return property.files || [];
      
      case 'status':
        return property.status?.name || null;
      
      case 'relation':
        return property.relation?.map((rel: any) => rel.id) || [];
      
      case 'formula':
        // Extract value based on formula result type
        if (property.formula?.type === 'string') {
          return property.formula.string;
        } else if (property.formula?.type === 'number') {
          return property.formula.number;
        } else if (property.formula?.type === 'boolean') {
          return property.formula.boolean;
        } else if (property.formula?.type === 'date') {
          return property.formula.date?.start;
        }
        return null;
      
      case 'rollup':
        // Extract value based on rollup result type
        if (property.rollup?.type === 'number') {
          return property.rollup.number;
        } else if (property.rollup?.type === 'date') {
          return property.rollup.date?.start;
        } else if (property.rollup?.type === 'array') {
          return property.rollup.array;
        }
        return null;
      
      default:
        return null;
    }
  }
  
  // ============================================================================
  // Page Body (Block) Content
  // ============================================================================

  /**
   * Read all blocks from a Notion page and convert to markdown.
   */
  private async readPageContent(pageId: string): Promise<string> {
    try {
      const allBlocks: any[] = [];
      let cursor: string | undefined;

      do {
        const response = await this.client.listBlockChildren({
          block_id: pageId,
          start_cursor: cursor,
          page_size: 100,
        }) as any;

        if (response.results) {
          allBlocks.push(...response.results);
        }
        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);

      if (allBlocks.length === 0) return '';

      if (this.contentFormat === 'blocks') {
        return JSON.stringify(allBlocks);
      }
      return blocksToMarkdown(allBlocks);
    } catch (error) {
      console.error(`[NotionAdapter] Error reading page content ${pageId}:`, error);
      return '';
    }
  }

  /**
   * Write markdown content to a Notion page body (replacing existing blocks).
   */
  private async writePageContent(pageId: string, content: string): Promise<void> {
    try {
      // Clear existing blocks
      await this.clearPageBlocks(pageId);

      // Convert content to blocks
      let blocks: any[];
      if (this.contentFormat === 'blocks') {
        blocks = typeof content === 'string' ? JSON.parse(content) : content;
      } else {
        blocks = markdownToBlocks(content);
      }

      if (blocks.length === 0) return;

      // Append in batches (Notion limit per call)
      for (let i = 0; i < blocks.length; i += NOTION_BLOCK_BATCH_LIMIT) {
        const batch = blocks.slice(i, i + NOTION_BLOCK_BATCH_LIMIT);
        await this.client.appendBlockChildren({
          block_id: pageId,
          children: batch,
        });
      }
    } catch (error) {
      console.error(`[NotionAdapter] Error writing page content ${pageId}:`, error);
      throw error;
    }
  }

  /**
   * Delete all blocks from a Notion page.
   */
  private async clearPageBlocks(pageId: string): Promise<void> {
    try {
      const response = await this.client.listBlockChildren({
        block_id: pageId,
        page_size: 100,
      }) as any;

      if (!response.results || response.results.length === 0) return;

      // Delete in parallel batches of 3 (stay within Notion rate limits).
      // We use a fixed delay because Notion doesn't expose Retry-After headers on block deletes.
      const blocks = response.results;
      for (let i = 0; i < blocks.length; i += 3) {
        const batch = blocks.slice(i, i + 3);
        await Promise.all(batch.map((b: any) => this.client.deleteBlock(b.id)));
        if (i + 3 < blocks.length) {
          await new Promise((r) => setTimeout(r, NOTION_RATE_LIMIT_DELAY_MS));
        }
      }

      // Handle pagination — if there were more blocks, recurse
      if (response.has_more) {
        await this.clearPageBlocks(pageId);
      }
    } catch (error) {
      console.error(`[NotionAdapter] Error clearing page blocks ${pageId}:`, error);
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Find page by Smallstore key
   */
  private async findPageByKey(key: string): Promise<PageObjectResponse | null> {
    try {
      const response = await this.client.queryDatabase({
        database_id: this.databaseId,
        filter: {
          property: this.keyProperty,
          rich_text: {
            equals: key,
          },
        },
        page_size: 1,
      });
      
      return (response.results[0] as PageObjectResponse) || null;
    } catch (error) {
      console.error(`[NotionAdapter] Error finding page by key ${key}:`, error);
      return null;
    }
  }
  
  /**
   * Extract Smallstore key from Notion page
   */
  private extractKeyFromPage(page: PageObjectResponse): string | null {
    const properties = (page as NotionPageWithProperties).properties;
    const keyProp = properties[this.keyProperty];
    
    if (!keyProp) return null;
    
    return keyProp.rich_text?.[0]?.text?.content || null;
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

  /**
   * Clean Notion ID (remove dashes)
   */
  private cleanNotionId(id: string): string {
    return id.replace(/-/g, '');
  }
  
  // ============================================================================
  // High-Level Operations (Composition-Compatible)
  // ============================================================================
  
  /**
   * Upsert objects into Notion database by key field
   * 
   * This is the natural way to work with Notion databases - each object
   * becomes a page, keyed by a unique identifier.
   * 
   * @param data - Single object or array of objects to upsert
   * @param options - Upsert options
   * 
   * @example
   * await notionAdapter.upsert(
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
   * Insert objects into Notion database with auto-key detection
   * 
   * Like upsert(), but with smart ID field detection.
   * 
   * @param data - Single object or array of objects
   * @param options - Insert options
   * 
   * @example
   * // Auto-detects 'id' field
   * await notionAdapter.insert([
   *   { id: '123', name: 'Alice' },
   *   { id: '456', name: 'Bob' }
   * ]);
   * 
   * @example
   * // Custom ID field
   * await notionAdapter.insert(
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
            suggestion: 'Common ID fields: id, _id, email, pmid, doi',
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
   * Merge arrays - NOT SUPPORTED by Notion
   * 
   * Notion stores individual pages (records), not arrays.
   * Use insert() or upsert() to add pages to your database.
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
      'Notion databases store individual pages (records), not arrays.',
      'insert() or upsert()'
    );
  }
  
  /**
   * Query Notion database with filters
   * 
   * Wraps Notion's native query API for advanced filtering and sorting.
   * 
   * @param query - Notion query parameters
   * @returns Array of transformed objects
   * 
   * @example
   * const activeUsers = await notionAdapter.query({
   *   filter: {
   *     property: 'Status',
   *     select: { equals: 'Active' }
   *   },
   *   sorts: [{ property: 'Created', direction: 'descending' }]
   * });
   */
  async query(query: {
    filter?: any;
    sorts?: any[];
    pageSize?: number;
    startCursor?: string;
  }): Promise<{ data: any[]; totalCount: number }> {
    try {
      const response = await this.client.queryDatabase({
        database_id: this.databaseId,
        filter: query.filter,
        sorts: query.sorts,
        page_size: query.pageSize || 100,
        start_cursor: query.startCursor,
      });

      // Transform all pages to Smallstore format
      const data = response.results
        .filter((page: any) => page.object === 'page' && 'properties' in page)
        .map((page: any) => this.transformFromNotion(page));
      return { data, totalCount: data.length };
    } catch (error) {
      console.error('[NotionAdapter] Error querying database:', error);
      throw error;
    }
  }
  
  /**
   * List all items in database
   * 
   * Convenience method that fetches all pages and transforms them.
   * 
   * @param options - Pagination options
   * @returns Array of objects
   * 
   * @example
   * const allItems = await notionAdapter.list();
   * const firstPage = await notionAdapter.list({ limit: 10 });
   */
  async list(options?: {
    limit?: number;
    startCursor?: string;
  }): Promise<any[]> {
    const items: any[] = [];
    let hasMore = true;
    let startCursor = options?.startCursor;
    const limit = options?.limit;
    
    while (hasMore && (!limit || items.length < limit)) {
      const response = await this.client.queryDatabase({
        database_id: this.databaseId,
        start_cursor: startCursor,
        page_size: limit ? Math.min(100, limit - items.length) : 100,
      });
      
      for (const page of response.results) {
        items.push(this.transformFromNotion(page as PageObjectResponse));
        if (limit && items.length >= limit) break;
      }
      
      hasMore = response.has_more;
      startCursor = response.next_cursor || undefined;
      
      if (!hasMore || (limit && items.length >= limit)) break;
    }
    
    return items;
  }
  
  // ============================================================================
  // Schema Introspection (Phase 3.6b)
  // ============================================================================
  
  /**
   * Introspect database schema from Notion API
   * 
   * Queries the database to get all properties and their types,
   * then auto-generates mappings.
   * 
   * @returns Map of property name → property type
   */
  public async introspectSchema(): Promise<Map<string, string>> {
    try {
      debug(`[NotionAdapter] Introspecting schema for database ${this.databaseId}...`);
      
      // Fetch database metadata
      const database = await this.client.getDatabase(this.databaseId);

      // Notion API v5+: properties may have moved from database to data_sources
      let properties = (database as any).properties;

      if (!properties && (database as any).data_sources?.length > 0) {
        const dataSourceId = (database as any).data_sources[0].id;
        debug(`[NotionAdapter] API v5 detected — fetching properties from data source ${dataSourceId}`);
        try {
          const dataSource = await this.client.getDataSource(dataSourceId);
          properties = (dataSource as any).properties;
        } catch {
          // dataSources.retrieve may not exist in older client versions — use raw fetch
          if (this.notionSecret) {
            const resp = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
              headers: {
                'Authorization': `Bearer ${this.notionSecret}`,
                'Notion-Version': '2025-09-03',
              },
            });
            if (resp.ok) {
              const ds = await resp.json() as Record<string, any>;
              properties = ds.properties;
            }
          }
        }
      }

      if (!properties) {
        throw new Error('No properties found on database or data source. Check that the database has at least one column.');
      }
      
      const schema = new Map<string, string>();
      
      // Extract property types
      for (const [propName, propData] of Object.entries(properties)) {
        const propType = (propData as any).type;
        schema.set(propName, propType);
      }
      
      debug(`[NotionAdapter] Found ${schema.size} properties`);
      
      return schema;
    } catch (error) {
      console.error('[NotionAdapter] Error introspecting schema:', error);
      throw new Error(
        `Failed to introspect Notion database schema: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  /**
   * Generate mappings from introspected schema
   * 
   * Converts Notion property definitions to NotionSchemaMapping format.
   * Uses sensible defaults (sourcePath = lowercase property name).
   * 
   * @param schema - Introspected schema
   * @returns Generated mappings
   */
  private generateMappingsFromSchema(schema: Map<string, string>): NotionSchemaMapping[] {
    const mappings: NotionSchemaMapping[] = [];
    
    for (const [propName, propType] of schema.entries()) {
      // Skip system properties
      if (propName === this.keyProperty) continue;
      if (propName === this.unmappedProperty) continue;
      
      // Use property name as-is for source path to preserve casing
      const sourcePath = propName;
      
      mappings.push({
        notionProperty: propName,
        sourcePath,
        notionType: propType as any,
        required: propType === 'title', // Title is typically required
      });
    }
    
    debug(`[NotionAdapter] Generated ${mappings.length} mappings`);
    
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
    
    debug('[NotionAdapter] Initializing schema from Notion...');

    try {
      // Introspect schema
      const schema = await this.introspectSchema();

      // Generate mappings
      this.mappings = this.generateMappingsFromSchema(schema);

      // Ensure _smallstore_key property exists
      if (!schema.has(this.keyProperty)) {
        debug(`[NotionAdapter] Creating ${this.keyProperty} property...`);
        await this.client.updateDatabase({
          database_id: this.databaseId,
          properties: {
            [this.keyProperty]: { rich_text: {} },
          },
        } as any);
        debug(`[NotionAdapter] Created ${this.keyProperty} property`);
      }

      this.schemaInitialized = true;

      debug('[NotionAdapter] Schema initialization complete');
    } catch (error) {
      console.error('[NotionAdapter] Schema initialization failed:', error);
      throw error;
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
    
    if (this.mappings.length === 0) {
      throw new Error(
        '[NotionAdapter] No schema mappings available. ' +
        'Either provide mappings in config or enable introspectSchema.'
      );
    }
  }
  
  // ============================================================================
  // Schema Update Methods (Phase 3.6c)
  // ============================================================================
  
  /**
   * Sync schema from platform
   * 
   * Re-introspects the database and updates internal mappings.
   * Use this after schema changes in Notion (added/removed properties).
   * 
   * @param options - Sync options
   */
  async syncSchema(options?: {
    merge?: boolean;              // Merge with existing or replace (default: true)
    preserveCustomTransforms?: boolean;  // Keep custom transform functions (default: true)
  }): Promise<void> {
    const merge = options?.merge !== false;
    const preserveCustomTransforms = options?.preserveCustomTransforms !== false;
    
    debug(`[NotionAdapter] Syncing schema from Notion (merge: ${merge})...`);
    
    try {
      // Introspect current schema
      const schema = await this.introspectSchema();
      const newMappings = this.generateMappingsFromSchema(schema);
      
      if (merge && preserveCustomTransforms) {
        // Merge: Keep existing mappings with custom logic, add new ones
        const existingMap = new Map(
          this.mappings.map(m => [m.notionProperty, m])
        );
        
        const mergedMappings: NotionSchemaMapping[] = [];
        
        // Add existing mappings (preserving custom transforms)
        for (const existing of this.mappings) {
          if (schema.has(existing.notionProperty)) {
            mergedMappings.push(existing);
          } else {
            console.warn(`[NotionAdapter] Property "${existing.notionProperty}" no longer exists in database`);
          }
        }
        
        // Add new mappings
        for (const newMapping of newMappings) {
          if (!existingMap.has(newMapping.notionProperty)) {
            mergedMappings.push(newMapping);
            debug(`[NotionAdapter] Added new property: ${newMapping.notionProperty}`);
          }
        }
        
        this.mappings = mergedMappings;
      } else {
        // Replace: Use new mappings entirely
        this.mappings = newMappings;
      }
      
      this.schemaInitialized = true;
      
      debug(`[NotionAdapter] Schema synced (${this.mappings.length} properties)`);
    } catch (error) {
      console.error('[NotionAdapter] Schema sync failed:', error);
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
    add?: NotionSchemaMapping[];
    remove?: string[];  // Property names to remove
    modify?: Record<string, Partial<NotionSchemaMapping>>;
  }): Promise<void> {
    debug('[NotionAdapter] Updating schema...');
    
    // Remove mappings
    if (updates.remove && updates.remove.length > 0) {
      this.mappings = this.mappings.filter(
        m => !updates.remove!.includes(m.notionProperty)
      );
      debug(`[NotionAdapter] Removed ${updates.remove.length} properties`);
    }
    
    // Modify existing mappings
    if (updates.modify) {
      for (const [propName, changes] of Object.entries(updates.modify)) {
        const existing = this.mappings.find(m => m.notionProperty === propName);
        if (existing) {
          Object.assign(existing, changes);
          debug(`[NotionAdapter] Modified property: ${propName}`);
        } else {
          console.warn(`[NotionAdapter] Property "${propName}" not found, cannot modify`);
        }
      }
    }
    
    // Add new mappings
    if (updates.add && updates.add.length > 0) {
      this.mappings.push(...updates.add);
      debug(`[NotionAdapter] Added ${updates.add.length} properties`);
    }
    
    debug(`[NotionAdapter] Schema updated (${this.mappings.length} properties)`);
  }
  
  /**
   * Introspect and update schema
   * 
   * Combines introspection with smart merging.
   * Detects added/removed/changed properties and updates mappings accordingly.
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
    
    debug(`[NotionAdapter] Introspecting and updating schema (mode: ${mode})...`);
    
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
          this.mappings.map(m => [m.notionProperty, m])
        );
        const newMap = new Map(
          newMappings.map(m => [m.notionProperty, m])
        );
        
        // Find added properties
        for (const [propName] of newMap) {
          if (!existingMap.has(propName)) {
            added.push(propName);
          }
        }
        
        // Find removed properties
        for (const [propName] of existingMap) {
          if (!newMap.has(propName)) {
            removed.push(propName);
          }
        }
        
        // Update mappings
        const updatedMappings: NotionSchemaMapping[] = [];
        
        // Keep existing (if still in platform schema)
        for (const existing of this.mappings) {
          if (newMap.has(existing.notionProperty)) {
            updatedMappings.push(existing);
          } else if (!removeObsolete) {
            // Keep even if removed from platform
            updatedMappings.push(existing);
          }
        }
        
        // Add new
        for (const newMapping of newMappings) {
          if (!existingMap.has(newMapping.notionProperty)) {
            updatedMappings.push(newMapping);
          }
        }
        
        this.mappings = updatedMappings;
      } else {
        // Replace mode
        added.push(...newMappings.map(m => m.notionProperty));
        removed.push(...this.mappings.map(m => m.notionProperty));
        this.mappings = newMappings;
      }
      
      // Create missing fields on platform if requested
      if (options?.createMissing && removed.length > 0) {
        const fieldsToCreate: Record<string, any> = {};
        for (const fieldName of removed) {
          fieldsToCreate[fieldName] = ''; // Use empty string for type inference (defaults to rich_text)
        }
        const created = await this.createMissingFields(fieldsToCreate);
        debug(`[NotionAdapter] Created ${created.length} missing fields on platform`);
        // Fields that were successfully created are no longer "removed"
        const createdSet = new Set(created);
        const stillRemoved = removed.filter(k => !createdSet.has(k));
        removed.length = 0;
        removed.push(...stillRemoved);
      }

      this.schemaInitialized = true;

      debug('[NotionAdapter] Schema update complete:');
      debug(`  Added: ${added.length}`);
      debug(`  Removed: ${removed.length}`);
      debug(`  Total: ${this.mappings.length}`);

      return { added, removed, modified };
    } catch (error) {
      console.error('[NotionAdapter] Introspect and update failed:', error);
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
    mappings: NotionSchemaMapping[],
    options?: { validate?: boolean }
  ): Promise<void> {
    const validate = options?.validate !== false;
    
    debug(`[NotionAdapter] Replacing schema (${mappings.length} properties)...`);
    
    if (validate) {
      // Validate new mappings have required properties
      const hasTitle = mappings.some(m => m.notionType === 'title');
      if (!hasTitle) {
        console.warn('[NotionAdapter] Warning: No title property in new schema');
      }
    }
    
    this.mappings = mappings;
    this.schemaInitialized = true;
    
    debug('[NotionAdapter] Schema replaced');
  }
  
  /**
   * Get current schema info
   * 
   * Returns information about the current schema state.
   * 
   * @returns Schema info
   */
  getSchemaInfo(): {
    propertyCount: number;
    properties: Array<{ name: string; type: string; sourcePath: string }>;
    initialized: boolean;
    introspectionEnabled: boolean;
  } {
    return {
      propertyCount: this.mappings.length,
      properties: this.mappings.map(m => ({
        name: m.notionProperty,
        type: m.notionType,
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
   * Infer Notion property type from JavaScript value
   * 
   * @param fieldName - Field name (for context)
   * @param value - Value to infer type from
   * @returns Notion property type
   */
  private inferNotionPropertyType(fieldName: string, value: any): string {
    // null/undefined → rich_text (default)
    if (value === null || value === undefined) {
      return 'rich_text';
    }
    
    // Array → check for Notion files format first, then multi_select
    if (Array.isArray(value)) {
      // Detect Notion files format: [{ type: 'external', external: { url } }] or [{ type: 'file', file: { url } }]
      if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        const first = value[0];
        if (
          (first.type === 'external' && first.external?.url) ||
          (first.type === 'file' && first.file?.url)
        ) {
          return 'files';
        }
      }
      return 'multi_select';
    }
    
    // Boolean → checkbox
    if (typeof value === 'boolean') {
      return 'checkbox';
    }
    
    // Number → number
    if (typeof value === 'number') {
      return 'number';
    }
    
    // Date → date
    if (value instanceof Date) {
      return 'date';
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
        
        // Date string pattern (ISO 8601)
        if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
          return 'date';
        }
      }
      
      // Default: rich_text
      return 'rich_text';
    }
    
    // Object - check for date range
    if (typeof value === 'object') {
      if ('start' in value || 'end' in value) {
        return 'date';
      }
    }
    
    // Fallback
    return 'rich_text';
  }
  
  /**
   * Create missing fields in Notion database
   * 
   * @param fields - Map of field name → value (for type inference)
   * @returns Array of created field names
   */
  async createMissingFields(fields: Record<string, any>): Promise<string[]> {
    const createdFields: string[] = [];
    
    debug(`[NotionAdapter] Creating ${Object.keys(fields).length} missing fields...`);
    
    try {
      // Build property updates for all fields
      const propertyUpdates: Record<string, any> = {};
      
      for (const [fieldName, value] of Object.entries(fields)) {
        // Sanitize field name
        const sanitizedName = this.sanitizeFieldName(fieldName);
        
        // Infer type
        const inferredType = this.inferNotionPropertyType(sanitizedName, value);
        
        // Build property definition
        propertyUpdates[sanitizedName] = {
          [inferredType]: {}  // Type-specific config (empty for now)
        };
        
        debug(`[NotionAdapter]   - ${sanitizedName}: ${inferredType}`);
      }
      
      // Single API call to create all fields
      await this.client.updateDatabase({
        database_id: this.databaseId,
        properties: propertyUpdates
      } as any);
      
      // Add to mappings
      for (const [fieldName, value] of Object.entries(fields)) {
        const sanitizedName = this.sanitizeFieldName(fieldName);
        const inferredType = this.inferNotionPropertyType(sanitizedName, value);
        
        this.mappings.push({
          notionProperty: sanitizedName,
          sourcePath: fieldName,
          notionType: inferredType as any
        });
        
        createdFields.push(sanitizedName);
      }
      
      debug(`[NotionAdapter] ✅ Created ${createdFields.length} fields`);
    } catch (error) {
      console.error('[NotionAdapter] Failed to create fields:', error);
      throw new Error(
        `Failed to create fields in Notion: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    
    return createdFields;
  }
  
  /**
   * Sanitize field name for Notion
   * 
   * @param name - Raw field name
   * @returns Sanitized field name
   */
  private sanitizeFieldName(name: string): string {
    // Notion: 100 char limit, allow spaces and most chars
    return name
      .trim()
      .slice(0, 100);
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
    
    // Get all mapped source paths
    const mappedPaths = new Set(this.mappings.map(m => m.sourcePath));
    
    // Find fields in data that aren't mapped
    const unmapped: string[] = [];
    for (const field of Object.keys(data)) {
      if (!mappedPaths.has(field)) {
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
      'id', '_id', 'pmid', 'doi', 'uuid', 'key', 'uid', 'recordId',
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
          debug(`[NotionAdapter] Auto-detected ID field: '${field}'`);
          return field;
        }
      }
    }
    
    return null;
  }
}

/**
 * Create Notion database adapter
 * 
 * @param config - Adapter configuration
 * @returns NotionDatabaseAdapter
 * 
 * @example
 * ```typescript
 * const notion = createNotionAdapter({
 *   databaseId: 'your-database-id',
 *   mappings: [
 *     {
 *       notionProperty: 'Name',
 *       sourcePath: 'name',
 *       notionType: 'title',
 *       required: true,
 *     },
 *     {
 *       notionProperty: 'Email',
 *       sourcePath: 'contact.email',
 *       notionType: 'email',
 *     },
 *     {
 *       notionProperty: 'Tags',
 *       sourcePath: 'tags',
 *       notionType: 'multi_select',
 *     },
 *   ],
 * });
 * ```
 */
export function createNotionAdapter(config: NotionAdapterConfig): NotionDatabaseAdapter {
  return new NotionDatabaseAdapter(config);
}

