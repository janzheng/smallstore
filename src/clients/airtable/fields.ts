/**
 * Airtable Fields API
 * 
 * Handles field-level operations:
 * - Create field
 * - Update field
 * - Field types and cell value formats
 * 
 * @see https://airtable.com/developers/web/api/create-field
 * @see https://airtable.com/developers/web/api/field-model
 */

import type { AirtableClient } from "./client.ts";
import type { FieldDefinition } from "./bases.ts";

// ============================================================================
// Base Field Types
// ============================================================================

export type FieldType =
  | "aiText"
  | "multipleAttachments"
  | "autoNumber"
  | "barcode"
  | "button"
  | "checkbox"
  | "singleCollaborator"
  | "count"
  | "createdBy"
  | "createdTime"
  | "currency"
  | "date"
  | "dateTime"
  | "duration"
  | "email"
  | "formula"
  | "lastModifiedBy"
  | "lastModifiedTime"
  | "multipleRecordLinks"
  | "multilineText"
  | "multipleLookupValues"
  | "multipleCollaborators"
  | "multipleSelects"
  | "number"
  | "percent"
  | "phoneNumber"
  | "rating"
  | "richText"
  | "rollup"
  | "singleLineText"
  | "singleSelect"
  | "externalSyncSource"
  | "url";

export type SelectColor =
  | "blueLight2" | "cyanLight2" | "tealLight2" | "greenLight2" | "yellowLight2" | "orangeLight2" | "redLight2" | "pinkLight2" | "purpleLight2" | "grayLight2"
  | "blueLight1" | "cyanLight1" | "tealLight1" | "greenLight1" | "yellowLight1" | "orangeLight1" | "redLight1" | "pinkLight1" | "purpleLight1" | "grayLight1"
  | "blueBright" | "cyanBright" | "tealBright" | "greenBright" | "yellowBright" | "orangeBright" | "redBright" | "pinkBright" | "purpleBright" | "grayBright"
  | "blueDark1" | "cyanDark1" | "tealDark1" | "greenDark1" | "yellowDark1" | "orangeDark1" | "redDark1" | "pinkDark1" | "purpleDark1" | "grayDark1";

export type CheckboxColor = "greenBright" | "tealBright" | "cyanBright" | "blueBright" | "purpleBright" | "pinkBright" | "redBright" | "orangeBright" | "yellowBright" | "grayBright";

export type CheckboxIcon = "check" | "xCheckbox" | "star" | "heart" | "thumbsUp" | "flag" | "dot";

export type RatingColor = "yellowBright" | "orangeBright" | "redBright" | "pinkBright" | "purpleBright" | "blueBright" | "cyanBright" | "tealBright" | "greenBright" | "grayBright";

export type RatingIcon = "star" | "heart" | "thumbsUp" | "flag" | "dot";

export type Timezone = string; // IANA timezone string like "America/Los_Angeles"

export type PermissionLevel = "none" | "read" | "comment" | "edit" | "create";

// ============================================================================
// Cell Value Types
// ============================================================================

/**
 * AI Text cell value (read only)
 */
export type AITextCellValue = 
  | {
      state: "empty" | "loading" | "generated";
      isStale: boolean;
      value: string | null;
    }
  | {
      state: "error";
      errorType: string;
      isStale: boolean;
      value: string | null;
    };

/**
 * Attachment object
 */
export interface AttachmentObject {
  id: string;
  type: string;
  filename: string;
  height?: number;
  size: number;
  url: string;
  width?: number;
  thumbnails?: {
    small?: { url: string; height: number; width: number };
    large?: { url: string; height: number; width: number };
    full?: { url: string; height: number; width: number };
  };
}

/**
 * Attachment cell value (write)
 */
export type AttachmentWriteValue = 
  | { url: string; filename?: string }
  | { id: string };

/**
 * Barcode cell value
 */
export interface BarcodeCellValue {
  type?: string | null;
  text: string;
}

/**
 * Button cell value (read only)
 */
export interface ButtonCellValue {
  label: string;
  url: string | null;
}

