/**
 * Response Utilities
 * 
 * Phase 3.2: Standardized file response format
 * 
 * Compatible with file-transport.ts but standalone (no dependencies).
 * All file operations return consistent metadata + content structure.
 */

import type { DataType, KeyLocation } from '../types.ts';
import { parsePath } from './path.ts';
import { parseExtension, getMimeType, getMimeTypeForDataType } from './extensions.ts';

// ============================================================================
// Response Interface
// ============================================================================

/**
 * Standardized file response format
 * 
 * Compatible with file-transport.ts FileReference pattern.
 * Provides:
 * - File reference (metadata, MIME type, size, timestamps)
 * - Content (actual data)
 * - URL (for external/streaming access)
 * - Storage metadata (adapter, data type)
 * 
 * This format enables:
 * - Consistent API across all storage operations
 * - Easy integration with file serving systems
 * - Proper MIME type handling
 * - Adapter-agnostic file management
 */
export interface StorageFileResponse {
  /**
   * File reference metadata
   * 
   * Compatible with FileReference from file-transport.ts
   */
  reference: {
    /** Full storage key */
    key: string;
    
    /** Filename (last path segment) */
    name: string;
    
    /** MIME type (based on extension or data type) */
    type: string;
    
    /** Size in bytes */
    size: number;
    
    /** Source indicator (always 'storage' for Smallstore) */
    source: 'storage';
    
    /** Adapter name (where file is stored) */
    storage: string;
    
    /** Optional additional metadata */
    metadata?: Record<string, any>;
    
    /** Unix timestamp (milliseconds) */
    createdAt?: number;
  };
  
  /**
   * Actual file content
   * 
   * Type varies by data type:
   * - object: any JSON-serializable data
   * - blob: Uint8Array
   * - kv: string, number, boolean, null
   */
  content?: Uint8Array | object | string | number | boolean | null;
  
  /**
   * Direct URL to file (if adapter supports it)
   * 
   * Examples:
   * - R2: https://r2.cloudflare.com/bucket/key
   * - Notion: https://notion.so/files/...
   * - Airtable: https://dl.airtable.com/...
   */
  url?: string;
  
  /**
   * Adapter name (where file is stored)
   */
  adapter: string;
  
  /**
   * Smallstore data type
   */
  dataType: DataType;
}

// ============================================================================
// Response Wrapping
// ============================================================================

/**
 * Options for wrapping responses
 */
export interface WrapResponseOptions {
  /** Override MIME type (instead of detecting from extension) */
  mimeType?: string;
  
