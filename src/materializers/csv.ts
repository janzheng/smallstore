/**
 * CSV Materializer
 * 
 * Phase 3.2: Content negotiation - materialize collections as CSV
 * 
 * Returns collections as CSV format for spreadsheet imports and data analysis.
 * Works best with homogeneous object collections.
 */

import type { Smallstore } from '../types.ts';
import { parsePath } from '../utils/path.ts';

// ============================================================================
// CSV Materialization
// ============================================================================

/**
 * Materialize collection as CSV
 * 
 * Converts collection items to CSV format:
 * - Extracts common fields from objects
 * - Handles nested objects (flattened dot notation)
 * - Includes metadata columns (key, type, adapter, size)
 * 
 * Use cases:
 * - Spreadsheet imports (Excel, Google Sheets)
 * - Data analysis (pandas, R)
 * - Reporting and exports
 * 
 * Limitations:
 * - Works best with object collections
 * - Blobs shown as [Binary]
 * - Arrays/nested objects shown as JSON strings
 * 
 * @param storage - Smallstore instance
 * @param collectionPath - Collection to materialize
 * @param options - CSV options
 * @returns CSV string
 * 
 * @example
 * const csv = await materializeCsv(storage, "bookmarks/tech");
 * // → key,type,adapter,title,url,tags
 * //   article1,object,upstash,Cool Post,https://...,tech;ai
 * //   article2,object,upstash,Another Post,https://...,tech;web
 */
export async function materializeCsv(
  storage: Smallstore,
  collectionPath: string,
  options?: CsvOptions
): Promise<string> {
  const parsed = parsePath(collectionPath);
  
  // Get all keys in collection
  const keys = await storage.keys(collectionPath);
  
  if (keys.length === 0) {
    return 'key,type,adapter\n'; // Empty CSV with headers
  }
  
  // Load all items
  const items: Array<{
    key: string;
    type: string;
    adapter: string;
    size: number;
    data: any;
  }> = [];
  
  for (const key of keys) {
    try {
      const response = await storage.get(`${collectionPath}/${key}`);
      if (!response) continue;
      
      items.push({
        key,
        type: response.dataType,
        adapter: response.adapter,
        size: response.reference.size,
        data: response.content,
      });
    } catch (err) {
      console.warn(`[materializeCsv] Failed to load key "${key}":`, err);
      // Continue with other keys
    }
  }
  
  // Extract all unique fields from objects
  const allFields = new Set<string>();
  const rows: Array<Record<string, any>> = [];
  
  for (const item of items) {
    const row: Record<string, any> = {
      key: item.key,
      type: item.type,
      adapter: item.adapter,
      size: item.size,
    };
    
    // Extract data fields
    if (item.type === 'object' && typeof item.data === 'object' && item.data !== null) {
      const flattened = flattenObject(item.data, options?.maxDepth);
      for (const [field, value] of Object.entries(flattened)) {
        allFields.add(field);
        row[field] = value;
      }
    } else if (item.type === 'blob') {
      row['value'] = '[Binary]';
      allFields.add('value');
    } else {
      // kv (primitives)
      row['value'] = item.data;
      allFields.add('value');
    }
    
    rows.push(row);
  }
  
  // Build CSV
  const metadataColumns = ['key', 'type', 'adapter', 'size'];
  const dataColumns = Array.from(allFields).sort();
  const columns = [...metadataColumns, ...dataColumns];
  
  // Header row
  const lines: string[] = [];
  lines.push(columns.map(escapeCsvValue).join(','));
  
  // Data rows
  for (const row of rows) {
    const values = columns.map(col => {
      const value = row[col];
      return formatCsvValue(value);
    });
    lines.push(values.map(escapeCsvValue).join(','));
  }
  
  return lines.join('\n');
}

/**
 * CSV options
 */
export interface CsvOptions {
  /** Maximum depth for flattening nested objects (default: 2) */
  maxDepth?: number;
  
  /** Include metadata columns (key, type, adapter, size) */
  includeMetadata?: boolean;
}

