/**
 * Airtable Bases API
 * 
 * Handles base-level operations:
 * - List bases
 * - Get base schema
 * - Create base
 * 
 * @see https://airtable.com/developers/web/api/list-bases
 * @see https://airtable.com/developers/web/api/get-base-schema
 * @see https://airtable.com/developers/web/api/create-base
 */

import type { AirtableClient } from "./client.ts";

/**
 * Permission level for a base
 */
export type PermissionLevel = "none" | "read" | "comment" | "edit" | "create";

/**
 * Base information
 */
export interface AirtableBase {
  /** Base ID, a unique identifier for a base */
  id: string;
  /** Base name */
  name: string;
  /** Permission level for the authenticated user */
  permissionLevel: PermissionLevel;
}

/**
 * List bases response
 * 
 * Returns up to 1000 bases at a time.
 * Use the offset for pagination if more bases are available.
 */
export interface ListBasesResponse {
  /** Array of bases the token can access */
  bases: AirtableBase[];
  /** 
   * Pagination offset for the next page of results.
   * If present, pass as ?offset=... query parameter to get next page.
   * Example: "itr23sEjsdfEr3282/appSW9R5uCNmRmfl6"
   */
  offset?: string;
}

/**
 * Table field definition
 */
export interface FieldDefinition {
  /** Field ID */
  id: string;
  /** Field name */
  name: string;
  /** Field type (e.g., "singleLineText", "multipleAttachments", "multipleRecordLinks") */
  type: string;
  /** Field description */
  description?: string;
  /** Field-specific options based on type */
  options?: Record<string, any>;
}

/**
 * Table view definition
 */
export interface ViewDefinition {
  /** View ID */
  id: string;
  /** View name */
  name: string;
  /** View type (e.g., "grid", "form", "calendar") */
  type: string;
  /** 
   * Visible field IDs in the view (grid views only).
   * Only included when requested via ?include=visibleFieldIds query parameter.
   */
  visibleFieldIds?: string[];
}

/**
 * Table schema (Table model)
 */
export interface TableSchema {
  /** Table ID */
  id: string;
  /** Table name */
  name: string;
  /** Table description */
  description?: string;
  /** Primary field ID - the first field in the table */
  primaryFieldId: string;
  /** Array of field definitions */
  fields: FieldDefinition[];
  /** Array of view definitions */
  views: ViewDefinition[];
}

/**
 * Get base schema response
 * 
 * Returns an array of table models with their fields and views.
 */
export interface GetBaseSchemaResponse {
  /** Array of table schemas in the base */
  tables: TableSchema[];
}

/**
 * Field configuration for table creation
 */
export interface FieldConfig {
  /** Field name (required) - must be case-insensitive unique within the table */
  name: string;
  /** Field type (required) - must be a supported writable field type */
  type: string;
  /** Field description (optional) */
  description?: string;
  /** Field-specific options based on type (optional) */
  options?: Record<string, any>;
}

/**
 * Table configuration for base creation (Table Config)
 * 
 * Note: The first field in the fields array will be used as the table's 
 * primary field and must be a supported primary field type.
 * A default grid view will be created with all fields visible.
 */
export interface TableConfig {
  /** Table name (required) */
  name: string;
  /** Table description (optional) */
  description?: string;
  /** 
   * Array of field configurations (required, at least one field).
   * First field becomes the primary field - must be a supported primary field type.
   * Field names must be case-insensitive unique within the table.
   */
  fields: FieldConfig[];
}

/**
 * Create base request
 * 
 * At least one table and field must be specified.
 */
export interface CreateBaseRequest {
  /** The name for the new base (required) */
  name: string;
  /** The workspace where the base will be created (required) */
  workspaceId: string;
  /** 
   * A list of table configurations (required, at least one table).
   * Each table will have a default grid view created with all fields visible.
   */
  tables: TableConfig[];
}

/**
 * Create base response
 * 
 * Returns the base ID and full schema of created tables with generated IDs.
 */
