/**
 * Shared text extraction utility for search providers.
 *
 * Extracts searchable text from stored values by pulling from known text fields
 * (content, text, body, description, title, name, summary) or falling back to
 * JSON.stringify for objects without recognized fields.
 */

const DEFAULT_FIELDS = ['content', 'text', 'body', 'description', 'title', 'name', 'summary'];

/**
 * Extract searchable text from a value for indexing.
 *
 * @param value - The stored value (string, object, or other)
 * @param fields - Optional custom field list to extract from objects
 * @returns Extracted text, or null if no text could be extracted
 */
export function extractSearchableText(value: any, fields?: string[]): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const textFields = fields || DEFAULT_FIELDS;
    const parts: string[] = [];
    for (const field of textFields) {
      if (typeof value[field] === 'string') parts.push(value[field]);
    }
    if (parts.length > 0) return parts.join(' ');
    try { return JSON.stringify(value); } catch { return null; }
  }
  return null;
}
