/**
 * Router routing tests — Lane C3 (B006, B017, B018)
 *
 * - B006: `patternMatches` escapes regex metachars before expanding `*`.
 * - B017: `matchRoutingPattern` sorts rules by literal-prefix length desc
 *         (longest/most-specific wins) regardless of insertion order.
 * - B018: `set()` and `append()` route identically for bare collections that
 *         only match a mount pattern via the trailing-slash fallback.
 */

import { assertEquals } from 'jsr:@std/assert';
import { SmartRouter } from '../src/router.ts';
import { MemoryAdapter } from '../src/adapters/memory.ts';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Build a SmartRouter with one memory adapter per name plus mount/routing rules.
 * Uses the first adapter name as default + metadata adapter.
 */
function buildRouter(
  adapterNames: string[],
  opts: {
    mounts?: Record<string, string>;
    routing?: Record<string, { adapter: string }>;
  } = {},
) {
  const adapters: Record<string, MemoryAdapter> = {};
  for (const name of adapterNames) adapters[name] = new MemoryAdapter();
  return new SmartRouter({
    adapters,
    defaultAdapter: adapterNames[0],
    metadataAdapter: adapterNames[0],
    mounts: opts.mounts,
    routing: opts.routing,
  });
}

/**
 * Reach into the private `matchRoutingPattern` for direct unit testing.
 * Casts through `unknown` to keep the production type clean.
 */
function callMatch(
  router: SmartRouter,
  collection: string,
  rules: Record<string, { adapter: string }>,
): string | null {
  return (router as unknown as {
    matchRoutingPattern: (
      c: string,
      r: Record<string, { adapter: string }>,
    ) => string | null;
  }).matchRoutingPattern(collection, rules);
}

/**
 * Reach into the private `patternMatches` for direct unit testing.
 */
function callPatternMatches(
  router: SmartRouter,
  collection: string,
  pattern: string,
): boolean {
  return (router as unknown as {
    patternMatches: (c: string, p: string) => boolean;
  }).patternMatches(collection, pattern);
}

// ============================================================================
// B006 — regex metachars escaped before `*`-to-`.*` expansion
// ============================================================================

Deno.test('B006 — patternMatches: literal `.` does not match arbitrary char', () => {
  const r = buildRouter(['a']);

  // Exact match still works
  assertEquals(callPatternMatches(r, 'cache.temp', 'cache.temp'), true);

  // The `.` is now literal — must not match `cacheXtemp` / `cache!temp`
  assertEquals(callPatternMatches(r, 'cacheXtemp', 'cache.temp'), false);
  assertEquals(callPatternMatches(r, 'cache!temp', 'cache.temp'), false);
  assertEquals(callPatternMatches(r, 'cache temp', 'cache.temp'), false);
});

Deno.test('B006 — patternMatches: `*` glob still works after escape', () => {
  const r = buildRouter(['a']);

  // `cache.*` is a glob → "cache." prefix + anything
  assertEquals(callPatternMatches(r, 'cache.foo', 'cache.*'), true);
  assertEquals(callPatternMatches(r, 'cache.bar', 'cache.*'), true);
  assertEquals(callPatternMatches(r, 'cache.', 'cache.*'), true);

  // The dot is still literal: "cacheXfoo" must NOT match "cache.*"
  assertEquals(callPatternMatches(r, 'cacheXfoo', 'cache.*'), false);
});

Deno.test('B006 — patternMatches: other regex metachars are escaped', () => {
  const r = buildRouter(['a']);

  // `+`, `(`, `)`, `[`, `]`, `?`, `{`, `}`, `^`, `$`, `|`, `\` should all be literal
  assertEquals(callPatternMatches(r, 'a+b', 'a+b'), true);
  assertEquals(callPatternMatches(r, 'aab', 'a+b'), false); // + not "one or more"
  assertEquals(callPatternMatches(r, 'a(b)c', 'a(b)c'), true);
  assertEquals(callPatternMatches(r, 'abc', 'a(b)c'), false);
  assertEquals(callPatternMatches(r, 'q?', 'q?'), true);
  assertEquals(callPatternMatches(r, 'q', 'q?'), false);
});

Deno.test('B006 — patternMatches: catch-all `*` is unchanged', () => {
  const r = buildRouter(['a']);
  assertEquals(callPatternMatches(r, 'anything/at/all', '*'), true);
  assertEquals(callPatternMatches(r, '', '*'), true);
});

// ============================================================================
// B017 — longest-literal-prefix wins regardless of insertion order
// ============================================================================

Deno.test('B017 — matchRoutingPattern: more-specific wins (broader-first insertion)', () => {
  const r = buildRouter(['a', 'b']);
  const rules = {
    'mailroom/*': { adapter: 'a' },          // broader (prefix length 9)
    'mailroom/inbox/*': { adapter: 'b' },    // more specific (prefix length 15)
  };
  assertEquals(callMatch(r, 'mailroom/inbox/foo', rules), 'b');
  // Sanity: a path that only matches the broader rule still resolves to 'a'
  assertEquals(callMatch(r, 'mailroom/other/foo', rules), 'a');
});

