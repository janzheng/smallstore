/**
 * Modern Notion API Wrapper
 *
 * This module provides direct access to the official Notion API client
 * with modern features like data sources, multi-source databases, etc.
 *
 * IMPORTANT: This is separate from NotionCoreLoader, which handles legacy
 * production code. This module uses the official API client directly.
 *
 * NOTE ON `as any` CASTS:
 * The Notion SDK v2/v5 TypeScript types are incomplete in several areas:
 *   - `page.properties` is not exposed on the union type returned by pages.retrieve/create
 *   - `client.dataSources` is only present in SDK v5+ and has no public types
 *   - `client.databases.query` was removed in SDK v5 but may exist at runtime
 *   - Response types for list/search are union types that don't expose `.results` directly
 * The `as any` casts below are intentional workarounds for these SDK gaps.
 * We use `NotionApiResponse` for the most common pattern (objects with .id, .results, etc).
 */

import { Client } from '@notionhq/client';
import {
  resolveNotionApiKey,
  resolveNotionVersion,
  cleanNotionId,
  formatNotionIdWithDashes
} from "./helpers.ts";
import {
  transformCreatePageParams,
  transformUpdatePageParams,
  transformCreateDatabaseParams,
  transformUpdateDatabaseParams,
} from "./notionTransformers.ts";
import { debug } from '../../utils/debug.ts';
import type {
  PageObjectResponse,
  PartialPageObjectResponse,
  DatabaseObjectResponse,
  PartialDatabaseObjectResponse,
  BlockObjectResponse,
  PartialBlockObjectResponse,
  QueryDataSourceResponse,
  GetDatabaseResponse,
  CreatePageParameters,
  UpdatePageParameters,
  CreateDatabaseParameters,
  UpdateDatabaseParameters,
} from '@notionhq/client/build/src/api-endpoints.d.ts';

/**
 * Helper type for Notion API responses that the SDK types don't fully expose.
 * Covers page objects (.id, .properties, .parent), database objects (.id, .data_sources),
 * and list responses (.results, .has_more, .next_cursor).
 */
type NotionApiResponse = {
  id?: string;
  properties?: Record<string, any>;
  parent?: Record<string, any>;
  data_sources?: Array<{ id: string; [key: string]: any }>;
  results?: any[];
  has_more?: boolean;
  next_cursor?: string | null;
  [key: string]: any;
};

export interface NotionModernClientOptions {
  notionSecret?: string;
  notionVersion?: string;
  keyResolver?: any; // KeyResolver from runner/utils/key-resolver.ts
  autoTransform?: boolean; // Auto-transform data to match Notion's schema (default: true)
}

/**
 * Modern Notion API Client
 * 
 * Provides direct access to the official Notion API with modern features.
 * This is separate from NotionCoreLoader for backward compatibility.
 * 
 * Supports flexible API key resolution from multiple sources:
 * 1. Direct options.notionSecret
 * 2. keyResolver (from headers/config)
 * 3. Environment variables
 */
export class NotionModernClient {
  private client: Client;
  private notionVersion: string;
  private autoTransform: boolean;
  private dataSourceCache: Map<string, string> = new Map();

  constructor(options: NotionModernClientOptions = {}) {
    // Resolve API key using helper (supports params > keyResolver > env)
    const secret = resolveNotionApiKey(options, options.keyResolver);
    
    // Resolve version using helper (optional, will use default if not found)
    const resolvedVersion = resolveNotionVersion(options, options.keyResolver);
    this.notionVersion = resolvedVersion || '2025-09-03'; // Latest version with multi-source databases
    
    // Auto-transform is enabled by default
    this.autoTransform = options.autoTransform !== false;
    
    this.client = new Client({ 
      auth: secret,
      notionVersion: this.notionVersion
    });
  }

  // ============================================================================
  // PAGES API
  // ============================================================================

  /**
   * Retrieve a page by ID
   */
  async getPage(page_id: string): Promise<PageObjectResponse | PartialPageObjectResponse> {
    const cleanId = formatNotionIdWithDashes(page_id);
    return await this.client.pages.retrieve({ page_id: cleanId });
  }