/**
 * Collaborator object
 */
export interface CollaboratorObject {
  id: string;
  email?: string;
  name?: string;
  permissionLevel?: PermissionLevel;
  profilePicUrl?: string;
}

/**
 * Collaborator write value
 */
export type CollaboratorWriteValue = 
  | { id: string }
  | { email: string };

/**
 * Select option (read)
 */
export interface SelectOption {
  id: string;
  name: string;
  color?: SelectColor;
}

/**
 * Select option (write)
 */
export interface SelectOptionWrite {
  id?: string;
  name: string;
  color?: SelectColor;
}

/**
 * Select option (webhooks v2)
 */
export interface SelectOptionWebhook {
  id: string;
  name: string;
  color?: SelectColor;
}

/**
 * Link to another record (webhooks v2)
 */
export interface LinkedRecordWebhook {
  id: string;
  name: string;
}

/**
 * Lookup cell value (webhooks v2)
 */
export interface LookupCellValueWebhook {
  valuesByLinkedRecordId: Record<string, any[]>;
  linkedRecordIds: string[];
}

/**
 * Sync source (webhooks v2)
 */
export interface SyncSourceWebhook {
  id: string;
  name: string;
  color?: SelectColor;
}

// ============================================================================
// Field Options Types
// ============================================================================

/**
 * AI Text field options
 */
export interface AITextOptions {
  prompt?: Array<string | { field: { fieldId: string } }>;
  referencedFieldIds?: string[];
}

/**
 * Multiple attachments field options
 */
export interface MultipleAttachmentsOptions {
  isReversed: boolean;
}

/**
 * Checkbox field options
 */
export interface CheckboxOptions {
  color: CheckboxColor;
  icon: CheckboxIcon;
}

/**
 * Count field options
 */
export interface CountOptions {
  isValid: boolean;
  recordLinkFieldId?: string | null;
}

/**
 * Date format
 */
export interface DateFormat {
  name: "local" | "friendly" | "us" | "european" | "iso";
  format?: "l" | "LL" | "M/D/YYYY" | "D/M/YYYY" | "YYYY-MM-DD";
}

/**
 * Time format
 */
export interface TimeFormat {
  name: "12hour" | "24hour";
  format?: "h:mma" | "HH:mm";
}

/**
 * Date field options
 */
export interface DateOptions {
  dateFormat: DateFormat;
}

/**
 * DateTime field options
 */
