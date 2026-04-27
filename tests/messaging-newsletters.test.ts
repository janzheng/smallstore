/**
 * Phase 2 — newsletter views (per `.brief/forward-notes-and-newsletter-profiles.md`).
 *
 * Covers:
 *   - Inbox.list / Inbox.query with `order_by: 'original_sent_at'`
 *   - HTTP routes:
 *       GET /inbox/:name/newsletters
 *       GET /inbox/:name/newsletters/:slug
 *       GET /inbox/:name/newsletters/:slug/items
 *       GET /inbox/:name/newsletters/:slug/notes
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
  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));
  return { app, inbox, fetch };
}

function makeForward(opts: {
  id: string;
  slug?: string;
  original_sent_at?: string;
  received_at?: string;
  forward_note?: string;
  subject?: string;
  display?: string;
}): InboxItem {
  return {
    id: opts.id,
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: opts.received_at ?? '2026-04-26T20:05:00.000Z',
    summary: `Fwd: ${opts.subject ?? 'Issue'}`,
    fields: {
      from_email: 'me@example.com',
      subject: `Fwd: ${opts.subject ?? 'Issue'}`,
      ...(opts.slug !== undefined && { newsletter_slug: opts.slug }),
      ...(opts.original_sent_at !== undefined && { original_sent_at: opts.original_sent_at }),
      ...(opts.forward_note !== undefined && { forward_note: opts.forward_note }),
      original_subject: opts.subject ?? 'Issue',
      original_from_addr: opts.display ?? 'Steph at Internet Pipes <internetpipes@example.com>',
      original_from_email: 'internetpipes@example.com',
    },
    labels: ['forwarded', 'manual'],
  };
}

async function ingestForwards(inbox: any, items: InboxItem[]): Promise<void> {
  for (const item of items) {
    await inbox._ingest(item);
  }
}

// ============================================================================
// Inbox.query with order_by
// ============================================================================

Deno.test('Inbox.query — order_by=original_sent_at sorts by that field', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'item-1', slug: 'ip', original_sent_at: '2024-08-08T07:06:00Z', received_at: '2026-04-26T20:05:00.000Z' }),
    makeForward({ id: 'item-2', slug: 'ip', original_sent_at: '2025-01-09T07:47:00Z', received_at: '2026-04-26T20:04:50.000Z' }),
    makeForward({ id: 'item-3', slug: 'ip', original_sent_at: '2026-04-26T10:16:00Z', received_at: '2026-04-26T20:04:40.000Z' }),
  ]);
  const result = await fx.inbox.query(
    { fields_regex: { newsletter_slug: '^ip$' } },
    { order_by: 'original_sent_at', order: 'oldest' },
  );
  assertEquals(result.items.map((i) => i.id), ['item-1', 'item-2', 'item-3']);
  assertEquals(result.total, 3);
});

Deno.test('Inbox.query — order_by=original_sent_at oldest tail items missing the field', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'with-date', slug: 'ip', original_sent_at: '2024-08-08T07:06:00Z' }),
    makeForward({ id: 'no-date', slug: 'ip' }), // no original_sent_at
  ]);
  const result = await fx.inbox.query(
    { fields_regex: { newsletter_slug: '^ip$' } },
    { order_by: 'original_sent_at', order: 'oldest' },
  );
  // with-date first (has the field), no-date last (missing-field tails)
  assertEquals(result.items.map((i) => i.id), ['with-date', 'no-date']);
});

Deno.test('Inbox.query — order_by=original_sent_at rejects cursor', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'ip', original_sent_at: '2024-01-01T00:00:00Z' }),
  ]);
  let threw = false;
  try {
    await fx.inbox.query(
      { fields_regex: { newsletter_slug: '^ip$' } },
      { order_by: 'original_sent_at', cursor: 'bogus' },
    );
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes('Cursor pagination is not supported'));
  }
  assert(threw);
});

Deno.test('Inbox.list — default order_by undefined preserves received_at behavior', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', received_at: '2026-04-01T00:00:00.000Z' }),
    makeForward({ id: 'b', received_at: '2026-04-02T00:00:00.000Z' }),
  ]);
  const result = await fx.inbox.list({});
  assertEquals(result.items.map((i) => i.id), ['b', 'a']); // newest first
});

// ============================================================================
// GET /inbox/:name/newsletters
// ============================================================================

Deno.test('GET /inbox/:name/newsletters — returns slugs with counts (latest-first)', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'ip-1', slug: 'internet-pipes', original_sent_at: '2024-08-08T00:00:00Z' }),
    makeForward({ id: 'ip-2', slug: 'internet-pipes', original_sent_at: '2026-04-26T00:00:00Z' }),
    makeForward({ id: 'sb-1', slug: 'sidebar-io', original_sent_at: '2025-06-01T00:00:00Z', display: 'Sidebar.io <hello@uxdesign.cc>' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.newsletters.length, 2);
  // Latest first → internet-pipes (2026 latest) before sidebar-io (2025)
  assertEquals(body.newsletters[0].slug, 'internet-pipes');
  assertEquals(body.newsletters[0].count, 2);
  assertEquals(body.newsletters[1].slug, 'sidebar-io');
  assertEquals(body.newsletters[1].count, 1);
  assertEquals(body.newsletters[1].display, 'Sidebar.io');
});

Deno.test('GET /inbox/:name/newsletters — empty inbox returns empty list', async () => {
  const fx = buildFixture();
  const res = await fx.fetch('/inbox/mailroom/newsletters');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.newsletters, []);
});

// ============================================================================
// GET /inbox/:name/newsletters/:slug
// ============================================================================

Deno.test('GET /inbox/:name/newsletters/:slug — profile dashboard', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'internet-pipes', original_sent_at: '2024-08-08T00:00:00Z', forward_note: 'liked the agrivoltaics piece', subject: 'IP 1' }),
    makeForward({ id: 'b', slug: 'internet-pipes', original_sent_at: '2025-01-09T00:00:00Z', subject: 'IP 2' }),
    makeForward({ id: 'c', slug: 'internet-pipes', original_sent_at: '2026-04-26T00:00:00Z', forward_note: 'great whimsymaxxing read', subject: 'IP 3' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/internet-pipes');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.slug, 'internet-pipes');
  assertEquals(body.count, 3);
  assertEquals(body.first_seen_at, '2024-08-08T00:00:00Z');
  assertEquals(body.last_seen_at, '2026-04-26T00:00:00Z');
  assertEquals(body.notes_count, 2);
  assertEquals(body.last_note.text, 'great whimsymaxxing read');
  assertEquals(body.last_note.subject, 'IP 3');
});

Deno.test('GET /inbox/:name/newsletters/:slug — 404 unknown slug', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'real-slug' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/nonexistent');
  assertEquals(res.status, 404);
});

// ============================================================================
// GET /inbox/:name/newsletters/:slug/items
// ============================================================================

Deno.test('GET /inbox/:name/newsletters/:slug/items — chronological order (oldest default)', async () => {
  const fx = buildFixture();
  // Ingest deliberately out-of-order
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'c', slug: 'ip', original_sent_at: '2026-04-26T00:00:00Z', received_at: '2026-04-26T20:00:01.000Z' }),
    makeForward({ id: 'a', slug: 'ip', original_sent_at: '2024-08-08T00:00:00Z', received_at: '2026-04-26T20:00:02.000Z' }),
    makeForward({ id: 'b', slug: 'ip', original_sent_at: '2025-01-09T00:00:00Z', received_at: '2026-04-26T20:00:03.000Z' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/ip/items');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.map((i: InboxItem) => i.id), ['a', 'b', 'c']);
});

Deno.test('GET /inbox/:name/newsletters/:slug/items — order=newest reverses', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'ip', original_sent_at: '2024-08-08T00:00:00Z' }),
    makeForward({ id: 'c', slug: 'ip', original_sent_at: '2026-04-26T00:00:00Z' }),
    makeForward({ id: 'b', slug: 'ip', original_sent_at: '2025-01-09T00:00:00Z' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/ip/items?order=newest');
  const body = await res.json();
  assertEquals(body.items.map((i: InboxItem) => i.id), ['c', 'b', 'a']);
});

Deno.test('GET /inbox/:name/newsletters/:slug/items — only items with matching slug', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'ip-1', slug: 'ip', original_sent_at: '2024-08-08T00:00:00Z' }),
    makeForward({ id: 'sb-1', slug: 'sidebar-io', original_sent_at: '2024-08-08T00:00:00Z' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/ip/items');
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].id, 'ip-1');
});

// ============================================================================
// GET /inbox/:name/newsletters/:slug/notes
// ============================================================================

Deno.test('GET /inbox/:name/newsletters/:slug/notes — only items with non-empty forward_note', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'ip', original_sent_at: '2024-08-08T00:00:00Z', forward_note: 'first note', subject: 'IP 1' }),
    makeForward({ id: 'b', slug: 'ip', original_sent_at: '2025-01-09T00:00:00Z', subject: 'IP 2' }), // no note
    makeForward({ id: 'c', slug: 'ip', original_sent_at: '2026-04-26T00:00:00Z', forward_note: 'third note', subject: 'IP 3' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/ip/notes');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.count, 2);
  assertEquals(body.notes.map((n: any) => n.id), ['a', 'c']); // chronological
  assertEquals(body.notes[0].note, 'first note');
  assertEquals(body.notes[0].subject, 'IP 1');
});

Deno.test('GET /inbox/:name/newsletters/:slug/notes — empty when no notes', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'ip', original_sent_at: '2024-08-08T00:00:00Z' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom/newsletters/ip/notes');
  const body = await res.json();
  assertEquals(body.count, 0);
  assertEquals(body.notes, []);
});

// ============================================================================
// Edge: slug regex escaping
// ============================================================================

Deno.test('GET /inbox/:name/newsletters/:slug — slug with special chars escaped properly', async () => {
  const fx = buildFixture();
  // Realistic slugs from `slugifyNewsletterDisplayName` are kebab-case lowercase,
  // but defensively check that regex meta-chars in a slug don't break the route.
  // (Won't happen with the current slugifier, but the route MUST escape regardless.)
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'normal-slug', original_sent_at: '2024-08-08T00:00:00Z' }),
  ]);
  // A slug-shaped string with regex meta-chars should NOT match `normal-slug`
  // due to substring/regex behavior.
  const res = await fx.fetch('/inbox/mailroom/newsletters/.+');
  assertEquals(res.status, 404, 'wildcard-shaped slug must NOT match — regex chars must escape');
});

// ============================================================================
// /inbox/:name?order_by=original_sent_at
// ============================================================================

Deno.test('GET /inbox/:name?order_by=original_sent_at — sorts the whole inbox', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'ip', original_sent_at: '2024-08-08T00:00:00Z', received_at: '2026-04-26T20:00:03Z' }),
    makeForward({ id: 'b', slug: 'ip', original_sent_at: '2025-01-09T00:00:00Z', received_at: '2026-04-26T20:00:02Z' }),
    makeForward({ id: 'c', slug: 'ip', original_sent_at: '2026-04-26T00:00:00Z', received_at: '2026-04-26T20:00:01Z' }),
  ]);
  const res = await fx.fetch('/inbox/mailroom?order_by=original_sent_at&order=oldest');
  const body = await res.json();
  assertEquals(body.items.map((i: InboxItem) => i.id), ['a', 'b', 'c']);
});

// ============================================================================
// Engagement signal — total_note_chars + avg_note_chars
// ============================================================================

Deno.test('GET /inbox/:name/newsletters — index includes total_note_chars + notes_count per slug', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'engaged', forward_note: 'a long thoughtful note about this issue' }), // 39 chars
    makeForward({ id: 'b', slug: 'engaged', forward_note: 'short' }), // 5 chars
    makeForward({ id: 'c', slug: 'silent' }), // no note
    makeForward({ id: 'd', slug: 'silent' }),
  ]);

  const res = await fx.fetch('/inbox/mailroom/newsletters');
  const body = await res.json();
  const engaged = body.newsletters.find((n: { slug: string }) => n.slug === 'engaged');
  const silent = body.newsletters.find((n: { slug: string }) => n.slug === 'silent');

  assertEquals(engaged.notes_count, 2);
  assertEquals(engaged.total_note_chars, 44);
  assertEquals(silent.notes_count, 0);
  assertEquals(silent.total_note_chars, 0);
});

Deno.test('GET /inbox/:name/newsletters/:slug — profile dashboard returns total_note_chars + avg_note_chars', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'pub', forward_note: 'a' .repeat(40) }),
    makeForward({ id: 'b', slug: 'pub', forward_note: 'b' .repeat(60) }),
    makeForward({ id: 'c', slug: 'pub' }), // no note — doesn't count toward avg
  ]);

  const res = await fx.fetch('/inbox/mailroom/newsletters/pub');
  const body = await res.json();

  assertEquals(body.notes_count, 2);
  assertEquals(body.total_note_chars, 100);
  assertEquals(body.avg_note_chars, 50); // 100 / 2 noted issues, not 100 / 3 total
});

Deno.test('GET /inbox/:name/newsletters/:slug — avg_note_chars is 0 (not NaN) when notes_count is 0', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'never-noted' }),
    makeForward({ id: 'b', slug: 'never-noted' }),
  ]);

  const res = await fx.fetch('/inbox/mailroom/newsletters/never-noted');
  const body = await res.json();

  assertEquals(body.notes_count, 0);
  assertEquals(body.total_note_chars, 0);
  assertEquals(body.avg_note_chars, 0);
});

Deno.test('GET /inbox/:name/newsletters/:slug?format=markdown — Engagement line appears when notes exist', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({
      id: 'a',
      slug: 'pub',
      forward_note: 'thinking about this',
      original_sent_at: '2026-04-26T10:00:00Z',
    }),
  ]);

  const res = await fx.fetch('/inbox/mailroom/newsletters/pub?format=markdown');
  const body = await res.text();

  // "**Engagement:** 19 chars across 1 notes (avg 19/note)"
  if (!body.includes('**Engagement:**')) {
    throw new Error(`expected Engagement line in markdown, got:\n${body}`);
  }
  if (!body.includes('19 chars')) {
    throw new Error(`expected "19 chars" in markdown, got:\n${body}`);
  }
});

Deno.test('GET /inbox/:name/newsletters/:slug?format=markdown — no Engagement line when zero notes', async () => {
  const fx = buildFixture();
  await ingestForwards(fx.inbox, [
    makeForward({ id: 'a', slug: 'pub', original_sent_at: '2026-04-26T10:00:00Z' }),
  ]);

  const res = await fx.fetch('/inbox/mailroom/newsletters/pub?format=markdown');
  const body = await res.text();

  if (body.includes('**Engagement:**')) {
    throw new Error(`Engagement line should be omitted when notes_count=0:\n${body}`);
  }
});