  /**
   * Create a new page
   */
  async createPage(params: CreatePageParameters): Promise<PageObjectResponse | PartialPageObjectResponse> {
    // Clean parent IDs
    let cleanedParams = this.cleanCreatePageParams(params);
    
    // Auto-transform properties if enabled
    if (this.autoTransform) {
      cleanedParams = transformCreatePageParams(cleanedParams);
    }
    
    const page = await this.client.pages.create(cleanedParams);
    
    // Normalize the response for API v2025-09-03+
    // The API returns parent.type = "data_source_id" but tools expect "database_id"
    const isNewApiVersion = this.notionVersion >= '2025-09-03';
    const pageResponse = page as NotionApiResponse;
    if (isNewApiVersion && pageResponse.parent) {
      const parent = pageResponse.parent;
      if (parent.type === 'data_source_id' && parent.data_source_id) {
        // Normalize to database_id format for backward compatibility
        pageResponse.parent = {
          type: 'database_id',
          database_id: parent.data_source_id
        };
      }
    }
    
    return page;
  }

  /**
   * Update a page
   */
  async updatePage(params: UpdatePageParameters): Promise<PageObjectResponse | PartialPageObjectResponse> {
    let cleanedParams = {
      ...params,
      page_id: formatNotionIdWithDashes(params.page_id)
    };
    
    // Auto-transform properties if enabled
    if (this.autoTransform) {
      cleanedParams = transformUpdatePageParams(cleanedParams);
    }
    
    return await this.client.pages.update(cleanedParams);
  }

  /**
   * Archive a page (soft delete)
   */
  async archivePage(page_id: string): Promise<PageObjectResponse | PartialPageObjectResponse> {
    const cleanId = formatNotionIdWithDashes(page_id);
    return await this.client.pages.update({
      page_id: cleanId,
      in_trash: true
    } as any);
  }

  /**
   * Restore a trashed page
   */
  async restorePage(page_id: string): Promise<PageObjectResponse | PartialPageObjectResponse> {
    const cleanId = formatNotionIdWithDashes(page_id);
    return await this.client.pages.update({
      page_id: cleanId,
      in_trash: false
    } as any);
  }

  // ============================================================================
  // DATABASES API (Modern)
  // ============================================================================

  /**
   * Retrieve a database by ID
   */
  async getDatabase(database_id: string): Promise<GetDatabaseResponse> {
    const cleanId = formatNotionIdWithDashes(database_id);
    return await this.client.databases.retrieve({ database_id: cleanId });
  }

  /**
   * Resolve a database_id to its primary data_source_id (API v2025-09-03+).
   * In v5, databases are containers holding one or more data sources; queries target
   * the data source, not the database. For backwards compat we accept a database_id
   * here and look up its first data source, caching the result.
   * If the input is already a data_source_id, `databases.retrieve` will 404 — callers
   * should fall through to the raw-id path in that case.
   */
  private async resolveDataSourceId(database_id: string): Promise<string | null> {
    const cleanId = formatNotionIdWithDashes(database_id);
    const cached = this.dataSourceCache.get(cleanId);
    if (cached) return cached;

    try {
      const db = await this.client.databases.retrieve({ database_id: cleanId }) as NotionApiResponse;
      const dsId = db.data_sources?.[0]?.id;
      if (dsId) {
        this.dataSourceCache.set(cleanId, dsId);
        return dsId;
      }
    } catch {
      // retrieve failed — likely the caller passed a data_source_id, not a database_id
    }
    return null;
  }

