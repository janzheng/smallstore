/**
 * Stale-unread sweep tests.
 *
 * Covers cutoff math, idempotence, the disable knob (cutoffDays <= 0),
 * the safety cap, and that the sweep does not touch items outside the
 * window or items already marked read.
 */

import { assertEquals } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { runUnreadSweep } from '../src/messaging/unread-sweep.ts';
import type { InboxItem } from '../src/messaging/types.ts';

async function buildInbox() {
  const items = new MemoryAdapter();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });
  let counter = 0;
  const seed = async (overrides: Partial<InboxItem>): Promise<InboxItem> => {
    const id = overrides.id ?? `item-${++counter}`;
    const item: InboxItem = {
      id,
      source: 'email/v1',
      source_version: 'email/v1',
      received_at: '2026-04-26T10:00:00.000Z',
      summary: 'test',
      labels: ['unread'],
      fields: {},
      ...overrides,
    };
    return await inbox._ingest(item, { force: true });
  };
  return { inbox, seed };
}

const NOW = Date.parse('2026-04-27T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

Deno.test('runUnreadSweep — items older than cutoff get marked read', async () => {
  const { inbox, seed } = await buildInbox();
  await seed({ id: 'old', received_at: new Date(NOW - 60 * DAY).toISOString() });
  await seed({ id: 'fresh', received_at: new Date(NOW - 1 * DAY).toISOString() });

  const result = await runUnreadSweep({ inbox, cutoffDays: 30, now: NOW });

  assertEquals(result.changed, 1);
  assertEquals(result.matched, 1);
  // Fresh item still has `unread`
  const fresh = await inbox.read('fresh');
  assertEquals(fresh?.labels?.includes('unread'), true);
  // Old item no longer has `unread`. Labels may be undefined (last-label-removed
  // path) or an array without `unread`; either way, !includes('unread').
  const old = await inbox.read('old');
  assertEquals((old?.labels ?? []).includes('unread'), false);
});

Deno.test('runUnreadSweep — items at exactly the cutoff are kept (until is inclusive)', async () => {
  // Filter semantics: `received_at > until` excludes; `received_at <= until` keeps.
  // An item exactly at the boundary is matched (kept in the result).
  const { inbox, seed } = await buildInbox();
  await seed({ id: 'boundary', received_at: new Date(NOW - 30 * DAY).toISOString() });

  const result = await runUnreadSweep({ inbox, cutoffDays: 30, now: NOW });
  assertEquals(result.changed, 1);
});

Deno.test('runUnreadSweep — cutoffDays: 0 → no-op (disabled)', async () => {
  const { inbox, seed } = await buildInbox();
  await seed({ id: 'old', received_at: new Date(NOW - 100 * DAY).toISOString() });

  const result = await runUnreadSweep({ inbox, cutoffDays: 0, now: NOW });
  assertEquals(result.changed, 0);
  assertEquals(result.matched, 0);
  // Item still has `unread`
  const old = await inbox.read('old');
  assertEquals(old?.labels?.includes('unread'), true);
});

Deno.test('runUnreadSweep — cutoffDays: negative → no-op', async () => {
  const { inbox, seed } = await buildInbox();
  await seed({ id: 'old', received_at: new Date(NOW - 100 * DAY).toISOString() });

  const result = await runUnreadSweep({ inbox, cutoffDays: -7, now: NOW });
  assertEquals(result.changed, 0);
});

Deno.test('runUnreadSweep — does not touch items already without `unread` label', async () => {
  const { inbox, seed } = await buildInbox();
  await seed({
    id: 'old-read',
    received_at: new Date(NOW - 60 * DAY).toISOString(),
    labels: ['bookmark'], // no unread
  });

  const result = await runUnreadSweep({ inbox, cutoffDays: 30, now: NOW });
  // Filter is intersected with `unread` → no match
  assertEquals(result.matched, 0);
  const item = await inbox.read('old-read');
  assertEquals(item?.labels, ['bookmark']);
});

Deno.test('runUnreadSweep — preserves other labels when removing `unread`', async () => {
  const { inbox, seed } = await buildInbox();
  await seed({
    id: 'old',
    received_at: new Date(NOW - 60 * DAY).toISOString(),
    labels: ['unread', 'newsletter', 'bookmark'],
  });

  await runUnreadSweep({ inbox, cutoffDays: 30, now: NOW });
  const item = await inbox.read('old');
  assertEquals(item?.labels?.sort(), ['bookmark', 'newsletter']);
});

Deno.test('runUnreadSweep — idempotent on rerun', async () => {
  const { inbox, seed } = await buildInbox();
  await seed({ id: 'old', received_at: new Date(NOW - 60 * DAY).toISOString() });

  const first = await runUnreadSweep({ inbox, cutoffDays: 30, now: NOW });
  assertEquals(first.changed, 1);

  const second = await runUnreadSweep({ inbox, cutoffDays: 30, now: NOW });
  assertEquals(second.matched, 0);
  assertEquals(second.changed, 0);
});

Deno.test('runUnreadSweep — hardCap caps the per-run batch', async () => {
  const { inbox, seed } = await buildInbox();
  for (let i = 0; i < 5; i++) {
    await seed({
      id: `old-${i}`,
      received_at: new Date(NOW - (60 + i) * DAY).toISOString(),
    });
  }

  const result = await runUnreadSweep({ inbox, cutoffDays: 30, hardCap: 3, now: NOW });
  assertEquals(result.changed, 3);
  assertEquals(result.capped, true);
  // Two items still unread → next run will mop them up
  const remaining = await inbox.query({ labels: ['unread'] }, { limit: 100 });
  assertEquals(remaining.items.length, 2);
});
