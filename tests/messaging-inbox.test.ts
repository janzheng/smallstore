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

Deno.test('inbox — query honors order=oldest in filter path (2026-04-27 fix)', async () => {
  const inbox = freshInbox();
  await inbox._ingest(makeItem('a', '2026-04-22T10:00:00Z', { tag: 'match' }));
  await inbox._ingest(makeItem('b', '2026-04-22T11:00:00Z', { tag: 'match' }));
  await inbox._ingest(makeItem('c', '2026-04-22T12:00:00Z', { tag: 'match' }));

  const newest = await inbox.query({ fields: { tag: 'match' } });
  assertEquals(newest.items.map((i) => i.id), ['c', 'b', 'a']);

  const oldest = await inbox.query({ fields: { tag: 'match' } }, { order: 'oldest' });
  assertEquals(oldest.items.map((i) => i.id), ['a', 'b', 'c']);
});

Deno.test('inbox — query order=oldest works with cursor pagination', async () => {
  const inbox = freshInbox();
  for (let i = 0; i < 5; i++) {
    await inbox._ingest(makeItem(`m${i}`, `2026-04-22T12:0${i}:00Z`, { tag: 'match' }));
  }

  const page1 = await inbox.query(
    { fields: { tag: 'match' } },
    { limit: 2, order: 'oldest' },
  );
  assertEquals(page1.items.map((i) => i.id), ['m0', 'm1']);
  assertExists(page1.next_cursor);

  const page2 = await inbox.query(
    { fields: { tag: 'match' } },
    { limit: 2, order: 'oldest', cursor: page1.next_cursor },
  );
  assertEquals(page2.items.map((i) => i.id), ['m2', 'm3']);
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

// ============================================================================
// readAttachment
// ============================================================================

Deno.test('readAttachment — returns content + metadata for a known filename', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  await blobs.set('attachments/abc/photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items, blobs } });
  await inbox._ingest({
    id: 'abc',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    body: null,
    fields: {
      from_email: 'a@b.com',
      has_attachments: true,
      attachments: [{
        id: 'photo.png',
        filename: 'photo.png',
        content_type: 'image/png',
        size: 4,
        ref: 'attachments/abc/photo.png',
      }],
    },
  });

  const result = await inbox.readAttachment('abc', 'photo.png');
  assertExists(result);
  assertEquals(result?.attachment.content_type, 'image/png');
  assertEquals(result?.attachment.size, 4);
  assertEquals((result?.content as Uint8Array)[0], 0x89);
});

Deno.test('readAttachment — returns null for unknown filename (no traversal)', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  // Plant a blob under a totally different path — only attachments listed
  // in fields.attachments[] should resolve.
  await blobs.set('attachments/abc/photo.png', new Uint8Array([1, 2, 3]));
  await blobs.set('raw/abc.eml', 'secret raw email contents');
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items, blobs } });
  await inbox._ingest({
    id: 'abc',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    body: null,
    fields: {
      from_email: 'a@b.com',
      attachments: [{
        id: 'photo.png',
        filename: 'photo.png',
        content_type: 'image/png',
        size: 3,
        ref: 'attachments/abc/photo.png',
      }],
    },
  });

  // Filenames that aren't in attachments[] get rejected — even if a blob
  // exists at that path. This is the path-traversal guard.
  assertEquals(await inbox.readAttachment('abc', '../raw/abc.eml'), null);
  assertEquals(await inbox.readAttachment('abc', 'unknown.pdf'), null);
});

Deno.test('readAttachment — returns null for unknown item', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items, blobs } });
  assertEquals(await inbox.readAttachment('does-not-exist', 'any.png'), null);
});

Deno.test('readAttachment — returns null when blobs adapter is missing', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items } });
  await inbox._ingest({
    id: 'abc',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    body: null,
    fields: {
      from_email: 'a@b.com',
      attachments: [{
        id: 'photo.png',
        filename: 'photo.png',
        content_type: 'image/png',
        size: 4,
        ref: 'attachments/abc/photo.png',
      }],
    },
  });
  assertEquals(await inbox.readAttachment('abc', 'photo.png'), null);
});

Deno.test('readAttachment — returns null for item with no attachments field', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items, blobs } });
  await inbox._ingest({
    id: 'abc',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    body: 'plain email',
    fields: { from_email: 'a@b.com' }, // no attachments field
  });
  assertEquals(await inbox.readAttachment('abc', 'photo.png'), null);
});

Deno.test('readAttachment — returns null when blob is gone (partial-delete state)', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  // Item references an attachment, but the blob was never set (or was
  // half-deleted). Should fail soft, not throw.
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items, blobs } });
  await inbox._ingest({
    id: 'abc',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    body: null,
    fields: {
      from_email: 'a@b.com',
      attachments: [{
        id: 'gone.pdf',
        filename: 'gone.pdf',
        content_type: 'application/pdf',
        size: 100,
        ref: 'attachments/abc/gone.pdf',
      }],
    },
  });
  assertEquals(await inbox.readAttachment('abc', 'gone.pdf'), null);
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

