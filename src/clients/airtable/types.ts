/**
 * Airtable API Types
 * 
 * TypeScript types for the official Airtable REST API.
 * Based on: https://airtable.com/developers/web/api/introduction
 */

// ============================================================================
// Common Types
// ============================================================================

/**
 * Airtable record ID (starts with "rec")
 */
export type RecordId = string;

/**
 * Airtable table ID (starts with "tbl")
 */
export type TableId = string;

/**
 * Airtable base ID (starts with "app")
 */
export type BaseId = string;

/**
 * Airtable field ID (starts with "fld")
 */
export type FieldId = string;

/**
 * Airtable view ID (starts with "viw")
 */
export type ViewId = string;

/**
 * Airtable workspace ID (starts with "wsp")
 */
export type WorkspaceId = string;

/**
 * Airtable webhook ID (starts with "ach")
 */
export type WebhookId = string;

/**
 * ISO 8601 timestamp
 */
export type Timestamp = string;

// ============================================================================
// Field Value Types
// ============================================================================

/**
 * Possible cell values based on field type
 */
export type CellValue =
  | string
  | number
  | boolean
  | null
  | Attachment[]
  | Collaborator
  | Collaborator[]
  | RecordId[]
  | { id: string; name: string }
  | { specialValue: string }
  | unknown;

/**
 * Attachment object
 */
export interface Attachment {
  id: string;
  url: string;
  filename: string;
  size?: number;
  type?: string;
  width?: number;
  height?: number;
  thumbnails?: {
    small?: AttachmentThumbnail;
    large?: AttachmentThumbnail;
    full?: AttachmentThumbnail;
  };
}

export interface AttachmentThumbnail {
  url: string;
  width: number;
  height: number;
}

/**
 * Collaborator object
 */
export interface Collaborator {
  id: string;
  email?: string;
  name?: string;
}

/**
 * Record fields object
 */
export type RecordFields = Record<string, CellValue>;

// ============================================================================
// Record Types
// ============================================================================

/**
 * Airtable record object
 */
export interface AirtableRecord {
  id: RecordId;
  createdTime: Timestamp;
  fields: RecordFields;
}

/**
 * Record with comment count (when includeCommentCount is true)
 */
export interface AirtableRecordWithComments extends AirtableRecord {
  commentCount?: number;
}

/**
 * Record creation input
 */
export interface RecordCreate {
  fields: RecordFields;
}

/**
 * Record update input
 */
export interface RecordUpdate {
  id: RecordId;
  fields: RecordFields;
}

/**
 * Record patch input (PATCH method)
 */
export interface RecordPatch {
  id: RecordId;
  fields: RecordFields;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Paginated list response
 */
export interface ListResponse<T> {
  records: T[];
  offset?: string;
}

/**
 * Error response from Airtable API
 */
export interface AirtableError {
  error: {
    type: string;
    message: string;
  };
}

/**
 * Record deletion response
 */
export interface DeletedRecord {
  id: RecordId;
  deleted: boolean;
}

// ============================================================================
// Query Parameters
// ============================================================================

/**
 * List records query parameters
 */
export interface ListRecordsParams {
  /** Maximum number of records to return (1-100, default: 100) */
  pageSize?: number;
  
  /** Pagination offset from previous request */
  offset?: string;
  
  /** List of field names to include (empty = all fields) */
  fields?: string[];
  
  /** Airtable formula to filter records */
  filterByFormula?: string;
  
  /** Maximum total number of records to return */
  maxRecords?: number;
  
  /** List of sort objects */
  sort?: SortParameter[];
  
  /** View ID or name to use */
  view?: string;
  
  /** Cell format: 'json' or 'string' (default: 'json') */
  cellFormat?: 'json' | 'string';
  
  /** Time zone for date fields (default: 'utc') */
  timeZone?: string;
  
  /** User locale for date formatting (e.g., 'en-us') */
  userLocale?: string;
  
  /** Include comment count for each record */
  returnFieldsByFieldId?: boolean;
  
