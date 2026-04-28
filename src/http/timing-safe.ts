/**
 * Constant-time string equality for bearer-token comparison.
 *
 * Rationale: `a === b` short-circuits at the first mismatched character,
 * which leaks character-position-by-character timing on a high-entropy
 * secret. Over HTTPS the network jitter usually dominates, but the
 * cryptographically-correct approach is to fold every byte into the
 * comparison and only branch on the final accumulator.
 *
 * Usage is for ASCII / printable bearer tokens — we compare string
 * codepoints rather than byte streams. This is fine for tokens issued by
 * `wrangler secret put` (printable subset) and avoids the async overhead
 * of `crypto.subtle.timingSafeEqual` for what should be a sub-millisecond
 * call on every request.
 *
 * Both inputs must be strings; non-strings return false. A length mismatch
 * is folded into the accumulator so it never short-circuits the loop.
 */
export function timingSafeEqualString(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length;
  const bLen = b.length;
  // Iterate over the longer string so we always do `len` codepoint reads
  // regardless of which side is longer. The XOR-of-lengths primes the
  // accumulator with a non-zero value on length mismatch so the function
  // returns false even if all overlapping characters happen to match.
  const len = aLen >= bLen ? aLen : bLen;
  let mismatch = aLen ^ bLen;
  for (let i = 0; i < len; i++) {
    const ca = i < aLen ? a.charCodeAt(i) : 0;
    const cb = i < bLen ? b.charCodeAt(i) : 0;
    mismatch |= (ca ^ cb);
  }
  return mismatch === 0;
}