export interface CreateBaseResponse {
  /** Base ID, a unique identifier for the newly created base */
  id: string;
  /** Array of table models with generated IDs, fields, and views */
  tables: TableSchema[];
}

/**
 * Airtable Bases API
 * 
 * Requirements:
 * - Authentication: Personal access token or OAuth integration
 * - Scope: schema.bases:read (for list/get), schema.bases:write (for create)
 * - Billing: All plans
 */
export class BasesAPI {
  constructor(private client: AirtableClient) {}

  /**
   * List bases
   * 
   * GET https://api.airtable.com/v0/meta/bases
   * 
   * Returns the list of bases the token can access, 1000 bases at a time.
   * If there is another page to request, pass the offset as a URL query parameter.
   * 
   * Requirements:
   * - Authentication: Personal access token or OAuth integration
   * - Scope: schema.bases:read
   * - User role: Base read-only
   * - Billing: All plans
   * 
   * @param offset - Pagination offset (optional). Pass the offset from previous response.
   *                 Example: "itr23sEjsdfEr3282/appSW9R5uCNmRmfl6"
   * @returns List of bases with optional pagination offset for next page
   * 
   * @example
   * ```ts
   * // First page
   * const response = await basesAPI.list();
   * console.log(response.bases); // Array of up to 1000 bases
   * 
   * // Next page if offset is present
   * if (response.offset) {
   *   const nextPage = await basesAPI.list(response.offset);
   * }
   * 
   * // Response example:
   * // {
   * //   "bases": [
   * //     { "id": "appLkNDICXNqxSDhG", "name": "Apartment Hunting", "permissionLevel": "create" },
   * //     { "id": "appSW9R5uCNmRmfl6", "name": "Project Tracker", "permissionLevel": "edit" }
   * //   ],
   * //   "offset": "itr23sEjsdfEr3282/appSW9R5uCNmRmfl6"
   * // }
   * ```
   * 
   * @see https://airtable.com/developers/web/api/list-bases
   */
  async list(offset?: string): Promise<ListBasesResponse> {
    const params = offset ? { offset } : undefined;
    return this.client.get<ListBasesResponse>('/meta/bases', params);
  }

  /**
   * Get base schema
   * 
   * GET https://api.airtable.com/v0/meta/bases/{baseId}/tables
   * 
   * Returns the schema of the tables in the specified base.
   * 
   * Requirements:
   * - Authentication: Personal access token or OAuth integration
   * - Scope: schema.bases:read
   * - User role: Base read-only
   * - Billing: All plans
   * 
   * @param baseId - Base ID
   * @param includeVisibleFieldIds - If true, includes visibleFieldIds in views (grid views only).
   *                                 Pass as ?include=visibleFieldIds query parameter.
   * @returns Base schema with array of table models
   * 
   * @example
   * ```ts
   * // Get base schema without visible field IDs
   * const schema = await basesAPI.getSchema('appLkNDICXNqxSDhG');
   * console.log(schema.tables); // Array of tables with fields and views
   * 
   * // Get base schema with visible field IDs (for grid views)
   * const schemaWithFields = await basesAPI.getSchema('appLkNDICXNqxSDhG', true);
   * console.log(schemaWithFields.tables[0].views[0].visibleFieldIds); // Array of field IDs
   * 
   * // Response example:
   * // {
   * //   "tables": [
   * //     {
   * //       "id": "tbltp8DGLhqbUmjK1",
   * //       "name": "Apartments",
   * //       "description": "Apartments to track.",
   * //       "primaryFieldId": "fld1VnoyuotSTyxW1",
   * //       "fields": [
   * //         {
   * //           "id": "fld1VnoyuotSTyxW1",
   * //           "name": "Name",
   * //           "type": "singleLineText",
   * //           "description": "Name of the apartment"
   * //         },
   * //         {
   * //           "id": "fldoaIqdn5szURHpw",
   * //           "name": "Pictures",
   * //           "type": "multipleAttachments",
   * //           "options": { "isReversed": false }
   * //         }
   * //       ],
   * //       "views": [
   * //         {
   * //           "id": "viwQpsuEDqHFqegkp",
   * //           "name": "Grid view",
   * //           "type": "grid"
   * //         }
   * //       ]
   * //     }
   * //   ]
   * // }
   * ```
   * 
   * @see https://airtable.com/developers/web/api/get-base-schema
   */
  async getSchema(
    baseId: string,
    includeVisibleFieldIds = false
  ): Promise<GetBaseSchemaResponse> {
    const params = includeVisibleFieldIds 
      ? { include: ['visibleFieldIds'] } 
      : undefined;
    
    return this.client.get<GetBaseSchemaResponse>(
      `/meta/bases/${baseId}/tables`,
      params
    );
  }

