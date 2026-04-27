/**
 * Cross-newsletter notes endpoint — `GET /inbox/:name/notes`.
 *
 * Closes the "do we have a way to aggregate / search / get all the notes"
 * gap surfaced in `.brief/api-access-and-notes.md § 3`. Per-newsletter
 * notes already worked via /newsletters/:slug/notes; this covers the
 * cross-publisher case + first-class text search inside notes.
 *
 * Covers:
 *   - Returns every item with non-empty forward_note across slugs
 *   - Slim shape projection (id, slug, display, dates, subject, from, note)
 *   - ?text= substring filter (case-insensitive) on forward_note ONLY
 *     (NOT body — explicit regression check)
 *   - ?slug= scope filter
 *   - ?since= filter on received_at
 *   - ?order=newest|oldest
 *   - ?limit cap, ?total reports filtered count before limit
 *   - ?format=markdown groups by slug, emits filter metadata in header
 *   - 404 unknown inbox
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

interface Fixture {
  app: Hono;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  seed: (overrides: Partial<InboxItem>) => Promise<InboxItem>;
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

  let counter = 0;
  return {
    app,
    fetch: async (path, init) => await app.request(path, init),
    seed: async (overrides) => {
      const id = overrides.id ?? `item-${++counter}`;
      const item: InboxItem = {
        id,
        source: 'email/v1',
        source_version: 'email/v1',
        received_at: '2026-04-26T10:00:00.000Z',
        summary: 'Test',
        labels: ['forwarded'],
        fields: { from_email: 'sender@example.com' },
        ...overrides,
      };
      return await inbox._ingest(item, { force: true });
    },
  };
}

Deno.test('notes: returns every item with non-empty forward_note across slugs', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    received_at: '2026-04-26T10:00:00.000Z',
    fields: {
      newsletter_slug: 'pub-a',
      original_from_addr: 'Pub A',
      original_subject: 'a-subject',
      forward_note: 'thoughts on A',
    },
  });
  await f.seed({
    id: 'b',
    received_at: '2026-04-25T10:00:00.000Z',
    fields: {
      newsletter_slug: 'pub-b',
      original_from_addr: 'Pub B',
      original_subject: 'b-subject',
      forward_note: 'thoughts on B',
    },
  });
  await f.seed({
    id: 'c-no-note',
    fields: { newsletter_slug: 'pub-c', original_subject: 'c' },
  });

  const r = await f.fetch('/inbox/mailroom/notes');
  assertEquals(r.status, 200);
  const body = await r.json();
  assertEquals(body.count, 2);
  assertEquals(new Set(body.notes.map((n: { newsletter_slug: string }) => n.newsletter_slug)), new Set(['pub-a', 'pub-b']));
  // Default order: newest by received_at — A landed at 10:00, B at the day before
  assertEquals(body.notes[0].id, 'a');
});

Deno.test('notes: slim shape projection (no body, no labels)', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    body: 'huge body here',
    labels: ['x', 'y', 'z'],
    fields: {
      newsletter_slug: 'p',
      original_from_addr: 'Pub',
      original_subject: 'subj',
      original_sent_at: '2026-04-26T08:00:00.000Z',
      forward_note: 'a note',
    },
  });

  const r = await f.fetch('/inbox/mailroom/notes');
  const body = await r.json();
  const note = body.notes[0];
  assertEquals(Object.keys(note).sort(), [
    'from',
    'id',
    'newsletter_display',
    'newsletter_slug',
    'note',
    'original_sent_at',
    'received_at',
    'subject',
  ]);
  assertEquals(note.note, 'a note');
});

Deno.test('notes: ?text=keyword filters on forward_note ONLY (not body)', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'note-has-keyword',
    body: 'unrelated body',
    fields: { newsletter_slug: 'p', forward_note: 'I loved this section about pivots' },
  });
  await f.seed({
    id: 'body-has-keyword',
    body: 'this body talks about pivots a lot',
    fields: { newsletter_slug: 'p', forward_note: 'just a thought' },
  });

  const r = await f.fetch('/inbox/mailroom/notes?text=pivot');
  const body = await r.json();
  assertEquals(body.count, 1);
  assertEquals(body.notes[0].id, 'note-has-keyword');
});

Deno.test('notes: ?text= is case-insensitive', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: { newsletter_slug: 'p', forward_note: 'Thoughts on Substack' },
  });

  const r = await f.fetch('/inbox/mailroom/notes?text=SUBSTACK');
  const body = await r.json();
  assertEquals(body.count, 1);
});

Deno.test('notes: ?slug= scopes to one newsletter', async () => {
  const f = buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'note A' } });
  await f.seed({ id: 'b', fields: { newsletter_slug: 'pub-b', forward_note: 'note B' } });

  const r = await f.fetch('/inbox/mailroom/notes?slug=pub-a');
  const body = await r.json();
  assertEquals(body.count, 1);
  assertEquals(body.notes[0].id, 'a');
});

Deno.test('notes: ?since= filters by received_at', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'old',
    received_at: '2026-04-20T00:00:00.000Z',
    fields: { newsletter_slug: 'p', forward_note: 'old' },
  });
  await f.seed({
    id: 'new',
    received_at: '2026-04-26T00:00:00.000Z',
    fields: { newsletter_slug: 'p', forward_note: 'new' },
  });

  const r = await f.fetch('/inbox/mailroom/notes?since=2026-04-22T00:00:00.000Z');
  const body = await r.json();
  assertEquals(body.count, 1);
  assertEquals(body.notes[0].id, 'new');
});

Deno.test('notes: ?order=oldest reverses', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    received_at: '2026-04-26T10:00:00.000Z',
    fields: { newsletter_slug: 'p', forward_note: 'a' },
  });
  await f.seed({
    id: 'b',
    received_at: '2026-04-25T10:00:00.000Z',
    fields: { newsletter_slug: 'p', forward_note: 'b' },
  });

  const newest = await (await f.fetch('/inbox/mailroom/notes')).json();
  assertEquals(newest.notes[0].id, 'a');

  const oldest = await (await f.fetch('/inbox/mailroom/notes?order=oldest')).json();
  assertEquals(oldest.notes[0].id, 'b');
});

Deno.test('notes: total reports pre-limit filtered count', async () => {
  const f = buildFixture();
  for (let i = 1; i <= 5; i++) {
    await f.seed({
      id: `a-${i}`,
      received_at: `2026-04-2${i}T10:00:00.000Z`,
      fields: { newsletter_slug: 'p', forward_note: `note ${i}` },
    });
  }

  const r = await f.fetch('/inbox/mailroom/notes?limit=2');
  const body = await r.json();
  assertEquals(body.count, 2);
  assertEquals(body.total, 5);
});

Deno.test('notes: ?format=markdown groups by slug with H2 per group', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'internet-pipes',
      original_from_addr: 'Steph at Internet Pipes',
      original_subject: 'IP Digest #1',
      original_sent_at: '2024-08-31T08:55:00.000Z',
      forward_note: 'loved the factory tour section',
    },
  });
  await f.seed({
    id: 'b',
    fields: {
      newsletter_slug: 'rosieland',
      original_from_addr: 'Rosieland',
      original_subject: 'pivot',
      original_sent_at: '2026-04-26T08:16:00.000Z',
      forward_note: 'reminder to self: sub mailroom to rosieland',
    },
  });

  const r = await f.fetch('/inbox/mailroom/notes?format=markdown');
  assertEquals(r.status, 200);
  assertEquals(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const body = await r.text();
  assertStringIncludes(body, '# Mailroom — all notes');
  // H2 per slug
  assertStringIncludes(body, '## Steph at Internet Pipes');
  assertStringIncludes(body, '## Rosieland');
  // Notes rendered as blockquote
  assertStringIncludes(body, '> loved the factory tour section');
  assertStringIncludes(body, '> reminder to self: sub mailroom to rosieland');
  // Slug metadata line
  assertStringIncludes(body, '**Slug:** `internet-pipes`');
  assertStringIncludes(body, '**Slug:** `rosieland`');
});

Deno.test('notes: ?format=markdown surfaces filter metadata in header', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: { newsletter_slug: 'p', forward_note: 'a thought about pivots' },
  });

  const r = await f.fetch('/inbox/mailroom/notes?format=markdown&text=pivot');
  const body = await r.text();
  assertStringIncludes(body, '**Filters:** text: `pivot`');
});

Deno.test('notes: ?format=markdown empty-state when no notes match', async () => {
  const f = buildFixture();
  const r = await f.fetch('/inbox/mailroom/notes?format=markdown');
  const body = await r.text();
  assertStringIncludes(body, '_No matching notes._');
});

Deno.test('notes: 404 on unknown inbox', async () => {
  const f = buildFixture();
  const r = await f.fetch('/inbox/no-such-inbox/notes');
  assertEquals(r.status, 404);
});

Deno.test('notes: items with empty-string forward_note are excluded', async () => {
  const f = buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'p', forward_note: '' } });
  await f.seed({ id: 'b', fields: { newsletter_slug: 'p', forward_note: 'real' } });

  const r = await f.fetch('/inbox/mailroom/notes');
  const body = await r.json();
  assertEquals(body.count, 1);
  assertEquals(body.notes[0].id, 'b');
});

Deno.test('notes: slug regex meta-chars survive (escapeRegex precondition)', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: { newsletter_slug: 'foo.bar', forward_note: 'a' },
  });
  await f.seed({
    id: 'b',
    fields: { newsletter_slug: 'fooXbar', forward_note: 'b' },
  });

  // If the slug were treated as regex, "foo.bar" would also match "fooXbar".
  const r = await f.fetch('/inbox/mailroom/notes?slug=foo.bar');
  const body = await r.json();
  assertEquals(body.count, 1);
  assertEquals(body.notes[0].id, 'a');
});
