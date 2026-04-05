/**
 * Blob Field Detection
 *
 * Detects blob inputs by their sentinel shapes — { file }, { buffer },
 * { base64 }, { url, reupload }, Uint8Array, Blob.
 *
 * Used by the middleware to find which fields need upload processing.
 */

import type { BlobInput } from './types.ts';

// ============================================================================
// Single Value Detection
// ============================================================================

/**
 * Check if a value is a blob input (one of the sentinel shapes).
 *
 * Recognized shapes:
 * - `{ file: "path/to/file.jpg" }`
 * - `{ buffer: Uint8Array }`
 * - `{ base64: "..." }`
 * - `{ url: "https://...", reupload: true }`
 * - `Uint8Array`
 * - `Blob`
 */
export function isBlobInput(value: unknown): value is BlobInput {
  if (value == null) return false;

  // Direct binary types
  if (value instanceof Uint8Array) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;

  // Object sentinel shapes
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // { file: string }
    if (typeof obj.file === 'string' && obj.file.length > 0) return true;

    // { buffer: Uint8Array }
    if (obj.buffer instanceof Uint8Array) return true;

    // { base64: string }
    if (typeof obj.base64 === 'string' && obj.base64.length > 0) return true;

    // { url: string, reupload: true } — only blob if reupload is set
    if (typeof obj.url === 'string' && obj.reupload === true) return true;
  }

  return false;
}

// ============================================================================
// Object Walking — Find All Blob Fields
// ============================================================================

/** A detected blob field with its dot-notation path and value */
export interface DetectedBlobField {
  /** Dot-notation path to the field (e.g. "image", "meta.thumbnail") */
  path: string;
  /** The blob input value */
  value: BlobInput;
}

/**
 * Walk an object and find all blob input fields.
 * Returns dot-notation paths and their values.
 *
 * Only walks one level deep by default — blob fields should be
 * top-level or at most one nested object deep. We don't recurse
 * into arrays.
 *
 * @param data - The data object to scan
 * @param maxDepth - Maximum nesting depth to scan (default: 3)
 * @returns Array of detected blob fields with their paths
 *
 * @example
 * ```ts
 * const fields = detectBlobFields({
 *   title: 'Sunset',
 *   image: { file: './sunset.jpg' },
 *   meta: { thumbnail: { file: './thumb.jpg' } },
 *   tags: ['photo', 'nature'],
 * });
 * // → [
 * //   { path: 'image', value: { file: './sunset.jpg' } },
 * //   { path: 'meta.thumbnail', value: { file: './thumb.jpg' } },
 * // ]
 * ```
 */
export function detectBlobFields(
  data: Record<string, unknown>,
  maxDepth = 3,
): DetectedBlobField[] {
  const results: DetectedBlobField[] = [];
  walk(data, '', 0, maxDepth, results);
  return results;
}

function walk(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  maxDepth: number,
  results: DetectedBlobField[],
): void {
  if (depth > maxDepth) return;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isBlobInput(value)) {
      results.push({ path, value: value as BlobInput });
    } else if (
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array) &&
      !(typeof Blob !== 'undefined' && value instanceof Blob)
    ) {
      // Recurse into plain objects
      walk(value as Record<string, unknown>, path, depth + 1, maxDepth, results);
    }
  }
}
