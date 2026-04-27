/**
 * Phase 2a — markdown rendering for newsletter views
 * (per `.brief/notes-todos-and-mirror.md`).
 *
 * Covers:
 *   - All three routes accept `?format=markdown` and respond with
 *     `Content-Type: text/markdown; charset=utf-8`
 *   - Index page renders a table linking to `./<slug>.md` (relative)
 *   - Per-publisher view renders profile header + chronological items
 *     + notes inlined as blockquotes
 *   - Notes-only view skips items without notes, includes display name
 *   - Slug regex meta-chars survive (escapeRegex precondition)
 *   - Empty newsletter index renders the empty-state line
 *   - Items missing original_sent_at sort to tail with "(date unknown)"
 *   - Subject falls back to summary when original_subject missing
 *   - Note with embedded markdown round-trips verbatim into blockquote
 *   - Multi-line notes render with one `> ` per line
 *   - JSON path (no format=) still works (regression check)
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import {
  renderNewsletterIndex,
  renderNewsletterNotes,
  renderNewsletterProfile,
} from '../src/messaging/newsletter-markdown.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

interface Fixture {
  app: Hono;
  inbox: ReturnType<typeof createInbox>;
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
    inbox,
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

// ---------------------------------------------------------------------
// Pure renderer unit tests
// ---------------------------------------------------------------------

Deno.test('renderNewsletterIndex: empty state', () => {
  const md = renderNewsletterIndex('mailroom', []);
  assertStringIncludes(md, '# Mailroom newsletters');
  assertStringIncludes(md, '_No newsletters yet');
});

Deno.test('renderNewsletterIndex: relative link per slug', () => {
  const md = renderNewsletterIndex('mailroom', [
    { slug: 'internet-pipes', count: 24, latest_at: '2026-04-26T10:16:00.000Z', display: 'Steph at Internet Pipes' },
    { slug: 'rosieland', count: 1, latest_at: '2026-04-26T08:16:00.000Z', display: 'Rosieland' },
  ]);
  assertStringIncludes(md, '| [internet-pipes](./internet-pipes.md) | Steph at Internet Pipes | 24 | 2026-04-26 |');
  assertStringIncludes(md, '| [rosieland](./rosieland.md) | Rosieland | 1 | 2026-04-26 |');
});

Deno.test('renderNewsletterIndex: pipes in display name escaped', () => {
  const md = renderNewsletterIndex('mailroom', [
    { slug: 'weird', count: 1, latest_at: '2026-04-26', display: 'Foo | Bar' },
  ]);
  assertStringIncludes(md, 'Foo \\| Bar');
});

Deno.test('renderNewsletterProfile: header + items + notes inlined', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2024-08-31T08:55:00.000Z',
      summary: 'IP Digest 1',
      fields: {
        original_sent_at: '2024-08-31T08:55:00.000Z',
        original_subject: 'IP Digest: New Events, Disaster Insurance, Bubble Tea & More!',
        forward_note: 'I loved the section on factory tours.',
      },
    },
    {
      id: 'b',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2024-09-01T08:01:00.000Z',
      summary: 'IP Digest 2',
      fields: {
        original_sent_at: '2024-09-01T08:01:00.000Z',
        original_subject: 'IP Digest: Free Homes, Tanpin Kanri, & More!',
      },
    },
  ];
  const md = renderNewsletterProfile(
    'mailroom',
    'internet-pipes',
    {
      slug: 'internet-pipes',
      display: 'Steph at Internet Pipes',
      count: 2,
      first_seen_at: '2024-08-31T08:55:00.000Z',
      last_seen_at: '2024-09-01T08:01:00.000Z',
      notes_count: 1,
    },
    items,
    'https://smallstore.labspace.ai',
  );

  assertStringIncludes(md, '# Steph at Internet Pipes');
  assertStringIncludes(md, '**Slug:** `internet-pipes`');
  assertStringIncludes(md, '**Issues:** 2');
  assertStringIncludes(md, '**Notes:** 1');
  // Chronological — first item heading
  assertStringIncludes(md, '## 2024-08-31 — IP Digest: New Events');
  // Note rendered as blockquote
  assertStringIncludes(md, '> I loved the section on factory tours.');
  // Item without note shows the placeholder
  assertStringIncludes(md, '_(no note)_');
  // Absolute View item link
  assertStringIncludes(md, '[View item →](https://smallstore.labspace.ai/inbox/mailroom/items/a)');
});

Deno.test('renderNewsletterProfile: chronological order, dates missing tail', () => {
  const items: InboxItem[] = [
    {
      id: 'undated',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-20T10:00:00.000Z',
      summary: 'No date',
      fields: { original_subject: 'Item with no original_sent_at' },
    },
    {
      id: 'dated-late',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Late',
      fields: {
        original_sent_at: '2026-04-26T08:00:00.000Z',
        original_subject: 'Late dated item',
      },
    },
    {
      id: 'dated-early',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-22T10:00:00.000Z',
      summary: 'Early',
      fields: {
        original_sent_at: '2026-04-22T08:00:00.000Z',
        original_subject: 'Early dated item',
      },
    },
  ];
  const md = renderNewsletterProfile(
    'mailroom',
    'p',
    { slug: 'p', count: 3, notes_count: 0 },
    items,
    '',
  );
  // Order: dated-early, dated-late, undated (tail)
  const earlyIdx = md.indexOf('Early dated item');
  const lateIdx = md.indexOf('Late dated item');
  const undatedIdx = md.indexOf('Item with no original_sent_at');
  assert(earlyIdx > 0 && earlyIdx < lateIdx);
  assert(lateIdx < undatedIdx);
  assertStringIncludes(md, '## (date unknown) — Item with no original_sent_at');
});

Deno.test('renderNewsletterProfile: falls back to top-level sent_at when original_sent_at is missing', () => {
  // Direct subs (not forwarded) don't get original_sent_at populated by
  // forward-detect. Mirror should still show the email's Date header.
  const items: InboxItem[] = [
    {
      id: 'forwarded',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Forwarded',
      fields: {
        original_sent_at: '2026-04-26T08:00:00.000Z',
        original_subject: 'Forwarded item',
      },
    },
    {
      id: 'direct-sub',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-25T10:00:00.000Z',
      sent_at: '2026-04-25T07:30:00.000Z', // top-level fallback
      summary: 'Direct sub item',
      fields: {},
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 2, notes_count: 0 }, items, '');
  // Direct sub renders with its sent_at date — not "(date unknown)".
  assertStringIncludes(md, '## 2026-04-25 — Direct sub item');
  // And sorts before the forwarded item (oldest first).
  const directIdx = md.indexOf('Direct sub item');
  const forwardedIdx = md.indexOf('Forwarded item');
  assert(directIdx > 0 && directIdx < forwardedIdx);
});

Deno.test('renderNewsletterProfile: inlines body_inflated when present (HTML stripped)', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Issue 1',
      body: null,
      body_ref: 'html/a.html',
      body_inflated: '<h2>Hello</h2><p>Some <a href="https://x.com">link</a> here.</p>',
      fields: { original_sent_at: '2026-04-26T08:00:00.000Z', original_subject: 'Issue 1' },
    } as InboxItem,
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 0 }, items, '');
  assertStringIncludes(md, '## Hello'); // HTML h2 → markdown
  assertStringIncludes(md, '[link](https://x.com)');
  // No "(no note)" placeholder when body is present.
  assertEquals(md.includes('_(no note)_'), false);
});

Deno.test('renderNewsletterProfile: inlines plain-text body when no body_inflated', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Plain issue',
      body: 'This is plain text content.\n\nWith two paragraphs.',
      fields: { original_sent_at: '2026-04-26T08:00:00.000Z', original_subject: 'Plain issue' },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 0 }, items, '');
  assertStringIncludes(md, 'This is plain text content.');
  assertStringIncludes(md, 'With two paragraphs.');
});

Deno.test('renderNewsletterProfile: shows note AND body together when both exist', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Annotated',
      body: 'Newsletter body here.',
      fields: {
        original_sent_at: '2026-04-26T08:00:00.000Z',
        original_subject: 'Annotated',
        forward_note: 'My take: this is great.',
      },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 1 }, items, '');
  assertStringIncludes(md, '> My take: this is great.');
  assertStringIncludes(md, 'Newsletter body here.');
});

Deno.test('renderNewsletterProfile: missing body keeps "(no note)" fallback when there is no note either', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Empty',
      body: null,
      fields: { original_sent_at: '2026-04-26T08:00:00.000Z', original_subject: 'Empty' },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 0 }, items, '');
  assertStringIncludes(md, '_(no note)_');
});

Deno.test('renderNewsletterProfile: prefers original_sent_at over sent_at when both present', () => {
  // Forwarded items: forward-detect's original_sent_at (upstream send)
  // wins over the top-level sent_at (when the user forwarded).
  const items: InboxItem[] = [
    {
      id: 'forwarded',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-27T10:00:00.000Z',
      sent_at: '2026-04-27T09:00:00.000Z', // forward time
      summary: 'Forwarded',
      fields: {
        original_sent_at: '2024-09-01T08:00:00.000Z', // upstream send time
        original_subject: 'Old IP digest',
      },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 0 }, items, '');
  assertStringIncludes(md, '## 2024-09-01 — Old IP digest');
});

// ============================================================================
// renderRecentFeed
// ============================================================================

Deno.test('renderRecentFeed: filters items by window, sorts newest-first', async () => {
  const { renderRecentFeed } = await import('../src/messaging/newsletter-markdown.ts');
  const items: InboxItem[] = [
    {
      id: 'old',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-01-01T10:00:00Z',
      summary: 'Ancient',
      sent_at: '2026-01-01T10:00:00Z',
      fields: { newsletter_slug: 'pub-a', original_subject: 'Ancient' },
    },
    {
      id: 'mid',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-25T10:00:00Z',
      summary: 'Recent',
      sent_at: '2026-04-25T10:00:00Z',
      fields: { newsletter_slug: 'pub-a', original_subject: 'Recent' },
    },
    {
      id: 'new',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-27T10:00:00Z',
      summary: 'Newest',
      sent_at: '2026-04-27T10:00:00Z',
      fields: { newsletter_slug: 'pub-b', original_subject: 'Newest' },
    },
  ];
  const now = Date.parse('2026-04-27T12:00:00Z');
  const md = renderRecentFeed('mailroom', items, '', 7, now);

  // Newest first; old item excluded by 7-day window.
  assertStringIncludes(md, '## 2026-04-27 — Newest');
  assertStringIncludes(md, '## 2026-04-25 — Recent');
  assertEquals(md.includes('Ancient'), false);
  // Newest appears before mid in the document.
  assert(md.indexOf('Newest') < md.indexOf('Recent'));
});

Deno.test('renderRecentFeed: empty window emits a friendly placeholder', async () => {
  const { renderRecentFeed } = await import('../src/messaging/newsletter-markdown.ts');
  const items: InboxItem[] = [
    {
      id: 'old',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-01-01T10:00:00Z',
      summary: 'Ancient',
      sent_at: '2026-01-01T10:00:00Z',
      fields: { newsletter_slug: 'pub', original_subject: 'Ancient' },
    },
  ];
  const now = Date.parse('2026-04-27T12:00:00Z');
  const md = renderRecentFeed('mailroom', items, '', 7, now);
  assertStringIncludes(md, 'Nothing landed in the last 7 days');
  assertEquals(md.includes('Ancient'), false);
});

Deno.test('renderRecentFeed: shows publisher with relative .md link', async () => {
  const { renderRecentFeed } = await import('../src/messaging/newsletter-markdown.ts');
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00Z',
      summary: 'Issue',
      sent_at: '2026-04-26T10:00:00Z',
      fields: {
        newsletter_slug: 'sidebar-io',
        newsletter_name: 'Sidebar.io',
        original_subject: 'Issue',
      },
    },
  ];
  const now = Date.parse('2026-04-27T12:00:00Z');
  const md = renderRecentFeed('mailroom', items, '', 7, now);
  assertStringIncludes(md, '**Publisher:** [Sidebar.io](./sidebar-io.md)');
});

Deno.test('renderRecentFeed: items without dates are excluded entirely', async () => {
  const { renderRecentFeed } = await import('../src/messaging/newsletter-markdown.ts');
  const items: InboxItem[] = [
    {
      id: 'undated',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00Z',
      summary: 'No date',
      // no sent_at, no original_sent_at
      fields: { newsletter_slug: 'pub', original_subject: 'Undated' },
    },
  ];
  const now = Date.parse('2026-04-27T12:00:00Z');
  const md = renderRecentFeed('mailroom', items, '', 7, now);
  assertStringIncludes(md, 'Nothing landed in the last 7 days');
  assertEquals(md.includes('Undated'), false);
});

Deno.test('renderRecentFeed: includes header counts (items, publishers)', async () => {
  const { renderRecentFeed } = await import('../src/messaging/newsletter-markdown.ts');
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00Z',
      summary: 'A',
      sent_at: '2026-04-26T10:00:00Z',
      fields: { newsletter_slug: 'pub-a', original_subject: 'A' },
    },
    {
      id: 'b',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T11:00:00Z',
      summary: 'B',
      sent_at: '2026-04-26T11:00:00Z',
      fields: { newsletter_slug: 'pub-b', original_subject: 'B' },
    },
    {
      id: 'c',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T12:00:00Z',
      summary: 'C',
      sent_at: '2026-04-26T12:00:00Z',
      fields: { newsletter_slug: 'pub-a', original_subject: 'C' },
    },
  ];
  const now = Date.parse('2026-04-27T12:00:00Z');
  const md = renderRecentFeed('mailroom', items, '', 7, now);
  assertStringIncludes(md, '**Items:** 3');
  assertStringIncludes(md, '**Publishers:** 2');
});

// ============================================================================
// renderNewsletterProfile (existing tests)
// ============================================================================

Deno.test('renderNewsletterProfile: multi-line note → one `>` per line', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'x',
      fields: {
        original_sent_at: '2026-04-26T10:00:00.000Z',
        original_subject: 'x',
        forward_note: 'first thought\n\nfollow-up after re-reading\n\n- bullet point',
      },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 1 }, items, '');
  assertStringIncludes(md, '> first thought');
  assertStringIncludes(md, '> follow-up after re-reading');
  assertStringIncludes(md, '> - bullet point');
  // Empty lines in the note become bare `>` markers (preserves visual spacing in
  // markdown viewers).
  assertStringIncludes(md, '>\n');
});

Deno.test('renderNewsletterProfile: subject falls back to summary then placeholder', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'Summary fallback',
      fields: { original_sent_at: '2026-04-26T10:00:00.000Z' },
    },
    {
      id: 'b',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T11:00:00.000Z',
      summary: undefined as unknown as string,
      fields: { original_sent_at: '2026-04-26T11:00:00.000Z' },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 2, notes_count: 0 }, items, '');
  assertStringIncludes(md, 'Summary fallback');
  assertStringIncludes(md, '(no subject)');
});

Deno.test('renderNewsletterProfile: empty origin omits View item link', () => {
  const items: InboxItem[] = [
    {
      id: 'a',
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'x',
      fields: { original_sent_at: '2026-04-26T10:00:00.000Z', original_subject: 'x' },
    },
  ];
  const md = renderNewsletterProfile('mailroom', 'p', { slug: 'p', count: 1, notes_count: 0 }, items, '');
  assert(!md.includes('View item'));
});

Deno.test('renderNewsletterNotes: notes-only — skips items with no note', () => {
  const md = renderNewsletterNotes(
    'mailroom',
    'p',
    { slug: 'p', display: 'Pub', count: 0, notes_count: 1 },
    [
      { id: 'a', original_sent_at: '2026-04-26T10:00:00.000Z', subject: 'has-note', note: 'thoughts' },
      { id: 'b', original_sent_at: '2026-04-25T10:00:00.000Z', subject: 'no-note', note: '' },
    ],
    '',
  );
  assertStringIncludes(md, 'has-note');
  assert(!md.includes('no-note'));
});

Deno.test('renderNewsletterNotes: empty notes list → empty-state placeholder', () => {
  const md = renderNewsletterNotes(
    'mailroom',
    'p',
    { slug: 'p', count: 0, notes_count: 0 },
    [],
    '',
  );
  assertStringIncludes(md, '_No notes yet');
});

// ---------------------------------------------------------------------
// HTTP integration tests
// ---------------------------------------------------------------------

Deno.test('GET /newsletters?format=markdown sets Content-Type and renders index', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'pub-a',
      original_from_addr: 'Pub A',
      original_sent_at: '2026-04-26T10:00:00.000Z',
    },
  });

  const r = await f.fetch('/inbox/mailroom/newsletters?format=markdown');
  assertEquals(r.status, 200);
  assertEquals(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const body = await r.text();
  assertStringIncludes(body, '# Mailroom newsletters');
  assertStringIncludes(body, '[pub-a](./pub-a.md)');
});

Deno.test('GET /newsletters/:slug?format=markdown renders the full profile view', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'rosieland',
      original_from_addr: 'Rosieland <rosieland@ghost.io>',
      original_subject: "The overglorification of 'the pivot'",
      original_sent_at: '2026-04-26T08:16:00.000Z',
      forward_note: 'reminder to self: sub mailroom to rosieland',
    },
  });

  const r = await f.fetch('/inbox/mailroom/newsletters/rosieland?format=markdown');
  assertEquals(r.status, 200);
  assertEquals(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const body = await r.text();
  assertStringIncludes(body, '# Rosieland'); // angle-addr stripped
  assertStringIncludes(body, '**Slug:** `rosieland`');
  assertStringIncludes(body, '**Issues:** 1');
  assertStringIncludes(body, "## 2026-04-26 — The overglorification of 'the pivot'");
  assertStringIncludes(body, '> reminder to self: sub mailroom to rosieland');
});

Deno.test('GET /newsletters/:slug/notes?format=markdown renders notes-only view', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'pub',
      original_from_addr: 'Pub',
      original_subject: 'first issue',
      original_sent_at: '2026-04-26T10:00:00.000Z',
      forward_note: 'a thought',
    },
  });

  const r = await f.fetch('/inbox/mailroom/newsletters/pub/notes?format=markdown');
  assertEquals(r.status, 200);
  assertEquals(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const body = await r.text();
  assertStringIncludes(body, '# Notes — Pub');
  assertStringIncludes(body, '> a thought');
});

Deno.test('JSON path still works — no format= param returns JSON', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'pub',
      original_from_addr: 'Pub',
      original_sent_at: '2026-04-26T10:00:00.000Z',
    },
  });

  const r = await f.fetch('/inbox/mailroom/newsletters/pub');
  assertEquals(r.status, 200);
  assert(r.headers.get('content-type')?.startsWith('application/json'));
  const body = await r.json();
  assertEquals(body.slug, 'pub');
  assertEquals(body.count, 1);
});

Deno.test('Slug with regex meta-chars survives markdown rendering', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'foo.bar',
      original_from_addr: 'Foo.Bar',
      original_sent_at: '2026-04-26T10:00:00.000Z',
      original_subject: 's',
    },
  });

  const r = await f.fetch('/inbox/mailroom/newsletters/foo.bar?format=markdown');
  assertEquals(r.status, 200);
  const body = await r.text();
  assertStringIncludes(body, '**Slug:** `foo.bar`');
});

Deno.test('Markdown view 404s on unknown slug (same as JSON)', async () => {
  const f = buildFixture();
  const r = await f.fetch('/inbox/mailroom/newsletters/no-such-slug?format=markdown');
  assertEquals(r.status, 404);
});
