/**
 * Messaging — opaque cursor encode/decode tests.
 */

import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { decodeCursor, encodeCursor } from '../src/messaging/cursor.ts';

Deno.test('cursor — round-trips a normal cursor', () => {
  const c = { at: '2026-04-22T12:34:56Z', id: 'abc123' };
  const decoded = decodeCursor(encodeCursor(c));
  assertEquals(decoded, c);
});

Deno.test('cursor — encoded form is opaque (does not contain raw fields)', () => {
  const c = { at: '2026-04-22T12:34:56Z', id: 'mysecretid' };
  const enc = encodeCursor(c);
  assertEquals(enc.includes(c.id), false);
  assertEquals(enc.startsWith('v1.'), true);
});

Deno.test('cursor — decoder returns null for malformed input', () => {
  assertEquals(decodeCursor(''), null);
  assertEquals(decodeCursor(null), null);
  assertEquals(decodeCursor(undefined), null);
  assertEquals(decodeCursor('not-a-cursor'), null);
  assertEquals(decodeCursor('v1.notbase64!@#$'), null);
  assertEquals(decodeCursor('v999.aGVsbG8'), null); // wrong version
});

Deno.test('cursor — different inputs produce different encodings', () => {
  const a = encodeCursor({ at: '2026-04-22T12:34:56Z', id: 'a' });
  const b = encodeCursor({ at: '2026-04-22T12:34:56Z', id: 'b' });
  assertNotEquals(a, b);
});

Deno.test('cursor — handles unicode ids and timestamps', () => {
  const c = { at: '2026-04-22T12:34:56Z', id: 'café-😀-id' };
  const decoded = decodeCursor(encodeCursor(c));
  assertEquals(decoded, c);
});

// ============================================================================
// B041 — shape validation after JSON.parse
// ============================================================================

/** Helper: build a v1 cursor from an arbitrary JSON payload (skips encodeCursor's typing). */
function craftCursor(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `v1.${b64}`;
}

Deno.test('cursor B041 — malformed JSON payload returns null', () => {
  // base64-decodes fine but JSON.parse throws → catch → null
  assertEquals(decodeCursor('v1.bm90LWpzb24'), null); // "not-json"
});

Deno.test('cursor B041 — non-object payload returns null', () => {
  assertEquals(decodeCursor(craftCursor(42)), null);
  assertEquals(decodeCursor(craftCursor('a string')), null);
  assertEquals(decodeCursor(craftCursor(null)), null);
  assertEquals(decodeCursor(craftCursor([1, 2, 3])), null);
});

Deno.test('cursor B041 — missing or wrong-typed at/id returns null', () => {
  assertEquals(decodeCursor(craftCursor({ at: 123, id: 'x' })), null);
  assertEquals(decodeCursor(craftCursor({ at: '2026-04-22T12:34:56Z', id: 42 })), null);
  assertEquals(decodeCursor(craftCursor({ at: '2026-04-22T12:34:56Z' })), null);
  assertEquals(decodeCursor(craftCursor({ id: 'x' })), null);
});

Deno.test('cursor B041 — non-ISO `at` returns null', () => {
  // Date.parse-able but not ISO-8601 — must still be rejected
  assertEquals(decodeCursor(craftCursor({ at: 'Jan 1, 2026', id: 'x' })), null);
  assertEquals(decodeCursor(craftCursor({ at: '2026', id: 'x' })), null);
  assertEquals(decodeCursor(craftCursor({ at: '2026-04-22', id: 'x' })), null); // no time
  assertEquals(decodeCursor(craftCursor({ at: 'not-a-date', id: 'x' })), null);
  // Empty `at` rejected
  assertEquals(decodeCursor(craftCursor({ at: '', id: 'x' })), null);
});

Deno.test('cursor B041 — oversized id returns null', () => {
  // 257 chars (over MAX_ID_LENGTH=256)
  const bigId = 'a'.repeat(257);
  assertEquals(decodeCursor(craftCursor({ at: '2026-04-22T12:34:56Z', id: bigId })), null);

  // Pathological multi-megabyte id rejected without OOM (the cursor itself is
  // ~10MB base64 so this also exercises the bounded-id check working before
  // any pagination code touches it).
  const hugeId = 'x'.repeat(10_000);
  assertEquals(decodeCursor(craftCursor({ at: '2026-04-22T12:34:56Z', id: hugeId })), null);
});

Deno.test('cursor B041 — empty id is accepted (head-watermark sentinel)', () => {
  // inbox.cursor() emits `{ at: epoch, id: '' }` for an empty inbox; the
  // round-trip must not break this contract.
  const decoded = decodeCursor(
    craftCursor({ at: '1970-01-01T00:00:00.000Z', id: '' }),
  );
  assertEquals(decoded, { at: '1970-01-01T00:00:00.000Z', id: '' });
});

Deno.test('cursor B041 — accepts ISO-8601 with fractional seconds and offset', () => {
  // Fractional seconds + Z
  const a = decodeCursor(craftCursor({ at: '2026-04-22T12:34:56.789Z', id: 'x' }));
  assertEquals(a, { at: '2026-04-22T12:34:56.789Z', id: 'x' });
  // ±HH:MM offset
  const b = decodeCursor(craftCursor({ at: '2026-04-22T12:34:56+02:00', id: 'y' }));
  assertEquals(b, { at: '2026-04-22T12:34:56+02:00', id: 'y' });
});

Deno.test('cursor B041 — boundary id length (256) accepted', () => {
  const exactly256 = 'a'.repeat(256);
  const decoded = decodeCursor(craftCursor({ at: '2026-04-22T12:34:56Z', id: exactly256 }));
  assertEquals(decoded?.id.length, 256);
});
