/**
 * After-the-fact note annotation — `POST /inbox/:name/items/:id/note`.
 *
 * Covers:
 *   - Sets `fields.forward_note` on an existing item
 *   - Stamps `fields.note_updated_at` (ISO)
 *   - Preserves identity (id, received_at, source) and labels
 *   - `mode: 'append'` joins to existing note via thematic break
 *   - `mode: 'replace'` (default) overwrites
 *   - Empty string clears
 *   - 404 / 400 error paths
 *   - Annotated note is visible to `/inbox/:name/newsletters/:slug/notes`
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
  inbox: ReturnType<typeof createInbox>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildFixture(): Fixture {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'items' } as InboxConfig, 'boot');
  const buildInbox = async (n: string, cfg: InboxConfig) =>
    createInbox({ name: n, channel: cfg.channel, storage: { items } });

  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });

  return {
    app,
    inbox,
    fetch: async (path, init) => await app.request(path, init),
  };
}

async function seedItem(
  inbox: ReturnType<typeof createInbox>,
  overrides: Partial<InboxItem> = {},
): Promise<InboxItem> {
  const item: InboxItem = {
    id: 'item-1',
    source: 'email/v1',
    source_version: 'email/v1',
    received_at: '2026-04-26T10:00:00.000Z',
    summary: 'Test newsletter',
    labels: ['forwarded', 'newsletter'],
    fields: { from_email: 'sender@example.com', newsletter_slug: 'example' },
    ...overrides,
  };
  return await inbox._ingest(item, { force: true });
}

Deno.test('annotation: sets forward_note + note_updated_at on existing item', async () => {
  const f = buildFixture();
  await seedItem(f.inbox);

  const before = Date.now();
  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'This was a great issue.' }),
  });
  const after = Date.now();

  assertEquals(r.status, 200);
  const body = await r.json();
  assertEquals(body.inbox, 'mailroom');
  assertEquals(body.item.fields.forward_note, 'This was a great issue.');

  const ts = Date.parse(body.item.fields.note_updated_at);
  assert(ts >= before && ts <= after, `note_updated_at ${body.item.fields.note_updated_at} not in [${before}, ${after}]`);
});

Deno.test('annotation: preserves identity (id, received_at, source) and labels', async () => {
  const f = buildFixture();
  const seeded = await seedItem(f.inbox);

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'thoughts' }),
  });

  assertEquals(r.status, 200);
  const { item } = await r.json();
  assertEquals(item.id, seeded.id);
  assertEquals(item.received_at, seeded.received_at);
  assertEquals(item.source, seeded.source);
  assertEquals(item.source_version, seeded.source_version);
  assertEquals(item.summary, seeded.summary);
  assertEquals(new Set(item.labels), new Set(seeded.labels));
});

Deno.test('annotation: preserves untouched fields (does not wipe forward-detect output)', async () => {
  const f = buildFixture();
  await seedItem(f.inbox, {
    fields: {
      from_email: 'sender@example.com',
      newsletter_slug: 'example',
      original_sent_at: '2026-04-25T08:00:00.000Z',
      original_from_addr: 'Steph at Internet Pipes',
    },
  });

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'late annotation' }),
  });

  assertEquals(r.status, 200);
  const { item } = await r.json();
  // Pre-existing fields untouched
  assertEquals(item.fields.from_email, 'sender@example.com');
  assertEquals(item.fields.newsletter_slug, 'example');
  assertEquals(item.fields.original_sent_at, '2026-04-25T08:00:00.000Z');
  assertEquals(item.fields.original_from_addr, 'Steph at Internet Pipes');
  // New fields added
  assertEquals(item.fields.forward_note, 'late annotation');
  assertExists(item.fields.note_updated_at);
});

Deno.test('annotation: replace (default) overwrites existing note', async () => {
  const f = buildFixture();
  await seedItem(f.inbox, { fields: { from_email: 'x@x.com', forward_note: 'first thought' } });

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'second thought' }),
  });

  const { item } = await r.json();
  assertEquals(item.fields.forward_note, 'second thought');
});

Deno.test('annotation: mode=append joins with thematic break', async () => {
  const f = buildFixture();
  await seedItem(f.inbox, { fields: { from_email: 'x@x.com', forward_note: 'first thought' } });

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'second thought', mode: 'append' }),
  });

  const { item } = await r.json();
  assertEquals(item.fields.forward_note, 'first thought\n\n---\n\nsecond thought');
});

Deno.test('annotation: mode=append on item with no existing note just sets it (no leading separator)', async () => {
  const f = buildFixture();
  await seedItem(f.inbox);

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'first note', mode: 'append' }),
  });

  const { item } = await r.json();
  assertEquals(item.fields.forward_note, 'first note');
});

Deno.test('annotation: empty string clears the note', async () => {
  const f = buildFixture();
  await seedItem(f.inbox, { fields: { from_email: 'x@x.com', forward_note: 'old note' } });

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '' }),
  });

  const { item } = await r.json();
  assertEquals(item.fields.forward_note, '');
});

Deno.test('annotation: 404 when item not found', async () => {
  const f = buildFixture();

  const r = await f.fetch('/inbox/mailroom/items/missing-id/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'hi' }),
  });

  assertEquals(r.status, 404);
});

Deno.test('annotation: 404 when inbox not registered', async () => {
  const f = buildFixture();

  const r = await f.fetch('/inbox/no-such-inbox/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'hi' }),
  });

  assertEquals(r.status, 404);
});

Deno.test('annotation: 400 when note missing or non-string', async () => {
  const f = buildFixture();
  await seedItem(f.inbox);

  const missing = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assertEquals(missing.status, 400);

  const wrongType = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 42 }),
  });
  assertEquals(wrongType.status, 400);
});

Deno.test('annotation: 400 when mode is invalid', async () => {
  const f = buildFixture();
  await seedItem(f.inbox);

  const r = await f.fetch('/inbox/mailroom/items/item-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'hi', mode: 'prepend' }),
  });
  assertEquals(r.status, 400);
});

Deno.test('annotation: annotated note appears in /newsletters/:slug/notes', async () => {
  const f = buildFixture();
  await seedItem(f.inbox, {
    id: 'ip-1',
    fields: {
      newsletter_slug: 'internet-pipes',
      from_email: 'steph@internetpipes.com',
      original_from_addr: 'Steph at Internet Pipes',
      subject: 'IP Digest #42',
      original_sent_at: '2026-04-20T10:00:00.000Z',
    },
  });

  // Initially no notes — item exists but no forward_note
  const empty = await f.fetch('/inbox/mailroom/newsletters/internet-pipes/notes');
  assertEquals(empty.status, 200);
  const emptyBody = await empty.json();
  assertEquals(emptyBody.count, 0);

  // Annotate
  const annotate = await f.fetch('/inbox/mailroom/items/ip-1/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'I loved the section on factory tours.' }),
  });
  assertEquals(annotate.status, 200);

  // Now the notes route surfaces it
  const notes = await f.fetch('/inbox/mailroom/newsletters/internet-pipes/notes');
  assertEquals(notes.status, 200);
  const body = await notes.json();
  assertEquals(body.count, 1);
  assertEquals(body.notes[0].note, 'I loved the section on factory tours.');
  assertEquals(body.notes[0].id, 'ip-1');
});

Deno.test('annotation: index entry untouched (item not duplicated, position preserved)', async () => {
  const f = buildFixture();
  await seedItem(f.inbox, { id: 'a', received_at: '2026-04-26T10:00:00.000Z' });
  await seedItem(f.inbox, { id: 'b', received_at: '2026-04-26T11:00:00.000Z' });
  await seedItem(f.inbox, { id: 'c', received_at: '2026-04-26T12:00:00.000Z' });

  const beforeList = await f.fetch('/inbox/mailroom?limit=10');
  const before = await beforeList.json();
  const beforeIds = before.items.map((it: { id: string }) => it.id);
  assertEquals(beforeIds.length, 3);

  await f.fetch('/inbox/mailroom/items/a/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'late annotation on the oldest one' }),
  });

  const afterList = await f.fetch('/inbox/mailroom?limit=10');
  const after = await afterList.json();
  const afterIds = after.items.map((it: { id: string }) => it.id);
  assertEquals(afterIds, beforeIds);
});
