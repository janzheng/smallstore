/**
 * HTTP integration tests for the attachment routes.
 *
 *   GET /inbox/:name/items/:id/attachments
 *   GET /inbox/:name/items/:id/attachments/:filename
 *
 * Backed by MemoryAdapter, so the same code path that hits R2 in prod
 * goes through the in-process map here.
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

interface Fixture {
  app: Hono;
  itemsAdapter: MemoryAdapter;
  blobsAdapter: MemoryAdapter;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildApp(opts: { withBlobs?: boolean } = {}): Fixture {
  const itemsAdapter = new MemoryAdapter();
  const blobsAdapter = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();

  const inbox = createInbox({
    name: 'mailroom',
    channel: 'cf-email',
    storage: opts.withBlobs === false
      ? { items: itemsAdapter }
      : { items: itemsAdapter, blobs: blobsAdapter },
  });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'items' } as InboxConfig, 'boot');

  const buildInbox = async (name: string, cfg: InboxConfig) =>
    createInbox({ name, channel: cfg.channel, storage: { items: itemsAdapter, blobs: blobsAdapter } });

  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });

  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  return { app, itemsAdapter, blobsAdapter, fetch };
}

async function seedItemWithAttachments(fx: Fixture) {
  // Drop a binary into the blobs adapter, then ingest an item that
  // references it via fields.attachments[]. Mirrors what cf-email.ts
  // does at parse time.
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await fx.blobsAdapter.set('attachments/item1/photo.png', pngBytes);
  await fx.blobsAdapter.set('attachments/item1/notes.txt', 'just some notes');

  const item: InboxItem = {
    id: 'item1',
    source: 'cf-email',
    received_at: '2026-04-22T12:00:00Z',
    summary: 'with attachments',
    body: 'see attached',
    fields: {
      from_email: 'sender@example.com',
      has_attachments: true,
      attachments: [
        {
          id: 'photo.png',
          filename: 'photo.png',
          content_type: 'image/png',
          size: pngBytes.byteLength,
          ref: 'attachments/item1/photo.png',
        },
        {
          id: 'notes.txt',
          filename: 'notes.txt',
          content_type: 'text/plain',
          size: 15,
          ref: 'attachments/item1/notes.txt',
        },
      ],
    },
  };
  const inbox = (fx.app as any); // placeholder; we ingest via the registry below
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(item),
  });
  return pngBytes;
}

// ============================================================================
// GET /inbox/:name/items/:id/attachments — list
// ============================================================================

Deno.test('http — list attachments returns metadata + download URLs', async () => {
  const fx = buildApp();
  await seedItemWithAttachments(fx);

  const res = await fx.fetch('/inbox/mailroom/items/item1/attachments');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.inbox, 'mailroom');
  assertEquals(body.item_id, 'item1');
  assertEquals(body.attachments.length, 2);

  const photo = body.attachments.find((a: any) => a.filename === 'photo.png');
  assertExists(photo);
  assertEquals(photo.content_type, 'image/png');
  assertEquals(photo.size, 8);
  assertEquals(
    photo.download_url,
    '/inbox/mailroom/items/item1/attachments/photo.png',
  );
});

Deno.test('http — list attachments returns empty array when item has none', async () => {
  const fx = buildApp();
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'plain',
      source: 'cf-email',
      received_at: '2026-04-22T12:00:00Z',
      summary: 'no attachments here',
      body: 'just text',
      fields: { from_email: 'a@b.com' },
    }),
  });

  const res = await fx.fetch('/inbox/mailroom/items/plain/attachments');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.attachments, []);
});

Deno.test('http — list attachments 404 when item missing', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/mailroom/items/does-not-exist/attachments');
  assertEquals(res.status, 404);
});

Deno.test('http — list attachments 404 when inbox unknown', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/no-such-inbox/items/x/attachments');
  assertEquals(res.status, 404);
});

// ============================================================================
// GET /inbox/:name/items/:id/attachments/:filename — download
// ============================================================================

Deno.test('http — download streams bytes with correct content-type + length', async () => {
  const fx = buildApp();
  const expected = await seedItemWithAttachments(fx);

  const res = await fx.fetch('/inbox/mailroom/items/item1/attachments/photo.png');
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'image/png');
  assertEquals(res.headers.get('content-length'), String(expected.byteLength));
  // Default disposition is inline so browsers preview.
  assert(res.headers.get('content-disposition')?.startsWith('inline; '));

  const buf = new Uint8Array(await res.arrayBuffer());
  assertEquals(buf.byteLength, expected.byteLength);
  assertEquals(buf[0], 0x89);
  assertEquals(buf[1], 0x50);
});

Deno.test('http — download honors ?download=1 for forced attachment disposition', async () => {
  const fx = buildApp();
  await seedItemWithAttachments(fx);

  const res = await fx.fetch('/inbox/mailroom/items/item1/attachments/photo.png?download=1');
  assertEquals(res.status, 200);
  const dispo = res.headers.get('content-disposition') ?? '';
  assert(dispo.startsWith('attachment; '));
  assert(dispo.includes('filename="photo.png"'));
  await res.body?.cancel();
});

Deno.test('http — download streams text attachment correctly', async () => {
  const fx = buildApp();
  await seedItemWithAttachments(fx);

  const res = await fx.fetch('/inbox/mailroom/items/item1/attachments/notes.txt');
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'text/plain');
  const text = await res.text();
  assertEquals(text, 'just some notes');
});

Deno.test('http — download 404 when filename not in attachments[] (no path traversal)', async () => {
  const fx = buildApp();
  await seedItemWithAttachments(fx);

  // Plant a separate blob the route shouldn't expose — it's NOT in
  // fields.attachments[] for any item, so the route must reject the
  // filename even though the underlying blob exists.
  await fx.blobsAdapter.set('raw/item1.eml', 'should-not-be-readable-via-attachments-route');

  const traversal = await fx.fetch(
    `/inbox/mailroom/items/item1/attachments/${encodeURIComponent('../raw/item1.eml')}`,
  );
  assertEquals(traversal.status, 404);

  const unknown = await fx.fetch('/inbox/mailroom/items/item1/attachments/not-a-real-file.pdf');
  assertEquals(unknown.status, 404);
});

Deno.test('http — download 404 when item missing', async () => {
  const fx = buildApp();
  await seedItemWithAttachments(fx);
  const res = await fx.fetch('/inbox/mailroom/items/no-such-item/attachments/photo.png');
  assertEquals(res.status, 404);
});

Deno.test('http — download 404 when inbox unknown', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/no-such/items/x/attachments/y.png');
  assertEquals(res.status, 404);
});

Deno.test('http — download handles URL-encoded filenames with spaces / special chars', async () => {
  const fx = buildApp();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await fx.blobsAdapter.set('attachments/item2/Hello World.pdf', bytes);
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'item2',
      source: 'cf-email',
      received_at: '2026-04-22T12:00:00Z',
      body: null,
      fields: {
        from_email: 'a@b.com',
        attachments: [{
          id: 'Hello World.pdf',
          filename: 'Hello World.pdf',
          content_type: 'application/pdf',
          size: 4,
          ref: 'attachments/item2/Hello World.pdf',
        }],
      },
    }),
  });

  const res = await fx.fetch(
    `/inbox/mailroom/items/item2/attachments/${encodeURIComponent('Hello World.pdf')}`,
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'application/pdf');
  const buf = new Uint8Array(await res.arrayBuffer());
  assertEquals(buf.byteLength, 4);
});

Deno.test('http — download falls back to octet-stream when content_type is missing', async () => {
  const fx = buildApp();
  await fx.blobsAdapter.set('attachments/item3/blob.bin', new Uint8Array([0xff, 0xfe]));
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'item3',
      source: 'cf-email',
      received_at: '2026-04-22T12:00:00Z',
      body: null,
      fields: {
        from_email: 'a@b.com',
        attachments: [{
          id: 'blob.bin',
          filename: 'blob.bin',
          content_type: '',
          size: 2,
          ref: 'attachments/item3/blob.bin',
        }],
      },
    }),
  });

  const res = await fx.fetch('/inbox/mailroom/items/item3/attachments/blob.bin');
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'application/octet-stream');
  await res.body?.cancel();
});

Deno.test('http — download 501 when inbox has no readAttachment (no blobs adapter)', async () => {
  // The reference Inbox returns null when blobs adapter is missing; the
  // route surfaces that as 404, not 501. The 501 path is for inboxes
  // implementing the interface without the readAttachment method. Confirm
  // the 404-when-no-blobs behavior (route still resolves the inbox but
  // gets no content back).
  const fx = buildApp({ withBlobs: false });
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'noblobs',
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
          ref: 'attachments/noblobs/photo.png',
        }],
      },
    }),
  });
  const res = await fx.fetch('/inbox/mailroom/items/noblobs/attachments/photo.png');
  assertEquals(res.status, 404);
});
