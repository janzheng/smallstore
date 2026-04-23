/**
 * Messaging — quarantine + restore tests.
 *
 * Exercises the label-based quarantine surface:
 *   - quarantineSink  (Sink factory used by the pipeline)
 *   - quarantineItem  (post-hoc tagging of an already-stored item)
 *   - restoreItem     (label removal)
 *   - listQuarantined (review-queue convenience query)
 *
 * Uses in-memory adapters throughout. No network, no D1.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import {
  DEFAULT_QUARANTINE_LABEL,
  listQuarantined,
  quarantineItem,
  quarantineSink,
  restoreItem,
} from '../src/messaging/quarantine.ts';
import type { InboxItem, SinkContext } from '../src/messaging/types.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeItem(
  id: string,
  receivedAt: string,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id,
    source: 'cf-email',
    received_at: receivedAt,
    summary: overrides.summary ?? `Subject ${id}`,
    body: overrides.body ?? `Body ${id}`,
    fields: overrides.fields ?? { from_email: 'sender@example.com' },
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

function freshInbox(name = 'quarantine-test') {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  return createInbox({ name, channel: 'cf-email', storage: { items, blobs } });
}

const CTX: SinkContext = { channel: 'cf-email' };

// ============================================================================
// quarantineSink
// ============================================================================

Deno.test('quarantineSink — ingests item with quarantined label added', async () => {
  const inbox = freshInbox();
  const sink = quarantineSink(inbox);

  const result = await sink(makeItem('a', '2026-04-22T12:00:00Z'), CTX);
  assertEquals(result.stored, true);
  assertEquals(result.id, 'a');

  const stored = await inbox.read('a');
  assertExists(stored);
  assertEquals(stored?.labels, [DEFAULT_QUARANTINE_LABEL]);
});

Deno.test('quarantineSink — preserves pre-existing labels', async () => {
  const inbox = freshInbox();
  const sink = quarantineSink(inbox);

  await sink(
    makeItem('a', '2026-04-22T12:00:00Z', { labels: ['newsletter', 'bulk'] }),
    CTX,
  );

  const stored = await inbox.read('a');
  const labels = new Set(stored?.labels ?? []);
  assertEquals(labels.has('newsletter'), true);
  assertEquals(labels.has('bulk'), true);
  assertEquals(labels.has(DEFAULT_QUARANTINE_LABEL), true);
});

Deno.test('quarantineSink — dedupes when quarantined label already present', async () => {
  const inbox = freshInbox();
  const sink = quarantineSink(inbox);

  await sink(
    makeItem('a', '2026-04-22T12:00:00Z', { labels: [DEFAULT_QUARANTINE_LABEL] }),
    CTX,
  );

  const stored = await inbox.read('a');
  const count = (stored?.labels ?? []).filter(
    (l) => l === DEFAULT_QUARANTINE_LABEL,
  ).length;
  assertEquals(count, 1);
});

Deno.test('quarantineSink — reason option adds a second label alongside', async () => {
  const inbox = freshInbox();
  const sink = quarantineSink(inbox, { reason: 'blocklist' });

  await sink(makeItem('a', '2026-04-22T12:00:00Z'), CTX);

  const stored = await inbox.read('a');
  const labels = new Set(stored?.labels ?? []);
  assertEquals(labels.has(DEFAULT_QUARANTINE_LABEL), true);
  assertEquals(labels.has('blocklist'), true);
});

Deno.test('quarantineSink — custom label option overrides default', async () => {
  const inbox = freshInbox();
  const sink = quarantineSink(inbox, { label: 'flagged' });

  await sink(makeItem('a', '2026-04-22T12:00:00Z'), CTX);

  const stored = await inbox.read('a');
  const labels = new Set(stored?.labels ?? []);
  assertEquals(labels.has('flagged'), true);
  assertEquals(labels.has(DEFAULT_QUARANTINE_LABEL), false);
});

// ============================================================================
// quarantineItem
// ============================================================================

Deno.test('quarantineItem — tags an existing item with the quarantine label', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T12:00:00Z'));

  const updated = await quarantineItem(inbox, 'a');
  assertExists(updated);
  assertEquals(updated?.labels?.includes(DEFAULT_QUARANTINE_LABEL), true);

  const reread = await inbox.read('a');
  assertEquals(reread?.labels?.includes(DEFAULT_QUARANTINE_LABEL), true);
});

Deno.test('quarantineItem — is idempotent (calling twice leaves one label)', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T12:00:00Z'));

  await quarantineItem(inbox, 'a');
  await quarantineItem(inbox, 'a');

  const stored = await inbox.read('a');
  const count = (stored?.labels ?? []).filter(
    (l) => l === DEFAULT_QUARANTINE_LABEL,
  ).length;
  assertEquals(count, 1);
});

Deno.test('quarantineItem — returns null for unknown id', async () => {
  const inbox = freshInbox();
  const result = await quarantineItem(inbox, 'does-not-exist');
  assertEquals(result, null);
});

Deno.test('quarantineItem — preserves existing labels and adds reason', async () => {
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem('a', '2026-04-22T12:00:00Z', { labels: ['newsletter'] }),
  );

  const updated = await quarantineItem(inbox, 'a', { reason: 'spam' });
  assertExists(updated);
  const labels = new Set(updated?.labels ?? []);
  assertEquals(labels.has('newsletter'), true);
  assertEquals(labels.has('spam'), true);
  assertEquals(labels.has(DEFAULT_QUARANTINE_LABEL), true);
});

// ============================================================================
// restoreItem
// ============================================================================

Deno.test('restoreItem — removes quarantine label, keeps other labels', async () => {
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem('a', '2026-04-22T12:00:00Z', {
      labels: [DEFAULT_QUARANTINE_LABEL, 'spam', 'newsletter'],
    }),
  );

  const restored = await restoreItem(inbox, 'a');
  assertExists(restored);
  const labels = new Set(restored?.labels ?? []);
  assertEquals(labels.has(DEFAULT_QUARANTINE_LABEL), false);
  assertEquals(labels.has('spam'), true);
  assertEquals(labels.has('newsletter'), true);
});

Deno.test('restoreItem — unsets labels entirely when quarantine was the only one', async () => {
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem('a', '2026-04-22T12:00:00Z', { labels: [DEFAULT_QUARANTINE_LABEL] }),
  );

  const restored = await restoreItem(inbox, 'a');
  assertExists(restored);
  assertEquals(restored?.labels, undefined);
});

Deno.test('restoreItem — returns null when item is not quarantined', async () => {
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem('a', '2026-04-22T12:00:00Z', { labels: ['newsletter'] }),
  );

  const restored = await restoreItem(inbox, 'a');
  assertEquals(restored, null);

  // Item untouched
  const stored = await inbox.read('a');
  assertEquals(stored?.labels, ['newsletter']);
});

Deno.test('restoreItem — returns null for unknown id', async () => {
  const inbox = freshInbox();
  const result = await restoreItem(inbox, 'does-not-exist');
  assertEquals(result, null);
});

Deno.test('restoreItem — custom label option', async () => {
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem('a', '2026-04-22T12:00:00Z', { labels: ['flagged', 'newsletter'] }),
  );

  const restored = await restoreItem(inbox, 'a', { label: 'flagged' });
  assertExists(restored);
  assertEquals(restored?.labels, ['newsletter']);
});

// ============================================================================
// listQuarantined
// ============================================================================

Deno.test('listQuarantined — returns only items with the quarantine label', async () => {
  const inbox = freshInbox();

  // Three items: two quarantined, one not
  await inbox._ingest(
    makeItem('a', '2026-04-22T10:00:00Z', { labels: [DEFAULT_QUARANTINE_LABEL] }),
  );
  await inbox._ingest(makeItem('b', '2026-04-22T11:00:00Z', { labels: ['newsletter'] }));
  await inbox._ingest(
    makeItem('c', '2026-04-22T12:00:00Z', {
      labels: [DEFAULT_QUARANTINE_LABEL, 'spam'],
    }),
  );

  const result = await listQuarantined(inbox);
  const ids = result.items.map((i) => i.id).sort();
  assertEquals(ids, ['a', 'c']);
});

Deno.test('listQuarantined — cursor pagination', async () => {
  const inbox = freshInbox();
  for (let i = 0; i < 5; i++) {
    await inbox._ingest(
      makeItem(`q${i}`, `2026-04-22T12:0${i}:00Z`, {
        labels: [DEFAULT_QUARANTINE_LABEL],
      }),
    );
  }

  const page1 = await listQuarantined(inbox, { limit: 2 });
  assertEquals(page1.items.length, 2);
  assertExists(page1.next_cursor);

  const page2 = await listQuarantined(inbox, {
    limit: 2,
    cursor: page1.next_cursor,
  });
  assertEquals(page2.items.length, 2);
  assertExists(page2.next_cursor);

  const page3 = await listQuarantined(inbox, {
    limit: 2,
    cursor: page2.next_cursor,
  });
  assertEquals(page3.items.length, 1);
  assertEquals(page3.next_cursor, undefined);

  const allIds = new Set(
    [...page1.items, ...page2.items, ...page3.items].map((i) => i.id),
  );
  assertEquals(allIds.size, 5);
});

Deno.test('listQuarantined — respects custom label', async () => {
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem('a', '2026-04-22T10:00:00Z', { labels: ['flagged'] }),
  );
  await inbox._ingest(
    makeItem('b', '2026-04-22T11:00:00Z', { labels: [DEFAULT_QUARANTINE_LABEL] }),
  );

  const result = await listQuarantined(inbox, { label: 'flagged' });
  assertEquals(result.items.map((i) => i.id), ['a']);
});

// ============================================================================
// Integration: main-view filtering pattern
// ============================================================================

Deno.test('exclude_labels — main view hides quarantined items', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T10:00:00Z'));
  await inbox._ingest(
    makeItem('b', '2026-04-22T11:00:00Z', {
      labels: [DEFAULT_QUARANTINE_LABEL, 'spam'],
    }),
  );
  await inbox._ingest(makeItem('c', '2026-04-22T12:00:00Z'));

  const main = await inbox.query({
    exclude_labels: [DEFAULT_QUARANTINE_LABEL],
  });
  const ids = main.items.map((i) => i.id).sort();
  assertEquals(ids, ['a', 'c']);
});

Deno.test('quarantineSink + restoreItem — round-trip', async () => {
  const inbox = freshInbox();
  const sink = quarantineSink(inbox, { reason: 'blocklist' });

  // 1. Sink quarantines a new item
  await sink(makeItem('a', '2026-04-22T12:00:00Z'), CTX);
  let stored = await inbox.read('a');
  assertEquals(stored?.labels?.includes(DEFAULT_QUARANTINE_LABEL), true);
  assertEquals(stored?.labels?.includes('blocklist'), true);

  // 2. Review-queue surfaces it
  const queue = await listQuarantined(inbox);
  assertEquals(queue.items.map((i) => i.id), ['a']);

  // 3. Restore removes quarantine label; reason label stays (audit trail)
  const restored = await restoreItem(inbox, 'a');
  assertExists(restored);
  assertEquals(restored?.labels?.includes(DEFAULT_QUARANTINE_LABEL), false);
  assertEquals(restored?.labels?.includes('blocklist'), true);

  // 4. Main view now sees it
  const main = await inbox.query({
    exclude_labels: [DEFAULT_QUARANTINE_LABEL],
  });
  assertEquals(main.items.map((i) => i.id), ['a']);

  // 5. Review queue no longer shows it
  const queueAfter = await listQuarantined(inbox);
  assertEquals(queueAfter.items, []);

  // 6. Second restore returns null (already restored)
  stored = await inbox.read('a');
  const restoredAgain = await restoreItem(inbox, 'a');
  assertEquals(restoredAgain, null);
});
