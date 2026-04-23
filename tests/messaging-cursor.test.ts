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
