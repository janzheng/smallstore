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
 * Decode an opaque cursor string. Returns null if malformed.
 *
 * Throws nothing — callers should treat null as "start from beginning".
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
    if (typeof obj?.at !== 'string' || typeof obj?.id !== 'string') return null;
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
