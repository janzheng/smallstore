/**
 * Messaging — mailroom rules store tests.
 *
 * Exercises `createRulesStore` against `MemoryAdapter` — CRUD, apply
 * semantics (tag-style stacking, terminal first-match-by-priority, disabled
 * rules), and `applyRetroactive` against a real `MemoryAdapter`-backed
 * Inbox.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { createRulesStore } from '../src/messaging/rules.ts';
import { createRulesHook } from '../src/messaging/rules-hook.ts';
import type { MailroomRule, RulesStore } from '../src/messaging/rules.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Fixtures
// ============================================================================

function freshStore(opts?: { generateId?: () => string }) {
  const adapter = new MemoryAdapter();
  // Deterministic ids so tests can reason about ordering where useful.
  let counter = 0;
  const gen = opts?.generateId ?? (() => `rule-${String(++counter).padStart(3, '0')}`);
  const store = createRulesStore(adapter, { generateId: gen });
  return { adapter, store };
}

function freshInbox() {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  return createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items, blobs } });
}

function makeItem(overrides: Partial<InboxItem> & { fields?: Record<string, any> } = {}): InboxItem {
  return {
    id: overrides.id ?? 'item-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'cf-email',
    received_at: overrides.received_at ?? '2026-04-22T12:00:00Z',
    summary: overrides.summary ?? 'Hello',
    body: overrides.body ?? 'Body text',
    fields: {
      from_email: 'jane@example.com',
      ...overrides.fields,
    },
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

// ============================================================================
// CRUD
// ============================================================================

Deno.test('rules — create assigns id, created_at, defaults priority=100 and disabled=false', async () => {
  const { store } = freshStore();
  const rule = await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100, // required by the Omit input type
  });
  assertExists(rule.id);
  assertExists(rule.created_at);
  assertEquals(rule.priority, 100);
  assertEquals(rule.disabled, false);
  assertEquals(rule.action, 'archive');
});

Deno.test('rules — create omitting priority still yields default 100', async () => {
  const { store } = freshStore();
  // Cast: the public type requires priority, but we want to exercise the
  // default-assignment path (HTTP bodies may arrive without it).
  const rule = await store.create({
    match: { fields: { from_email: 'x@y.com' } },
    action: 'archive',
  } as any);
  assertEquals(rule.priority, 100);
  assertEquals(rule.disabled, false);
});

Deno.test('rules — create + get round-trip', async () => {
  const { store } = freshStore();
  const created = await store.create({
    match: { labels: ['newsletter'] },
    action: 'bookmark',
    priority: 50,
  });
  const fetched = await store.get(created.id);
  assertExists(fetched);
  assertEquals(fetched!.id, created.id);
  assertEquals(fetched!.action, 'bookmark');
  assertEquals(fetched!.priority, 50);
});

Deno.test('rules — update patches fields, preserves id + created_at, sets updated_at', async () => {
  const { store } = freshStore();
  const created = await store.create({
    match: { fields: { from_email: 'a@b.com' } },
    action: 'archive',
    priority: 100,
  });
  // Sleep a millisecond to ensure distinguishable timestamps.
  await new Promise((r) => setTimeout(r, 2));
  const updated = await store.update(created.id, {
    priority: 10,
    notes: 'now urgent',
    disabled: true,
  });
  assertExists(updated);
  assertEquals(updated!.id, created.id);
  assertEquals(updated!.created_at, created.created_at);
  assertEquals(updated!.priority, 10);
  assertEquals(updated!.notes, 'now urgent');
  assertEquals(updated!.disabled, true);
  assertExists(updated!.updated_at);
});

Deno.test('rules — update on unknown id returns null', async () => {
  const { store } = freshStore();
  const res = await store.update('nope-nope', { priority: 1 });
  assertEquals(res, null);
});

Deno.test('rules — delete removes and reports true; delete unknown returns false', async () => {
  const { store } = freshStore();
  const created = await store.create({
    match: { labels: ['spam'] },
    action: 'drop',
    priority: 1,
  });
  assertEquals(await store.delete(created.id), true);
  assertEquals(await store.get(created.id), null);
  assertEquals(await store.delete(created.id), false);
});

Deno.test('rules — list returns all rules; list with limit + cursor paginates', async () => {
  const { store } = freshStore();
  const created: MailroomRule[] = [];
  for (let i = 0; i < 5; i++) {
    created.push(
      await store.create({
        match: { fields: { from_email: `s${i}@example.com` } },
        action: 'tag',
        action_args: { tag: `t${i}` },
        priority: 100,
      }),
    );
    await new Promise((r) => setTimeout(r, 2)); // force distinct created_at
  }

  const all = await store.list();
  assertEquals(all.rules.length, 5);
  assertEquals(all.next_cursor, undefined);

  const page1 = await store.list({ limit: 2 });
  assertEquals(page1.rules.length, 2);
  assertExists(page1.next_cursor);

  const page2 = await store.list({ limit: 2, cursor: page1.next_cursor });
  assertEquals(page2.rules.length, 2);
  assertExists(page2.next_cursor);
  // No overlap between pages
  const ids1 = new Set(page1.rules.map((r) => r.id));
  for (const r of page2.rules) assertEquals(ids1.has(r.id), false);

  const page3 = await store.list({ limit: 2, cursor: page2.next_cursor });
  assertEquals(page3.rules.length, 1);
  assertEquals(page3.next_cursor, undefined);
});

Deno.test('rules — disabled rules are persisted but ignored by apply()', async () => {
  const { store } = freshStore();
  const rule = await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
    disabled: true,
  });
  assertEquals(rule.disabled, true);
  const stored = await store.get(rule.id);
  assertEquals(stored!.disabled, true);

  const result = await store.apply(
    makeItem({ fields: { from_email: 'news@annoying.com' } }),
  );
  assertEquals(result.labelsToAdd.length, 0);
  assertEquals(result.terminal, undefined);
  assertEquals(result.matchedRuleIds.length, 0);
});

// ============================================================================
// apply()
// ============================================================================

Deno.test('rules — apply with no rules → labelsToAdd empty, terminal undefined', async () => {
  const { store } = freshStore();
  const result = await store.apply(makeItem());
  assertEquals(result.labelsToAdd, []);
  assertEquals(result.terminal, undefined);
  assertEquals(result.matchedRuleIds, []);
});

Deno.test('rules — apply: single tag-style rule matches, derives correct label', async () => {
  const { store } = freshStore();
  await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  const result = await store.apply(
    makeItem({ fields: { from_email: 'news@annoying.com' } }),
  );
  assertEquals(result.labelsToAdd, ['archived']);
  assertEquals(result.terminal, undefined);
  assertEquals(result.matchedRuleIds.length, 1);
});

Deno.test('rules — apply: multiple tag-style rules stack labels, dedup', async () => {
  const { store } = freshStore();
  await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  await store.create({
    match: { fields: { from_email: 'annoying.com' } }, // substring match
    action: 'tag',
    action_args: { tag: 'read-later' },
    priority: 50,
  });
  await store.create({
    // Different rule adding 'archived' again — must dedup.
    match: { labels: ['promotional'] },
    action: 'archive',
    priority: 100,
  });

  const result = await store.apply(
    makeItem({
      fields: { from_email: 'news@annoying.com' },
      labels: ['promotional'],
    }),
  );
  assertEquals(result.labelsToAdd.length, 2);
  // Dedup: only one 'archived'
  assertEquals(new Set(result.labelsToAdd), new Set(['archived', 'read-later']));
  assertEquals(result.terminal, undefined);
  assertEquals(result.matchedRuleIds.length, 3);
});

Deno.test('rules — apply: single terminal drop rule → terminal="drop"', async () => {
  const { store } = freshStore();
  await store.create({
    match: { fields: { from_email: 'spammer@evil.com' } },
    action: 'drop',
    priority: 1,
  });
  const result = await store.apply(
    makeItem({ fields: { from_email: 'spammer@evil.com' } }),
  );
  assertEquals(result.terminal, 'drop');
  assertEquals(result.labelsToAdd, []);
});

Deno.test('rules — apply: single terminal quarantine rule → terminal="quarantine"', async () => {
  const { store } = freshStore();
  await store.create({
    match: { text: 'suspicious' },
    action: 'quarantine',
    priority: 10,
  });
  const result = await store.apply(
    makeItem({ summary: 'a suspicious message', body: '...' }),
  );
  assertEquals(result.terminal, 'quarantine');
  assertEquals(result.labelsToAdd, []);
});

Deno.test('rules — apply: tag + terminal both match → terminal wins, tag labels still collected', async () => {
  const { store } = freshStore();
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
  const result = await store.apply(
    makeItem({ fields: { from_email: 'mixed@test.com' } }),
  );
  assertEquals(result.terminal, 'quarantine');
  assertEquals(result.labelsToAdd, ['archived']);
  assertEquals(result.matchedRuleIds.length, 2);
});

Deno.test('rules — apply: priority ordering, lower priority terminal wins', async () => {
  const { store } = freshStore();
  // Priority 200: should NOT be the terminal used
  await store.create({
    match: { fields: { from_email: 'same@test.com' } },
    action: 'drop',
    priority: 200,
  });
  // Priority 10: lower → wins
  await store.create({
    match: { fields: { from_email: 'same@test.com' } },
    action: 'quarantine',
    priority: 10,
  });
  const result = await store.apply(
    makeItem({ fields: { from_email: 'same@test.com' } }),
  );
  assertEquals(result.terminal, 'quarantine');
  // Both matched, but only the quarantine (lower priority) was recorded as terminal.
  assertEquals(result.matchedRuleIds.length, 2);
});

// ============================================================================
// applyRetroactive()
// ============================================================================

Deno.test('rules — applyRetroactive: N matching items get tagged on re-ingest', async () => {
  const { store } = freshStore();
  const inbox = freshInbox();

  // Seed: 3 items from news@annoying.com, 2 from other sender.
  for (let i = 0; i < 3; i++) {
    await inbox._ingest(
      makeItem({
        id: `annoy-${i}`,
        fields: { from_email: 'news@annoying.com' },
        received_at: `2026-04-22T12:0${i}:00Z`,
      }),
    );
  }
  for (let i = 0; i < 2; i++) {
    await inbox._ingest(
      makeItem({
        id: `other-${i}`,
        fields: { from_email: 'ok@example.com' },
        received_at: `2026-04-22T13:0${i}:00Z`,
      }),
    );
  }

  const rule = await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'tag',
    action_args: { tag: 'read-later' },
    priority: 100,
  });

  const res = await store.applyRetroactive(rule, inbox);
  assertEquals(res.affected, 3);
  assertEquals(res.error, undefined);

  // Matching items now carry the label
  for (let i = 0; i < 3; i++) {
    const item = await inbox.read(`annoy-${i}`);
    assertExists(item);
    assertEquals(item!.labels?.includes('read-later'), true);
  }
  // Non-matching items unchanged
  for (let i = 0; i < 2; i++) {
    const item = await inbox.read(`other-${i}`);
    assertExists(item);
    assertEquals(item!.labels?.includes('read-later') ?? false, false);
  }
});

Deno.test('rules — applyRetroactive (archive): items get "archived" label', async () => {
  const { store } = freshStore();
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem({
      id: 'one',
      fields: { from_email: 'news@annoying.com' },
      received_at: '2026-04-22T12:00:00Z',
    }),
  );

  const rule = await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  const res = await store.applyRetroactive(rule, inbox);
  assertEquals(res.affected, 1);
  const item = await inbox.read('one');
  assertEquals(item!.labels?.includes('archived'), true);
});

Deno.test('rules — applyRetroactive on terminal action is a no-op with error', async () => {
  const { store } = freshStore();
  const inbox = freshInbox();
  await inbox._ingest(
    makeItem({
      id: 'x',
      fields: { from_email: 'spammer@evil.com' },
      received_at: '2026-04-22T12:00:00Z',
    }),
  );

  const dropRule = await store.create({
    match: { fields: { from_email: 'spammer@evil.com' } },
    action: 'drop',
    priority: 1,
  });
  const res = await store.applyRetroactive(dropRule, inbox);
  assertEquals(res.affected, 0);
  assertExists(res.error);
  // Item still present, un-labeled.
  const item = await inbox.read('x');
  assertExists(item);
  assertEquals(item!.labels ?? [], []);
});

// ============================================================================
// B008 — evaluateFilter throw isolation in apply()
// ============================================================================

Deno.test('rules — B008: malformed filter that throws in evaluateFilter is treated as no-match (no rule wedge)', async () => {
  // We force evaluateFilter to throw by handing it a filter shape it can't
  // safely process. `matchFieldPartial` calls `.toLowerCase()` on the
  // expected value — a `null` (smuggled past TS via `as any`) raises a
  // TypeError. Before B008 this would bubble through `apply` → the
  // rules-hook → terminate ingest. After B008: the rule is skipped, a
  // warning is logged, and apply() keeps going.
  const { store } = freshStore();

  // First rule: malformed (will throw inside evaluateFilter).
  await store.create({
    match: { fields: { from_email: null as any } },
    action: 'archive',
    priority: 100,
  });
  // Second rule: well-formed and SHOULD still match — proves the loop
  // didn't abort on the throw.
  await store.create({
    match: { fields: { from_email: 'good@example.com' } },
    action: 'tag',
    action_args: { tag: 'survived' },
    priority: 100,
  });

  // Capture console.warn output to confirm we logged the bad rule's id.
  const original = console.warn;
  const warnings: any[][] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args);
  };
  try {
    const result = await store.apply(
      makeItem({ fields: { from_email: 'good@example.com' } }),
    );
    // Well-formed rule still matched — pipeline kept walking past the throw.
    assertEquals(result.labelsToAdd, ['survived']);
    assertEquals(result.terminal, undefined);
    // We logged the throw — at least one warning mentioning evaluateFilter.
    const sawWarning = warnings.some((w) =>
      typeof w[0] === 'string' && w[0].includes('evaluateFilter')
    );
    assertEquals(sawWarning, true);
  } finally {
    console.warn = original;
  }
});

Deno.test('rules-hook — B008: rulesStore.apply() throw → hook returns "accept", logs error, ingest survives', async () => {
  // Hand the hook a store whose `apply()` throws unconditionally — proves
  // the hook's outer try/catch keeps ingest alive instead of crashing the
  // pipeline.
  const burningStore: RulesStore = {
    list: async () => ({ rules: [] }),
    get: async () => null,
    create: async () => ({} as MailroomRule),
    update: async () => null,
    delete: async () => false,
    apply: async () => {
      throw new Error('storage adapter on fire');
    },
    applyRetroactive: async () => ({ affected: 0 }),
  };

  const hook = createRulesHook({ rulesStore: burningStore });
  const ctx: HookContext = { channel: 'cf-email', registration: 'mailroom' };

  const original = console.error;
  const errors: any[][] = [];
  console.error = (...args: any[]) => {
    errors.push(args);
  };
  let verdict: any;
  try {
    verdict = await hook(makeItem({ id: 'survivor' }), ctx);
  } finally {
    console.error = original;
  }

  // Ingest survives — verdict is the pass-through 'accept'.
  assertEquals(verdict, 'accept');
  // Error was logged so an operator can see it.
  const sawError = errors.some((e) =>
    typeof e[0] === 'string' && e[0].includes('rulesStore.apply')
  );
  assertEquals(sawError, true);
});

// ============================================================================
// B024 — applyRetroactive cursor non-advance detection
// ============================================================================

Deno.test('rules — B024: applyRetroactive bails after 3 consecutive stuck pages with non-advancing cursor', async () => {
  const { store } = freshStore();
  // Fake inbox where `query` always returns the same `next_cursor`,
  // simulating an `inbox.query` bug or index corruption that signals "more"
  // without advancing. Pre-B024 this would loop to the 10k cap; post-B024
  // it bails after 3 stuck pages.
  let queryCalls = 0;
  const ingestCalls: number[] = [];
  const fakeInbox: any = {
    query: async (_filter: any, _opts: any) => {
      queryCalls++;
      // Return one fresh item per page so it's not the dedup-skip path that
      // exits — we want to prove the cursor logic is what stops the loop.
      return {
        items: [
          {
            id: `item-${queryCalls}`,
            source: 'cf-email',
            received_at: '2026-04-22T12:00:00Z',
            summary: 's',
            body: 'b',
            fields: { from_email: 'a@b.com' },
            labels: [],
          } as InboxItem,
        ],
        next_cursor: 'STUCK_CURSOR',
      };
    },
    _ingest: async (_item: InboxItem, _opts: any) => {
      ingestCalls.push(queryCalls);
    },
  };

  const rule = await store.create({
    match: { fields: { from_email: 'a@b.com' } },
    action: 'tag',
    action_args: { tag: 't' },
    priority: 100,
  });

  const original = console.warn;
  const warnings: any[][] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args);
  };
  let res: { affected: number; error?: string };
  try {
    res = await store.applyRetroactive(rule, fakeInbox);
  } finally {
    console.warn = original;
  }

  // Bailed early — nowhere close to 10k pages, and an error was returned.
  assertExists(res.error);
  // 3 consecutive stuck pages: the first page sets lastCursor; the next 3
  // each match it. So we expect ~4 query calls (1 baseline + 3 stuck).
  // Allow a small margin for boundary interpretation, but assert << 10k.
  assertEquals(queryCalls < 10, true, `expected fast-fail, got ${queryCalls} pages`);
  // We logged the stuck-cursor warning.
  const sawWarning = warnings.some((w) =>
    typeof w[0] === 'string' && w[0].includes('cursor stuck')
  );
  assertEquals(sawWarning, true);
});

Deno.test('rules — B024: applyRetroactive does not bail when cursor advances normally', async () => {
  // Counter-test — make sure the cursor-advance check doesn't false-positive
  // on a healthy paginated query. Three pages, each with a distinct cursor,
  // last page returns no cursor (end).
  const { store } = freshStore();
  let queryCalls = 0;
  const fakeInbox: any = {
    query: async (_filter: any, _opts: any) => {
      queryCalls++;
      const item = {
        id: `item-${queryCalls}`,
        source: 'cf-email',
        received_at: '2026-04-22T12:00:00Z',
        summary: 's',
        body: 'b',
        fields: { from_email: 'a@b.com' },
        labels: [],
      } as InboxItem;
      if (queryCalls < 3) {
        return { items: [item], next_cursor: `cursor-${queryCalls}` };
      }
      // Last page: no next_cursor → loop exits cleanly.
      return { items: [item], next_cursor: undefined };
    },
    _ingest: async (_item: InboxItem, _opts: any) => {},
  };

  const rule = await store.create({
    match: { fields: { from_email: 'a@b.com' } },
    action: 'tag',
    action_args: { tag: 't' },
    priority: 100,
  });

  const res = await store.applyRetroactive(rule, fakeInbox);
  assertEquals(res.error, undefined);
  assertEquals(res.affected, 3);
  assertEquals(queryCalls, 3);
});

Deno.test('rules — applyRetroactive skips items already carrying the derived label', async () => {
  const { store } = freshStore();
  const inbox = freshInbox();
  // Seed: one item already has 'archived', one does not.
  await inbox._ingest(
    makeItem({
      id: 'has',
      fields: { from_email: 'news@annoying.com' },
      received_at: '2026-04-22T12:00:00Z',
      labels: ['archived'],
    }),
  );
  await inbox._ingest(
    makeItem({
      id: 'nope',
      fields: { from_email: 'news@annoying.com' },
      received_at: '2026-04-22T12:01:00Z',
    }),
  );

  const rule = await store.create({
    match: { fields: { from_email: 'news@annoying.com' } },
    action: 'archive',
    priority: 100,
  });
  const res = await store.applyRetroactive(rule, inbox);
  // Only one item actually mutated.
  assertEquals(res.affected, 1);
  // Both end up with the label.
  const a = await inbox.read('has');
  const b = await inbox.read('nope');
  assertEquals(a!.labels?.filter((l) => l === 'archived').length, 1); // not duplicated
  assertEquals(b!.labels?.includes('archived'), true);
});
