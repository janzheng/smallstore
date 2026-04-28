/**
 * Tests for `timingSafeEqualString` — constant-time bearer-token compare
 * (audit finding B011).
 *
 * The function isn't strictly constant-time at the CPU-cycle level (JS chars
 * are u16 codepoints, not bytes) but the contract is:
 *   - all matching pairs return true
 *   - all mismatching pairs (length OR character) return false
 *   - the loop iterates `max(aLen, bLen)` codepoints regardless of where the
 *     mismatch is, so wall-time timing doesn't reveal mismatch position
 *
 * We test the correctness contract here. The constant-time property is
 * tested-by-construction (the loop body has no early exit).
 */

import { assertEquals } from 'jsr:@std/assert@1';
import { timingSafeEqualString } from '../src/http/timing-safe.ts';

Deno.test('timingSafeEqualString: equal strings return true', () => {
  assertEquals(timingSafeEqualString('abc', 'abc'), true);
  assertEquals(timingSafeEqualString('Bearer eyJhbGciOi...', 'Bearer eyJhbGciOi...'), true);
  assertEquals(timingSafeEqualString('', ''), true);
});

Deno.test('timingSafeEqualString: mismatched chars return false', () => {
  assertEquals(timingSafeEqualString('abc', 'abd'), false);
  assertEquals(timingSafeEqualString('Bearer abc', 'Bearer abd'), false);
});

Deno.test('timingSafeEqualString: different lengths return false', () => {
  // A shorter prefix of the secret should NOT match — without the length-XOR
  // priming the accumulator could remain zero on length mismatch.
  assertEquals(timingSafeEqualString('Bearer abc', 'Bearer abcd'), false);
  assertEquals(timingSafeEqualString('Bearer abcd', 'Bearer abc'), false);
  assertEquals(timingSafeEqualString('', 'a'), false);
  assertEquals(timingSafeEqualString('a', ''), false);
});

Deno.test('timingSafeEqualString: non-string inputs return false', () => {
  // deno-lint-ignore no-explicit-any
  assertEquals(timingSafeEqualString(undefined as any, 'abc'), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(timingSafeEqualString('abc', null as any), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(timingSafeEqualString(123 as any, 123 as any), false);
});

Deno.test('timingSafeEqualString: position of mismatch does not short-circuit', () => {
  // Smoke check that the loop runs to completion regardless of where the
  // mismatch is. Both calls iterate the same number of codepoints; we
  // can't measure timing reliably in a unit test, but we can at least
  // verify both return false (no early return that would otherwise let a
  // bug like "true on first match" sneak through).
  assertEquals(timingSafeEqualString('aaaaaaaa', 'baaaaaaa'), false); // mismatch at index 0
  assertEquals(timingSafeEqualString('aaaaaaaa', 'aaaaaaab'), false); // mismatch at index 7
});
