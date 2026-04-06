/**
 * Notion Data Transformers
 * 
 * Provides automatic transformation and sanitization of data being sent to Notion API.
 * Handles common data type mismatches and enforces Notion's strict schema requirements.
 * 
 * This is a "shim" layer that makes the Notion API more forgiving while maintaining
 * data integrity.
 */

import type {
  CreatePageParameters,
  UpdatePageParameters,
} from '@notionhq/client/build/src/api-endpoints.d.ts';

// ============================================================================
// CORE TRANSFORMATION FUNCTIONS
// ============================================================================

/**
 * Transform array to comma-separated string
 */
function arrayToString(value: any, separator: string = ', '): string {
  if (Array.isArray(value)) {
    return value.map(v => String(v || '')).join(separator);
  }
  return String(value || '');
}

/**
 * Transform any value to a valid Notion rich_text content string
 */
function toRichTextString(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  
  if (Array.isArray(value)) {
    return arrayToString(value);
  }
  
  if (typeof value === 'object') {
    // Try to extract meaningful string from object
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if ('content' in value && typeof value.content === 'string') {
      return value.content;
    }
    // Fall back to JSON string representation (guard against circular references)
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  
  return String(value);
}

/**
 * Transform any value to a valid Notion title content string
 */
function toTitleString(value: any): string {
  // Notion titles have a 2000 character limit
  const MAX_TITLE_LENGTH = 2000;
  const str = toRichTextString(value);

  if (str.length > MAX_TITLE_LENGTH) {
    // Truncate to 1997 chars + "..." = exactly 2000
    return str.slice(0, MAX_TITLE_LENGTH - 3) + '...';
  }

  return str;
}

/**
 * Transform any value to a valid Notion number
 */
function toNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  const num = Number(value);
  return isNaN(num) ? null : num;
}

/**
 * Transform any value to a valid Notion date string (ISO 8601)
 * 
 * Supports common date formats:
 * - ISO 8601: "2024-01-15"
 * - US format: "01/15/2024", "1/15/2024"
 * - PubMed format: "2025 Nov 13", "2024 Jan 15"
 * - Human readable: "Jan 15, 2024", "January 15, 2024"
 * - Timestamps: 1705276800000
 * - Date objects
 */
function toDateString(value: any): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  try {
    // Handle Date objects directly
    if (value instanceof Date) {
      if (isNaN(value.getTime())) {
        return null;
      }
      return value.toISOString().split('T')[0]; // YYYY-MM-DD format
    }
    
    // Handle numeric timestamps
    if (typeof value === 'number') {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return null;
      }
      return date.toISOString().split('T')[0];
    }
    
    // Handle string dates
    const str = String(value).trim();
    if (!str) {
      return null;
    }
    
    // Try to parse with JavaScript's Date parser
    // This handles most formats including:
    // - "2025 Nov 13" (PubMed format)
    // - "2024-01-15" (ISO)
    // - "Jan 15, 2024" (US readable)
    // - "01/15/2024" (US numeric)
    const date = new Date(str);
    if (isNaN(date.getTime())) {
      return null;
    }
    
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  } catch (error) {
    // Silently return null on any parsing error
    return null;
  }
}

/**
 * Transform any value to a valid Notion checkbox boolean
 */
function toBoolean(value: any): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return lower === 'true' || lower === 'yes' || lower === '1';
  }
  
  return Boolean(value);
}

/**
 * Transform any value to a valid Notion URL string
 */