/**
 * Flatten nested object to dot notation
 * 
 * @param obj - Object to flatten
 * @param maxDepth - Maximum depth (default: 2)
 * @param prefix - Current prefix (for recursion)
 * @param depth - Current depth (for recursion)
 * @returns Flattened object
 * 
 * @example
 * flattenObject({ user: { name: "Alice", age: 30 } });
 * // → { "user.name": "Alice", "user.age": 30 }
 */
function flattenObject(
  obj: any,
  maxDepth = 2,
  prefix = '',
  depth = 0
): Record<string, any> {
  const result: Record<string, any> = {};
  
  if (depth >= maxDepth || typeof obj !== 'object' || obj === null) {
    return { [prefix || 'value']: obj };
  }
  
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    
    if (Array.isArray(value)) {
      // Arrays as JSON strings
      result[newKey] = JSON.stringify(value);
    } else if (typeof value === 'object' && value !== null) {
      // Recurse into nested objects
      if (depth < maxDepth - 1) {
        Object.assign(result, flattenObject(value, maxDepth, newKey, depth + 1));
      } else {
        result[newKey] = JSON.stringify(value);
      }
    } else {
      result[newKey] = value;
    }
  }
  
  return result;
}

/**
 * Format value for CSV
 * 
 * Converts various types to CSV-friendly strings.
 * 
 * @param value - Value to format
 * @returns Formatted string
 */
function formatCsvValue(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  
  if (typeof value === 'string') {
    return value;
  }
  
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  
  if (Array.isArray(value)) {
    // Arrays as semicolon-separated (Excel-friendly)
    return value.map(v => String(v)).join(';');
  }
  
  if (typeof value === 'object') {
    // Objects as JSON strings
    return JSON.stringify(value);
  }
  
  return String(value);
}

/**
 * Escape CSV value (RFC 4180)
 * 
 * Wraps values in quotes if they contain:
 * - Commas
 * - Newlines
 * - Quotes
 * 
 * Doubles internal quotes.
 * 
 * @param value - Value to escape
 * @returns Escaped value
 * 
 * @example
 * escapeCsvValue('Hello, World'); // → '"Hello, World"'
 * escapeCsvValue('Say "Hi"'); // → '"Say ""Hi"""'
 */
function escapeCsvValue(value: string): string {
  if (!value) {
    return '';
  }
  
  // Check if escaping is needed
  const needsEscape = /[,"\n\r]/.test(value);
  
  if (!needsEscape) {
    return value;
  }
  
  // Escape quotes by doubling them
  const escaped = value.replace(/"/g, '""');
  
  // Wrap in quotes
  return `"${escaped}"`;
}

/**
 * Materialize single item as CSV
 * 
 * For single items (not collections), returns the item as a single-row CSV.
 * 
 * @param storage - Smallstore instance
 * @param itemPath - Path to single item
 * @param options - CSV options
 * @returns CSV string
 * 
 * @example
 * const csv = await materializeCsvItem(storage, "users/alice");
 * // → key,type,adapter,name,email
 * //   users/alice,object,upstash,Alice,alice@example.com
 */
export async function materializeCsvItem(
  storage: Smallstore,
  itemPath: string,
  options?: CsvOptions
): Promise<string> {
  const response = await storage.get(itemPath);
  if (!response) {
    return 'key,type,adapter\n'; // Empty CSV
  }
  
  const row: Record<string, any> = {
    key: itemPath,
    type: response.dataType,
    adapter: response.adapter,
    size: response.reference.size,
  };
  
  // Extract data fields
  if (response.dataType === 'object' && typeof response.content === 'object' && response.content !== null) {
    const flattened = flattenObject(response.content, options?.maxDepth);
    Object.assign(row, flattened);
  } else if (response.dataType === 'blob') {
    row['value'] = '[Binary]';
  } else {
    row['value'] = response.content;
  }
  
  // Build CSV
  const columns = Object.keys(row);
  const lines: string[] = [];
  
  // Header row
  lines.push(columns.map(escapeCsvValue).join(','));
  
  // Data row
  const values = columns.map(col => formatCsvValue(row[col]));
  lines.push(values.map(escapeCsvValue).join(','));
  
  return lines.join('\n');
}

