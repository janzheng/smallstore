/**
 * Messaging — reference Inbox tests.
 *
 * Composes the Inbox with an in-memory adapter; verifies ingest dedup,
 * cursor pagination, query-by-filter, and read.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { decodeCursor } from '../src/messaging/cursor.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import type { InboxItem } from '../src/messaging/types.ts';

function makeItem(id: string, receivedAt: string, fields: Record<string, any> = {}, opts: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    source: 'cf-email',
    received_at: receivedAt,
    summary: opts.summary ?? `Subject ${id}`,
    body: opts.body ?? `Body for ${id}`,
    fields: { from_email: 'sender@example.com', ...fields },
    labels: opts.labels,
    thread_id: opts.thread_id,
  };
}

function freshInbox(name = 'test') {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  return createInbox({
    name,
    channel: 'cf-email',
    storage: { items, blobs },
  });
}

Deno.test('inbox — empty inbox: list returns no items', async () => {
  const inbox = freshInbox();
  const result = await inbox.list();
  assertEquals(result.items, []);
  assertEquals(result.next_cursor, undefined);
});

Deno.test('inbox — ingest stores item and list returns it', async () => {
  const inbox = freshInbox();
  const item = makeItem('a', '2026-04-22T12:00:00Z');
  await inbox._ingest(item);

  const result = await inbox.list();
  assertEquals(result.items.length, 1);
  assertEquals(result.items[0].id, 'a');
});

Deno.test('inbox — ingest is idempotent on same id', async () => {
  const inbox = freshInbox();
  const item = makeItem('a', '2026-04-22T12:00:00Z');
  await inbox._ingest(item);
  await inbox._ingest({ ...item, summary: 'changed' }); // same id, different summary

  const result = await inbox.list();
  assertEquals(result.items.length, 1);
  // Returns existing item, not the new one
  assertEquals(result.items[0].summary, 'Subject a');
});

Deno.test('inbox — list is newest-first', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T10:00:00Z'));
  await inbox._ingest(makeItem('b', '2026-04-22T12:00:00Z'));
  await inbox._ingest(makeItem('c', '2026-04-22T11:00:00Z'));

  const result = await inbox.list();
  assertEquals(result.items.map(i => i.id), ['b', 'c', 'a']);
});

Deno.test('inbox — cursor pagination walks the whole list', async () => {
  const inbox = freshInbox();
  for (let i = 0; i < 5; i++) {
    await inbox._ingest(makeItem(`item${i}`, `2026-04-22T12:0${i}:00Z`));
  }

  const page1 = await inbox.list({ limit: 2 });
  assertEquals(page1.items.length, 2);
  assertExists(page1.next_cursor);

  const page2 = await inbox.list({ limit: 2, cursor: page1.next_cursor });
  assertEquals(page2.items.length, 2);
  assertExists(page2.next_cursor);

  const page3 = await inbox.list({ limit: 2, cursor: page2.next_cursor });
  assertEquals(page3.items.length, 1);
  assertEquals(page3.next_cursor, undefined);

  // No overlap
  const allIds = [...page1.items, ...page2.items, ...page3.items].map(i => i.id);
  assertEquals(new Set(allIds).size, 5);
});

Deno.test('inbox — read returns null for unknown id', async () => {
  const inbox = freshInbox();
  const result = await inbox.read('does-not-exist');
  assertEquals(result, null);
});

Deno.test('inbox — read returns the stored item', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T12:00:00Z'));
  const item = await inbox.read('a');
  assertExists(item);
  assertEquals(item?.id, 'a');
});

Deno.test('inbox — query filters by fields', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T10:00:00Z', { from_email: 'alice@example.com' }));
  await inbox._ingest(makeItem('b', '2026-04-22T11:00:00Z', { from_email: 'bob@example.com' }));
  await inbox._ingest(makeItem('c', '2026-04-22T12:00:00Z', { from_email: 'alice@example.com' }));

  const result = await inbox.query({ fields: { from_email: 'alice' } });
  assertEquals(result.items.map(i => i.id).sort(), ['a', 'c']);
});

Deno.test('inbox — query honors cursor pagination', async () => {
  const inbox = freshInbox();
  for (let i = 0; i < 5; i++) {
    await inbox._ingest(makeItem(`m${i}`, `2026-04-22T12:0${i}:00Z`, { tag: 'match' }));
  }

  const page1 = await inbox.query({ fields: { tag: 'match' } }, { limit: 2 });
  assertEquals(page1.items.length, 2);
  assertExists(page1.next_cursor);

  const page2 = await inbox.query({ fields: { tag: 'match' } }, { limit: 2, cursor: page1.next_cursor });
  assertEquals(page2.items.length, 2);
});

Deno.test('inbox — cursor() returns the head watermark', async () => {
  const inbox = freshInbox();
  const empty = await inbox.cursor();
  assertExists(decodeCursor(empty));

  await inbox._ingest(makeItem('a', '2026-04-22T10:00:00Z'));
  await inbox._ingest(makeItem('b', '2026-04-22T12:00:00Z'));

  const head = await inbox.cursor();
  const decoded = decodeCursor(head);
  assertEquals(decoded?.id, 'b'); // newest
});

Deno.test('inbox — full read inflates body_ref from blobs adapter', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  await blobs.set('html/abc.html', '<p>Hello world</p>');
  const inbox = createInbox({
    name: 't',
    channel: 'cf-email',
    storage: { items, blobs },
  });
  await inbox._ingest({
    id: 'abc',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    body: null,
    body_ref: 'html/abc.html',
    fields: {},
  });

  const full = await inbox.read('abc', { full: true });
  assertEquals(full?.body_inflated, '<p>Hello world</p>');
});