  /**
   * Query a database (uses dataSources.query in API v5+)
   * Note: In Notion API v5+, query moved from databases to dataSources
   * Supports URLs, prefixed IDs, and UUIDs with/without dashes
   */
  async queryDatabase(params: {
    database_id: string;
    filter?: any;
    sorts?: any[];
    start_cursor?: string;
    page_size?: number;
  }): Promise<QueryDataSourceResponse> {
    const cleanId = formatNotionIdWithDashes(params.database_id);

    // SDK v5+ removed databases.query; it's now dataSources.query.
    // For older API versions (< 2025), dataSources endpoint doesn't exist server-side,
    // so we fall back to a raw POST to /v1/databases/{id}/query.
    const useDataSources = this.notionVersion >= '2025-01-01' && (this.client as any).dataSources?.query;

    if (useDataSources) {
      // v5 split databases (containers) from data sources (tables). Resolve the
      // database_id to its first data_source_id; fall back to the raw id if the
      // caller already passed a data_source_id.
      const dataSourceId = (await this.resolveDataSourceId(cleanId)) ?? cleanId;
      return await (this.client as any).dataSources.query({
        data_source_id: dataSourceId,
        filter: params.filter,
        sorts: params.sorts,
        start_cursor: params.start_cursor,
        page_size: params.page_size,
      });
    } else if ((this.client as any).databases?.query) {
      // SDK v4 path
      return await (this.client as any).databases.query({
        database_id: cleanId,
        filter: params.filter,
        sorts: params.sorts,
        start_cursor: params.start_cursor,
        page_size: params.page_size,
      });
    } else {
      // SDK v5+ with older API version: raw HTTP fallback
      const body: Record<string, any> = {};
      if (params.filter) body.filter = params.filter;
      if (params.sorts) body.sorts = params.sorts;
      if (params.start_cursor) body.start_cursor = params.start_cursor;
      if (params.page_size) body.page_size = params.page_size;

      return await (this.client as any).request({
        path: `databases/${cleanId}/query`,
        method: 'post',
        body,
      });
    }
  }

  /**
   * Create a new database
   * 
   * NOTE: In API v2025-09-03+, databases and data sources are separate.
   * This method creates a database, then updates its data source with properties.
   * For older API versions, it creates the database with properties directly.
   */
  async createDatabase(params: CreateDatabaseParameters): Promise<DatabaseObjectResponse | PartialDatabaseObjectResponse> {
    // Clean parent IDs
    let cleanedParams: any = this.cleanCreateDatabaseParams(params);
    
    // Auto-transform database properties schema if enabled
    // This adds missing 'type' fields to property definitions
    if (this.autoTransform) {
      cleanedParams = transformCreateDatabaseParams(cleanedParams);
      
      // Debug logging - check for debug flag
      if (Deno.env?.get?.('DEBUG_NOTION_TRANSFORM')) {
        debug('[NotionModern] Auto-transform applied to createDatabase');
        debug('[NotionModern] Transformed properties:', JSON.stringify(cleanedParams.properties, null, 2));
      }
    }
    
    // Check API version to handle data sources correctly
    const isNewApiVersion = this.notionVersion >= '2025-09-03';
    
    if (isNewApiVersion && cleanedParams.properties) {
      // API v5+: Create database first, then update data source with properties
      const { properties, ...dbParamsWithoutProps } = cleanedParams;
      
      // Create database (gets a default data source with "Name" title property)
      const database = await this.client.databases.create(dbParamsWithoutProps as any);

      // Get the auto-created data source ID
      const dbResponse = database as NotionApiResponse;
      const dataSourceId = dbResponse.data_sources?.[0]?.id;
      
      const propertyErrors: string[] = [];

      if (dataSourceId && properties) {
        // Remove Title property if it exists (data source already has one called "Name")
        const { Title, ...propertiesWithoutTitle } = properties as any;

        // If user provided a "Title" property, rename the default "Name" to match
        if (Title) {
          try {
            await (this.client as any).dataSources.update({
              data_source_id: dataSourceId,
              properties: {
                "Name": {
                  name: "Title",
                  type: "title",
                  title: {}
                },
                ...propertiesWithoutTitle
              }
            } as any);
          } catch (error: any) {
            // Fallback: try adding just the other properties without title rename
            try {
              await (this.client as any).dataSources.update({
                data_source_id: dataSourceId,
                properties: propertiesWithoutTitle
              } as any);
              // Title rename failed but other properties succeeded
              propertyErrors.push(`Failed to rename "Name" to "Title": ${error?.message || error}`);
            } catch (err2: any) {
              propertyErrors.push(`Failed to set database properties: ${err2?.message || err2}`);
            }
          }
        } else {
          // No Title property, just add the others
          try {
            await (this.client as any).dataSources.update({
              data_source_id: dataSourceId,
              properties: propertiesWithoutTitle
            } as any);
          } catch (error: any) {
            propertyErrors.push(`Failed to add properties to data source: ${error?.message || error}`);
          }
        }
      }

      // Log accumulated property errors at error level
      if (propertyErrors.length > 0) {
        console.error('[NotionModern] Database created but property setup had errors:', propertyErrors);
      }

      // Return database with normalized structure for backward compatibility
      // For API v2025-09-03+, also include the data_source_id for createPage operations
      const result: any = {
        ...database,
        id: database.id,  // Database ID
      };

      // Add data_source_id as a convenience field for creating pages
      if (dataSourceId) {
        result.data_source_id = dataSourceId;
      }

      // Include property errors in result so callers can detect partial failures
      if (propertyErrors.length > 0) {
        result._propertyErrors = propertyErrors;
      }

      return result;
    } else {
      // Older API versions: create database with properties directly
      return await this.client.databases.create(cleanedParams);
    }
  }

