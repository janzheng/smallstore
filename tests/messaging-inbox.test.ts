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

// ============================================================================
// keyPrefix — namespace isolation when multiple inboxes share one adapter
// ============================================================================

Deno.test('inbox — keyPrefix omitted writes bare _index + items/<id> (backwards compat)', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });

  await inbox._ingest(makeItem('a', '2026-04-22T12:00:00Z'));

  // The historical layout: keys are `_index` and `items/a` (no prefix).
  assertExists(await items.get('_index'));
  assertExists(await items.get('items/a'));
  assertEquals(await items.get('inbox/mailroom/_index'), null);
  assertEquals(await items.get('inbox/mailroom/items/a'), null);
});

Deno.test('inbox — keyPrefix prefixes _index + items/<id>', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({
    name: 'biorxiv',
    channel: 'rss',
    storage: { items },
    keyPrefix: 'inbox/biorxiv/',
  });

  await inbox._ingest(makeItem('paper-1', '2026-04-22T12:00:00Z'));

  // Keys live under the namespace; bare keys are untouched.
  assertExists(await items.get('inbox/biorxiv/_index'));
  assertExists(await items.get('inbox/biorxiv/items/paper-1'));
  assertEquals(await items.get('_index'), null);
  assertEquals(await items.get('items/paper-1'), null);
});

Deno.test('inbox — two inboxes with different keyPrefix on the same adapter do not collide', async () => {
  const shared = new MemoryAdapter();
  const a = createInbox({ name: 'a', channel: 'cf-email', storage: { items: shared }, keyPrefix: 'inbox/a/' });
  const b = createInbox({ name: 'b', channel: 'cf-email', storage: { items: shared }, keyPrefix: 'inbox/b/' });

  await a._ingest(makeItem('x', '2026-04-22T12:00:00Z'));
  await b._ingest(makeItem('y', '2026-04-22T13:00:00Z'));

  const aList = await a.list();
  const bList = await b.list();
  assertEquals(aList.items.map(i => i.id), ['x']);
  assertEquals(bList.items.map(i => i.id), ['y']);

  // Cross-reads return null — each inbox only sees its own namespace.
  assertEquals(await a.read('y'), null);
  assertEquals(await b.read('x'), null);
});

Deno.test('inbox — keyPrefix isolates list/query/cursor/delete', async () => {
  const shared = new MemoryAdapter();
  const a = createInbox({ name: 'a', channel: 'cf-email', storage: { items: shared }, keyPrefix: 'inbox/a/' });
  const b = createInbox({ name: 'b', channel: 'cf-email', storage: { items: shared }, keyPrefix: 'inbox/b/' });

  await a._ingest(makeItem('a1', '2026-04-22T10:00:00Z', { from_email: 'alice@a.com' }));
  await a._ingest(makeItem('a2', '2026-04-22T11:00:00Z', { from_email: 'alice@a.com' }));
  await b._ingest(makeItem('b1', '2026-04-22T12:00:00Z', { from_email: 'bob@b.com' }));

  // Query scoped to inbox a only — bob's item must not appear.
  const aQuery = await a.query({ fields: { from_email: 'alice@a.com' } });
  assertEquals(aQuery.items.map(i => i.id).sort(), ['a1', 'a2']);

  // Cursor on inbox a points at the head of inbox a, not inbox b.
  const aCursor = await a.cursor();
  const decoded = decodeCursor(aCursor);
  assertEquals(decoded?.id, 'a2');

  // Delete on inbox b removes b1 only; inbox a is untouched.
  const removed = await b.delete('b1');
  assertEquals(removed, true);
  assertEquals((await a.list()).items.length, 2);
  assertEquals((await b.list()).items.length, 0);
});
