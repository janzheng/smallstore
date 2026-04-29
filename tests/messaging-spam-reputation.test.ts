/**
 * Sender reputation hook tests — Layer 3 of `.brief/spam-layers.md`.
 *
 * Covers:
 *   - computeConsiderDemote — trusted bypass + threshold math
 *   - hook trusted bypass (no label even at very high spam_rate)
 *   - min-count gate
 *   - high / medium / below-threshold label decisions
 *   - idempotency
 *   - missing sender / unknown sender → no-op
 *   - case-insensitive sender lookup round-trip
 *   - custom thresholds
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import {
  createSenderIndex,
  type SenderIndex,
  type SenderRecord,
} from '../src/messaging/sender-index.ts';
import {
  computeConsiderDemote,
  createSenderReputationHook,
} from '../src/messaging/spam-reputation.ts';
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

async function seedSender(
  senderIndex: SenderIndex,
  record: Partial<SenderRecord> & { address: string },
): Promise<void> {
  const full: SenderRecord = {
    address: record.address,
    first_seen: record.first_seen ?? '2026-01-01T00:00:00Z',
    last_seen: record.last_seen ?? '2026-04-28T00:00:00Z',
    count: record.count ?? 0,
    spam_count: record.spam_count ?? 0,
    not_spam_count: record.not_spam_count ?? 0,
    marked_at: record.marked_at,
    tags: record.tags ?? [],
    display_name: record.display_name,
    list_unsubscribe_url: record.list_unsubscribe_url,
  };
  await senderIndex.setRecord(full);
}

// ============================================================================
// computeConsiderDemote
// ============================================================================

Deno.test('computeConsiderDemote — not trusted → false', () => {
  assertEquals(
    computeConsiderDemote({ tags: [], spam_count: 10, not_spam_count: 0 }),
    false,
  );
});

Deno.test('computeConsiderDemote — trusted but below count threshold → false', () => {
  assertEquals(
    computeConsiderDemote({
      tags: ['trusted'],
      spam_count: 2,
      not_spam_count: 2,
    }),
    false,
  );
});

Deno.test('computeConsiderDemote — trusted + count=6 + spam_rate=0.5 → false (strict >0.5)', () => {
  assertEquals(
    computeConsiderDemote({
      tags: ['trusted'],
      spam_count: 3,
      not_spam_count: 3,
    }),
    false,
  );
});

Deno.test('computeConsiderDemote — trusted + count=5 + spam_rate=0.6 → true', () => {
  assertEquals(
    computeConsiderDemote({
      tags: ['trusted'],
      spam_count: 3,
      not_spam_count: 2,
    }),
    true,
  );
});

// ============================================================================
// Hook — behavioral cases
// ============================================================================

Deno.test('hook — trusted bypass: very high spam_rate but trusted → accept (no label)', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'jane@trusted.com',
    count: 100,
    spam_count: 95,
    not_spam_count: 0,
    tags: ['trusted'],
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'jane@trusted.com' });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — below min count → accept', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'low@example.com',
    count: 2,
    spam_count: 2,
    not_spam_count: 0,
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'low@example.com' });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — high threshold: spam_rate=1.0 → spam-suspect:high label appended', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'high@example.com',
    count: 10,
    spam_count: 8,
    not_spam_count: 0,
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'high@example.com' }, {
    labels: ['newsletter'],
  });
  const verdict = await hook(item, CTX);
  assert(typeof verdict === 'object', 'expected mutated item');
  assertEquals((verdict as InboxItem).labels, [
    'newsletter',
    'spam-suspect:high',
  ]);
});

Deno.test('hook — medium threshold: spam_rate=0.5 → spam-suspect:medium label appended', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'med@example.com',
    count: 10,
    spam_count: 4,
    not_spam_count: 4,
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'med@example.com' });
  const verdict = await hook(item, CTX);
  assert(typeof verdict === 'object', 'expected mutated item');
  assertEquals((verdict as InboxItem).labels, ['spam-suspect:medium']);
});

Deno.test('hook — below medium threshold: spam_rate=0.2 → accept (no label)', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'clean@example.com',
    count: 10,
    spam_count: 2,
    not_spam_count: 8,
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'clean@example.com' });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — idempotent: item already has spam-suspect:high → accept', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'high@example.com',
    count: 10,
    spam_count: 9,
    not_spam_count: 0,
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'high@example.com' }, {
    labels: ['spam-suspect:high'],
  });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — missing fields.from_email → accept', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({});
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — unknown sender (senderIndex.get returns null) → accept', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'nobody@example.com' });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — from_email normalized: stored lowercase, item mixed case → label fires', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'mixed@example.com',
    count: 10,
    spam_count: 8,
    not_spam_count: 0,
  });
  const hook = createSenderReputationHook({ senderIndex });
  const item = makeItem({ from_email: 'Mixed@Example.COM' });
  const verdict = await hook(item, CTX);
  assert(typeof verdict === 'object', 'expected mutated item');
  assert(
    (verdict as InboxItem).labels?.includes('spam-suspect:high'),
    'expected spam-suspect:high label',
  );
});

Deno.test('hook — custom highThreshold=0.9: spam_rate=0.8 → medium (not high)', async () => {
  const senderIndex = createSenderIndex(new MemoryAdapter());
  await seedSender(senderIndex, {
    address: 'mid@example.com',
    count: 10,
    spam_count: 8,
    not_spam_count: 2,
  });
  const hook = createSenderReputationHook({
    senderIndex,
    highThreshold: 0.9,
  });
  const item = makeItem({ from_email: 'mid@example.com' });
  const verdict = await hook(item, CTX);
  assert(typeof verdict === 'object', 'expected mutated item');
  assertEquals((verdict as InboxItem).labels, ['spam-suspect:medium']);
});
