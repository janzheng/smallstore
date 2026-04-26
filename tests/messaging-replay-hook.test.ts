/**
 * Phase 3 — retroactive hook replay (per `.brief/forward-notes-and-newsletter-profiles.md`).
 *
 * Covers:
 *   - `IngestOptions.fields_only` — partial merge into stored items
 *   - `POST /admin/inboxes/:name/replay` — generic hook-replay endpoint
 *   - The IP-Digest-shaped backfill scenario end-to-end
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { createForwardDetectHook } from '../src/messaging/forward-detect.ts';
import type { InboxConfig, InboxItem, PreIngestHook } from '../src/messaging/types.ts';

const SELF = ['me@example.com'];

interface Fixture {
  app: Hono;
  inbox: ReturnType<typeof createInbox>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  hooks: Map<string, PreIngestHook>;
}

function buildFixture(): Fixture {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'items' } as InboxConfig, 'boot');
  const buildInbox = async (n: string, cfg: InboxConfig) =>
    createInbox({ name: n, channel: cfg.channel, storage: { items } });

  const hooks = new Map<string, PreIngestHook>();
  hooks.set('forward-detect', createForwardDetectHook({ selfAddresses: SELF }));

  const app = new Hono();
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInbox,
    replayHookFor: (inboxName, hookName) => {
      if (inboxName !== 'mailroom') return undefined;
      return hooks.get(hookName);
    },
  });
  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));
  return { app, inbox, fetch, hooks };
}

// ============================================================================
// IngestOptions.fields_only
// ============================================================================

Deno.test('_ingest fields_only — merges fields, unions labels, preserves identity', async () => {
  const fx = buildFixture();
  const orig: InboxItem = {
    id: 'item-1',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-26T20:05:00.000Z',
    summary: 'Original',
    fields: { from_email: 'me@example.com', existing_field: 'keep-me' },
    labels: ['existing-label'],
  };
  await (fx.inbox as any)._ingest(orig);

  const patch: InboxItem = {
    id: 'item-1',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '1999-01-01T00:00:00.000Z', // ignored
    summary: 'IGNORED',
    fields: { new_field: 'added-by-replay', existing_field: 'overwritten' },
    labels: ['new-label'],
  };
  const merged = await (fx.inbox as any)._ingest(patch, { fields_only: true });

  assertEquals(merged.id, 'item-1');
  assertEquals(merged.received_at, '2026-04-26T20:05:00.000Z'); // identity preserved
  assertEquals(merged.summary, 'Original'); // summary preserved
  assertEquals(merged.fields.existing_field, 'overwritten'); // patch wins
  assertEquals(merged.fields.from_email, 'me@example.com'); // existing preserved
  assertEquals(merged.fields.new_field, 'added-by-replay'); // new added
  assertEquals(merged.labels?.sort(), ['existing-label', 'new-label']); // unioned
});

Deno.test('_ingest fields_only — non-existent id returns the patch (callers detect via id round-trip)', async () => {
  const fx = buildFixture();
  const ghost: InboxItem = {
    id: 'never-stored',
    source: 'cf-email',
    received_at: '2026-01-01T00:00:00Z',
    fields: { foo: 'bar' },
  };
  const result = await (fx.inbox as any)._ingest(ghost, { fields_only: true });
  // Returns the patch unchanged when the target doesn't exist; nothing is written.
  // Verify by checking the inbox is still empty.
  const list = await fx.inbox.list({});
  assertEquals(list.items.length, 0);
});

// ============================================================================
// POST /admin/inboxes/:name/replay
// ============================================================================

function makeForward(opts: {
  id: string;
  body: string;
  subject?: string;
}): InboxItem {
  return {
    id: opts.id,
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-26T20:05:00.000Z',
    summary: opts.subject ?? 'Forward',
    body: opts.body,
    fields: {
      from_email: 'me@example.com',
      subject: opts.subject ?? 'Fwd: Issue',
    },
  };
}

const IP_BODY_TEMPLATE = (date: string) => [
  '---------- Forwarded message ---------',
  'From: Steph at Internet Pipes <internetpipes@broadcasts.lemonsqueezy-mail.com>',
  `Date: ${date}`,
  'Subject: IP Digest: Sample',
  'To: <janeazy@gmail.com>',
  '',
  'Hello!',
].join('\n');

Deno.test('POST /admin/inboxes/:name/replay — dry-run reports samples without writing', async () => {
  const fx = buildFixture();
  // Ingest an item that LACKS original_sent_at / newsletter_slug (simulating
  // pre-Phase-1 forwards). Use force:true to skip dedup.
  const item = makeForward({ id: 'ip-1', body: IP_BODY_TEMPLATE('Sun, Apr 26, 2026 at 10:16 AM') });
  await (fx.inbox as any)._ingest(item, { force: true });

  const res = await fx.fetch('/admin/inboxes/mailroom/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'forward-detect', dry_run: true }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.dry_run, true);
  assertEquals(body.applied, 1);
  assertEquals(body.scanned, 1);
  assertExists(body.samples);
  assertEquals(body.samples.length, 1);
  assertEquals(body.samples[0].id, 'ip-1');
  assertExists(body.samples[0].added_fields.original_sent_at);
  assertEquals(body.samples[0].added_fields.newsletter_slug, 'internet-pipes');

  // CRITICAL: dry-run did NOT write
  const stored = await fx.inbox.read('ip-1');
  assertEquals(stored?.fields.original_sent_at, undefined);
  assertEquals(stored?.fields.newsletter_slug, undefined);
});

Deno.test('POST /admin/inboxes/:name/replay — non-dry-run applies the merge', async () => {
  const fx = buildFixture();
  const item = makeForward({ id: 'ip-1', body: IP_BODY_TEMPLATE('Sun, Apr 26, 2026 at 10:16 AM') });
  await (fx.inbox as any)._ingest(item, { force: true });

  const res = await fx.fetch('/admin/inboxes/mailroom/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'forward-detect' }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.dry_run, false);
  assertEquals(body.applied, 1);

  const stored = await fx.inbox.read('ip-1');
  assertExists(stored?.fields.original_sent_at);
  assertEquals(stored?.fields.newsletter_slug, 'internet-pipes');
  // Identity preserved
  assertEquals(stored?.received_at, '2026-04-26T20:05:00.000Z');
});

Deno.test('POST /admin/inboxes/:name/replay — IP Digest backfill scenario (the user moment)', async () => {
  const fx = buildFixture();
  // Ingest several pre-Phase-1 forwards across many original dates
  const fixtures: Array<{ id: string; date: string; subject: string }> = [
    { id: 'ip-2024-08-08', date: 'Thu, Aug 8, 2024 at 7:06 AM', subject: 'Fwd: IP Digest #1' },
    { id: 'ip-2025-01-09', date: 'Thu, Jan 9, 2025 at 7:47 AM', subject: 'Fwd: IP Digest #2' },
    { id: 'ip-2026-04-26', date: 'Sun, Apr 26, 2026 at 10:16 AM', subject: 'Fwd: IP Digest #3' },
  ];
  for (const fx_ of fixtures) {
    await (fx.inbox as any)._ingest(
      makeForward({ id: fx_.id, body: IP_BODY_TEMPLATE(fx_.date), subject: fx_.subject }),
      { force: true },
    );
  }

  // Backfill via the replay endpoint with a subject filter (mimicking the user's
  // real call: scope to IP Digest items only).
  const res = await fx.fetch('/admin/inboxes/mailroom/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook: 'forward-detect',
      filter: { fields_regex: { subject: 'IP Digest|Pipes ' } },
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.applied, 3);

  // Now query newsletters route — should show internet-pipes with chronological
  // sort working
  const itemsRes = await fx.fetch('/inbox/mailroom/newsletters/internet-pipes/items');
  const itemsBody = await itemsRes.json();
  assertEquals(itemsBody.items.length, 3);
  assertEquals(itemsBody.items.map((i: InboxItem) => i.id), [
    'ip-2024-08-08',
    'ip-2025-01-09',
    'ip-2026-04-26',
  ]);
});

Deno.test('POST /admin/inboxes/:name/replay — 404 unknown hook', async () => {
  const fx = buildFixture();
  const res = await fx.fetch('/admin/inboxes/mailroom/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'never-registered' }),
  });
  assertEquals(res.status, 404);
});

Deno.test('POST /admin/inboxes/:name/replay — 404 unknown inbox', async () => {
  const fx = buildFixture();
  const res = await fx.fetch('/admin/inboxes/nope/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'forward-detect' }),
  });
  assertEquals(res.status, 404);
});

Deno.test('POST /admin/inboxes/:name/replay — 400 missing hook field', async () => {
  const fx = buildFixture();
  const res = await fx.fetch('/admin/inboxes/mailroom/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter: {} }),
  });
  assertEquals(res.status, 400);
});

Deno.test('POST /admin/inboxes/:name/replay — 501 when replayHookFor not provided', async () => {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'items' } as InboxConfig, 'boot');
  const buildInbox = async (n: string, cfg: InboxConfig) =>
    createInbox({ name: n, channel: cfg.channel, storage: { items } });

  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });

  const res = await app.fetch(
    new Request('http://localhost/admin/inboxes/mailroom/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook: 'forward-detect' }),
    }),
  );
  assertEquals(res.status, 501);
});

Deno.test('POST /admin/inboxes/:name/replay — items already populated → applied=0', async () => {
  const fx = buildFixture();
  // Ingest an item that ALREADY has original_sent_at + newsletter_slug
  const item: InboxItem = {
    id: 'already-done',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-26T20:05:00.000Z',
    summary: 'Fwd: IP Digest',
    body: IP_BODY_TEMPLATE('Sun, Apr 26, 2026 at 10:16 AM'),
    fields: {
      from_email: 'me@example.com',
      subject: 'Fwd: IP Digest',
      original_sent_at: '2026-04-26T17:16:00.000Z',
      newsletter_slug: 'internet-pipes',
      original_from_addr: 'Steph at Internet Pipes <internetpipes@broadcasts.lemonsqueezy-mail.com>',
      original_from_email: 'internetpipes@broadcasts.lemonsqueezy-mail.com',
      original_subject: 'IP Digest: Sample',
    },
    labels: ['forwarded', 'manual'],
  };
  await (fx.inbox as any)._ingest(item, { force: true });

  const res = await fx.fetch('/admin/inboxes/mailroom/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'forward-detect', dry_run: true }),
  });
  const body = await res.json();
  // Hook re-runs and produces same fields → no changes → applied=0
  assertEquals(body.applied, 0);
});
