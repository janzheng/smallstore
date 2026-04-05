/**
 * Airtable Records API
 * 
 * Handles record-level CRUD operations:
 * - List records
 * - Get record
 * - Create records
 * - Update records (with upsert support)
 * - Delete records
 * - Sync CSV data
 * - Upload attachments
 * 
 * @see https://airtable.com/developers/web/api/list-records
 */

import type { AirtableClient } from "./client.ts";

/**
 * Record fields (flexible structure)
 */
export type RecordFields = Record<string, any>;

/**
 * Airtable record
 */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: RecordFields;
  /** 
   * Number of comments on the record (only included if recordMetadata includes "commentCount")
   */
  commentCount?: number;
}

/**
 * List records response
 */
export interface ListRecordsResponse {
  records: AirtableRecord[];
  offset?: string;
}

/**
 * List records options
 */
export interface ListRecordsOptions {
  /** Fields to include in response */
  fields?: string[];
  
  /** Filter by formula */
  filterByFormula?: string;
  
  /** Maximum number of records to return */
  maxRecords?: number;
  
  /** Number of records per page (max 100) */
  pageSize?: number;
  
  /** Sort records */
  sort?: Array<{
    field: string;
    direction?: 'asc' | 'desc';
  }>;
  
  /** View to use */
  view?: string;
  
  /** Cell format (default: json) */
  cellFormat?: 'json' | 'string';
  
  /** Time zone for date fields (required when cellFormat is 'string') */
  timeZone?: string;
  
  /** User locale for date formatting (required when cellFormat is 'string') */
  userLocale?: string;
  
  /** Pagination offset */
  offset?: string;
  
  /** 
   * Return field objects keyed by field ID instead of field name.
   * Defaults to false (returns fields keyed by name).
   */
  returnFieldsByFieldId?: boolean;
  
  /** 
   * Include additional record metadata.
   * Currently supports "commentCount" to include comment count on each record.
   */
  recordMetadata?: Array<'commentCount'>;
}

/**
 * Create/Update record request
 */
export interface RecordData {
  fields: RecordFields;
}

/**
 * Batch create request
 */
export interface BatchRecordsRequest {
  records: RecordData[];
  /** Enable automatic type conversion */
  typecast?: boolean;
  /** Return fields keyed by field ID instead of field name */
  returnFieldsByFieldId?: boolean;
}

/**
 * Single record create request
 */
export interface SingleRecordRequest {
  fields: RecordFields;
  /** Enable automatic type conversion */
  typecast?: boolean;
  /** Return fields keyed by field ID instead of field name */
  returnFieldsByFieldId?: boolean;
}

/**
 * Batch create response
 */
export interface BatchRecordsResponse {
  records: AirtableRecord[];
  /** Partial success details */
  details?: PartialSuccessDetails;
}

/**
 * Single record create response
 */
export interface SingleRecordResponse extends AirtableRecord {
  /** Partial success details */
  details?: PartialSuccessDetails;
}

/**
 * Update record with ID
 */
export interface UpdateRecordData extends RecordData {
  id: string;
}

/**
 * Batch update request
 */
export interface BatchUpdateRequest {
  records: UpdateRecordData[];
  typecast?: boolean;
}

/**
 * Delete records response
 */
export interface DeleteRecordsResponse {
  records: Array<{
    id: string;
    /** Always true for successfully deleted records */
    deleted: true;
  }>;
}

/**
 * Sync CSV data response
 */
export interface SyncCSVResponse {
  /** Always true for successful sync */
  success: true;
}

/**
 * Upload attachment request
 */
export interface UploadAttachmentRequest {
  /** Content type, e.g. "image/jpeg" */
  contentType: string;
  /** Base64 encoded string of the file to be uploaded */
  file: string;
  /** Filename, e.g. "foo.jpg" */
  filename: string;
}

/**
 * Upload attachment response
 * Note: Fields are keyed by field ID (not field name)
 */
export interface UploadAttachmentResponse {
  id: string;
  createdTime: string;
  /** Cell values keyed by field ID */
  fields: RecordFields;
}

/**
 * Get record options
 */
export interface GetRecordOptions {
  /** Cell format (default: json) */
  cellFormat?: 'json' | 'string';
  
  /** Time zone for date fields (required when cellFormat is 'string') */
  timeZone?: string;
  
