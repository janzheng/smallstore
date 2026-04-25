/**
 * Auto-confirm hook tests.
 *
 * Covers parse, glob match, URL safety, and the full hook flow with
 * an injected fetch so no network traffic leaves the test runner.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import {
  createAutoConfirmHook,
  isSafeUrl,
  isSenderAllowed,
  parseAllowedSenders,
} from '../src/messaging/auto-confirm.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

const CTX: HookContext = { channel: 'cf-email', registration: 'test' };

function makeItem(
  fields: Record<string, any> = {},
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id: 'item-test',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-24T12:00:00Z',
    summary: fields.subject ?? 'test',
    body: null,
    fields,
    labels: ['newsletter', 'needs-confirm'],
    ...overrides,
  };
}

// Simple stub fetcher — returns a pre-canned Response.
function stubFetch(status: number, body: string = ''): typeof fetch {
  return async (_input: unknown): Promise<Response> => {
    return new Response(body, { status });
  };
}

function throwingFetch(msg: string): typeof fetch {
  return async (_input: unknown): Promise<Response> => {
    throw new Error(msg);
  };
}

// ============================================================================
// parseAllowedSenders
// ============================================================================

Deno.test('parse — undefined → []', () => {
  assertEquals(parseAllowedSenders(undefined), []);
});

Deno.test('parse — empty string → []', () => {
  assertEquals(parseAllowedSenders(''), []);
});

Deno.test('parse — array lowercases + trims', () => {
  assertEquals(
    parseAllowedSenders(['  *@Substack.com  ', '*@ConvertKit.com']),
    ['*@substack.com', '*@convertkit.com'],
  );
});

Deno.test('parse — CSV form', () => {
  assertEquals(
    parseAllowedSenders('*@substack.com, *@convertkit.com,*@beehiiv.com'),
    ['*@substack.com', '*@convertkit.com', '*@beehiiv.com'],
  );
});

Deno.test('parse — CSV drops empty entries', () => {
  assertEquals(
    parseAllowedSenders('*@a.com,,  ,*@b.com'),
    ['*@a.com', '*@b.com'],
  );
});

// ============================================================================
// isSenderAllowed
// ============================================================================

Deno.test('allowed — wildcard domain matches', () => {
  assert(isSenderAllowed('hi@substack.com', ['*@substack.com']));
});

Deno.test('allowed — subdomain wildcard matches', () => {
  assert(isSenderAllowed('notifications@mg.substack.com', ['*substack.com']));
});

Deno.test('allowed — case-insensitive match', () => {
  assert(isSenderAllowed('Hi@Substack.COM', ['*@substack.com']));
});

Deno.test('allowed — no patterns → false', () => {
  assertEquals(isSenderAllowed('hi@substack.com', []), false);
});

Deno.test('allowed — no match → false', () => {
  assertEquals(isSenderAllowed('hi@randomspam.com', ['*@substack.com']), false);
});

Deno.test('allowed — empty / null address → false', () => {
  assertEquals(isSenderAllowed('', ['*@substack.com']), false);
  assertEquals(isSenderAllowed(null, ['*@substack.com']), false);
  assertEquals(isSenderAllowed(undefined, ['*@substack.com']), false);
});

Deno.test('allowed — regex metachars in pattern are escaped (only * is wildcard)', () => {
  // If "." were treated as a regex metachar, "axsubstackxcom" would match.
  assertEquals(isSenderAllowed('hi@substackxcom', ['*@substack.com']), false);
});

Deno.test('allowed — anchored (no substring matches)', () => {
  // Pattern *@substack.com should NOT match *@substack.com.evil.co
  assertEquals(
    isSenderAllowed('hi@substack.com.evil.co', ['*@substack.com']),
    false,
  );
});

// ============================================================================
// isSafeUrl
// ============================================================================

Deno.test('url — https with domain host → true', () => {
  assert(isSafeUrl('https://substack.com/confirm?t=abc'));
});

Deno.test('url — http (not https) → false', () => {
  assertEquals(isSafeUrl('http://substack.com/confirm?t=abc'), false);
});

Deno.test('url — IPv4 host → false', () => {
  assertEquals(isSafeUrl('https://192.168.1.1/confirm'), false);
});

Deno.test('url — IPv6 host → false', () => {
  assertEquals(isSafeUrl('https://[::1]/confirm'), false);
});

Deno.test('url — unsubscribe in path → false', () => {
  assertEquals(isSafeUrl('https://example.com/unsubscribe/abc'), false);
});

Deno.test('url — opt-out in query → false', () => {
  assertEquals(isSafeUrl('https://example.com/confirm?opt-out=true'), false);
});

Deno.test('url — malformed → false', () => {
  assertEquals(isSafeUrl('not a url'), false);
});

Deno.test('url — empty / null → false', () => {
  assertEquals(isSafeUrl(''), false);
  assertEquals(isSafeUrl(null), false);
  assertEquals(isSafeUrl(undefined), false);
});

// ============================================================================
// Hook — pass-through cases
// ============================================================================

Deno.test('hook — empty allowlist → accept (pass-through)', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: [], fetch: stubFetch(200) });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm?t=abc',
  });
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

Deno.test('hook — no needs-confirm label → accept', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: stubFetch(200) });
  const item = makeItem(
    { from_email: 'hi@substack.com', confirm_url: 'https://substack.com/confirm' },
    { labels: ['newsletter'] },
  );
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

Deno.test('hook — already auto-confirmed → idempotent', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: stubFetch(200) });
  const item = makeItem(
    { from_email: 'hi@substack.com', confirm_url: 'https://substack.com/confirm' },
    { labels: ['newsletter', 'needs-confirm', 'auto-confirmed'] },
  );
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

Deno.test('hook — already manually confirmed → skip', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: stubFetch(200) });
  const item = makeItem(
    { from_email: 'hi@substack.com', confirm_url: 'https://substack.com/confirm' },
    { labels: ['newsletter', 'needs-confirm', 'confirmed'] },
  );
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

Deno.test('hook — sender not in allowlist → accept', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: stubFetch(200) });
  const item = makeItem({
    from_email: 'random@unknown.com',
    confirm_url: 'https://unknown.com/confirm',
  });
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

Deno.test('hook — unsafe URL (http) → accept (pass-through)', async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return new Response('', { status: 200 });
  };
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: fetcher });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'http://substack.com/confirm', // http, not https
  });
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
  assertEquals(called, false); // fetch never invoked
});

Deno.test('hook — unsafe URL (IP host) → accept', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: stubFetch(200) });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://10.0.0.1/confirm',
  });
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

Deno.test('hook — missing confirm_url → accept', async () => {
  const hook = createAutoConfirmHook({ allowedSenders: ['*@substack.com'], fetch: stubFetch(200) });
  const item = makeItem({ from_email: 'hi@substack.com' });
  const v = await hook(item, CTX);
  assertEquals(v, 'accept');
});

// ============================================================================
// Hook — success path
// ============================================================================

Deno.test('hook — allowed sender + safe URL + 200 → strips needs-confirm, adds auto-confirmed, writes status', async () => {
  const hook = createAutoConfirmHook({
    allowedSenders: ['*@substack.com'],
    fetch: stubFetch(200, 'Thanks!'),
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm?t=abc',
  });
  const v = await hook(item, CTX);
  if (typeof v === 'string') throw new Error('expected mutated item');

  assert(!v.labels?.includes('needs-confirm'));
  assert(v.labels?.includes('auto-confirmed'));
  assert(v.labels?.includes('newsletter')); // unrelated labels preserved
  assertEquals(v.fields.auto_confirm_status, 200);
  assertEquals(typeof v.fields.auto_confirmed_at, 'string');
});

Deno.test('hook — 302 redirect status counts as success', async () => {
  const hook = createAutoConfirmHook({
    allowedSenders: ['*@substack.com'],
    fetch: stubFetch(302),
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm?t=abc',
  });
  const v = await hook(item, CTX);
  if (typeof v === 'string') throw new Error('expected mutated item');
  assert(v.labels?.includes('auto-confirmed'));
});

// ============================================================================
// Hook — failure paths
// ============================================================================

Deno.test('hook — upstream 404 → labels unchanged, error written', async () => {
  const hook = createAutoConfirmHook({
    allowedSenders: ['*@substack.com'],
    fetch: stubFetch(404),
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm?t=abc',
  });
  const v = await hook(item, CTX);
  if (typeof v === 'string') throw new Error('expected mutated item');

  // Labels preserved so manual retry still works.
  assert(v.labels?.includes('needs-confirm'));
  assert(!v.labels?.includes('auto-confirmed'));
  assertEquals(v.fields.auto_confirm_error, 'HTTP 404');
  assertEquals(typeof v.fields.auto_confirm_attempted_at, 'string');
});

Deno.test('hook — fetch exception → labels unchanged, error written', async () => {
  const hook = createAutoConfirmHook({
    allowedSenders: ['*@substack.com'],
    fetch: throwingFetch('ECONNREFUSED'),
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm?t=abc',
  });
  const v = await hook(item, CTX);
  if (typeof v === 'string') throw new Error('expected mutated item');

  assert(v.labels?.includes('needs-confirm'));
  assertEquals(v.fields.auto_confirm_error, 'ECONNREFUSED');
});

// ============================================================================
// Hook — invariants
// ============================================================================

Deno.test('hook — does not mutate input', async () => {
  const hook = createAutoConfirmHook({
    allowedSenders: ['*@substack.com'],
    fetch: stubFetch(200),
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm?t=abc',
  });
  const snapshot = JSON.stringify(item);
  await hook(item, CTX);
  assertEquals(JSON.stringify(item), snapshot);
});

Deno.test('hook — CSV allowlist config works', async () => {
  const hook = createAutoConfirmHook({
    allowedSenders: '*@substack.com,*@convertkit.com',
    fetch: stubFetch(200),
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm',
  });
  const v = await hook(item, CTX);
  if (typeof v === 'string') throw new Error('expected mutated item');
  assert(v.labels?.includes('auto-confirmed'));
});

// ============================================================================
// Dynamic pattern source (`getPatterns`) — runtime-editable allowlist
// ============================================================================

Deno.test('dynamic — getPatterns called per invocation; new pattern takes effect', async () => {
  let patterns: string[] = []; // mutable backing store
  const hook = createAutoConfirmHook({
    getPatterns: async () => patterns,
    fetch: stubFetch(200),
    cacheTtlMs: 0, // bypass cache for the test
  });

  const item1 = makeItem({
    from_email: 'hi@beehiiv.com',
    confirm_url: 'https://beehiiv.com/confirm/abc',
  });

  // No patterns yet — passthrough.
  const before = await hook(item1, CTX);
  assertEquals(before, 'accept');

  // Add a pattern — next invocation auto-confirms.
  patterns = ['*@beehiiv.com'];
  const item2 = makeItem({
    from_email: 'hi@beehiiv.com',
    confirm_url: 'https://beehiiv.com/confirm/abc',
  });
  const after = await hook(item2, CTX);
  if (typeof after === 'string') throw new Error('expected mutated item');
  assert(after.labels?.includes('auto-confirmed'));
});

Deno.test('dynamic — cache TTL avoids hammering getPatterns on every call', async () => {
  let calls = 0;
  const hook = createAutoConfirmHook({
    getPatterns: async () => {
      calls++;
      return ['*@substack.com'];
    },
    fetch: stubFetch(200),
    cacheTtlMs: 60_000, // long TTL
  });

  // Call 5 times; getPatterns should only fire once thanks to the cache.
  for (let i = 0; i < 5; i++) {
    const item = makeItem({
      from_email: `n${i}@substack.com`,
      confirm_url: `https://substack.com/confirm/${i}`,
    });
    await hook(item, CTX);
  }
  assertEquals(calls, 1);
});

Deno.test('dynamic — getPatterns failure falls back to stale cache when present', async () => {
  let mode: 'ok' | 'fail' = 'ok';
  const hook = createAutoConfirmHook({
    getPatterns: async () => {
      if (mode === 'fail') throw new Error('D1 down');
      return ['*@substack.com'];
    },
    fetch: stubFetch(200),
    cacheTtlMs: 0, // force re-fetch each call
  });

  // Prime cache with a successful call.
  const okItem = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm/1',
  });
  const v1 = await hook(okItem, CTX);
  if (typeof v1 === 'string') throw new Error('expected mutated item');
  assert(v1.labels?.includes('auto-confirmed'));

  // Flip to failure — hook should still auto-confirm using the cached patterns.
  mode = 'fail';
  const failItem = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm/2',
  });
  const v2 = await hook(failItem, CTX);
  if (typeof v2 === 'string') throw new Error('expected mutated item');
  assert(v2.labels?.includes('auto-confirmed'));
});

Deno.test('dynamic — getPatterns returning [] disables hook (passthrough)', async () => {
  const hook = createAutoConfirmHook({
    getPatterns: async () => [],
    fetch: stubFetch(200),
    cacheTtlMs: 0,
  });
  const item = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm',
  });
  assertEquals(await hook(item, CTX), 'accept');
});

Deno.test('dynamic — getPatterns wins when both static and dynamic sources are set', async () => {
  // Static says `*@substack.com`, dynamic says `*@beehiiv.com` — dynamic wins.
  const hook = createAutoConfirmHook({
    allowedSenders: ['*@substack.com'],
    getPatterns: async () => ['*@beehiiv.com'],
    fetch: stubFetch(200),
    cacheTtlMs: 0,
  });

  const substackItem = makeItem({
    from_email: 'hi@substack.com',
    confirm_url: 'https://substack.com/confirm',
  });
  // Substack should NOT auto-confirm — dynamic doesn't include it.
  assertEquals(await hook(substackItem, CTX), 'accept');

  const beehiivItem = makeItem({
    from_email: 'hi@beehiiv.com',
    confirm_url: 'https://beehiiv.com/confirm',
  });
  const v = await hook(beehiivItem, CTX);
  if (typeof v === 'string') throw new Error('expected mutated item');
  assert(v.labels?.includes('auto-confirmed'));
});