export interface DateTimeOptions {
  timeZone: Timezone;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

/**
 * Duration format
 */
export type DurationFormat = "h:mm" | "h:mm:ss" | "h:mm:ss.S" | "h:mm:ss.SS" | "h:mm:ss.SSS";

/**
 * Duration field options
 */
export interface DurationOptions {
  durationFormat: DurationFormat;
}

/**
 * Formula field options
 */
export interface FormulaOptions {
  formula: string;
  isValid: boolean;
  referencedFieldIds: string[] | null;
  result: FieldTypeConfig | null;
}

/**
 * Currency field options
 */
export interface CurrencyOptions {
  precision: number; // 0-7
  symbol: string;
}

/**
 * Number field options
 */
export interface NumberOptions {
  precision: number; // 0-8
}

/**
 * Percent field options
 */
export interface PercentOptions {
  precision: number; // 0-8
}

/**
 * Rating field options
 */
export interface RatingOptions {
  color: RatingColor;
  icon: RatingIcon;
  max: number; // 1-10
}

/**
 * Single select field options
 */
export interface SingleSelectOptions {
  choices: SelectOption[];
}

/**
 * Single select field options (write)
 */
export interface SingleSelectOptionsWrite {
  choices: SelectOptionWrite[];
}

/**
 * Multiple selects field options
 */
export interface MultipleSelectsOptions {
  choices: SelectOption[];
}

/**
 * Multiple selects field options (write)
 */
export interface MultipleSelectsOptionsWrite {
  choices: SelectOptionWrite[];
}

/**
 * Multiple record links field options
 */
export interface MultipleRecordLinksOptions {
  isReversed: boolean;
  linkedTableId: string;
  prefersSingleRecordLink: boolean;
  inverseLinkFieldId?: string;
  viewIdForRecordSelection?: string;
}

/**
 * Multiple record links field options (write)
 */
export interface MultipleRecordLinksOptionsWrite {
  linkedTableId: string;
  viewIdForRecordSelection?: string;
}

/**
 * Multiple lookup values field options
 */
export interface MultipleLookupValuesOptions {
  fieldIdInLinkedTable: string | null;
  isValid: boolean;
  recordLinkFieldId: string | null;
  result: FieldTypeConfig | null;
}

/**
 * Rollup field options
 */
export interface RollupOptions {
  fieldIdInLinkedTable?: string;
  recordLinkFieldId?: string;
  result?: FieldTypeConfig | null;
  isValid?: boolean;
  referencedFieldIds?: string[];
}

/**
 * Last modified time field options
 */
export interface LastModifiedTimeOptions {
  isValid: boolean;
  referencedFieldIds: string[] | null;
  result: null | DateOptions | DateTimeOptions;
}

/**
 * Created time field options
 */
export interface CreatedTimeOptions {
  result?: DateOptions | DateTimeOptions;
}

/**
 * External sync source field options
 */
export interface ExternalSyncSourceOptions {
  choices: SelectOption[];
}

// ============================================================================
// Field Type Configs (for nested field definitions)
// ============================================================================

export type FieldTypeConfig =
  | { type: "aiText"; options: AITextOptions }
  | { type: "multipleAttachments"; options: MultipleAttachmentsOptions }
  | { type: "autoNumber" }
  | { type: "barcode" }
  | { type: "button" }
  | { type: "checkbox"; options: CheckboxOptions }
  | { type: "singleCollaborator" }
  | { type: "count"; options: CountOptions }
  | { type: "createdBy" }
  | { type: "createdTime"; options: CreatedTimeOptions }
  | { type: "currency"; options: CurrencyOptions }
  | { type: "date"; options: DateOptions }
  | { type: "dateTime"; options: DateTimeOptions }
  | { type: "duration"; options: DurationOptions }
  | { type: "email" }
  | { type: "formula"; options: FormulaOptions }
  | { type: "lastModifiedBy" }
  | { type: "lastModifiedTime"; options: LastModifiedTimeOptions }
  | { type: "multipleRecordLinks"; options: MultipleRecordLinksOptions }
  | { type: "multilineText" }
  | { type: "multipleLookupValues"; options: MultipleLookupValuesOptions }
  | { type: "multipleCollaborators" }
  | { type: "multipleSelects"; options: MultipleSelectsOptions }
  | { type: "number"; options: NumberOptions }
  | { type: "percent"; options: PercentOptions }
  | { type: "phoneNumber" }
  | { type: "rating"; options: RatingOptions }
  | { type: "richText" }
  | { type: "rollup"; options: RollupOptions }
  | { type: "singleLineText" }
  | { type: "singleSelect"; options: SingleSelectOptions }
  | { type: "externalSyncSource"; options: ExternalSyncSourceOptions }
  | { type: "url" };

// ============================================================================
// Field Request Types
// ============================================================================

/**
 * Create field request
 * 
 * Field model with name - identical to Field type and options,
 * with additional name and description properties
 */
export interface CreateFieldRequest {
  /** Field name (required) */
  name: string;
  /** Field type (required) - must be a supported writable field type */
  type: FieldType;
  /** Field description (optional) - max 20,000 characters */
  description?: string;
  /** Field-specific options based on field type */
  options?: Record<string, any>;
}

/**
 * Update field request
 * 
 * At least one of name or description must be specified.
 * Note: Not all field types support options updates.
 */
export interface UpdateFieldRequest {
  /** New name for the field (optional) */
  name?: string;
  /** New description for the field (optional) - max 20,000 characters */
  description?: string;
  /** Updated field options (optional) - support varies by field type */
  options?: Record<string, any>;
}

/**
 * Field response from API
 */
export interface FieldResponse {
  /** Field ID */
  id: string;
  /** Field type */
  type: FieldType;
  /** Field name */
  name: string;
  /** Field description */
  description?: string;
  /** Field-specific options */
  options?: Record<string, any>;
}

/**
 * Airtable Fields API
 * 
 * Requirements:
 * - Authentication: Personal access token or OAuth integration
 * - Scope: schema.bases:write
 * - Billing: All plans
 */
export class FieldsAPI {
  constructor(private client: AirtableClient) {}

