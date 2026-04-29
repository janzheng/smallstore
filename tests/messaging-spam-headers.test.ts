/**
 * Header heuristic helpers + headerHeuristicsHook tests.
 *
 * Covers each pure helper, hook label emission, and the trusted-sender
 * short-circuit (.brief/spam-layers.md decision #4).
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import {
  createHeaderHeuristicsHook,
  hasBulkWithoutListUnsubscribe,
  hasDmarcFail,
  hasFromReplyToMismatch,
  hasGenericDisplayName,
} from '../src/messaging/spam-headers.ts';
import type { SenderIndex } from '../src/messaging/sender-index.ts';
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
    received_at: '2026-04-28T12:00:00Z',
    summary: fields.subject ?? 'test',
    body: null,
    fields,
    labels: [],
    ...overrides,
  };
}

// ============================================================================
// hasFromReplyToMismatch
// ============================================================================

Deno.test('mismatch — same domain → false', () => {
  const item = makeItem({
    from_email: 'sender@example.com',
    headers: { 'reply-to': 'replies@example.com' },
  });
  assertEquals(hasFromReplyToMismatch(item), false);
});

Deno.test('mismatch — different domain → true', () => {
  const item = makeItem({
    from_email: 'sender@example.com',
    headers: { 'reply-to': 'attacker@evil.com' },
  });
  assertEquals(hasFromReplyToMismatch(item), true);
});

Deno.test('mismatch — no Reply-To header → false', () => {
  const item = makeItem({
    from_email: 'sender@example.com',
    headers: {},
  });
  assertEquals(hasFromReplyToMismatch(item), false);
});

Deno.test('mismatch — missing from_email → false', () => {
  const item = makeItem({
    headers: { 'reply-to': 'attacker@evil.com' },
  });
  assertEquals(hasFromReplyToMismatch(item), false);
});

Deno.test('mismatch — case-insensitive header key (Reply-To)', () => {
  const item = makeItem({
    from_email: 'sender@example.com',
    headers: { 'Reply-To': 'attacker@evil.com' },
  });
  assertEquals(hasFromReplyToMismatch(item), true);
});

// ============================================================================
// hasGenericDisplayName
// ============================================================================

Deno.test('display — "Team" → true', () => {
  const item = makeItem({ from_addr: 'Team <team@example.com>' });
  assertEquals(hasGenericDisplayName(item), true);
});

Deno.test('display — "Newsletter" → true', () => {
  const item = makeItem({ from_addr: 'Newsletter <news@example.com>' });
  assertEquals(hasGenericDisplayName(item), true);
});

Deno.test('display — "noreply" → true', () => {
  const item = makeItem({ from_addr: 'noreply <noreply@example.com>' });
  assertEquals(hasGenericDisplayName(item), true);
});

Deno.test('display — "Jane Doe" → false', () => {
  const item = makeItem({ from_addr: 'Jane Doe <jane@example.com>' });
  assertEquals(hasGenericDisplayName(item), false);
});

Deno.test('display — bare addr (no display name) → false', () => {
  const item = makeItem({ from_addr: 'jane@example.com' });
  assertEquals(hasGenericDisplayName(item), false);
});

Deno.test('display — quoted "Team" → true', () => {
  const item = makeItem({ from_addr: '"Team" <team@example.com>' });
  assertEquals(hasGenericDisplayName(item), true);
});

// ============================================================================
// hasBulkWithoutListUnsubscribe
// ============================================================================

Deno.test('bulk — "click here to unsubscribe" + no header → true', () => {
  const item = makeItem(
    { headers: {} },
    { body: 'Hi! click here to unsubscribe from this list.' },
  );
  assertEquals(hasBulkWithoutListUnsubscribe(item), true);
});

Deno.test('bulk — same body + List-Unsubscribe header → false', () => {
  const item = makeItem(
    { headers: { 'list-unsubscribe': '<https://example.com/unsub>' } },
    { body: 'Hi! click here to unsubscribe from this list.' },
  );
  assertEquals(hasBulkWithoutListUnsubscribe(item), false);
});

Deno.test('bulk — no unsubscribe text → false', () => {
  const item = makeItem(
    { headers: {} },
    { body: 'Just a normal newsletter body.' },
  );
  assertEquals(hasBulkWithoutListUnsubscribe(item), false);
});

Deno.test('bulk — null body → false', () => {
  const item = makeItem({ headers: {} }, { body: null });
  assertEquals(hasBulkWithoutListUnsubscribe(item), false);
});

Deno.test('bulk — HTML <a href> with unsubscribe + no header → true', () => {
  const item = makeItem(
    { headers: {} },
    { body: '<p>Hi <a href="https://e.com/u">unsubscribe here</a></p>' },
  );
  assertEquals(hasBulkWithoutListUnsubscribe(item), true);
});

// ============================================================================
// hasDmarcFail
// ============================================================================

Deno.test('dmarc — pass → "pass"', () => {
  const item = makeItem({
    headers: { 'authentication-results': 'mx.example.com; dmarc=pass header.from=example.com' },
  });
  assertEquals(hasDmarcFail(item), 'pass');
});

Deno.test('dmarc — fail → "fail"', () => {
  const item = makeItem({
    headers: { 'authentication-results': 'mx.example.com; dmarc=fail (p=none)' },
  });
  assertEquals(hasDmarcFail(item), 'fail');
});

Deno.test('dmarc — header missing → "none"', () => {
  const item = makeItem({ headers: {} });
  assertEquals(hasDmarcFail(item), 'none');
});

Deno.test('dmarc — header present without dmarc token → "unknown"', () => {
  const item = makeItem({
    headers: { 'authentication-results': 'mx.example.com; spf=pass smtp.mail=x@y.com' },
  });
  assertEquals(hasDmarcFail(item), 'unknown');
});

Deno.test('dmarc — case-insensitive header key', () => {
  const item = makeItem({
    headers: { 'Authentication-Results': 'mx.example.com; dmarc=fail' },
  });
  assertEquals(hasDmarcFail(item), 'fail');
});

// ============================================================================
// Hook
// ============================================================================

Deno.test('hook — clean item → accept', async () => {
  const hook = createHeaderHeuristicsHook();
  const item = makeItem({
    from_email: 'jane@example.com',
    from_addr: 'Jane Doe <jane@example.com>',
    headers: {
      'reply-to': 'jane@example.com',
      'list-unsubscribe': '<https://example.com/u>',
      'authentication-results': 'mx; dmarc=pass',
    },
  });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — emits header:dmarc-fail only on fail (not unknown/none)', async () => {
  const hook = createHeaderHeuristicsHook();
  // unknown → no label
  const unknownItem = makeItem({
    from_email: 'jane@example.com',
    headers: { 'authentication-results': 'mx; spf=pass' },
  });
  assertEquals(await hook(unknownItem, CTX), 'accept');

  // none (missing header) → no label
  const noneItem = makeItem({
    from_email: 'jane@example.com',
    headers: {},
  });
  assertEquals(await hook(noneItem, CTX), 'accept');

  // fail → label
  const failItem = makeItem({
    from_email: 'jane@example.com',
    headers: { 'authentication-results': 'mx; dmarc=fail' },
  });
  const verdict = await hook(failItem, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('header:dmarc-fail'));
});

Deno.test('hook — emits multiple labels when multiple heuristics fire', async () => {
  const hook = createHeaderHeuristicsHook();
  const item = makeItem(
    {
      from_email: 'sender@example.com',
      from_addr: 'Team <sender@example.com>',
      headers: {
        'reply-to': 'attacker@evil.com',
        'authentication-results': 'mx; dmarc=fail',
      },
    },
    { body: 'click here to unsubscribe please' },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('header:from-replyto-mismatch'));
  assert(verdict.labels?.includes('header:generic-display-name'));
  assert(verdict.labels?.includes('header:bulk-without-listunsubscribe'));
  assert(verdict.labels?.includes('header:dmarc-fail'));
});

Deno.test('hook — dedup: does not double-add already-present label', async () => {
  const hook = createHeaderHeuristicsHook();
  const item = makeItem(
    {
      from_email: 'sender@example.com',
      headers: {
        'reply-to': 'attacker@evil.com',
      },
    },
    { labels: ['header:from-replyto-mismatch'] },
  );
  const verdict = await hook(item, CTX);
  // Already present + nothing else fires → accept
  assertEquals(verdict, 'accept');
});

Deno.test('hook — trusted sender short-circuits even with mismatching headers', async () => {
  const stubSenderIndex: SenderIndex = {
    async get(addr: string) {
      if (addr === 'curator@example.com') {
        return {
          address: addr,
          first_seen: '2026-01-01T00:00:00Z',
          last_seen: '2026-04-28T00:00:00Z',
          count: 1,
          spam_count: 0,
          not_spam_count: 0,
          tags: ['trusted'],
        };
      }
      return null;
    },
    async upsert() {
      return null;
    },
    async query() {
      return { senders: [] };
    },
    async delete() {
      return false;
    },
    async setRecord() {},
  };

  const hook = createHeaderHeuristicsHook({ senderIndex: stubSenderIndex });
  const item = makeItem(
    {
      from_email: 'curator@example.com',
      from_addr: 'Team <curator@example.com>',
      headers: {
        'reply-to': 'attacker@evil.com',
        'authentication-results': 'mx; dmarc=fail',
      },
    },
    { body: 'click here to unsubscribe please' },
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — non-trusted sender via senderIndex still runs heuristics', async () => {
  const stubSenderIndex: SenderIndex = {
    async get() {
      return null;
    },
    async upsert() {
      return null;
    },
    async query() {
      return { senders: [] };
    },
    async delete() {
      return false;
    },
    async setRecord() {},
  };

  const hook = createHeaderHeuristicsHook({ senderIndex: stubSenderIndex });
  const item = makeItem({
    from_email: 'sender@example.com',
    headers: {
      'reply-to': 'attacker@evil.com',
    },
  });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('header:from-replyto-mismatch'));
});

Deno.test('hook — senderIndex.get throws → swallow + continue', async () => {
  const throwingIndex: SenderIndex = {
    async get() {
      throw new Error('boom');
    },
    async upsert() {
      return null;
    },
    async query() {
      return { senders: [] };
    },
    async delete() {
      return false;
    },
    async setRecord() {},
  };

  const hook = createHeaderHeuristicsHook({ senderIndex: throwingIndex });
  const item = makeItem({
    from_email: 'sender@example.com',
    headers: {
      'reply-to': 'attacker@evil.com',
    },
  });
  // Suppress the expected console.warn output during the test.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const verdict = await hook(item, CTX);
    if (typeof verdict === 'string') throw new Error('expected mutated item');
    assert(verdict.labels?.includes('header:from-replyto-mismatch'));
  } finally {
    console.warn = origWarn;
  }
});
