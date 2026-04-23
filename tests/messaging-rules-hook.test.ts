/**
 * Messaging — rules preIngest hook tests.
 *
 * Confirms `createRulesHook` translates RulesStore verdicts into the right
 * `HookVerdict` shape for the email-handler pipeline: drop, quarantine (with
 * label merge), tag-style label merging, and pass-through accept.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createRulesStore } from '../src/messaging/rules.ts';
import { createRulesHook } from '../src/messaging/rules-hook.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

const CTX: HookContext = { channel: 'cf-email', registration: 'mailroom' };

function freshPair() {
  const adapter = new MemoryAdapter();
  let counter = 0;
  const store = createRulesStore(adapter, { generateId: () => `rule-${++counter}` });
  const hook = createRulesHook({ rulesStore: store });
  return { adapter, store, hook };
}

function makeItem(overrides: Partial<InboxItem> & { fields?: Record<string, any> } = {}): InboxItem {
  return {
    id: overrides.id ?? 'item-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'cf-email',
    received_at: overrides.received_at ?? '2026-04-22T12:00:00Z',
    summary: overrides.summary ?? 'hello',
    body: overrides.body ?? 'body',
    fields: { from_email: 'jane@example.com', ...overrides.fields },
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

Deno.test('rules-hook — no matches returns "accept"', async () => {
  const { hook } = freshPair();
  const verdict = await hook(makeItem(), CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('rules-hook — tag-style match returns mutated item with label merged', async () => {
  const { store, hook } = freshPair();
  await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  const verdict = await hook(
    makeItem({ fields: { from_email: 'news@annoying.com' } }),
    CTX,
  );
  assertExists(verdict);
  assertEquals(typeof verdict, 'object');
  const mutated = verdict as InboxItem;
  assertEquals(mutated.labels?.includes('archived'), true);
});

Deno.test('rules-hook — multiple tag-style matches stack labels (deduped)', async () => {
  const { store, hook } = freshPair();
  await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  await store.create({
    match: { fields: { from_email: 'annoying.com' } },
    action: 'tag',
    action_args: { tag: 'read-later' },
    priority: 50,
  });
  await store.create({
    // Adds 'archived' again — must dedup.
    match: { labels: ['promo'] },
    action: 'archive',
    priority: 100,
  });
  const verdict = await hook(
    makeItem({ fields: { from_email: 'news@annoying.com' }, labels: ['promo'] }),
    CTX,
  );
  const mutated = verdict as InboxItem;
  const labels = mutated.labels ?? [];
  // Ensure 'archived' not duplicated
  assertEquals(labels.filter((l) => l === 'archived').length, 1);
  assertEquals(labels.includes('read-later'), true);
  assertEquals(labels.includes('promo'), true); // pre-existing preserved
});

Deno.test('rules-hook — drop terminal returns "drop" verdict', async () => {
  const { store, hook } = freshPair();
  await store.create({
    match: { fields: { from_email: 'spammer@evil.com' } },
    action: 'drop',
    priority: 1,
  });
  const verdict = await hook(
    makeItem({ fields: { from_email: 'spammer@evil.com' } }),
    CTX,
  );
  assertEquals(verdict, 'drop');
});

Deno.test('rules-hook — quarantine terminal returns mutated item with quarantineLabel', async () => {
  const { store, hook } = freshPair();
  await store.create({
    match: { text: 'suspicious' },
    action: 'quarantine',
    priority: 10,
  });
  const verdict = await hook(
    makeItem({ summary: 'this is suspicious', body: 'text' }),
    CTX,
  );
  const mutated = verdict as InboxItem;
  assertEquals(typeof mutated, 'object');
  assertEquals(mutated.labels?.includes('quarantined'), true);
});

Deno.test('rules-hook — quarantine terminal + tag rule: both labels merged', async () => {
  const { store, hook } = freshPair();
  await store.create({
    match: { fields: { from_email: 'mixed@test.com' } },
    action: 'archive',
    priority: 100,
  });
  await store.create({
    match: { fields: { from_email: 'mixed@test.com' } },
    action: 'quarantine',
    priority: 50,
  });
  const verdict = await hook(
    makeItem({ fields: { from_email: 'mixed@test.com' } }),
    CTX,
  );
  const mutated = verdict as InboxItem;
  assertEquals(mutated.labels?.includes('archived'), true);
  assertEquals(mutated.labels?.includes('quarantined'), true);
});

Deno.test('rules-hook — existing labels preserved and merged with dedup', async () => {
  const { store, hook } = freshPair();
  await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  const verdict = await hook(
    makeItem({
      fields: { from_email: 'news@annoying.com' },
      // Pre-existing label (including one we'd also add) — dedup test.
      labels: ['newsletter', 'archived'],
    }),
    CTX,
  );
  const mutated = verdict as InboxItem;
  const labels = mutated.labels ?? [];
  assertEquals(labels.includes('newsletter'), true);
  assertEquals(labels.filter((l) => l === 'archived').length, 1);
});

Deno.test('rules-hook — custom quarantineLabel respected', async () => {
  const adapter = new MemoryAdapter();
  const store = createRulesStore(adapter, { generateId: () => 'rr-1' });
  const hook = createRulesHook({ rulesStore: store, quarantineLabel: 'suspect' });
  await store.create({
    match: { text: 'needle' },
    action: 'quarantine',
    priority: 10,
  });
  const verdict = await hook(
    makeItem({ summary: 'has needle inside', body: 'x' }),
    CTX,
  );
  const mutated = verdict as InboxItem;
  assertEquals(mutated.labels?.includes('suspect'), true);
  assertEquals(mutated.labels?.includes('quarantined') ?? false, false);
});
