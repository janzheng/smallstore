/**
 * Messaging — sender index tests.
 *
 * Exercises the `createSenderIndex` factory against `MemoryAdapter`:
 * upsert lifecycle, tag merging, spam accounting, List-Unsubscribe parsing,
 * tag-filtered query, cursor pagination, and delete.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createSenderIndex, parseListUnsubscribe } from '../src/messaging/sender-index.ts';
import type { InboxItem } from '../src/messaging/types.ts';

function makeItem(overrides: Partial<InboxItem> & { fields?: Record<string, any> } = {}): InboxItem {
  return {
    id: overrides.id ?? 'id-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'cf-email',
    received_at: overrides.received_at ?? '2026-04-22T12:00:00Z',
    summary: overrides.summary ?? 'Hello',
    body: overrides.body ?? 'Body text',
    fields: {
      from_email: 'jane@example.com',
      from_addr: '"Jane Doe" <jane@example.com>',
      ...overrides.fields,
    },
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

function freshIndex() {
  const adapter = new MemoryAdapter();
  const index = createSenderIndex(adapter);
  return { adapter, index };
}

Deno.test('sender-index — upsert creates a new record with count=1 and first_seen', async () => {
  const { index } = freshIndex();
  const record = await index.upsert(makeItem({ received_at: '2026-04-22T10:00:00Z' }));

  assertExists(record);
  assertEquals(record!.address, 'jane@example.com');
  assertEquals(record!.count, 1);
  assertEquals(record!.spam_count, 0);
  assertEquals(record!.first_seen, '2026-04-22T10:00:00Z');
  assertEquals(record!.last_seen, '2026-04-22T10:00:00Z');
  assertEquals(record!.display_name, '"Jane Doe" <jane@example.com>');
});

Deno.test('sender-index — second upsert bumps count, updates last_seen, keeps first_seen', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ received_at: '2026-04-22T10:00:00Z' }));
  const record = await index.upsert(makeItem({ received_at: '2026-04-22T12:00:00Z' }));

  assertEquals(record!.count, 2);
  assertEquals(record!.first_seen, '2026-04-22T10:00:00Z');
  assertEquals(record!.last_seen, '2026-04-22T12:00:00Z');
});

Deno.test('sender-index — missing from_email skips upsert (no record, no throw)', async () => {
  const { adapter, index } = freshIndex();
  const result = await index.upsert(makeItem({ fields: { from_email: undefined } }));
  assertEquals(result, null);
  const keys = await adapter.keys('senders/');
  assertEquals(keys.length, 0);
});

Deno.test('sender-index — empty string from_email skips upsert', async () => {
  const { adapter, index } = freshIndex();
  const result = await index.upsert(makeItem({ fields: { from_email: '   ' } }));
  assertEquals(result, null);
  const keys = await adapter.keys('senders/');
  assertEquals(keys.length, 0);
});

Deno.test('sender-index — address is normalized to lowercase + trimmed', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ fields: { from_email: '  Jane@Example.COM  ' } }));
  const record = await index.get('JANE@example.com');
  assertExists(record);
  assertEquals(record!.address, 'jane@example.com');
});

Deno.test('sender-index — display_name updates to latest observed value', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ fields: { from_addr: '"Jane Doe" <jane@example.com>' } }));
  const record = await index.upsert(
    makeItem({ fields: { from_addr: '"Jane D." <jane@example.com>' } }),
  );
  assertEquals(record!.display_name, '"Jane D." <jane@example.com>');
});

Deno.test('sender-index — extracts list_unsubscribe_url from header (prefers https)', async () => {
  const { index } = freshIndex();
  const record = await index.upsert(makeItem({
    fields: {
      headers: {
        'list-unsubscribe': '<mailto:unsub@example.com>, <https://example.com/unsub?u=123>',
      },
    },
  }));
  assertEquals(record!.list_unsubscribe_url, 'https://example.com/unsub?u=123');
});

Deno.test('sender-index — list_unsubscribe_url falls back to mailto when no https', async () => {
  const { index } = freshIndex();
  const record = await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<mailto:unsub@example.com>' },
    },
  }));
  assertEquals(record!.list_unsubscribe_url, 'mailto:unsub@example.com');
});

Deno.test('sender-index — list_unsubscribe_url is preserved across later upserts', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<https://example.com/unsub?u=123>' },
    },
  }));
  // Second item without the header — existing url should stick.
  const record = await index.upsert(makeItem({}));
  assertEquals(record!.list_unsubscribe_url, 'https://example.com/unsub?u=123');
});

Deno.test('sender-index — spam_count increments on spam or quarantine labels', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ labels: ['spam'] }));
  await index.upsert(makeItem({ labels: ['newsletter'] }));
  const record = await index.upsert(makeItem({ labels: ['quarantine', 'newsletter'] }));
  assertEquals(record!.count, 3);
  assertEquals(record!.spam_count, 2); // spam + quarantine
});

Deno.test('sender-index — tags merge from item labels; bounce → bounce-source', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ labels: ['newsletter'] }));
  await index.upsert(makeItem({ labels: ['bounce'] }));
  const record = await index.get('jane@example.com');
  assertExists(record);
  const tags = new Set(record!.tags);
  assertEquals(tags.has('newsletter'), true);
  assertEquals(tags.has('bounce'), true);
  assertEquals(tags.has('bounce-source'), true);
  // 'unsubscribed' must NOT auto-appear just because of ingest.
  assertEquals(tags.has('unsubscribed'), false);
});

Deno.test('sender-index — query filters by tags (all required)', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: { from_email: 'newsletter@substack.com', from_addr: 'Sub' },
    labels: ['newsletter'],
  }));
  await index.upsert(makeItem({
    fields: { from_email: 'boss@company.com', from_addr: 'Boss' },
    labels: [],
  }));
  await index.upsert(makeItem({
    fields: { from_email: 'daemon@mail.com', from_addr: 'Mailer' },
    labels: ['bounce'],
  }));

  const newsletters = await index.query({ tags: ['newsletter'] });
  assertEquals(newsletters.senders.map((s) => s.address), ['newsletter@substack.com']);

  const bounceSources = await index.query({ tags: ['bounce-source'] });
  assertEquals(bounceSources.senders.map((s) => s.address), ['daemon@mail.com']);

  const all = await index.query();
  assertEquals(all.senders.length, 3);
});

Deno.test('sender-index — query honors limit + cursor for pagination', async () => {
  const { index } = freshIndex();
  for (const local of ['a', 'b', 'c', 'd']) {
    await index.upsert(makeItem({
      fields: { from_email: `${local}@example.com`, from_addr: local },
    }));
  }

  const page1 = await index.query({ limit: 2 });
  assertEquals(page1.senders.map((s) => s.address), ['a@example.com', 'b@example.com']);
  assertEquals(page1.next_cursor, 'b@example.com');

  const page2 = await index.query({ limit: 2, cursor: page1.next_cursor });
  assertEquals(page2.senders.map((s) => s.address), ['c@example.com', 'd@example.com']);
  assertEquals(page2.next_cursor, undefined);
});

Deno.test('sender-index — delete removes record and returns true only when present', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ fields: { from_email: 'gone@example.com', from_addr: 'G' } }));
  assertEquals(await index.delete('gone@example.com'), true);
  assertEquals(await index.get('gone@example.com'), null);
  assertEquals(await index.delete('gone@example.com'), false);
});

Deno.test('sender-index — custom keyPrefix isolates records', async () => {
  const adapter = new MemoryAdapter();
  const indexA = createSenderIndex(adapter, { keyPrefix: 'inbox-a/senders/' });
  const indexB = createSenderIndex(adapter, { keyPrefix: 'inbox-b/senders/' });

  await indexA.upsert(makeItem({ fields: { from_email: 'shared@example.com', from_addr: 'S' } }));
  await indexB.upsert(makeItem({ fields: { from_email: 'shared@example.com', from_addr: 'S' } }));
  await indexB.upsert(makeItem({ fields: { from_email: 'shared@example.com', from_addr: 'S' } }));

  const a = await indexA.get('shared@example.com');
  const b = await indexB.get('shared@example.com');
  assertEquals(a!.count, 1);
  assertEquals(b!.count, 2);
});

Deno.test('sender-index — parseListUnsubscribe handles raw value without brackets', () => {
  assertEquals(parseListUnsubscribe('https://example.com/u'), 'https://example.com/u');
  assertEquals(parseListUnsubscribe(''), undefined);
  assertEquals(parseListUnsubscribe(undefined), undefined);
});
