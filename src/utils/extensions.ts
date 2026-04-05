/**
 * Extension Utilities
 * 
 * Phase 3.2: File-like storage with extension-based MIME type detection
 * 
 * Handles:
 * - Extension parsing from keys/paths
 * - MIME type mapping for common file types
 * - DataType inference from extensions
 */

import type { DataType } from '../types.ts';

// ============================================================================
// Extension Parsing
// ============================================================================

/**
 * Parsed extension result
 */
export interface ParsedExtension {
  /** Path without extension */
  basePath: string;
  
  /** Extension (lowercase, without dot) */
  extension: string;
  
  /** Whether path has an extension */
  hasExtension: boolean;
}

/**
 * Parse extension from key/path
 * 
 * Extracts file extension while handling edge cases:
 * - Dotfiles (.gitignore) are not considered extensions
 * - Only dots after last slash are considered extension separators
 * - Extensions are normalized to lowercase
 * 
 * @param key - Storage key or path
 * @returns Parsed extension information
 * 
 * @example
 * parseExtension("documents/report.pdf");
 * // → { basePath: "documents/report", extension: "pdf", hasExtension: true }
 * 
 * parseExtension("images/photo.jpg");
 * // → { basePath: "images/photo", extension: "jpg", hasExtension: true }
 * 
 * parseExtension("users/alice");
 * // → { basePath: "users/alice", extension: "", hasExtension: false }
 * 
 * parseExtension("config/.gitignore");
 * // → { basePath: "config/.gitignore", extension: "", hasExtension: false }
 */
export function parseExtension(key: string): ParsedExtension {
  const lastDot = key.lastIndexOf('.');
  const lastSlash = key.lastIndexOf('/');
  
  // Extension must be after last slash (if any) and not at start of filename
  const afterSlash = lastSlash + 1;
  if (lastDot > lastSlash && lastDot !== -1 && lastDot > afterSlash) {
    return {
      basePath: key.substring(0, lastDot),
      extension: key.substring(lastDot + 1).toLowerCase(),
      hasExtension: true,
    };
  }
  
  return {
    basePath: key,
    extension: '',
    hasExtension: false,
  };
}

// ============================================================================
// MIME Type Mapping
// ============================================================================

/**
 * Comprehensive MIME type mappings
 * 
 * Covers common file types across categories:
 * - Documents (PDF, Office, text formats)
 * - Images (JPEG, PNG, GIF, WebP, SVG)
 * - Audio (MP3, WAV, OGG, FLAC)
 * - Video (MP4, WebM, MOV, AVI)
 * - Archives (ZIP, TAR, GZ)
 * - Web (HTML, CSS, JS, XML)
 * - Data (JSON, CSV, YAML, XML)
 * - Code (various programming languages)
 */
const MIME_TYPES: Record<string, string> = {
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'odt': 'application/vnd.oasis.opendocument.text',
  'ods': 'application/vnd.oasis.opendocument.spreadsheet',
  'odp': 'application/vnd.oasis.opendocument.presentation',
  'rtf': 'application/rtf',
  'txt': 'text/plain',
  'md': 'text/markdown',
  'markdown': 'text/markdown',
  'csv': 'text/csv',
  'tsv': 'text/tab-separated-values',
  
  // Data formats
  'json': 'application/json',
  'yaml': 'text/yaml',
  'yml': 'text/yaml',
  'xml': 'application/xml',
  'toml': 'application/toml',
  
  // Images
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'ico': 'image/x-icon',
  'bmp': 'image/bmp',
  'tif': 'image/tiff',
  'tiff': 'image/tiff',
  'heic': 'image/heic',
  'heif': 'image/heif',
  
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'oga': 'audio/ogg',
  'opus': 'audio/opus',
  'flac': 'audio/flac',
  'm4a': 'audio/mp4',
  'aac': 'audio/aac',
  'wma': 'audio/x-ms-wma',
  
  // Video
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'mov': 'video/quicktime',
  'avi': 'video/x-msvideo',
  'mkv': 'video/x-matroska',
  'flv': 'video/x-flv',
  'wmv': 'video/x-ms-wmv',
  'm4v': 'video/x-m4v',
  'ogv': 'video/ogg',
  
  // Archives
  'zip': 'application/zip',
  'tar': 'application/x-tar',
  'gz': 'application/gzip',
  'gzip': 'application/gzip',
  'bz2': 'application/x-bzip2',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/vnd.rar',
  'xz': 'application/x-xz',
  
  // Web
  'html': 'text/html',
  'htm': 'text/html',
  'css': 'text/css',
  'js': 'application/javascript',
  'mjs': 'application/javascript',
  'jsx': 'text/jsx',
  'ts': 'application/typescript',
  'tsx': 'text/tsx',
  'wasm': 'application/wasm',
  
  // Fonts
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  'eot': 'application/vnd.ms-fontobject',
  
  // Code
  'py': 'text/x-python',
  'rb': 'text/x-ruby',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'cpp': 'text/x-c++',
  'h': 'text/x-c',
  'hpp': 'text/x-c++',
  'go': 'text/x-go',
  'rs': 'text/x-rust',
  'php': 'text/x-php',
  'sh': 'application/x-sh',
  'bash': 'application/x-sh',
  'zsh': 'application/x-sh',
  'sql': 'application/sql',
  
  // Other
  'epub': 'application/epub+zip',
  'apk': 'application/vnd.android.package-archive',
  'dmg': 'application/x-apple-diskimage',
  'iso': 'application/x-iso9660-image',
};

