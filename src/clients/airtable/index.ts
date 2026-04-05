/**
 * Airtable API Client
 * 
 * Complete TypeScript wrapper for the Airtable REST API.
 * 
 * ## Structure
 * 
 * - `client.ts` - Low-level HTTP client with auth, rate limiting, retries
 * - `bases.ts` - Base-level operations (list, schema, create)
 * - `tables.ts` - Table-level operations (create, update)
 * - `fields.ts` - Field-level operations (create, update)
 * - `records.ts` - Record-level CRUD operations
 * 
 * ## Usage
 * 
 * ```typescript
 * import { createAirtable } from "./airtable/index.ts";
 * 
 * const airtable = createAirtable({
 *   apiKey: 'patYourToken...',
 * });
 * 
 * // Bases API
 * const bases = await airtable.bases.list();
 * const schema = await airtable.bases.getSchema('appXXX');
 * 
 * // Tables API
 * const table = await airtable.tables.create('appXXX', {
 *   name: 'My Table',
 *   fields: [...]
 * });
 * 
 * // Fields API
 * const field = await airtable.fields.create('appXXX', 'tblXXX', {
 *   name: 'My Field',
 *   type: 'singleLineText'
 * });
 * 
 * // Records API
 * const records = await airtable.records.list('appXXX', 'tblXXX');
 * const record = await airtable.records.createOne('appXXX', 'tblXXX', {
 *   Name: 'Test'
 * });
 * ```
 * 
 * ## API Coverage
 * 
 * ### Bases API ✅
 * - ✅ List bases
 * - ✅ Get base schema
 * - ✅ Create base
 * 
 * ### Tables API ✅
 * - ✅ Create table
 * - ✅ Update table
 * 
 * ### Fields API ✅
 * - ✅ Create field
 * - ✅ Update field
 * 
 * ### Records API ✅
 * - ✅ List records
 * - ✅ Get record
 * - ✅ Create records
 * - ✅ Update records
 * - ✅ Replace records (PUT)
 * - ✅ Delete records
 * 
 * ## Requirements
 * 
 * ### Authentication
 * - Personal Access Token (PAT) - Recommended
 * - OAuth integration
 * - API Key (being deprecated by Airtable)
 * 
 * ### Scopes (for PATs)
 * - `data.records:read` - Read records
 * - `data.records:write` - Create/update/delete records
 * - `schema.bases:read` - Read base/table/field schemas
 * - `schema.bases:write` - Create/modify bases/tables/fields
 * 
 * ### Billing
 * - All features available on all plans
 * 
 * @see https://airtable.com/developers/web/api/introduction
 */

// Core client
import { 
  AirtableClient, 
  AirtableApiError,
  createAirtableClient,
  createAirtableClientFromResolver 
} from "./client.ts";

export { 
  AirtableClient, 
  AirtableApiError,
  createAirtableClient,
  createAirtableClientFromResolver 
};

export type {
  AirtableClientConfig,
  RequestOptions,
  RateLimitInfo,
  AirtableError,
} from "./types.ts";

// Bases API
import { 
  BasesAPI, 
  createBasesAPI 
} from "./bases.ts";

export { 
  BasesAPI, 
  createBasesAPI 
};

export type {
  AirtableBase,
  ListBasesResponse,
  FieldDefinition,
  ViewDefinition,
  TableSchema,
  GetBaseSchemaResponse,
  TableConfig,
  CreateBaseRequest,
  CreateBaseResponse,
} from "./bases.ts";

// Tables API
import { 
  TablesAPI, 
  createTablesAPI 
} from "./tables.ts";

export { 
  TablesAPI, 
  createTablesAPI 
};

export type {
  CreateTableRequest,
  UpdateTableRequest,
} from "./tables.ts";

// Fields API
import { 
  FieldsAPI, 
  createFieldsAPI 
} from "./fields.ts";

export { 
  FieldsAPI, 
  createFieldsAPI 
};

export type {
  CreateFieldRequest,
  UpdateFieldRequest,
} from "./fields.ts";

// Records API
import { 
  RecordsAPI, 
  createRecordsAPI 
} from "./records.ts";

export { 
  RecordsAPI, 
  createRecordsAPI 
};

export type {
  RecordFields,
  AirtableRecord,
  ListRecordsResponse,
  ListRecordsOptions,
  RecordData,
  BatchRecordsRequest,
  BatchRecordsResponse,
  UpdateRecordData,
  BatchUpdateRequest,
  DeleteRecordsResponse,
} from "./records.ts";

/**
 * Unified Airtable API client
 */
export interface Airtable {
  /** Low-level HTTP client */
  client: AirtableClient;
  
  /** Bases API */
  bases: BasesAPI;
  
  /** Tables API */
  tables: TablesAPI;
  
  /** Fields API */
  fields: FieldsAPI;
  
  /** Records API */
  records: RecordsAPI;
}

/**
 * Create a unified Airtable API client
 * 
 * @param config - Client configuration with API key
 * @returns Unified API client with all endpoints
 * 
 * @example
 * ```typescript
 * const airtable = createAirtable({
 *   apiKey: 'patYourToken...',
 * });
 * 
 * // Use any API
 * const bases = await airtable.bases.list();
 * const records = await airtable.records.list('appXXX', 'tblXXX');
 * ```
 */
export function createAirtable(config: { apiKey: string; timeout?: number }): Airtable {
  const client = createAirtableClient(config.apiKey, {
    ...(config.timeout !== undefined && { timeout: config.timeout }),
  });
  
  return {
    client,
    bases: createBasesAPI(client),
    tables: createTablesAPI(client),
    fields: createFieldsAPI(client),
    records: createRecordsAPI(client),
  };
}

/**
 * Create Airtable client from keyResolver context
 * 
 * @param keyResolver - KeyResolver instance
 * @param config - Additional client configuration
 * @returns Unified API client or null if keys not found
 */
export function createAirtableFromResolver(
  keyResolver?: any,
  config?: { timeout?: number }
): Airtable | null {
  if (!keyResolver) {
    return null;
  }

  const apiKey = keyResolver.getKey?.('AIRTABLE_PRIVATE_API') || 
                 keyResolver.getKey?.('AIRTABLE_API_KEY');

  if (!apiKey) {
    return null;
  }

  return createAirtable({ apiKey, ...config });
}

// Note: Default export removed to avoid circular reference issues.
// Import named exports directly instead:
// import { createAirtable, createAirtableClient, ... } from "./airtable/index.ts";

