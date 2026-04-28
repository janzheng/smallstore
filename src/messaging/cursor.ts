/**
 * Opaque cursor encode/decode for inbox pagination.
 *
 * Format: `v1.<base64url(JSON({at, id}))>`
 *
 * - `at`: ISO-8601 received_at watermark
 * - `id`: tiebreaker for items sharing `at` (the InboxItem.id)
 *
 * The version prefix lets us evolve the encoding later without breaking
 * old persisted cursors. Callers MUST treat cursors as opaque strings.
 */

const VERSION = 'v1';

export interface Cursor {
  /** ISO-8601 timestamp (matches InboxItem.received_at). */
  at: string;
  /** Tiebreaker: id of the item AT this watermark (cursor points just before/after it). */
  id: string;
}

/**
 * Encode a cursor to an opaque string. Safe to embed in URLs.
 */
export function encodeCursor(c: Cursor): string {
  const json = JSON.stringify({ at: c.at, id: c.id });
  const b64 = base64urlEncode(json);
  return `${VERSION}.${b64}`;
}

/**
 * Maximum length of `id` in a decoded cursor. Inbox ids today are short
 * UUIDs / short slugs (~40 chars); 256 is generous headroom while still
 * bounding pathological input.
 */
const MAX_ID_LENGTH = 256;

/**
 * ISO-8601 with optional fractional seconds and either `Z` or `±HH:MM`
 * offset. Matches the shape `encodeCursor` produces (`InboxItem.received_at`)
 * without admitting open-ended Date.parse-able inputs like `"2026"` or
 * arbitrary RFC 2822 strings that would skew range queries.
 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Decode an opaque cursor string. Returns null if malformed.
 *
 * Throws nothing — callers should treat null as "start from beginning".
 *
 * B041: shape validation after JSON.parse. A base64-encoded JSON payload is
 * caller-controlled (it's a query param), so we can't trust `at` to be a
 * sane ISO date or `id` to be a bounded string. Validate both, returning
 * null on mismatch — callers already handle null as "start from beginning"
 * so a hostile cursor degrades gracefully instead of producing absurd date
 * ranges or carrying multi-megabyte ids through the pagination layer.
 */
export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  const dot = s.indexOf('.');
  if (dot <= 0) return null;
  const version = s.slice(0, dot);
  const payload = s.slice(dot + 1);
  if (version !== VERSION) return null;
  try {
    const json = base64urlDecode(payload);
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.at !== 'string' || typeof obj.id !== 'string') return null;
    // `at` must look like ISO-8601 AND parse to a real timestamp. Date.parse
    // alone is too permissive (accepts "1995", "Jan 1", numeric strings, etc.)
    // — gate on the regex first, then sanity-check via Date.parse.
    if (!obj.at || !ISO_8601_RE.test(obj.at)) return null;
    if (Number.isNaN(Date.parse(obj.at))) return null;
    // `id` is bounded. Empty string is allowed: `inbox.cursor()` uses the
    // sentinel `{ at: epoch, id: '' }` for an empty inbox (see inbox.ts:234)
    // — rejecting it would regress the round-trip contract.
    if (obj.id.length > MAX_ID_LENGTH) return null;
    return { at: obj.at, id: obj.id };
  } catch {
    return null;
  }
}

// ============================================================================
// base64url helpers — works in Deno + browser + Workers (no Node Buffer)
// ============================================================================

function base64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
