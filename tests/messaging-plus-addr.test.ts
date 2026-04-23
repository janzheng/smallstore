/**
 * Messaging — plus-addressing intent hook tests.
 *
 * Exercises `extractPlusIntent` (pure extraction) and `createPlusAddrHook`
 * (PreIngestHook wrapper). Focus:
 *
 *   - Happy path: `mailroom+bookmark@` → intent + labels
 *   - Edge cases: no inbox_addr, literal base, different base, empty intent
 *   - Case-insensitivity on baseLocal AND allowedIntents
 *   - Length cap (prevents garbage intents)
 *   - Hook returns mutated item (not 'accept') on hit; preserves existing labels
 *
 * No network, no storage — the hook is a pure transform.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import {
  createPlusAddrHook,
  extractPlusIntent,
} from '../src/messaging/plus-addr.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: overrides.id ?? 'test-id',
    source: overrides.source ?? 'cf-email',
    received_at: overrides.received_at ?? '2026-04-23T12:00:00Z',
    summary: overrides.summary ?? 'Test subject',
    body: overrides.body ?? 'Test body',
    fields: overrides.fields ?? {},
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

const CTX: HookContext = { channel: 'cf-email' };

// ============================================================================
// extractPlusIntent — extraction semantics
// ============================================================================

Deno.test('extractPlusIntent — no inbox_addr → empty result', () => {
  const item = makeItem({ fields: {} });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — literal mailroom@ (no plus) → empty result', () => {
  const item = makeItem({ fields: { inbox_addr: 'mailroom@labspace.ai' } });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — mailroom+bookmark@ with defaults → intent+labels', () => {
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+bookmark@labspace.ai' },
  });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result.intent, 'bookmark');
  assertEquals(new Set(result.labels), new Set(['bookmark', 'manual']));
});

Deno.test('extractPlusIntent — mixed case local + intent → normalized lowercase', () => {
  const item = makeItem({
    fields: { inbox_addr: 'Mailroom+BookMark@labspace.ai' },
  });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result.intent, 'bookmark');
  assert(result.labels.includes('bookmark'));
  assert(result.labels.includes('manual'));
});

Deno.test('extractPlusIntent — different base local → empty result', () => {
  const item = makeItem({
    fields: { inbox_addr: 'support+bookmark@labspace.ai' },
  });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — intent not in allowedIntents → empty result', () => {
  // `+trash` is not in the default allow list
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+trash@labspace.ai' },
  });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — custom allowedIntents respected (hit)', () => {
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+trash@labspace.ai' },
  });
  const result = extractPlusIntent(item, {
    baseLocal: 'mailroom',
    allowedIntents: ['trash', 'bookmark'],
  });
  assertEquals(result.intent, 'trash');
  assert(result.labels.includes('trash'));
});

Deno.test('extractPlusIntent — custom allowedIntents respected (miss on bookmark)', () => {
  // Bookmark is normally allowed but we shrink the list to exclude it
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+bookmark@labspace.ai' },
  });
  const result = extractPlusIntent(item, {
    baseLocal: 'mailroom',
    allowedIntents: ['trash'],
  });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — empty intent (mailroom+@) → empty result', () => {
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+@labspace.ai' },
  });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — intent longer than 64 chars → empty result', () => {
  const longIntent = 'a'.repeat(65);
  const item = makeItem({
    fields: { inbox_addr: `mailroom+${longIntent}@labspace.ai` },
  });
  const result = extractPlusIntent(item, {
    baseLocal: 'mailroom',
    allowedIntents: [longIntent], // even if somehow allow-listed
  });
  assertEquals(result, { labels: [] });
});

Deno.test('extractPlusIntent — custom extraLabels override default', () => {
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+bookmark@labspace.ai' },
  });
  const result = extractPlusIntent(item, {
    baseLocal: 'mailroom',
    extraLabels: ['via-email', 'curated'],
  });
  assertEquals(result.intent, 'bookmark');
  assertEquals(
    new Set(result.labels),
    new Set(['bookmark', 'via-email', 'curated']),
  );
  // 'manual' was the default; custom list replaces it
  assert(!result.labels.includes('manual'));
});

Deno.test('extractPlusIntent — read-later intent (hyphenated) works', () => {
  const item = makeItem({
    fields: { inbox_addr: 'mailroom+read-later@labspace.ai' },
  });
  const result = extractPlusIntent(item, { baseLocal: 'mailroom' });
  assertEquals(result.intent, 'read-later');
  assert(result.labels.includes('read-later'));
});

// ============================================================================
// createPlusAddrHook — PreIngestHook behavior
// ============================================================================

Deno.test('createPlusAddrHook — returns accept when no inbox_addr', async () => {
  const hook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const verdict = await hook(makeItem({ fields: {} }), CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('createPlusAddrHook — returns accept for literal base (no plus)', async () => {
  const hook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const verdict = await hook(
    makeItem({ fields: { inbox_addr: 'mailroom@labspace.ai' } }),
    CTX,
  );
  assertEquals(verdict, 'accept');
});

Deno.test('createPlusAddrHook — returns accept when intent not on allow list', async () => {
  const hook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const verdict = await hook(
    makeItem({ fields: { inbox_addr: 'mailroom+trash@labspace.ai' } }),
    CTX,
  );
  assertEquals(verdict, 'accept');
});

Deno.test('createPlusAddrHook — returns mutated item with labels + fields.intent', async () => {
  const hook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const input = makeItem({
    fields: { inbox_addr: 'mailroom+bookmark@labspace.ai', other: 'keep' },
  });
  const verdict = await hook(input, CTX);

  // Verdict is a mutated InboxItem, not an 'accept' string
  assert(typeof verdict !== 'string', 'expected mutated item, got string verdict');
  const mutated = verdict as InboxItem;

  assertEquals(mutated.fields.intent, 'bookmark');
  assertEquals(mutated.fields.inbox_addr, 'mailroom+bookmark@labspace.ai');
  assertEquals(mutated.fields.other, 'keep');
  assert(mutated.labels?.includes('bookmark'));
  assert(mutated.labels?.includes('manual'));

  // Input was not mutated in place
  assertEquals(input.fields.intent, undefined);
  assertEquals(input.labels, undefined);
});

Deno.test('createPlusAddrHook — preserves existing labels (dedupe merge)', async () => {
  const hook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const input = makeItem({
    fields: { inbox_addr: 'mailroom+bookmark@labspace.ai' },
    labels: ['forwarded', 'manual'], // 'manual' collides with default extraLabels
  });
  const verdict = await hook(input, CTX);
  const mutated = verdict as InboxItem;

  const labelSet = new Set(mutated.labels ?? []);
  assertEquals(labelSet.has('forwarded'), true);
  assertEquals(labelSet.has('manual'), true);
  assertEquals(labelSet.has('bookmark'), true);
  // 'manual' should appear exactly once despite collision
  const manualCount = (mutated.labels ?? []).filter((l) => l === 'manual').length;
  assertEquals(manualCount, 1);
});

Deno.test('createPlusAddrHook — case-insensitive end-to-end', async () => {
  const hook = createPlusAddrHook({ baseLocal: 'MailRoom' });
  const verdict = await hook(
    makeItem({ fields: { inbox_addr: 'mailroom+BOOKMARK@Labspace.AI' } }),
    CTX,
  );
  const mutated = verdict as InboxItem;
  assertEquals(mutated.fields.intent, 'bookmark');
  assert(mutated.labels?.includes('bookmark'));
});

Deno.test('createPlusAddrHook — nested plus (foo+bar) taken as composite intent', async () => {
  // Judgment call: take everything after the FIRST '+'. The composite is
  // not in the default allow list, so the hook no-ops. Callers who want
  // to accept nested-plus can add it to allowedIntents.
  const hookDefault = createPlusAddrHook({ baseLocal: 'mailroom' });
  const verdictDefault = await hookDefault(
    makeItem({ fields: { inbox_addr: 'mailroom+foo+bar@labspace.ai' } }),
    CTX,
  );
  assertEquals(verdictDefault, 'accept');

  // When explicitly allow-listed, the composite wins
  const hookCustom = createPlusAddrHook({
    baseLocal: 'mailroom',
    allowedIntents: ['foo+bar'],
  });
  const verdictCustom = await hookCustom(
    makeItem({ fields: { inbox_addr: 'mailroom+foo+bar@labspace.ai' } }),
    CTX,
  );
  const mutated = verdictCustom as InboxItem;
  assertEquals(mutated.fields.intent, 'foo+bar');
});