  /** Return field names as field IDs instead of names */
  recordMetadata?: ('commentCount')[];
}

/**
 * Sort parameter
 */
export interface SortParameter {
  field: string;
  direction?: 'asc' | 'desc';
}

/**
 * Get record query parameters
 */
export interface GetRecordParams {
  /** Return field names as field IDs */
  returnFieldsByFieldId?: boolean;
  
  /** Include comment count */
  recordMetadata?: ('commentCount')[];
}

/**
 * Create records options
 */
export interface CreateRecordsOptions {
  /** Return field names as field IDs */
  returnFieldsByFieldId?: boolean;
  
  /** Type cast cell values */
  typecast?: boolean;
}

/**
 * Update records options
 */
export interface UpdateRecordsOptions {
  /** Return field names as field IDs */
  returnFieldsByFieldId?: boolean;
  
  /** Type cast cell values */
  typecast?: boolean;
  
  /** Destructive update (PUT) vs partial update (PATCH) */
  method?: 'PUT' | 'PATCH';
}

/**
 * Delete records options
 */
export interface DeleteRecordsOptions {
  /** List of record IDs to delete */
  records: RecordId[];
}

// ============================================================================
// Field Types
// ============================================================================

/**
 * Field type names
 */
export type FieldType =
  | 'singleLineText'
  | 'email'
  | 'url'
  | 'multilineText'
  | 'number'
  | 'percent'
  | 'currency'
  | 'singleSelect'
  | 'multipleSelects'
  | 'singleCollaborator'
  | 'multipleCollaborators'
  | 'multipleRecordLinks'
  | 'date'
  | 'dateTime'
  | 'phoneNumber'
  | 'multipleAttachments'
  | 'checkbox'
  | 'formula'
  | 'createdTime'
  | 'rollup'
  | 'count'
  | 'lookup'
  | 'multipleLookupValues'
  | 'autoNumber'
  | 'barcode'
  | 'rating'
  | 'richText'
  | 'duration'
  | 'lastModifiedTime'
  | 'button'
  | 'createdBy'
  | 'lastModifiedBy'
  | 'externalSyncSource'
  | 'aiText';

/**
 * Field configuration
 */
export interface FieldConfig {
  type: FieldType;
  options?: Record<string, unknown>;
}

/**
 * Field schema
 */
export interface Field {
  id: FieldId;
  name: string;
  type: FieldType;
  description?: string;
  options?: Record<string, unknown>;
}

// ============================================================================
// Table Types
// ============================================================================

/**
 * Table configuration object
 */
export interface TableConfig {
  id: TableId;
  name: string;
  primaryFieldId: FieldId;
  description?: string;
  views: View[];
}

/**
 * Table model object (includes fields)
 */
export interface TableModel extends TableConfig {
  fields: Field[];
}

/**
 * View object
 */
export interface View {
  id: ViewId;
  name: string;
  type: string;
}

/**
 * Table creation input
 */
export interface TableCreate {
  name: string;
  description?: string;
  fields: FieldCreate[];
}

/**
 * Field creation input
 */
export interface FieldCreate {
  name: string;
  type: FieldType;
  description?: string;
  options?: Record<string, unknown>;
}

/**
 * Table update input
 */
export interface TableUpdate {
  name?: string;
  description?: string;
}

// ============================================================================
// Base Types
// ============================================================================

/**
 * Base object
 */
export interface Base {
  id: BaseId;
  name: string;
  permissionLevel: 'none' | 'read' | 'comment' | 'edit' | 'create';
}

/**
 * Base schema
 */
export interface BaseSchema {
  tables: TableModel[];
}

/**
 * Base creation input
 */
export interface BaseCreate {
  name: string;
  workspaceId: WorkspaceId;
  tables: TableCreate[];
}

// ============================================================================
// Webhook Types
// ============================================================================

/**
 * Webhook specification object
 */
export interface WebhookSpecification {
  options: {
    filters: {
      dataTypes: ('tableData' | 'tableFields' | 'tableMetadata')[];
      recordChangeScope?: string;
      sourceOptions?: {
        watchDataInFieldIds?: FieldId[];
        watchSchemaOfFieldIds?: FieldId[];
      };
      fromSources?: ('client' | 'publicApi' | 'formSubmission' | 'automation')[];
      watchSchemaChanges?: boolean;
    };
    includes?: {
      includeCellValuesInFieldIds?: 'all' | FieldId[];
      includePreviousCellValues?: boolean;
      includePreviousFieldDefinitions?: boolean;
    };
  };
}

/**
 * Webhook object
 */
export interface Webhook {
  id: WebhookId;
  macSecretBase64: string;
  expirationTime?: Timestamp;
  notificationUrl?: string;
  specification: WebhookSpecification;
  isHookEnabled?: boolean;
  lastSuccessfulNotificationTime?: Timestamp;
  lastNotificationResult?: {
    success: boolean;
    error?: {
      message: string;
    };
    completionTimestamp: Timestamp;
    durationMs: number;
    willBeRetried: boolean;
  };
  cursorForNextPayload?: number;
}

/**
 * Webhook creation input
 */
export interface WebhookCreate {
  notificationUrl: string;
  specification: WebhookSpecification;
}

/**
 * Webhook payload
 */
export interface WebhookPayload {
  baseTransactionNumber: number;
  actionMetadata: {
    source: 'client' | 'publicApi' | 'formSubmission' | 'automation';
    sourceMetadata?: Record<string, unknown>;
  };
  payloadFormat: 'v0';
  timestamp: Timestamp;
  changedTablesById?: Record<TableId, TableChanges>;
}

/**
 * Table changes in webhook payload
 */
export interface TableChanges {
  createdRecordsById?: Record<RecordId, RecordData>;
  changedRecordsById?: Record<RecordId, RecordChanges>;
  destroyedRecordIds?: RecordId[];
  createdFieldsById?: Record<FieldId, Field>;
  changedFieldsById?: Record<FieldId, FieldChanges>;
  destroyedFieldIds?: FieldId[];
  changedMetadata?: {
    current: {
      name: string;
      description?: string;
    };
    previous: {
      name: string;
      description?: string;
    };
  };
}

export interface RecordData {
  createdTime: Timestamp;
  cellValuesByFieldId: Record<FieldId, CellValue>;
}

export interface RecordChanges {
  current: {
    cellValuesByFieldId: Record<FieldId, CellValue>;
  };
  previous?: {
    cellValuesByFieldId: Record<FieldId, CellValue>;
  };
  unchanged?: {
    cellValuesByFieldId: Record<FieldId, CellValue>;
  };
}

export interface FieldChanges {
  current: Field;
  previous?: Field;
}

/**
 * Webhook payloads list response
 */
export interface WebhookPayloadsList {
  cursor: number;
  mightHaveMore: boolean;
  payloads: WebhookPayload[];
}

/**
 * Enable/disable webhook input
 */
export interface WebhookEnableDisable {
  enable: boolean;
}

// ============================================================================
// CSV Sync Types
// ============================================================================

/**
 * CSV sync options
 */
export interface CsvSyncOptions {
  csvData: string;
  contentType?: 'text/csv' | 'text/plain';
}

// ============================================================================
// Attachment Upload Types
// ============================================================================

/**
 * Attachment upload options
 */
export interface AttachmentUploadOptions {
  contentType: string;
  file: Blob | File | ArrayBuffer;
  filename: string;
}

/**
 * Attachment upload response
 */
export interface AttachmentUploadResponse {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
}

// ============================================================================
// API Client Configuration
// ============================================================================

/**
 * Airtable API client configuration
 */
export interface AirtableClientConfig {
  /** Personal Access Token or API Key */
  apiKey: string;
  
  /** Base API URL (default: https://api.airtable.com/v0) */
  baseUrl?: string;
  
  /** Request timeout in milliseconds */
  timeout?: number;
  
  /** Enable automatic retry on rate limit */
  retryOnRateLimit?: boolean;
  
  /** Maximum number of retries */
  maxRetries?: number;
}

/**
 * HTTP request options
 */
export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body string (for CSV, plain text, etc.) - overrides JSON serialization */
  rawBody?: string;
  /** Override base URL for this request (e.g., for content.airtable.com) */
  customBaseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Rate limit info
 */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