function toUrl(value: any): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  const str = String(value);
  
  // Basic URL validation
  try {
    new URL(str);
    return str;
  } catch {
    // If not a valid URL, try prepending https://
    if (!str.startsWith('http://') && !str.startsWith('https://')) {
      try {
        new URL('https://' + str);
        return 'https://' + str;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Transform any value to a valid Notion email string
 */
function toEmail(value: any): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  const str = String(value);
  
  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(str) ? str : null;
}

/**
 * Transform any value to a valid Notion phone_number string
 */
function toPhoneNumber(value: any): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  return String(value);
}

// ============================================================================
// PROPERTY TRANSFORMERS
// ============================================================================

/**
 * Transform a rich_text property value
 */
function transformRichTextProperty(property: any): any {
  if (!property || !Array.isArray(property.rich_text)) {
    return property;
  }

  return {
    ...property,
    rich_text: property.rich_text.map((item: any) => {
      if (!item || typeof item !== 'object') {
        return {
          type: 'text',
          text: { content: toRichTextString(item) }
        };
      }

      if (item.text && typeof item.text === 'object' && 'content' in item.text) {
        const result: any = {
          ...item,
          text: {
            ...item.text,
            content: toRichTextString(item.text.content)
          }
        };
        // Preserve link href if present
        if (item.href) {
          result.href = item.href;
        }
        return result;
      }

      return item;
    })
  };
}

/**
 * Transform a title property value
 */
function transformTitleProperty(property: any): any {
  if (!property || !Array.isArray(property.title)) {
    return property;
  }
  
  return {
    ...property,
    title: property.title.map((item: any) => {
      if (!item || typeof item !== 'object') {
        return {
          type: 'text',
          text: { content: toTitleString(item) }
        };
      }
      
      if (item.text && typeof item.text === 'object' && 'content' in item.text) {
        return {
          ...item,
          text: {
            ...item.text,
            content: toTitleString(item.text.content)
          }
        };
      }
      
      return item;
    })
  };
}

/**
 * Transform a number property value
 */
function transformNumberProperty(property: any): any {
  if (!property || typeof property !== 'object') {
    return { number: toNumber(property) };
  }
  
  if ('number' in property) {
    return { number: toNumber(property.number) };
  }
  
  return property;
}

/**
 * Transform a date property value
 */
function transformDateProperty(property: any): any {
  if (!property || typeof property !== 'object') {
    const dateStr = toDateString(property);
    return dateStr ? { date: { start: dateStr } } : { date: null };
  }
  
  if ('date' in property) {
    if (property.date === null) {
      return { date: null };
    }
    
    if (typeof property.date === 'string') {
      const dateStr = toDateString(property.date);
      return dateStr ? { date: { start: dateStr } } : { date: null };
    }
    
    if (typeof property.date === 'object' && 'start' in property.date) {
      const startDate = toDateString(property.date.start);
      const endDate = property.date.end ? toDateString(property.date.end) : undefined;
      
      // If start date is null/invalid, return { date: null } instead of { date: { start: null } }
      // Notion requires date.start to be a string, not null
      if (startDate === null) {
        return { date: null };
      }
      
      return {
        date: {
          start: startDate,
          end: endDate
        }
      };
    }
  }
  
  return property;
}

/**
 * Transform a checkbox property value
 */
function transformCheckboxProperty(property: any): any {
  if (!property || typeof property !== 'object') {
    return { checkbox: toBoolean(property) };
  }
  
  if ('checkbox' in property) {
    return { checkbox: toBoolean(property.checkbox) };
  }
  
  return property;
}

/**
 * Transform a url property value
 */
function transformUrlProperty(property: any): any {
  if (!property || typeof property !== 'object') {
    return { url: toUrl(property) };
  }
  
  if ('url' in property) {
    return { url: toUrl(property.url) };
  }
  
  return property;
}

/**
 * Transform an email property value
 */
function transformEmailProperty(property: any): any {
  if (!property || typeof property !== 'object') {
    return { email: toEmail(property) };
  }
  
  if ('email' in property) {
    return { email: toEmail(property.email) };
  }
  
  return property;
}

/**
 * Transform a phone_number property value
 */
function transformPhoneNumberProperty(property: any): any {
  if (!property || typeof property !== 'object') {
    return { phone_number: toPhoneNumber(property) };
  }
  
  if ('phone_number' in property) {
    return { phone_number: toPhoneNumber(property.phone_number) };
  }
  
  return property;
}

// ============================================================================
// MAIN TRANSFORMATION FUNCTION
// ============================================================================

/**
 * Detect property type from property definition
 */
function detectPropertyType(property: any): string | null {
  if (!property || typeof property !== 'object') {
    return null;
  }
  
  // Direct type indicators
  if ('rich_text' in property) return 'rich_text';
  if ('title' in property) return 'title';
  if ('number' in property) return 'number';
  if ('date' in property) return 'date';
  if ('checkbox' in property) return 'checkbox';
  if ('url' in property) return 'url';
  if ('email' in property) return 'email';
  if ('phone_number' in property) return 'phone_number';
  if ('select' in property) return 'select';
  if ('multi_select' in property) return 'multi_select';
  if ('people' in property) return 'people';
  if ('files' in property) return 'files';
  if ('relation' in property) return 'relation';
  if ('rollup' in property) return 'rollup';
  if ('formula' in property) return 'formula';
  
  return null;
}

/**
 * Transform a single property based on its type
 */
function transformProperty(property: any, propertyType?: string): any {
  const type = propertyType || detectPropertyType(property);
  
  switch (type) {
    case 'rich_text':
      return transformRichTextProperty(property);
    case 'title':
      return transformTitleProperty(property);
    case 'number':
      return transformNumberProperty(property);
    case 'date':
      return transformDateProperty(property);
    case 'checkbox':
      return transformCheckboxProperty(property);
    case 'url':
      return transformUrlProperty(property);
    case 'email':
      return transformEmailProperty(property);
    case 'phone_number':
      return transformPhoneNumberProperty(property);
    // Types that don't need transformation (yet)
    case 'select':
    case 'multi_select':
    case 'people':
    case 'files':
    case 'relation':
    case 'rollup':
    case 'formula':
    default:
      return property;
  }
}

/**
 * Transform all properties in a properties object
 */
export function transformProperties(properties: any): any {
  if (!properties || typeof properties !== 'object') {
    return properties;
  }
  
  const transformed: any = {};
  
  for (const [key, value] of Object.entries(properties)) {
    transformed[key] = transformProperty(value);
  }
  
  return transformed;
}

// ============================================================================
// DATABASE PROPERTY SCHEMA TRANSFORMERS
// ============================================================================

/**
 * Transform database property schema to ensure 'type' field is present
 * Notion requires both the type field AND the property-specific field
 * 
 * Example:
 *   Input:  { "Title": { "title": {} } }
 *   Output: { "Title": { "type": "title", "title": {} } }
 */
export function transformDatabaseProperties(properties: any): any {
  if (!properties || typeof properties !== 'object') {
    return properties;
  }
  
  const transformed: any = {};
  
  for (const [name, config] of Object.entries(properties)) {
    if (!config || typeof config !== 'object') {
      transformed[name] = config;
      continue;
    }
    
    // Detect property type from the config
    const propertyConfig = config as any;
    
    // If type is already present, keep as is
    if ('type' in propertyConfig) {
      transformed[name] = propertyConfig;
      continue;
    }
    
    // Auto-detect type from property keys
    const KNOWN_NOTION_TYPES = new Set([
      'title', 'rich_text', 'number', 'select', 'multi_select', 'date',
      'people', 'files', 'checkbox', 'url', 'email', 'phone_number',
      'formula', 'relation', 'rollup', 'created_time', 'created_by',
      'last_edited_time', 'last_edited_by', 'status', 'unique_id',
    ]);
    let detectedType: string | null = null;

    for (const key of Object.keys(propertyConfig)) {
      // Skip common non-type fields
      if (key === 'id' || key === 'name') continue;

      // Only accept known Notion property types
      if (KNOWN_NOTION_TYPES.has(key)) {
        detectedType = key;
        break;
      }
    }

    if (detectedType) {
      transformed[name] = {
        type: detectedType,
        ...propertyConfig
      };
    } else {
      // Can't detect type, keep as is
      transformed[name] = propertyConfig;
    }
  }
  
  return transformed;
}

// ============================================================================
// PAGE PARAMETER TRANSFORMERS
// ============================================================================

/**
 * Transform CreatePageParameters to ensure data compatibility
 */
export function transformCreatePageParams(params: CreatePageParameters): CreatePageParameters {
  if (!params.properties) {
    return params;
  }
  
  return {
    ...params,
    properties: transformProperties(params.properties)
  };
}

/**
 * Transform UpdatePageParameters to ensure data compatibility
 */
export function transformUpdatePageParams(params: UpdatePageParameters): UpdatePageParameters {
  if (!params.properties) {
    return params;
  }
  
  return {
    ...params,
    properties: transformProperties(params.properties)
  };
}

/**
 * Transform CreateDatabaseParameters to ensure schema compatibility
 * Automatically adds 'type' field to properties if missing
 */
export function transformCreateDatabaseParams(params: any): any {
  if (!params.properties) {
    return params;
  }
  
  return {
    ...params,
    properties: transformDatabaseProperties(params.properties)
  };
}

/**
 * Transform UpdateDatabaseParameters to ensure schema compatibility
 * Automatically adds 'type' field to properties if missing
 */
export function transformUpdateDatabaseParams(params: any): any {
  if (!params.properties) {
    return params;
  }
  
  return {
    ...params,
    properties: transformDatabaseProperties(params.properties)
  };
}

// ============================================================================
// CUSTOM TRANSFORMATION REGISTRY
// ============================================================================

export type PropertyTransformer = (property: any) => any;

interface TransformerRegistry {
  [propertyType: string]: PropertyTransformer;
}

/**
 * Registry for custom property transformers
 * Allows users to add their own transformation logic
 */
const customTransformers: TransformerRegistry = {};

/**
 * Register a custom transformer for a property type
 */
export function registerPropertyTransformer(
  propertyType: string,
  transformer: PropertyTransformer
): void {
  customTransformers[propertyType] = transformer;
}

/**
 * Get a custom transformer for a property type
 */
export function getPropertyTransformer(propertyType: string): PropertyTransformer | undefined {
  return customTransformers[propertyType];
}

/**
 * Clear all custom transformers
 */
export function clearPropertyTransformers(): void {
  for (const key in customTransformers) {
    delete customTransformers[key];
  }
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

export const transformers = {
  arrayToString,
  toRichTextString,
  toTitleString,
  toNumber,
  toDateString,
  toBoolean,
  toUrl,
  toEmail,
  toPhoneNumber,
  transformDatabaseProperties,
};

