/**
 * Spam triage primitives — Sprint 1 of `.brief/spam-layers.md`.
 *
 * Coverage:
 *   - SenderRecord schema bump (`not_spam_count`, `marked_at`) round-trips
 *     through senderIndex.upsert + setRecord
 *   - resolveSpamAttribution() — 3 decision branches (decision #2):
 *       (a) trusted forwarder + original_from_email → forwarder
 *       (b) untrusted forwarder + original_from_email → original
 *       (c) no forward chain → from_email
 *       (d) edge: missing from_email but has original → falls back to original
 *       (e) edge: missing both → null
 *   - mark-spam endpoint:
 *       - happy path: adds spam label, bumps spam_count via auto-ingest,
 *         writes marked_at, returns sender summary
 *       - idempotent (decision #1): second call on same item → already_spam=true,
 *         counter NOT bumped twice
 *       - attribution flows through (trusted forwarder routes correctly)
 *       - consider_demote (decision #4): trusted sender + ≥5 marks +
 *         spam_rate > 0.5 → flag set on response
 *       - 501 when senderIndexFor not wired (graceful unavailable)
 *   - mark-not-spam endpoint:
 *       - happy path: removes spam + quarantined, bumps not_spam_count
 *       - idempotent on items already not-spam → already_not_spam=true
 *       - auto-confirm revocation (decision #3): removes matching pattern,
 *         response carries { revoked_auto_confirm: { pattern, source } }
 *       - revoked_auto_confirm: null when item wasn't auto-confirmed
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createSenderIndex, type SenderIndex } from '../src/messaging/sender-index.ts';
import { createAutoConfirmSendersStore } from '../src/messaging/auto-confirm-senders.ts';
import { resolveSpamAttribution } from '../src/messaging/spam-attribution.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Harness — Hono app + memory-backed inbox + sender-index + auto-confirm store
// ============================================================================

interface Fixture {
  app: Hono;
  registry: InboxRegistry;
  inbox: ReturnType<typeof createInbox>;
  senderIndex: SenderIndex;
  autoConfirmStore: ReturnType<typeof createAutoConfirmSendersStore>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildFixture(opts: { wireSenderIndex?: boolean } = {}): Fixture {
  const wireSenderIndex = opts.wireSenderIndex !== false; // default true

  const itemsAdapter = new MemoryAdapter();
  const senderAdapter = new MemoryAdapter();
  const autoConfirmAdapter = new MemoryAdapter();

  const inbox = createInbox({
    name: 'mailroom',
    channel: 'cf-email',
    storage: { items: itemsAdapter },
  });

  const senderIndex = createSenderIndex(senderAdapter);
  const autoConfirmStore = createAutoConfirmSendersStore(autoConfirmAdapter);

  const registry = new InboxRegistry();
  const config: InboxConfig = { channel: 'cf-email', storage: 'items' };
  registry.register('mailroom', inbox, config, 'boot');

  const requireAuth = (_c: Context, next: Next) => next();
  const buildInbox = async () => inbox;

  const app = new Hono();
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInbox,
    senderIndexFor: wireSenderIndex ? () => senderIndex : undefined,
    autoConfirmSendersStore: autoConfirmStore,
  });

  return {
    app,
    registry,
    inbox,
    senderIndex,
    autoConfirmStore,
    fetch: (path, init) => app.fetch(new Request(`http://localhost${path}`, init)),
  };
}

function makeItem(
  id: string,
  fields: Record<string, any>,
  labels?: string[],
): InboxItem {
  return {
    id,
    source: 'cf-email',
    received_at: '2026-04-28T10:00:00Z',
    summary: fields.subject ?? 'test',
    body: null,
    fields,
    labels,
  };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ============================================================================
// SenderRecord schema bump (not_spam_count + marked_at)
// ============================================================================

Deno.test('schema bump — upsert defaults not_spam_count to 0 for new senders', async () => {
  const fx = buildFixture();
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'alice@example.com' }));
  const record = await fx.senderIndex.get('alice@example.com');
  assertExists(record);
  assertEquals(record!.not_spam_count, 0);
  assertEquals(record!.marked_at, undefined);
});

Deno.test('schema bump — setRecord round-trips not_spam_count + marked_at', async () => {
  const fx = buildFixture();
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'alice@example.com' }));
  const initial = await fx.senderIndex.get('alice@example.com');
  await fx.senderIndex.setRecord({
    ...initial!,
    not_spam_count: 3,
    marked_at: '2026-04-28T11:00:00Z',
  });
  const updated = await fx.senderIndex.get('alice@example.com');
  assertEquals(updated!.not_spam_count, 3);
  assertEquals(updated!.marked_at, '2026-04-28T11:00:00Z');
});

Deno.test('schema bump — second upsert preserves not_spam_count + marked_at', async () => {
  const fx = buildFixture();
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'alice@example.com' }));
  await fx.senderIndex.setRecord({
    ...(await fx.senderIndex.get('alice@example.com'))!,
    not_spam_count: 5,
    marked_at: '2026-04-28T11:00:00Z',
  });
  // Now another item from the same sender lands — auto-ingest path.
  await fx.senderIndex.upsert(makeItem('a2', { from_email: 'alice@example.com' }));
  const final = await fx.senderIndex.get('alice@example.com');
  // Auto-ingest does NOT touch not_spam_count or marked_at — only mark-spam /
  // mark-not-spam do. Decision #4 + #1.
  assertEquals(final!.not_spam_count, 5);
  assertEquals(final!.marked_at, '2026-04-28T11:00:00Z');
  assertEquals(final!.count, 2); // count still bumps
});

// ============================================================================
// resolveSpamAttribution — three branches per decision #2
// ============================================================================

Deno.test('attribution — case (c) no forward chain → from_email', async () => {
  const fx = buildFixture();
  const item = makeItem('a1', { from_email: 'alice@example.com' });
  const result = await resolveSpamAttribution(item, fx.senderIndex);
  assertEquals(result, 'alice@example.com');
});

Deno.test('attribution — case (b) untrusted forwarder → original_from_email', async () => {
  const fx = buildFixture();
  // Forwarder is registered but NOT trusted.
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'forwarder@example.com' }));
  const item = makeItem('fwd', {
    from_email: 'forwarder@example.com',
    original_from_email: 'newsletter@spam.io',
  });
  const result = await resolveSpamAttribution(item, fx.senderIndex);
  assertEquals(result, 'newsletter@spam.io');
});

Deno.test('attribution — case (a) trusted forwarder breaks the chain → forwarder', async () => {
  const fx = buildFixture();
  // Add the forwarder + tag them trusted.
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'jessica@example.com' }));
  await fx.senderIndex.setRecord({
    ...(await fx.senderIndex.get('jessica@example.com'))!,
    tags: ['trusted'],
  });
  const item = makeItem('fwd', {
    from_email: 'jessica@example.com',
    original_from_email: 'newsletter@somewhere.com',
  });
  const result = await resolveSpamAttribution(item, fx.senderIndex);
  // Trusted forwarder gets the bump, original sender is untouched.
  assertEquals(result, 'jessica@example.com');
});

Deno.test('attribution — edge: missing from_email but has original → original', async () => {
  const fx = buildFixture();
  const item = makeItem('odd', { original_from_email: 'orphan@example.com' });
  const result = await resolveSpamAttribution(item, fx.senderIndex);
  // No forwarder to check trust on — fall back to original.
  assertEquals(result, 'orphan@example.com');
});

Deno.test('attribution — edge: no sender at all → null', async () => {
  const fx = buildFixture();
  const item = makeItem('nada', {});
  const result = await resolveSpamAttribution(item, fx.senderIndex);
  assertEquals(result, null);
});

// ============================================================================
// mark-spam endpoint
// ============================================================================

Deno.test('mark-spam — happy path: adds spam label, bumps spam_count, writes marked_at', async () => {
  const fx = buildFixture();
  const item = makeItem('item-1', { from_email: 'spammer@example.com' }, ['newsletter']);
  await fx.inbox._ingest(item);
  // Pre-populate sender-index so we can observe the bump.
  await fx.senderIndex.upsert(item);

  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-spam', json({}));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.already_spam, false);
  assertEquals(body.attributed_to, 'spammer@example.com');
  // The item now carries `spam`.
  assert(body.item.labels.includes('spam'));
  // Sender summary reflects the bump (auto-ingest with spam label = +1).
  assertEquals(body.sender_summary.address, 'spammer@example.com');
  assertEquals(body.sender_summary.spam_count, 1);
  assertEquals(body.sender_summary.not_spam_count, 0);
  assertEquals(body.sender_summary.spam_rate, 1);
  // marked_at gets written by the endpoint (decision #1 partial — separate
  // from idempotency, this records the user-driven mark).
  assertExists(body.sender_summary.marked_at);
});

Deno.test('mark-spam — idempotent (decision #1): second call returns already_spam=true, no double-count', async () => {
  const fx = buildFixture();
  await fx.inbox._ingest(makeItem('item-1', { from_email: 'spammer@example.com' }, ['newsletter']));
  await fx.senderIndex.upsert(makeItem('item-1', { from_email: 'spammer@example.com' }));

  // First call — bumps counter.
  const r1 = await fx.fetch('/inbox/mailroom/items/item-1/mark-spam', json({}));
  const b1 = await r1.json();
  assertEquals(b1.already_spam, false);
  assertEquals(b1.sender_summary.spam_count, 1);

  // Second call on the same already-spam item — must NOT double-count.
  const r2 = await fx.fetch('/inbox/mailroom/items/item-1/mark-spam', json({}));
  assertEquals(r2.status, 200);
  const b2 = await r2.json();
  assertEquals(b2.already_spam, true);
  // Counter unchanged.
  assertEquals(b2.sender_summary.spam_count, 1);
});

Deno.test('mark-spam — attribution: trusted forwarder gets the bump, not the original sender', async () => {
  const fx = buildFixture();
  // Set up a trusted forwarder.
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'jessica@example.com' }));
  await fx.senderIndex.setRecord({
    ...(await fx.senderIndex.get('jessica@example.com'))!,
    tags: ['trusted'],
  });
  // Forwarded item.
  await fx.inbox._ingest(makeItem('fwd-1', {
    from_email: 'jessica@example.com',
    original_from_email: 'unknown-sender@somewhere.com',
  }));
  await fx.senderIndex.upsert(makeItem('fwd-1', { from_email: 'jessica@example.com' }));

  const res = await fx.fetch('/inbox/mailroom/items/fwd-1/mark-spam', json({}));
  const body = await res.json();
  // Decision #2(a): trusted forwarder routes to forwarder.
  assertEquals(body.attributed_to, 'jessica@example.com');
  // Original sender untouched — never appears in sender-index.
  const original = await fx.senderIndex.get('unknown-sender@somewhere.com');
  assertEquals(original, null);
});

Deno.test('mark-spam — consider_demote (decision #4): trusted + 5 total marks + spam_rate > 0.5 → flag', async () => {
  const fx = buildFixture();
  // Build a sender that's trusted but already accumulated marks.
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'mixed@example.com' }));
  await fx.senderIndex.setRecord({
    ...(await fx.senderIndex.get('mixed@example.com'))!,
    tags: ['trusted'],
    spam_count: 3,       // pre-existing
    not_spam_count: 1,   // 1 not-spam already
  });
  // Ingest a fresh item so we can mark it spam (this will push counts to 4 spam + 1 not-spam = 5 total, spam_rate 0.8).
  await fx.inbox._ingest(makeItem('item-x', { from_email: 'mixed@example.com' }, ['newsletter']));

  const res = await fx.fetch('/inbox/mailroom/items/item-x/mark-spam', json({}));
  const body = await res.json();
  assertEquals(body.consider_demote, true);
  assertEquals(body.sender_summary.trusted, true);
});

Deno.test('mark-spam — no consider_demote when sender NOT trusted', async () => {
  const fx = buildFixture();
  await fx.senderIndex.upsert(makeItem('a1', { from_email: 'normal@example.com' }));
  await fx.senderIndex.setRecord({
    ...(await fx.senderIndex.get('normal@example.com'))!,
    spam_count: 4,
    not_spam_count: 1,
    // No `trusted` tag.
  });
  await fx.inbox._ingest(makeItem('item-x', { from_email: 'normal@example.com' }, ['newsletter']));

  const res = await fx.fetch('/inbox/mailroom/items/item-x/mark-spam', json({}));
  const body = await res.json();
  // The flag is OMITTED (not just false) when criteria don't match.
  assertEquals(body.consider_demote, undefined);
});

Deno.test('mark-spam — 501 when senderIndexFor not wired', async () => {
  const fx = buildFixture({ wireSenderIndex: false });
  await fx.inbox._ingest(makeItem('item-1', { from_email: 'a@b.com' }));
  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-spam', json({}));
  assertEquals(res.status, 501);
});

// ============================================================================
// mark-not-spam endpoint
// ============================================================================

Deno.test('mark-not-spam — happy path: removes spam + quarantined, bumps not_spam_count', async () => {
  const fx = buildFixture();
  const item = makeItem('item-1', { from_email: 'a@b.com' }, ['spam', 'quarantined', 'newsletter']);
  await fx.inbox._ingest(item);
  await fx.senderIndex.upsert(item);

  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-not-spam', json({}));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.already_not_spam, false);
  // Both spam-flavored labels stripped, newsletter preserved.
  assert(!body.item.labels.includes('spam'));
  assert(!body.item.labels.includes('quarantined'));
  assert(body.item.labels.includes('newsletter'));
  // not_spam_count bumped.
  assertEquals(body.sender_summary.not_spam_count, 1);
  assertExists(body.sender_summary.marked_at);
});

Deno.test('mark-not-spam — idempotent: already-not-spam item returns already_not_spam=true', async () => {
  const fx = buildFixture();
  await fx.inbox._ingest(makeItem('item-1', { from_email: 'a@b.com' }, ['newsletter']));
  await fx.senderIndex.upsert(makeItem('item-1', { from_email: 'a@b.com' }));

  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-not-spam', json({}));
  const body = await res.json();
  assertEquals(body.already_not_spam, true);
  // No counter bump.
  assertEquals(body.sender_summary.not_spam_count, 0);
});

Deno.test('mark-not-spam — auto-confirm revocation (decision #3): revokes matching pattern + returns it', async () => {
  const fx = buildFixture();
  // Pre-seed the auto-confirm store with a pattern matching the sender.
  await fx.autoConfirmStore.add({ pattern: '*@substack.com', source: 'env' });
  // The item carries `auto-confirmed` and is from a substack address.
  const item = makeItem('item-1',
    { from_email: 'newsletter@substack.com' },
    ['spam', 'auto-confirmed'],
  );
  await fx.inbox._ingest(item);
  await fx.senderIndex.upsert(item);

  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-not-spam', json({}));
  const body = await res.json();
  // Pattern was revoked.
  assertExists(body.revoked_auto_confirm);
  assertEquals(body.revoked_auto_confirm.pattern, '*@substack.com');
  assertEquals(body.revoked_auto_confirm.source, 'env');
  // Pattern actually gone from the store.
  const stillThere = await fx.autoConfirmStore.get('*@substack.com');
  assertEquals(stillThere, null);
});

Deno.test('mark-not-spam — revoked_auto_confirm:null when item wasn\'t auto-confirmed', async () => {
  const fx = buildFixture();
  await fx.autoConfirmStore.add({ pattern: '*@substack.com', source: 'env' });
  // Item carries spam but NOT auto-confirmed.
  await fx.inbox._ingest(
    makeItem('item-1', { from_email: 'newsletter@substack.com' }, ['spam']),
  );
  await fx.senderIndex.upsert(
    makeItem('item-1', { from_email: 'newsletter@substack.com' }),
  );

  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-not-spam', json({}));
  const body = await res.json();
  assertEquals(body.revoked_auto_confirm, null);
  // Pattern still in the store — wasn't revoked.
  const stillThere = await fx.autoConfirmStore.get('*@substack.com');
  assertExists(stillThere);
});

Deno.test('mark-not-spam — undo path round-trip: revoked pattern can be re-added preserving source', async () => {
  const fx = buildFixture();
  await fx.autoConfirmStore.add({ pattern: '*@beehiiv.com', source: 'env' });
  await fx.inbox._ingest(
    makeItem('item-1',
      { from_email: 'pub@beehiiv.com' },
      ['spam', 'auto-confirmed'],
    ),
  );
  await fx.senderIndex.upsert(
    makeItem('item-1', { from_email: 'pub@beehiiv.com' }),
  );

  // Revoke via mark-not-spam.
  const res = await fx.fetch('/inbox/mailroom/items/item-1/mark-not-spam', json({}));
  const body = await res.json();
  const revoked = body.revoked_auto_confirm;
  assertExists(revoked);

  // Caller can undo by adding back with the same source.
  await fx.autoConfirmStore.add({ pattern: revoked.pattern, source: revoked.source });
  const restored = await fx.autoConfirmStore.get('*@beehiiv.com');
  assertExists(restored);
  // Source preserved.
  assertEquals(restored!.source, 'env');
});