  /**
   * Update a database
   */
  async updateDatabase(params: UpdateDatabaseParameters): Promise<DatabaseObjectResponse | PartialDatabaseObjectResponse> {
    let cleanedParams = {
      ...params,
      database_id: formatNotionIdWithDashes(params.database_id)
    };
    
    // Auto-transform database properties schema if enabled
    if (this.autoTransform) {
      cleanedParams = transformUpdateDatabaseParams(cleanedParams);
    }
    
    return await this.client.databases.update(cleanedParams);
  }

  // ============================================================================
  // DATA SOURCES API (Modern - Multi-source databases)
  // ============================================================================

  /**
   * Query a data source (modern multi-source database API)
   * This is the newer API that supports multiple linked data sources
   */
  async queryDataSource(params: {
    data_source_id: string;
    filter?: any;
    sorts?: any[];
    start_cursor?: string;
    page_size?: number;
  }): Promise<QueryDataSourceResponse> {
    const cleanedParams = {
      ...params,
      data_source_id: formatNotionIdWithDashes(params.data_source_id)
    };
    return await (this.client as any).dataSources.query(cleanedParams);
  }

  /**
   * List all data sources
   * Note: This method may not be available in all API versions
   */
  async listDataSources(): Promise<any> {
    // dataSources.list() doesn't exist in the current API
    // If you need to list data sources, you may need to search for them
    throw new Error('listDataSources is not available in the current Notion API. Use search() to find data sources instead.');
  }

  /**
   * Get a specific data source
   * Supports URLs, prefixed IDs, and UUIDs with/without dashes
   */
  async getDataSource(dataSourceId: string): Promise<any> {
    const cleanId = formatNotionIdWithDashes(dataSourceId);
    return await (this.client as any).dataSources.retrieve({ data_source_id: cleanId });
  }

  // ============================================================================
  // BLOCKS API
  // ============================================================================

  /**
   * Retrieve a block by ID
   */
  async getBlock(block_id: string): Promise<BlockObjectResponse | PartialBlockObjectResponse> {
    const cleanId = formatNotionIdWithDashes(block_id);
    return await this.client.blocks.retrieve({ block_id: cleanId });
  }

  /**
   * List block children
   */
  async listBlockChildren(params: {
    block_id: string;
    start_cursor?: string;
    page_size?: number;
  }): Promise<QueryDataSourceResponse> {
    const cleanedParams = {
      ...params,
      block_id: formatNotionIdWithDashes(params.block_id)
    };
    const response = await this.client.blocks.children.list(cleanedParams);
    // Convert the response to match QueryDataSourceResponse format
    return response as any;
  }

