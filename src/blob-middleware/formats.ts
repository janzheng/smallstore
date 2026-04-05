/**
 * Platform Format Transforms
 *
 * Converts a BlobReference into the correct attachment/file format
 * for Airtable, Notion, or plain URL.
 */

import type { BlobReference, TargetFormat } from './types.ts';

// ============================================================================
// Airtable Attachment Format
// ============================================================================

/** Airtable attachment object — one element of the attachment array */
export interface AirtableAttachment {
  url: string;
  filename: string;
}

/**
 * Format a blob reference as an Airtable attachment.
 * Airtable attachment fields expect an array of `{ url, filename }`.
 *
 * Returns a single attachment object — the caller wraps it in an array.
 */
export function toAirtableAttachment(ref: BlobReference): AirtableAttachment {
  return {
    url: ref.url,
    filename: ref.filename,
  };
}

// ============================================================================
// Notion File Format
// ============================================================================

/** Notion external file object */
export interface NotionFile {
  type: 'external';
  name: string;
  external: {
    url: string;
  };
}

/**
 * Format a blob reference as a Notion external file.
 * Notion file properties expect `{ type: 'external', name, external: { url } }`.
 */
export function toNotionFile(ref: BlobReference): NotionFile {
  return {
    type: 'external',
    name: ref.filename,
    external: {
      url: ref.url,
    },
  };
}

// ============================================================================
// Platform Dispatch
// ============================================================================

/**
 * Format a blob reference for the target platform.
 *
 * @param ref - The blob reference (URL, filename, etc.)
 * @param format - Target format
 * @returns Platform-specific value to set on the field
 *
 * - `airtable` → `[{ url, filename }]` (array of attachments)
 * - `notion` → `[{ type: 'external', name, external: { url } }]` (array of files)
 * - `url-only` → `"https://..."` (plain URL string)
 * - `blob-reference` → full BlobReference object
 */
export function formatForPlatform(
  ref: BlobReference,
  format: TargetFormat = 'url-only',
): unknown {
  switch (format) {
    case 'airtable':
      return [toAirtableAttachment(ref)];
    case 'notion':
      return [toNotionFile(ref)];
    case 'url-only':
      return ref.url;
    case 'blob-reference':
      return ref;
  }
}