  /**
   * Create field
   *
   * POST https://api.airtable.com/v0/meta/bases/{baseId}/tables/{tableId}/fields
   *
   * Creates a new column and returns the schema for the newly created column.
   *
   * Requirements:
   * - Authentication: Personal access token or OAuth integration
   * - Scope: schema.bases:write
   * - User role: Base creator
   * - Billing: All plans
   * - Field name must be case-insensitive unique within the table
   * - Type must be a supported writable field type
   *
   * @param baseId - Base ID
   * @param tableId - Table ID (must be ID, not name)
   * @param request - Field creation request (name, type, description, options)
   * @param existingFields - Optional list of existing fields for case-insensitive duplicate check
   * @returns Created field definition with id
   *
   * @example
   * ```ts
   * const field = await fieldsAPI.create(baseId, tableId, {
   *   name: "Visited",
   *   type: "checkbox",
   *   description: "Whether I have visited this apartment yet.",
   *   options: {
   *     color: "greenBright",
   *     icon: "check"
   *   }
   * });
   * // Returns: { id: "fld...", name: "Visited", type: "checkbox", ... }
   * ```
   *
   * @see https://airtable.com/developers/web/api/create-field
   */
  async create(
    baseId: string,
    tableId: string,
    request: CreateFieldRequest,
    existingFields?: FieldResponse[],
  ): Promise<FieldResponse> {
    // Case-insensitive duplicate check if existing fields are provided
    if (existingFields) {
      const exists = existingFields.some(
        f => f.name.toLowerCase() === request.name.toLowerCase()
      );
      if (exists) {
        throw new Error(
          `[Airtable] Field "${request.name}" already exists (case-insensitive match)`
        );
      }
    }

    return this.client.post<FieldResponse>(
      `/meta/bases/${baseId}/tables/${tableId}/fields`,
      request
    );
  }

  /**
   * Update field
   * 
   * PATCH https://api.airtable.com/v0/meta/bases/{baseId}/tables/{tableId}/fields/{columnId}
   * 
   * Updates the name and/or description of a field.
   * At least one of name or description must be specified.
   * 
   * Requirements:
   * - Authentication: Personal access token or OAuth integration
   * - Scope: schema.bases:write
   * - User role: Base creator
   * - Billing: All plans
   * 
   * Note: Not all field types support all update operations.
   * Refer to field type documentation for specifics.
   * 
   * @param baseId - Base ID
   * @param tableId - Table ID (must be ID, not name)
   * @param columnId - Field/Column ID (also called fieldId)
   * @param request - Field update request (at least one of name/description required)
   * @returns Updated field definition
   * 
   * @example
   * ```ts
   * const field = await fieldsAPI.update(baseId, tableId, columnId, {
   *   name: "Apartments (revised)",
   *   description: "I was changed!"
   * });
   * // Returns: { id: "fld...", name: "Apartments (revised)", type: "singleLineText", ... }
   * ```
   * 
   * @see https://airtable.com/developers/web/api/update-field
   */
  async update(
    baseId: string,
    tableId: string,
    columnId: string,
    request: UpdateFieldRequest
  ): Promise<FieldResponse> {
    return this.client.patch<FieldResponse>(
      `/meta/bases/${baseId}/tables/${tableId}/fields/${columnId}`,
      request
    );
  }
}

/**
 * Create a Fields API instance
 */
export function createFieldsAPI(client: AirtableClient): FieldsAPI {
  return new FieldsAPI(client);
}