  /**
   * Append children to a block.
   *
   * Accepts either:
   * - `after: string` — legacy block-id form (deprecated in SDK v5 but still works)
   * - `position: { type: "after_block", after_block: { id } } | { type: "start" } | { type: "end" }`
   *   — v5 form, more expressive (start/end options)
   *
   * If both are supplied, `position` wins. Positioning only applies to the
   * first batch when chunking; subsequent batches append to the end naturally.
   */
  async appendBlockChildren(params: {
    block_id: string;
    children: any[];
    after?: string;
    position?:
      | { type: "after_block"; after_block: { id: string } }
      | { type: "start" }
      | { type: "end" };
  }): Promise<QueryDataSourceResponse> {
    const blockId = formatNotionIdWithDashes(params.block_id);
    const afterId = params.after ? formatNotionIdWithDashes(params.after) : undefined;
    const cleanedPosition = params.position?.type === "after_block"
      ? { type: "after_block" as const, after_block: { id: formatNotionIdWithDashes(params.position.after_block.id) } }
      : params.position;

    const firstPositionArg: Record<string, unknown> = {};
    if (cleanedPosition) firstPositionArg.position = cleanedPosition;
    else if (afterId) firstPositionArg.after = afterId;

    // Notion API limit: max 100 blocks per append call
    const NOTION_BLOCK_LIMIT = 100;
    if (params.children.length <= NOTION_BLOCK_LIMIT) {
      const response = await this.client.blocks.children.append({
        block_id: blockId,
        children: params.children,
        ...firstPositionArg,
      } as any);
      return response as any;
    }

    // Split into chunks of 100 — position/after only applies to the first batch
    let lastResponse: any;
    for (let i = 0; i < params.children.length; i += NOTION_BLOCK_LIMIT) {
      const batch = params.children.slice(i, i + NOTION_BLOCK_LIMIT);
      lastResponse = await this.client.blocks.children.append({
        block_id: blockId,
        children: batch,
        ...(i === 0 ? firstPositionArg : {}),
      } as any);
    }
    return lastResponse as any;
  }

  /**
   * Update a block
   */
  async updateBlock(params: {
    block_id: string;
    [key: string]: any;
  }): Promise<BlockObjectResponse | PartialBlockObjectResponse> {
    const cleanedParams = {
      ...params,
      block_id: formatNotionIdWithDashes(params.block_id)
    };
    return await this.client.blocks.update(cleanedParams);
  }

  /**
   * Delete a block
   */
  async deleteBlock(block_id: string): Promise<BlockObjectResponse | PartialBlockObjectResponse> {
    const cleanId = formatNotionIdWithDashes(block_id);
    return await this.client.blocks.update({
      block_id: cleanId,
      in_trash: true
    } as any);
  }

  // ============================================================================
  // USERS API
  // ============================================================================

  /**
   * List all users
   */
  async listUsers(params?: {
    start_cursor?: string;
    page_size?: number;
  }): Promise<QueryDataSourceResponse> {
    const response = await this.client.users.list(params || {});
    // Convert the response to match QueryDataSourceResponse format
    return response as any;
  }

  /**
   * Retrieve a user by ID
   */
  async getUser(user_id: string): Promise<any> {
    const cleanId = formatNotionIdWithDashes(user_id);
    return await this.client.users.retrieve({ user_id: cleanId });
  }

  // ============================================================================
  // SEARCH API
  // ============================================================================

  /**
   * Search across all pages and databases
   */
  async search(params?: {
    query?: string;
    filter?: {
      value: 'page' | 'database';
      property: 'object';
    };
    sort?: {
      direction: 'ascending' | 'descending';
      timestamp: 'last_edited_time';
    };
    start_cursor?: string;
    page_size?: number;
  }): Promise<QueryDataSourceResponse> {
    const response = await this.client.search(params as any || {});
    // Convert the response to match QueryDataSourceResponse format
    return response as any;
  }

  // ============================================================================
  // COMMENTS API
  // ============================================================================

  /**
   * List comments for a block
   */
  async listComments(params: {
    block_id: string;
    start_cursor?: string;
    page_size?: number;
  }): Promise<QueryDataSourceResponse> {
    const cleanedParams = {
      ...params,
      block_id: formatNotionIdWithDashes(params.block_id)
    };
    const response = await this.client.comments.list(cleanedParams);
    // Convert the response to match QueryDataSourceResponse format
    return response as any;
  }