  /**
   * Create base
   * 
   * POST https://api.airtable.com/v0/meta/bases
   * 
   * Creates a new base with the provided tables and returns the schema 
   * for the newly created base.
   * 
   * Requirements:
   * - Authentication: Personal access token or OAuth integration
   * - Scope: schema.bases:write
   * - User role: Workspace creator
   * - Billing: All plans
   * - At least one table and field must be specified
   * - First field becomes the primary field (must be a supported primary field type)
   * - Field names must be case-insensitive unique within the table
   * - A default grid view is created for each table with all fields visible
   * 
   * Refer to field types for supported field types and write format for field options.
   * 
   * @param request - Base creation request with name, workspaceId, and tables
   * @returns Created base with ID and full table schemas (with generated IDs)
   * 
   * @example
   * ```ts
   * const newBase = await basesAPI.create({
   *   name: "Apartment Hunting",
   *   workspaceId: "wspmhESAta6clCCwF",
   *   tables: [
   *     {
   *       name: "Apartments",
   *       description: "A to-do list of places to visit",
   *       fields: [
   *         {
   *           name: "Name",
   *           type: "singleLineText",
   *           description: "Name of the apartment"
   *         },
   *         {
   *           name: "Address",
   *           type: "singleLineText"
   *         },
   *         {
   *           name: "Visited",
   *           type: "checkbox",
   *           options: {
   *             color: "greenBright",
   *             icon: "check"
   *           }
   *         }
   *       ]
   *     }
   *   ]
   * });
   * 
   * // Returns:
   * // {
   * //   "id": "appLkNDICXNqxSDhG",
   * //   "tables": [
   * //     {
   * //       "id": "tbltp8DGLhqbUmjK1",
   * //       "name": "Apartments",
   * //       "description": "A to-do list of places to visit",
   * //       "primaryFieldId": "fld1VnoyuotSTyxW1",
   * //       "fields": [
   * //         {
   * //           "id": "fld1VnoyuotSTyxW1",
   * //           "name": "Name",
   * //           "type": "singleLineText",
   * //           "description": "Name of the apartment"
   * //         },
   * //         {
   * //           "id": "fldoi0c3GaRQJ3xnI",
   * //           "name": "Address",
   * //           "type": "singleLineText"
   * //         },
   * //         {
   * //           "id": "fldumZe00w09RYTW6",
   * //           "name": "Visited",
   * //           "type": "checkbox",
   * //           "options": {
   * //             "color": "redBright",
   * //             "icon": "star"
   * //           }
   * //         }
   * //       ],
   * //       "views": [
   * //         {
   * //           "id": "viwQpsuEDqHFqegkp",
   * //           "name": "Grid view",
   * //           "type": "grid"
   * //         }
   * //       ]
   * //     }
   * //   ]
   * // }
   * ```
   * 
   * @see https://airtable.com/developers/web/api/create-base
   */
  async create(request: CreateBaseRequest): Promise<CreateBaseResponse> {
    return this.client.post<CreateBaseResponse>('/meta/bases', request);
  }
}

/**
 * Create a Bases API instance
 */
export function createBasesAPI(client: AirtableClient): BasesAPI {
  return new BasesAPI(client);
}