// ============================================================================
// B004 — atomicity / pending sidecar / recoverOrphans
// ============================================================================

Deno.test('inbox — happy path: pending key cleared after successful ingest (B004)', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items } });
  await inbox._ingest(makeItem('x1', '2026-04-28T10:00:00Z'));
  // After a successful ingest, no pending sidecar should remain.
  const pendingKeys = await items.keys('_pending/');
  assertEquals(pendingKeys.length, 0);
});

Deno.test('inbox — recoverOrphans: re-indexes items written without index update (B004)', async () => {
  // Wrap the items adapter so we can simulate "appendIndex throws on the first
  // call." The crash leaves a pending sidecar + an item, but the index is
  // never updated. recoverOrphans() should detect and re-index.
  const items = new MemoryAdapter();
  let nextSetThrows = false;
  const wrapped = new Proxy(items, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (prop === 'set') {
        return async (k: string, v: unknown) => {
          if (nextSetThrows && k.endsWith('_index')) {
            nextSetThrows = false;
            throw new Error('simulated mid-write crash');
          }
          return await orig.call(target, k, v);
        };
      }
      return orig;
    },
  });
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items: wrapped as any } });

  nextSetThrows = true;
  let threw = false;
  try {
    await inbox._ingest(makeItem('x1', '2026-04-28T10:00:00Z'));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  // Item exists, but is orphaned (not in index) and pending key still set.
  assertEquals((await items.has('items/x1')), true);
  assertEquals((await items.has('_pending/x1')), true);
  // List shouldn't see it (index was never updated).
  const before = await inbox.list();
  assertEquals(before.items.length, 0);

  // Recovery brings it back into the index.
  const summary = await inbox.recoverOrphans();
  assertEquals(summary.recovered, 1);
  assertEquals(summary.reaped, 0);
  assertEquals(summary.cleaned, 0);

  const after = await inbox.list();
  assertEquals(after.items.length, 1);
  assertEquals(after.items[0].id, 'x1');
  // Pending key is gone.
  assertEquals((await items.has('_pending/x1')), false);
});

Deno.test('inbox — recoverOrphans: reaps pending without item (crash before items.set)', async () => {
  const items = new MemoryAdapter();
  // Simulate a crash where we wrote pending but not the item itself.
  await items.set('_pending/orphan', { at: '2026-04-28T10:00:00Z', id: 'orphan', started_at: '2026-04-28T10:00:00Z' });
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items } });

  const summary = await inbox.recoverOrphans();
  assertEquals(summary.reaped, 1);
  assertEquals((await items.has('_pending/orphan')), false);
});

Deno.test('inbox — recoverOrphans: cleans benign pending after late delete (item indexed)', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items } });
  await inbox._ingest(makeItem('x1', '2026-04-28T10:00:00Z'));
  // Re-create a pending key as if the post-ingest delete had failed.
  await items.set('_pending/x1', { at: '2026-04-28T10:00:00Z', id: 'x1', started_at: '2026-04-28T10:00:00Z' });

  const summary = await inbox.recoverOrphans();
  assertEquals(summary.cleaned, 1);
  assertEquals(summary.recovered, 0);
  assertEquals(summary.reaped, 0);
  assertEquals((await items.has('_pending/x1')), false);
});

// ============================================================================
// B014 — concurrent appendIndex serialization
// ============================================================================

Deno.test('inbox — concurrent ingests do not lose entries (B014)', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items } });

  // 20 distinct ingests fired in parallel — without serialization the
  // index can race read-modify-write and end up with fewer than 20 entries.
  const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
  await Promise.all(ids.map((id, i) =>
    inbox._ingest(makeItem(id, `2026-04-28T10:00:${String(i).padStart(2, '0')}Z`))
  ));

  const result = await inbox.list({ limit: 100 });
  assertEquals(result.items.length, 20);
  // No duplicates either.
  const seen = new Set(result.items.map((i) => i.id));
  assertEquals(seen.size, 20);
});

Deno.test('inbox — concurrent ingests of same id stay deduplicated (B014)', async () => {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 't', channel: 'cf-email', storage: { items } });

  // Same id ingested 10x in parallel — should land as exactly one index entry.
  await Promise.all(
    Array.from({ length: 10 }, () => inbox._ingest(makeItem('dup', '2026-04-28T10:00:00Z'))),
  );

  const result = await inbox.list({ limit: 100 });
  assertEquals(result.items.length, 1);
  assertEquals(result.items[0].id, 'dup');
});