  /**
   * Create a comment
   */
  async createComment(params: {
    parent: {
      page_id?: string;
      block_id?: string;
    };
    discussion_id?: string;
    rich_text: any[];
  }): Promise<any> {
    // Ensure parent has at least one of page_id or block_id
    if (!params.parent.page_id && !params.parent.block_id) {
      throw new Error('Either page_id or block_id must be provided in parent');
    }
    
    // Clean parent IDs
    const cleanedParent: any = {};
    if (params.parent.page_id) {
      cleanedParent.page_id = formatNotionIdWithDashes(params.parent.page_id);
    }
    if (params.parent.block_id) {
      cleanedParent.block_id = formatNotionIdWithDashes(params.parent.block_id);
    }
    
    // Create the comment params - if discussion_id is provided, it's required
    const commentParams: any = {
      parent: cleanedParent,
      rich_text: params.rich_text,
    };
    
    if (params.discussion_id) {
      commentParams.discussion_id = params.discussion_id;
    }
    
    return await this.client.comments.create(commentParams);
  }

  // ============================================================================
  // PRIVATE HELPER METHODS
  // ============================================================================

  /**
   * Clean IDs in createPage parameters
   */
  private cleanCreatePageParams(params: CreatePageParameters): CreatePageParameters {
    const cleaned: any = { ...params };
    
    // Clean parent IDs based on type
    if (params.parent) {
      if ('page_id' in params.parent && params.parent.page_id) {
        cleaned.parent = {
          type: 'page_id',
          page_id: formatNotionIdWithDashes(params.parent.page_id)
        };
      } else if ('database_id' in params.parent && params.parent.database_id) {
        cleaned.parent = {
          type: 'database_id',
          database_id: formatNotionIdWithDashes(params.parent.database_id)
        };
      }
      // workspace parent doesn't need cleaning
    }
    
    return cleaned;
  }

  /**
   * Clean IDs in createDatabase parameters
   */
  private cleanCreateDatabaseParams(params: CreateDatabaseParameters): CreateDatabaseParameters {
    const cleaned: any = { ...params };
    
    // Clean parent IDs based on type
    if (params.parent) {
      // Handle page_id parent
      if ('page_id' in params.parent && params.parent.page_id) {
        cleaned.parent = {
          type: 'page_id',
          page_id: formatNotionIdWithDashes(params.parent.page_id)
        };
      }
      // Handle workspace parent - ensure correct structure
      else if ('workspace' in params.parent && params.parent.workspace) {
        cleaned.parent = {
          type: 'workspace',
          workspace: true
        };
      }
      // Handle legacy format where type might be provided incorrectly
      else if ((params.parent as any).type === 'page_id') {
        // User might have provided { type: 'page_id', page_id: 'xxx' }
        // This is already correct format, just clean the ID
        cleaned.parent = {
          type: 'page_id',
          page_id: formatNotionIdWithDashes((params.parent as any).page_id)
        };
      }
    }
    
    return cleaned;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Get the underlying Notion client for advanced usage
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * Get the current API version
   */
  getApiVersion(): string {
    return this.notionVersion;
  }

  /**
   * Check if auto-transform is enabled
   */
  isAutoTransformEnabled(): boolean {
    return this.autoTransform;
  }

  /**
   * Enable or disable auto-transform
   */
  setAutoTransform(enabled: boolean): void {
    this.autoTransform = enabled;
  }

  /**
   * Utility: Clean a Notion ID from various formats
   * Exposed for convenience when working with external IDs
   */
  cleanId(idOrUrl: string): string {
    return cleanNotionId(idOrUrl);
  }

  /**
   * Utility: Format a Notion ID with dashes (8-4-4-4-12)
   * Exposed for convenience when working with external IDs
   */
  formatIdWithDashes(idOrUrl: string): string {
    return formatNotionIdWithDashes(idOrUrl);
  }
}

/**
 * Factory function to create a modern Notion client
 */
export function createNotionModernClient(options?: NotionModernClientOptions): NotionModernClient {
  return new NotionModernClient(options);
}

// Re-export utility functions for convenience
export { cleanNotionId, formatNotionIdWithDashes, isValidNotionId } from "./helpers.ts";

// Re-export transformer utilities for advanced usage
export {
  transformProperties,
  transformCreatePageParams,
  transformUpdatePageParams,
  transformCreateDatabaseParams,
  transformUpdateDatabaseParams,
  transformDatabaseProperties,
  transformers,
} from "./notionTransformers.ts";