  /** Direct URL to file (if available) */
  url?: string;
  
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Wrap raw data in standardized StorageFileResponse format
 * 
 * This function:
 * 1. Extracts filename from key
 * 2. Detects MIME type from extension or data type
 * 3. Gets size, adapter, timestamps from KeyLocation
 * 4. Wraps everything in consistent format
 * 
 * @param key - Full storage key
 * @param content - Raw data content
 * @param location - Key location from KeyIndex
 * @param options - Optional overrides
 * @returns Standardized file response
 * 
 * @example
 * const response = wrapResponse(
 *   "documents/report.pdf",
 *   pdfBlob,
 *   { adapter: "r2", dataType: "blob", sizeBytes: 1024000, ... },
 *   { url: "https://r2.cloudflare.com/..." }
 * );
 * // → { reference: { name: "report.pdf", type: "application/pdf", ... }, content: ..., url: ... }
 */
export function wrapResponse(
  key: string,
  content: any,
  location: KeyLocation,
  options?: WrapResponseOptions
): StorageFileResponse {
  const parsed = parsePath(key);
  const filename = parsed.path.length > 0 
    ? parsed.path[parsed.path.length - 1]
    : parsed.collection;
  
  const ext = parseExtension(filename);
  
  // Determine MIME type
  let mimeType: string;
  if (options?.mimeType) {
    // 1. Explicit override
    mimeType = options.mimeType;
  } else if (ext.hasExtension) {
    // 2. From file extension
    mimeType = getMimeType(ext.extension);
  } else {
    // 3. From data type (implicit extension)
    mimeType = getMimeTypeForDataType(location.dataType);
  }
  
  // Parse created timestamp
  let createdAt: number | undefined;
  try {
    createdAt = new Date(location.created).getTime();
  } catch {
    createdAt = undefined;
  }
  
  return {
    reference: {
      key,
      name: filename,
      type: mimeType,
      size: location.sizeBytes,
      source: 'storage',
      storage: location.adapter,
      metadata: options?.metadata,
      createdAt,
    },
    content,
    url: options?.url,
    adapter: location.adapter,
    dataType: location.dataType,
  };
}

/**
 * Create response for data without KeyIndex
 * 
 * Fallback when KeyIndex is unavailable (e.g., during migration, testing).
 * Estimates size and uses defaults for missing information.
 * 
 * @param key - Full storage key
 * @param content - Raw data content
 * @param adapter - Adapter name
 * @param dataType - Data type
 * @param options - Optional overrides
 * @returns Standardized file response
 * 
 * @example
 * const response = wrapResponseWithoutIndex(
 *   "temp/data",
 *   { value: 42 },
 *   "memory",
 *   "object"
 * );
 * // → { reference: { name: "data", type: "application/json", ... }, content: ... }
 */
export function wrapResponseWithoutIndex(
  key: string,
  content: any,
  adapter: string,
  dataType: DataType,
  options?: WrapResponseOptions
): StorageFileResponse {
  const parsed = parsePath(key);
  const filename = parsed.path.length > 0 
    ? parsed.path[parsed.path.length - 1]
    : parsed.collection;
  
  const ext = parseExtension(filename);
  
  // Determine MIME type
  let mimeType: string;
  if (options?.mimeType) {
    mimeType = options.mimeType;
  } else if (ext.hasExtension) {
    mimeType = getMimeType(ext.extension);
  } else {
    mimeType = getMimeTypeForDataType(dataType);
  }
  
  // Estimate size
  let sizeBytes: number;
  if (content instanceof Uint8Array) {
    sizeBytes = content.byteLength;
  } else if (typeof content === 'string') {
    sizeBytes = new TextEncoder().encode(content).byteLength;
  } else {
    try {
      sizeBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
    } catch {
      sizeBytes = 0;
    }
  }
  
  return {
    reference: {
      key,
      name: filename,
      type: mimeType,
      size: sizeBytes,
      source: 'storage',
      storage: adapter,
      metadata: options?.metadata,
      createdAt: Date.now(),
    },
    content,
    url: options?.url,
    adapter,
    dataType,
  };
}

/**
 * Extract content from StorageFileResponse
 * 
 * Convenience helper for accessing just the data.
 * 
 * @param response - Storage file response
 * @returns Content only
 * 
 * @example
 * const data = extractContent(response);
 * // Same as: response.content
 */
export function extractContent(response: StorageFileResponse): any {
  return response.content;
}

/**
 * Check if response contains blob data
 * 
 * @param response - Storage file response
 * @returns true if content is Uint8Array
 */
export function isBlob(response: StorageFileResponse): boolean {
  return response.content instanceof Uint8Array;
}

/**
 * Check if response contains object data
 * 
 * @param response - Storage file response
 * @returns true if content is object (and not blob/null)
 */
export function isObject(response: StorageFileResponse): boolean {
  return (
    response.dataType === 'object' &&
    typeof response.content === 'object' &&
    response.content !== null &&
    !(response.content instanceof Uint8Array)
  );
}

/**
 * Check if response contains primitive data
 * 
 * @param response - Storage file response
 * @returns true if content is string/number/boolean/null
 */
export function isPrimitive(response: StorageFileResponse): boolean {
  return (
    response.dataType === 'kv' &&
    (typeof response.content === 'string' ||
     typeof response.content === 'number' ||
     typeof response.content === 'boolean' ||
     response.content === null)
  );
}

