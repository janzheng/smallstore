/**
 * Airtable Tables API
 * 
 * Handles table-level operations:
 * - Create table
 * - Update table
 * 
 * Note: Table listing is handled by the Bases API (getSchema)
 * 
 * @see https://airtable.com/developers/web/api/create-table
 */

import type { AirtableClient } from "./client.ts";
import type { TableSchema, TableConfig } from "./bases.ts";

/**
 * Create table request
 */
export interface CreateTableRequest {
  name: string;
  description?: string;
  fields: Array<{
    name: string;
    type: string;
    description?: string;
    options?: Record<string, any>;
  }>;
}

/**
 * Update table request
 */
export interface UpdateTableRequest {
  name?: string;
  description?: string;
}

/**
 * Airtable Tables API
 * 
 * Requirements:
 * - Authentication: Personal access token or OAuth integration
 * - Scope: schema.bases:write
 * - Billing: All plans
 */
export class TablesAPI {
  constructor(private client: AirtableClient) {}

  /**
   * Create table
   * 
   * Creates a new table in the specified base.
   * 
   * Requirements:
   * - At least one field must be specified
   * - First field becomes the primary field (must be a supported primary field type)
   * - Field names must be case-insensitive unique within the table
   * 
   * @param baseId - Base ID
   * @param request - Table creation request
   * @returns Created table schema
   * 
   * @see https://airtable.com/developers/web/api/create-table
   */
  async create(baseId: string, request: CreateTableRequest): Promise<TableSchema> {
    return this.client.post<TableSchema>(
      `/meta/bases/${baseId}/tables`,
      request
    );
  }

  /**
   * Update table
   * 
   * Updates table name and/or description.
   * 
   * @param baseId - Base ID
   * @param tableId - Table ID
   * @param request - Table update request
   * @returns Updated table schema
   * 
   * @see https://airtable.com/developers/web/api/update-table
   */
  async update(
    baseId: string,
    tableId: string,
    request: UpdateTableRequest
  ): Promise<TableSchema> {
    return this.client.patch<TableSchema>(
      `/meta/bases/${baseId}/tables/${tableId}`,
      request
    );
  }
}

/**
 * Create a Tables API instance
 */
export function createTablesAPI(client: AirtableClient): TablesAPI {
  return new TablesAPI(client);
}

