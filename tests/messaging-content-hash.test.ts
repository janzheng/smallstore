/**
 * Content-hash — Layer 4 spam defense (`.brief/spam-layers.md`).
 *
 * Coverage:
 *   - normalizeBody: strips Mailchimp/Substack/Beehiiv/etc tracking URLs;
 *     strips 1x1 imgs; strips per-recipient `?token=` params keeping rest of
 *     URL; collapses whitespace; strips salutations; two bodies differing
 *     only in tracking artifacts hash to the same sha256.
 *   - hashBody: deterministic; different inputs differ.
 *   - ContentHashStore.record: first call returns null, second returns
 *     existing record.
 *   - ContentHashStore.isRepeatWithin: in-window hit / out-of-window miss /
 *     missing key all behave correctly.
 *   - ContentHashStore.prune: drops old, preserves recent, returns count.
 *   - Hook first-seen: clean item, store empty → accept, record written.
 *   - Hook repeat untrusted: same body twice → second labeled campaign-blast.
 *   - Hook repeat trusted (decision #4 amplification): tagged 'trusted' →
 *     repeated:trusted, NOT campaign-blast.
 *   - Hook repeat outside window: 25h gap → fresh, no label.
 *   - Hook empty body / no sender / idempotent label / normalization unifies
 *     repeats across per-recipient URL variants.
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import {
  createContentHashHook,
  createContentHashStore,
  hashBody,
  normalizeBody,
} from '../src/messaging/content-hash.ts';
import { createSenderIndex } from '../src/messaging/sender-index.ts';
import type { InboxItem } from '../src/messaging/types.ts';

function makeItem(opts: {
  id?: string;
  from_email?: string | null;
  body?: string | null;
  labels?: string[];
}): InboxItem {
  return {
    id: opts.id ?? 'i1',
    source: 'cf-email',
    received_at: '2026-04-28T12:00:00Z',
    summary: 'test',
    body: opts.body === undefined ? 'hello world' : opts.body,
    fields: opts.from_email === null
      ? {}
      : { from_email: opts.from_email ?? 'campaigner@news.example.com' },
    labels: opts.labels,
  };
}

const CTX = { channel: 'cf-email' };

// ============================================================================
// normalizeBody
// ============================================================================

Deno.test('normalizeBody — strips Mailchimp tracking URL', () => {
  const body = 'Read this: https://example.list-manage.com/track/click?u=abc here.';
  const out = normalizeBody(body);
  assertEquals(out.includes('list-manage.com'), false);
  assertEquals(out.includes('read this'), true);
});

Deno.test('normalizeBody — strips 1x1 pixel img tags (width or height)', () => {
  const body = 'Hello <img src="https://x.com/p.gif" width="1" height="1" /> world';
  const out = normalizeBody(body);
  assertEquals(out.includes('<img'), false);
  assertEquals(out.includes('hello'), true);
  assertEquals(out.includes('world'), true);

  const widthOnly = normalizeBody('a <img width=1 src="x"> b');
  assertEquals(widthOnly.includes('<img'), false);

  const heightOnly = normalizeBody('a <img height="1" src="x"> b');
  assertEquals(heightOnly.includes('<img'), false);
});

Deno.test('normalizeBody — strips per-recipient token param while keeping the URL', () => {
  const body = 'click https://example.com/path?token=abc123&utm=x rest';
  const out = normalizeBody(body);
  assert(out.includes('https://example.com/path'), `expected URL preserved: ${out}`);
  assertEquals(out.includes('token=abc123'), false);
  assert(out.includes('utm=x'), `utm should remain: ${out}`);
});

Deno.test('normalizeBody — strips multiple per-recipient params', () => {
  const body = 'see https://x.com/p?recipient=jan&user=42&keep=this end';
  const out = normalizeBody(body);
  assertEquals(out.includes('recipient='), false);
  assertEquals(out.includes('user=42'), false);
  assert(out.includes('keep=this'));
});

Deno.test('normalizeBody — collapses whitespace runs', () => {
  const body = 'a\n\n\tb   c\r\n\rd';
  const out = normalizeBody(body);
  assertEquals(out, 'a b c d');
});

Deno.test('normalizeBody — strips Hi <name> salutation at line start', () => {
  const body = 'Hi Jane,\nWelcome to the newsletter.';
  const out = normalizeBody(body);
  assertEquals(out.startsWith('hi jane'), false);
  assert(out.includes('welcome to the newsletter.'));
});

Deno.test('normalizeBody — empty input returns empty string', () => {
  assertEquals(normalizeBody(''), '');
});

Deno.test('normalizeBody — bodies differing ONLY in tracking artifacts hash identical', async () => {
  const bodyA = 'Hi Alice, check this out: https://news.example.com/article?token=AAA111&id=42 ' +
    '<img src="px.gif" width="1" height="1">';
  const bodyB = 'Hi Bob,   check this out: https://news.example.com/article?token=BBB222&id=42 ' +
    '<img src="px.gif" width=1>';
  const a = await hashBody(normalizeBody(bodyA));
  const b = await hashBody(normalizeBody(bodyB));
  assertEquals(a, b);
});

// ============================================================================
// hashBody
// ============================================================================

Deno.test('hashBody — deterministic across calls', async () => {
  const a = await hashBody('hello world');
  const b = await hashBody('hello world');
  assertEquals(a, b);
  assertEquals(a.length, 64);
});

Deno.test('hashBody — different inputs produce different hashes', async () => {
  const a = await hashBody('hello world');
  const b = await hashBody('hello worle');
  assert(a !== b);
});

// ============================================================================
// ContentHashStore
// ============================================================================

Deno.test('ContentHashStore.record — first returns null, second returns existing', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  const first = await store.record('a@x.com', 'sha1', '2026-04-28T12:00:00Z');
  assertEquals(first, null);
  const second = await store.record('a@x.com', 'sha1', '2026-04-28T13:00:00Z');
  assertExists(second);
  assertEquals(second!.ingest_at, '2026-04-28T12:00:00Z');
});

Deno.test('ContentHashStore.isRepeatWithin — within window returns record', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  await store.record('a@x.com', 'sha1', '2026-04-28T12:00:00Z');
  const hit = await store.isRepeatWithin(
    'a@x.com',
    'sha1',
    '2026-04-28T20:00:00Z',
    24 * 60 * 60 * 1000,
  );
  assertExists(hit);
});

Deno.test('ContentHashStore.isRepeatWithin — outside window returns null', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  await store.record('a@x.com', 'sha1', '2026-04-28T12:00:00Z');
  const miss = await store.isRepeatWithin(
    'a@x.com',
    'sha1',
    '2026-04-29T13:00:00Z',
    24 * 60 * 60 * 1000,
  );
  assertEquals(miss, null);
});

Deno.test('ContentHashStore.isRepeatWithin — missing key returns null', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  const miss = await store.isRepeatWithin(
    'a@x.com',
    'nope',
    '2026-04-28T13:00:00Z',
    24 * 60 * 60 * 1000,
  );
  assertEquals(miss, null);
});

Deno.test('ContentHashStore.prune — drops old, keeps recent, returns count', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  await store.record('a@x.com', 'old1', '2026-04-20T00:00:00Z');
  await store.record('a@x.com', 'old2', '2026-04-21T00:00:00Z');
  await store.record('a@x.com', 'new1', '2026-04-28T00:00:00Z');
  const removed = await store.prune('2026-04-25T00:00:00Z');
  assertEquals(removed, 2);
  const stillThere = await store.isRepeatWithin(
    'a@x.com',
    'new1',
    '2026-04-28T01:00:00Z',
    24 * 60 * 60 * 1000,
  );
  assertExists(stillThere);
  const gone = await store.isRepeatWithin(
    'a@x.com',
    'old1',
    '2026-04-21T01:00:00Z',
    24 * 60 * 60 * 1000,
  );
  assertEquals(gone, null);
});

// ============================================================================
// Hook
// ============================================================================

Deno.test('hook — first-seen accepts and records', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  let now = '2026-04-28T12:00:00Z';
  const hook = createContentHashHook({ store, windowMs: 24 * 60 * 60 * 1000, now: () => now });

  const item = makeItem({ body: 'campaign body' });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');

  // confirm record was actually written by checking isRepeatWithin
  const sha = await hashBody(normalizeBody('campaign body'));
  const repeat = await store.isRepeatWithin(
    'campaigner@news.example.com',
    sha,
    now,
    24 * 60 * 60 * 1000,
  );
  assertExists(repeat);
});

Deno.test('hook — repeat untrusted gets campaign-blast label', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  let now = '2026-04-28T12:00:00Z';
  const hook = createContentHashHook({ store, now: () => now });

  await hook(makeItem({ id: 'i1', body: 'big campaign' }), CTX);
  now = '2026-04-28T18:00:00Z';
  const second = await hook(makeItem({ id: 'i2', body: 'big campaign' }), CTX);
  assert(typeof second === 'object', 'expected mutated item');
  const labels = (second as InboxItem).labels ?? [];
  assert(labels.includes('campaign-blast'), `labels: ${labels}`);
  assertEquals(labels.includes('repeated:trusted'), false);
});

Deno.test('hook — repeat trusted gets repeated:trusted (amplification, decision #4)', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  const senderAdapter = new MemoryAdapter();
  const senderIndex = createSenderIndex(senderAdapter);

  // tag the sender as trusted
  const sender = 'campaigner@news.example.com';
  await senderIndex.upsert(makeItem({ from_email: sender }));
  const initial = await senderIndex.get(sender);
  assertExists(initial);
  await senderIndex.setRecord({
    ...initial!,
    tags: [...(initial!.tags ?? []), 'trusted'],
  });

  let now = '2026-04-28T12:00:00Z';
  const hook = createContentHashHook({ store, senderIndex, now: () => now });

  await hook(makeItem({ id: 'i1', body: 'priority memo' }), CTX);
  now = '2026-04-28T18:00:00Z';
  const second = await hook(makeItem({ id: 'i2', body: 'priority memo' }), CTX);

  assert(typeof second === 'object', 'expected mutated item');
  const labels = (second as InboxItem).labels ?? [];
  assert(labels.includes('repeated:trusted'), `labels: ${labels}`);
  assertEquals(labels.includes('campaign-blast'), false);
});

Deno.test('hook — repeat outside window is treated as fresh (no label)', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  let now = '2026-04-28T12:00:00Z';
  const hook = createContentHashHook({
    store,
    windowMs: 24 * 60 * 60 * 1000,
    now: () => now,
  });

  await hook(makeItem({ id: 'i1', body: 'evergreen' }), CTX);
  now = '2026-04-29T13:00:00Z'; // 25h later
  const second = await hook(makeItem({ id: 'i2', body: 'evergreen' }), CTX);
  assertEquals(second, 'accept');
});

Deno.test('hook — empty body returns accept', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  const hook = createContentHashHook({ store });
  const verdict = await hook(makeItem({ body: null }), CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — missing from_email returns accept', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  const hook = createContentHashHook({ store });
  const verdict = await hook(makeItem({ from_email: null, body: 'whatever' }), CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — idempotent when item already carries campaign-blast', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  let now = '2026-04-28T12:00:00Z';
  const hook = createContentHashHook({ store, now: () => now });

  await hook(makeItem({ id: 'i1', body: 'spam blast' }), CTX);
  now = '2026-04-28T13:00:00Z';
  const second = await hook(
    makeItem({ id: 'i2', body: 'spam blast', labels: ['campaign-blast'] }),
    CTX,
  );
  assertEquals(second, 'accept');
});

Deno.test('hook — normalization unifies repeats with different per-recipient token URLs', async () => {
  const store = createContentHashStore(new MemoryAdapter());
  let now = '2026-04-28T12:00:00Z';
  const hook = createContentHashHook({ store, now: () => now });

  const bodyForJan = 'Hi Jan, see https://news.example.com/p?token=JAN111&id=7 thanks';
  const bodyForBob = 'Hi Bob, see https://news.example.com/p?token=BOB222&id=7 thanks';

  const first = await hook(makeItem({ id: 'i1', body: bodyForJan }), CTX);
  assertEquals(first, 'accept');

  now = '2026-04-28T15:00:00Z';
  const second = await hook(makeItem({ id: 'i2', body: bodyForBob }), CTX);
  assert(typeof second === 'object', 'expected mutated item — normalize should unify');
  const labels = (second as InboxItem).labels ?? [];
  assert(labels.includes('campaign-blast'), `labels: ${labels}`);
});