/**
 * Get MIME type for file extension
 * 
 * Returns appropriate MIME type for known extensions.
 * Falls back to 'application/octet-stream' for unknown types.
 * 
 * @param extension - File extension (without dot)
 * @returns MIME type string
 * 
 * @example
 * getMimeType("pdf"); // → "application/pdf"
 * getMimeType("jpg"); // → "image/jpeg"
 * getMimeType("json"); // → "application/json"
 * getMimeType("unknown"); // → "application/octet-stream"
 */
export function getMimeType(extension: string): string {
  const normalized = extension.toLowerCase();
  return MIME_TYPES[normalized] || 'application/octet-stream';
}

// ============================================================================
// DataType Inference
// ============================================================================

/**
 * Map file extensions to Smallstore DataTypes
 * 
 * Phase 3.2: Extensions help infer data types for proper routing
 * 
 * Categories:
 * - object: JSON-serializable data (json, yaml, yml)
 * - kv: Simple text/primitives (txt, md, csv, tsv)
 * - blob: Everything else (images, videos, PDFs, archives, etc.)
 */
const DATATYPE_MAPPINGS: Record<string, DataType> = {
  // Objects (structured data)
  'json': 'object',
  'yaml': 'object',
  'yml': 'object',
  
  // KV (simple text/primitives)
  'txt': 'kv',
  'md': 'kv',
  'markdown': 'kv',
  'csv': 'kv',
  'tsv': 'kv',
  
  // Everything else is blob by default
};

/**
 * Infer Smallstore DataType from file extension
 * 
 * Returns the most appropriate DataType for storage routing:
 * - 'object' for structured data (JSON, YAML)
 * - 'kv' for simple text (TXT, MD, CSV)
 * - 'blob' for binary/large files (images, videos, PDFs, etc.)
 * 
 * @param extension - File extension (without dot)
 * @returns DataType or null if extension is empty
 * 
 * @example
 * inferDataType("json"); // → "object"
 * inferDataType("txt"); // → "kv"
 * inferDataType("pdf"); // → "blob"
 * inferDataType("jpg"); // → "blob"
 * inferDataType(""); // → null
 */
export function inferDataType(extension: string): DataType | null {
  if (!extension) {
    return null;
  }
  
  const normalized = extension.toLowerCase();
  
  // Check explicit mappings first
  if (DATATYPE_MAPPINGS[normalized]) {
    return DATATYPE_MAPPINGS[normalized];
  }
  
  // Default: everything else is a blob
  return 'blob';
}

// ============================================================================
// Implicit Extension Support
// ============================================================================

/**
 * Get implicit extension for DataType
 * 
 * Phase 3.2: Data without explicit extensions get implicit ones:
 * - Objects → .json
 * - KV primitives → .txt
 * - Blobs → (no implicit extension, must be explicit)
 * 
 * @param dataType - Smallstore DataType
 * @returns Implicit extension (without dot) or empty string
 * 
 * @example
 * getImplicitExtension("object"); // → "json"
 * getImplicitExtension("kv"); // → "txt"
 * getImplicitExtension("blob"); // → ""
 */
export function getImplicitExtension(dataType: DataType): string {
  switch (dataType) {
    case 'object':
      return 'json';
    case 'kv':
      return 'txt';
    case 'blob':
      return ''; // Blobs must have explicit extensions
    default:
      return '';
  }
}

/**
 * Get MIME type for DataType (using implicit extension)
 * 
 * @param dataType - Smallstore DataType
 * @returns MIME type for implicit extension
 * 
 * @example
 * getMimeTypeForDataType("object"); // → "application/json"
 * getMimeTypeForDataType("kv"); // → "text/plain"
 * getMimeTypeForDataType("blob"); // → "application/octet-stream"
 */
export function getMimeTypeForDataType(dataType: DataType): string {
  const implicitExt = getImplicitExtension(dataType);
  if (!implicitExt) {
    return 'application/octet-stream';
  }
  return getMimeType(implicitExt);
}