  /** User locale for date formatting (required when cellFormat is 'string') */
  userLocale?: string;
  
  /** 
   * Return field objects keyed by field ID instead of field name.
   * Defaults to false (returns fields keyed by name).
   */
  returnFieldsByFieldId?: boolean;
}

/**
 * Upsert configuration for update operations
 */
export interface PerformUpsert {
  /**
   * Field names or IDs to use as external ID for matching records.
   * Must be 1-3 fields. These cannot be computed fields (formulas, lookups, rollups).
   * Valid field types: number, text, long text, single select, multiple select, date.
   */
  fieldsToMergeOn: string[];
}

/**
 * Update record data (with optional ID for upserts)
 */
export interface UpsertRecordData {
  /** Record ID (optional when performUpsert is set) */
  id?: string;
  fields: RecordFields;
}

/**
 * Batch update/upsert request
 */
export interface BatchUpsertRequest {
  records: UpsertRecordData[];
  /** Enable upsert behavior */
  performUpsert?: PerformUpsert;
  /** Enable automatic type conversion */
  typecast?: boolean;
  /** Return fields keyed by field ID instead of field name */
  returnFieldsByFieldId?: boolean;
}

/**
 * Partial success details
 */
export interface PartialSuccessDetails {
  message: 'partialSuccess';
  reasons: Array<'attachmentsFailedUploading' | 'attachmentUploadRateIsTooHigh'>;
}

/**
 * Batch update/upsert response
 */
export interface BatchUpsertResponse {
  records: AirtableRecord[];
  /** Record IDs created by upsert (only present for upsert requests) */
  createdRecords?: string[];
  /** Record IDs updated by upsert (only present for upsert requests) */
  updatedRecords?: string[];
  /** Partial success details */
  details?: PartialSuccessDetails;
}

/**
 * Airtable Records API
 * 
 * Requirements:
 * - Authentication: Personal access token, OAuth integration, or API key
 * - Scope: data.records:read (for read), data.records:write (for write)
 * - Billing: All plans
 */
export class RecordsAPI {
  constructor(private client: AirtableClient) {}