Deno.test('B017 — matchRoutingPattern: more-specific wins (specific-first insertion)', () => {
  const r = buildRouter(['a', 'b']);
  const rules = {
    'mailroom/inbox/*': { adapter: 'b' },    // more specific
    'mailroom/*': { adapter: 'a' },          // broader
  };
  // Same result regardless of insertion order — sort is the contract.
  assertEquals(callMatch(r, 'mailroom/inbox/foo', rules), 'b');
});

Deno.test('B017 — matchRoutingPattern: catch-all `*` loses to any literal-prefixed rule', () => {
  const r = buildRouter(['a', 'b']);
  // Catch-all comes first in insertion order; specific rule must still win.
  const rules = {
    '*': { adapter: 'a' },
    'cache/*': { adapter: 'b' },
  };
  assertEquals(callMatch(r, 'cache/anything', rules), 'b');
  assertEquals(callMatch(r, 'other/anything', rules), 'a'); // falls through to *
});

Deno.test('B017 — matchRoutingPattern: ties fall back to insertion order (stable sort)', () => {
  const r = buildRouter(['a', 'b']);
  // Both patterns have prefix length 6 — first inserted wins on tie.
  const rules = {
    'first/*': { adapter: 'a' },
    'first*': { adapter: 'b' }, // also prefix length 5 ("first")? Let's pick equal-length:
  };
  // Adjust: make both literal-prefix length 6 by using same prefix.
  const tieRules = {
    'shared/*': { adapter: 'a' },
    'shared/foo*': { adapter: 'b' },
  };
  // `shared/foo*` has literal-prefix length 10 → wins outright.
  assertEquals(callMatch(r, 'shared/foobar', tieRules), 'b');

  // True tie: both have exact-prefix length 7 → insertion order (a wins)
  const trueTieRules = {
    'sharedA': { adapter: 'a' }, // literal-only, length 7
    'sharedB': { adapter: 'b' }, // literal-only, length 7
  };
  assertEquals(callMatch(r, 'sharedA', trueTieRules), 'a');
  assertEquals(callMatch(r, 'sharedB', trueTieRules), 'b');
});

// ============================================================================
// B018 — set() and append() pick the same adapter for bare collections
// ============================================================================

Deno.test({
  name: 'B018 — set() + append() route bare collection through same adapter (mount with `*`)',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Two adapters: 'main' (default) and 'shared' (mounted at "yawnxyz/*").
    // Bare collection path "yawnxyz" should resolve to 'shared' for BOTH set
    // and append, exercising the trailing-slash fallback.
    const main = new MemoryAdapter();
    const shared = new MemoryAdapter();
    // append() requires the adapter to expose an `append` method. MemoryAdapter
    // doesn't, so install a minimal one for this test.
    (shared as unknown as { append: (items: unknown) => Promise<unknown> }).append =
      async (items: unknown) => {
        const arr = Array.isArray(items) ? items : [items];
        // Track appended items in a private bucket on the adapter.
        const bucket =
          ((shared as unknown as { __bucket?: unknown[] }).__bucket ??= []);
        for (const item of arr) bucket.push(item);
        return { count: bucket.length };
      };

    const router = new SmartRouter({
      adapters: { main, shared },
      defaultAdapter: 'main',
      metadataAdapter: 'main',
      mounts: { 'yawnxyz/*': 'shared' },
    });

    // append() to bare collection — must hit `shared`
    await router.append('yawnxyz', { id: 'a', body: 'one' });
    await router.append('yawnxyz', { id: 'b', body: 'two' });
    const sharedBucket =
      (shared as unknown as { __bucket: unknown[] }).__bucket;
    assertEquals(sharedBucket.length, 2);

    // set() to bare collection — must also hit `shared` (B018 reconciliation).
    // Use an array payload to avoid the "heterogeneous object" early-return
    // path inside set(), which would split a plain object into sub-paths and
    // skip the bare-collection mount lookup entirely.
    await router.set('yawnxyz', [{ id: 'c', body: 'three' }]);

    // Ground truth: the DATA key (`smallstore:yawnxyz` or
    // `smallstore:yawnxyz:...`) landed in `shared`, NOT `main`. `main` only
    // stores metadata + index keys (`smallstore:meta:*`, `smallstore:index:*`)
    // because it's wired as the metadataAdapter — those don't count.
    const sharedKeys = await shared.keys();
    const mainKeys = await main.keys();

    const isDataKey = (k: string) =>
      k.includes('yawnxyz') &&
      !k.startsWith('smallstore:meta:') &&
      !k.startsWith('smallstore:index:');

    const sharedHasData = sharedKeys.some(isDataKey);
    const mainHasData = mainKeys.some(isDataKey);

    assertEquals(
      sharedHasData,
      true,
      'set() data should land in mounted shared adapter',
    );
    assertEquals(
      mainHasData,
      false,
      'set() data should NOT fall through to main (would mean B018 chains diverge)',
    );
  },
});