  /**
   * List records
   * 
   * Lists records in a table with optional filtering, sorting, and pagination.
   * 
   * The server returns one page of records at a time (pageSize, max 100 by default).
   * Use the offset parameter to fetch subsequent pages.
   * 
   * Returned records do not include fields with "empty" values (e.g., "", [], false).
   * 
   * Note: Airtable's API only accepts requests with URLs shorter than 16,000 characters.
   * If your encoded formulas or parameters exceed this limit, use listRecordsPost() instead.
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name (table IDs recommended to avoid breaks on rename)
   * @param options - Query options (filtering, sorting, pagination, etc.)
   * @returns List of records with optional pagination offset
   * 
   * @see https://airtable.com/developers/web/api/list-records
   */
  async list(
    baseId: string,
    tableIdOrName: string,
    options?: ListRecordsOptions
  ): Promise<ListRecordsResponse> {
    return this.client.get<ListRecordsResponse>(
      `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
      options as any
    );
  }

  /**
   * List records (POST version)
   * 
   * Alternative to list() that uses POST with parameters in the request body.
   * Use this when your URL would exceed 16,000 characters (e.g., complex formulas).
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param options - Query options (filtering, sorting, pagination, etc.)
   * @returns List of records with optional pagination offset
   * 
   * @see https://airtable.com/developers/web/api/list-records
   */
  async listRecordsPost(
    baseId: string,
    tableIdOrName: string,
    options?: ListRecordsOptions
  ): Promise<ListRecordsResponse> {
    return this.client.post<ListRecordsResponse>(
      `/${baseId}/${encodeURIComponent(tableIdOrName)}/listRecords`,
      options || {}
    );
  }

  /**
   * Get record by ID
   * 
   * Retrieves a single record by its ID. Any "empty" fields (e.g., "", [], false)
   * will not be returned.
   * 
   * Note: If the record is not found in the specified table, Airtable will perform
   * a base-wide search and return the record if the ID is valid within the base.
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param recordId - Record ID
   * @param options - Query options (cellFormat, returnFieldsByFieldId, etc.)
   * @returns Record data
   * 
   * @see https://airtable.com/developers/web/api/get-record
   */
  async get(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
    options?: GetRecordOptions
  ): Promise<AirtableRecord> {
    return this.client.get<AirtableRecord>(
      `/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}`,
      options as any
    );
  }

  /**
   * Create records
   * 
   * Creates one or more records (up to 10 per request).
   * 
   * Supports two request formats:
   * 1. Batch: `{ records: [...], typecast?, returnFieldsByFieldId? }`
   * 2. Single: `{ fields: {...}, typecast?, returnFieldsByFieldId? }`
   * 
   * The API will return an array of records for batch creation, or a single
   * record object for single record creation.
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name (table IDs recommended)
   * @param request - Records to create (batch or single format)
   * @returns Created records (array or single, depending on request format)
   * 
   * @see https://airtable.com/developers/web/api/create-records
   */
  async create(
    baseId: string,
    tableIdOrName: string,
    request: BatchRecordsRequest | SingleRecordRequest
  ): Promise<BatchRecordsResponse | SingleRecordResponse> {
    // Check if this is a single record request (has 'fields' at top level)
    if ('fields' in request && !('records' in request)) {
      return this.client.post<SingleRecordResponse>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        request
      );
    }

    // Batch request — split into chunks of 10 (Airtable limit)
    const batchRequest = request as BatchRecordsRequest;
    if (batchRequest.records.length <= 10) {
      return this.client.post<BatchRecordsResponse>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        request
      );
    }

    const allRecords: AirtableRecord[] = [];
    const allDetails: string[] = [];
    for (let i = 0; i < batchRequest.records.length; i += 10) {
      const chunk = batchRequest.records.slice(i, i + 10);
      const resp = await this.client.post<BatchRecordsResponse>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        { ...batchRequest, records: chunk }
      );
      allRecords.push(...resp.records);
      if (resp.details) {
        allDetails.push(...(Array.isArray(resp.details) ? resp.details : [resp.details as any]));
      }
    }
    return {
      records: allRecords,
      details: allDetails.length ? allDetails as any : undefined,
    };
  }

  /**
   * Create single record
   * 
   * Convenience method for creating a single record using the batch format.
   * Returns the created record directly (not wrapped in an array).
   * 
   * Note: You can also use create() with a SingleRecordRequest for the API's
   * native single record format.
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param fields - Record fields
   * @param typecast - Enable automatic type conversion
   * @param returnFieldsByFieldId - Return fields keyed by field ID
   * @returns Created record
   */
  async createOne(
    baseId: string,
    tableIdOrName: string,
    fields: RecordFields,
    typecast = false,
    returnFieldsByFieldId = false
  ): Promise<AirtableRecord> {
    const response = await this.create(baseId, tableIdOrName, {
      records: [{ fields }],
      typecast,
      returnFieldsByFieldId,
    }) as BatchRecordsResponse;
    return response.records[0];
  }

  /**
   * Update records
   * 
   * Updates one or more records (up to 10 per request).
   * PATCH will only update the fields included in the request; other fields remain unchanged.
   * 
   * Supports upsert behavior when performUpsert is set:
   * - Records without ID will use fieldsToMergeOn to match existing records
   * - If no match: creates new record
   * - If one match: updates that record
   * - If multiple matches: request fails
   * - Records with ID will update normally (ignoring fieldsToMergeOn)
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param request - Records to update (supports upsert)
   * @returns Updated records (with createdRecords/updatedRecords for upserts)
   * 
   * @see https://airtable.com/developers/web/api/update-records
   */
  async update(
    baseId: string,
    tableIdOrName: string,
    request: BatchUpdateRequest | BatchUpsertRequest
  ): Promise<BatchUpsertResponse> {
    // Split into chunks of 10 (Airtable limit)
    if (request.records.length <= 10) {
      return this.client.patch<BatchUpsertResponse>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        request
      );
    }

    const allRecords: AirtableRecord[] = [];
    const allDetails: string[] = [];
    const allCreated: string[] = [];
    const allUpdated: string[] = [];
    for (let i = 0; i < request.records.length; i += 10) {
      const chunk = request.records.slice(i, i + 10);
      const resp = await this.client.patch<BatchUpsertResponse>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        { ...request, records: chunk }
      );
      allRecords.push(...resp.records);
      if (resp.details) {
        allDetails.push(...(Array.isArray(resp.details) ? resp.details : [resp.details as any]));
      }
      if (resp.createdRecords) allCreated.push(...resp.createdRecords);
      if (resp.updatedRecords) allUpdated.push(...resp.updatedRecords);
    }
    return {
      records: allRecords,
      details: allDetails.length ? allDetails as any : undefined,
      ...(allCreated.length ? { createdRecords: allCreated } : {}),
      ...(allUpdated.length ? { updatedRecords: allUpdated } : {}),
    };
  }

  /**
   * Update single record
   * 
   * Convenience method for updating a single record.
   * Only updates the fields included in the request; other fields remain unchanged.
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param recordId - Record ID
   * @param fields - Fields to update
   * @param typecast - Enable automatic type conversion
   * @returns Updated record
   */
  async updateOne(
    baseId: string,
    tableIdOrName: string,
    recordId: string,
    fields: RecordFields,
    typecast = false
  ): Promise<AirtableRecord> {
    const response = await this.update(baseId, tableIdOrName, {
      records: [{ id: recordId, fields }],
      typecast,
    });
    return response.records[0];
  }

  /**
   * Upsert records
   * 
   * Updates existing records or creates new ones based on fieldsToMergeOn.
   * This is a convenience wrapper around update() with performUpsert enabled.
   * 
   * For records without an ID:
   * - Uses fieldsToMergeOn fields as external ID to match records
   * - Creates new record if no match found
   * - Updates record if one match found
   * - Fails if multiple matches found
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param records - Records to upsert (ID optional)
   * @param fieldsToMergeOn - Field names/IDs to use for matching (1-3 fields)
   * @param typecast - Enable automatic type conversion
   * @returns Upserted records with createdRecords/updatedRecords arrays
   * 
   * @see https://airtable.com/developers/web/api/update-records
   */
  async upsert(
    baseId: string,
    tableIdOrName: string,
    records: UpsertRecordData[],
    fieldsToMergeOn: string[],
    typecast = false
  ): Promise<BatchUpsertResponse> {
    return this.update(baseId, tableIdOrName, {
      records,
      performUpsert: { fieldsToMergeOn },
      typecast,
    });
  }

  /**
   * Replace records
   * 
   * Replaces all fields in one or more records (up to 10 per request).
   * PUT will perform a destructive update - fields not included will be cleared.
   * 
   * Supports upsert behavior when performUpsert is set:
   * - Records without ID will use fieldsToMergeOn to match existing records
   * - If no match: creates new record
   * - If one match: replaces that record (clearing unspecified fields)
   * - If multiple matches: request fails
   * - Records with ID will replace normally (ignoring fieldsToMergeOn)
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param request - Records to replace (supports upsert)
   * @returns Replaced records (with createdRecords/updatedRecords for upserts)
   * 
   * @see https://airtable.com/developers/web/api/update-records
   */
  async replace(
    baseId: string,
    tableIdOrName: string,
    request: BatchUpdateRequest | BatchUpsertRequest
  ): Promise<BatchUpsertResponse> {
    return this.client.put<BatchUpsertResponse>(
      `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
      request
    );
  }

  /**
   * Delete records
   * 
   * Deletes one or more records (up to 10 per request) given an array of record IDs.
   * 
   * The record IDs are passed as query parameters in the format:
   * `?records[]=recId1&records[]=recId2&...`
   * 
   * Each deleted record will be confirmed in the response with `deleted: true`.
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param recordIds - Array of record IDs to delete (up to 10)
   * @returns Deleted record confirmations (each with id and deleted: true)
   * 
   * @see https://airtable.com/developers/web/api/delete-records
   */
  async delete(
    baseId: string,
    tableIdOrName: string,
    recordIds: string[]
  ): Promise<DeleteRecordsResponse> {
    // Split into chunks of 10 (Airtable limit)
    if (recordIds.length <= 10) {
      const params = { records: recordIds };
      return this.client.delete<DeleteRecordsResponse>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        params
      );
    }

    const allRecords: Array<{ id: string; deleted: true }> = [];
    const allDetails: string[] = [];
    for (let i = 0; i < recordIds.length; i += 10) {
      const chunk = recordIds.slice(i, i + 10);
      const params = { records: chunk };
      const resp = await this.client.delete<DeleteRecordsResponse & { details?: any }>(
        `/${baseId}/${encodeURIComponent(tableIdOrName)}`,
        params
      );
      allRecords.push(...resp.records);
      if (resp.details) {
        allDetails.push(...(Array.isArray(resp.details) ? resp.details : [resp.details]));
      }
    }
    return {
      records: allRecords,
      ...(allDetails.length ? { details: allDetails as any } : {}),
    } as DeleteRecordsResponse;
  }

  /**
   * Delete single record
   * 
   * Deletes a single record using the dedicated single-record DELETE endpoint.
   * This uses the path format: `/{baseId}/{tableIdOrName}/{recordId}`
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param recordId - Record ID to delete
   * @returns Deletion confirmation (id and deleted: true)
   * 
   * @see https://airtable.com/developers/web/api/delete-record
   */
  async deleteOne(
    baseId: string,
    tableIdOrName: string,
    recordId: string
  ): Promise<{ id: string; deleted: true }> {
    return this.client.delete<{ id: string; deleted: true }>(
      `/${baseId}/${encodeURIComponent(tableIdOrName)}/${recordId}`
    );
  }

  /**
   * Sync CSV data
   * 
   * Syncs raw CSV data into a Sync API table. You must first set up a sync from
   * a base (see Airtable support article for instructions). The apiEndpointSyncId
   * can be found in the setup flow when creating a new Sync API table, or from
   * the synced table settings.
   * 
   * Limitations:
   * - CSV can contain up to 10,000 rows
   * - CSV can contain up to 500 columns
   * - HTTP request size is limited to 2 MB
   * - Up to 10,000 rows will be synced per sync run
   * - Rate limit: 20 requests per 5 minutes per base
   * 
   * Requirements:
   * - Authentication: Personal access token
   * - Scopes: data.records:write, schema.bases:write
   * - User role: Base creator
   * - Billing: Pro, Enterprise (pre-2023.08 legacy plan), Enterprise Scale
   * 
   * @param baseId - Base ID
   * @param tableIdOrName - Table ID or name
   * @param apiEndpointSyncId - Sync API endpoint ID from table setup
   * @param csvData - Raw CSV data as string (with headers)
   * @returns Success confirmation
   * 
   * @see https://airtable.com/developers/web/api/sync-csv-data
   */
  async syncCSV(
    baseId: string,
    tableIdOrName: string,
    apiEndpointSyncId: string,
    csvData: string
  ): Promise<SyncCSVResponse> {
    return this.client.request<SyncCSVResponse>(
      `/${baseId}/${encodeURIComponent(tableIdOrName)}/sync/${apiEndpointSyncId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/csv',
        },
        rawBody: csvData,
      } as any
    );
  }

  /**
   * Upload attachment
   * 
   * Uploads an attachment up to 5 MB to an attachment cell via file bytes directly.
   * 
   * This endpoint uses a different base URL: https://content.airtable.com/v0
   * 
   * For attachments above 5 MB that are accessible by a public URL, they can be
   * added using the standard field update methods with the multipleAttachment field type.
   * 
   * Note: The response will have fields keyed by field ID (not field name).
   * 
   * Requirements:
   * - Authentication: Personal access token, OAuth integration
   * - Scope: data.records:write
   * - User role: Base editor
   * - Billing: All plans
   * - Max file size: 5 MB
   * 
   * @param baseId - Base ID
   * @param recordId - Record ID
   * @param attachmentFieldIdOrName - Attachment field ID or name
   * @param request - Upload request with file data, content type, and filename
   * @returns Updated record with fields keyed by field ID
   * 
   * @see https://airtable.com/developers/web/api/upload-attachment
   */
  async uploadAttachment(
    baseId: string,
    recordId: string,
    attachmentFieldIdOrName: string,
    request: UploadAttachmentRequest
  ): Promise<UploadAttachmentResponse> {
    return this.client.request<UploadAttachmentResponse>(
      `/${baseId}/${recordId}/${encodeURIComponent(attachmentFieldIdOrName)}/uploadAttachment`,
      {
        method: 'POST',
        body: request,
        customBaseUrl: 'https://content.airtable.com/v0',
      } as any
    );
  }
}

/**
 * Create a Records API instance
 */
export function createRecordsAPI(client: AirtableClient): RecordsAPI {
  return new RecordsAPI(client);
}

