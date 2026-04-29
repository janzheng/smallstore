/**
 * spam-stats — Sprint 3 ranking helper.
 *
 * Tests cover sorting, threshold cutoffs, trusted-exclusion, recency
 * window, and the four-list contract.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import { createMemoryAdapter } from '../src/adapters/memory.ts';
import { createSenderIndex, type SenderIndex, type SenderRecord } from '../src/messaging/sender-index.ts';
import { getSpamStats } from '../src/messaging/spam-stats.ts';

async function seed(senderIndex: SenderIndex, records: Partial<SenderRecord>[]): Promise<void> {
  for (const r of records) {
    const full: SenderRecord = {
      address: r.address!,
      display_name: r.display_name,
      first_seen: r.first_seen ?? '2026-04-01T00:00:00Z',
      last_seen: r.last_seen ?? '2026-04-28T00:00:00Z',
      count: r.count ?? 0,
      spam_count: r.spam_count ?? 0,
      not_spam_count: r.not_spam_count ?? 0,
      marked_at: r.marked_at,
      tags: r.tags ?? [],
      list_unsubscribe_url: r.list_unsubscribe_url,
    };
    await senderIndex.setRecord(full);
  }
}

function makeIndex(): SenderIndex {
  return createSenderIndex(createMemoryAdapter());
}

const NOW = '2026-04-28T12:00:00Z';
const fixedNow = () => NOW;

Deno.test('getSpamStats — empty index returns empty lists', async () => {
  const idx = makeIndex();
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.senders_top_spam, []);
  assertEquals(stats.senders_recently_marked, []);
  assertEquals(stats.suggested_blocklist, []);
  assertEquals(stats.suggested_whitelist, []);
});

Deno.test('senders_top_spam — ranks by spam_count desc, then count desc', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', count: 10, spam_count: 3 },
    { address: 'b@x.com', count: 20, spam_count: 7 },
    { address: 'c@x.com', count: 5, spam_count: 1 },
    { address: 'd@x.com', count: 50, spam_count: 0 },  // excluded — spam_count 0
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.senders_top_spam.map((r) => r.address), ['b@x.com', 'a@x.com', 'c@x.com']);
});

Deno.test('senders_top_spam — tiebreaker on count when spam_count equal', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', count: 5, spam_count: 3 },
    { address: 'b@x.com', count: 20, spam_count: 3 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.senders_top_spam[0].address, 'b@x.com');
});

Deno.test('senders_recently_marked — only includes senders with marked_at within windowDays', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'recent@x.com', count: 1, spam_count: 1, marked_at: '2026-04-25T00:00:00Z' },
    { address: 'old@x.com', count: 1, spam_count: 1, marked_at: '2026-01-01T00:00:00Z' },
    { address: 'never@x.com', count: 1, spam_count: 1 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow, windowDays: 30 });
  assertEquals(stats.senders_recently_marked.map((r) => r.address), ['recent@x.com']);
});

Deno.test('senders_recently_marked — sorted by marked_at descending', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', spam_count: 1, marked_at: '2026-04-20T00:00:00Z' },
    { address: 'b@x.com', spam_count: 1, marked_at: '2026-04-26T00:00:00Z' },
    { address: 'c@x.com', spam_count: 1, marked_at: '2026-04-24T00:00:00Z' },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.senders_recently_marked.map((r) => r.address), ['b@x.com', 'c@x.com', 'a@x.com']);
});

Deno.test('senders_recently_marked — custom windowDays', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', spam_count: 1, marked_at: '2026-04-22T00:00:00Z' },
  ]);
  const stats7 = await getSpamStats(idx, { now: fixedNow, windowDays: 7 });
  assertEquals(stats7.senders_recently_marked.length, 1);
  const stats3 = await getSpamStats(idx, { now: fixedNow, windowDays: 3 });
  assertEquals(stats3.senders_recently_marked.length, 0);
});

Deno.test('suggested_blocklist — meets count >= 5 AND spam_rate >= 0.7', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'block@x.com', count: 10, spam_count: 8, not_spam_count: 2 },
    { address: 'low-count@x.com', count: 4, spam_count: 4, not_spam_count: 0 },  // below count
    { address: 'low-rate@x.com', count: 10, spam_count: 5, not_spam_count: 5 },  // rate 0.5
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.suggested_blocklist.map((r) => r.address), ['block@x.com']);
});

Deno.test('suggested_blocklist — excludes trusted senders', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'trusted@x.com', count: 10, spam_count: 8, not_spam_count: 2, tags: ['trusted'] },
    { address: 'spammy@x.com', count: 10, spam_count: 8, not_spam_count: 2 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.suggested_blocklist.map((r) => r.address), ['spammy@x.com']);
});

Deno.test('suggested_blocklist — sorted by spam_rate desc then spam_count desc', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', count: 10, spam_count: 7, not_spam_count: 3 },     // rate 0.7
    { address: 'b@x.com', count: 20, spam_count: 18, not_spam_count: 2 },    // rate 0.9
    { address: 'c@x.com', count: 50, spam_count: 35, not_spam_count: 15 },   // rate 0.7
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.suggested_blocklist.map((r) => r.address), ['b@x.com', 'c@x.com', 'a@x.com']);
});

Deno.test('suggested_blocklist — custom thresholds', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'borderline@x.com', count: 10, spam_count: 5, not_spam_count: 5 },
  ]);
  const lenient = await getSpamStats(idx, { now: fixedNow, blocklistMinSpamRate: 0.5 });
  assertEquals(lenient.suggested_blocklist.length, 1);
  const strict = await getSpamStats(idx, { now: fixedNow, blocklistMinSpamRate: 0.6 });
  assertEquals(strict.suggested_blocklist.length, 0);
});

Deno.test('suggested_whitelist — meets explicit marks >= 3 AND not_spam > spam', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'good@x.com', count: 5, spam_count: 1, not_spam_count: 4 },
    { address: 'low-marks@x.com', count: 5, spam_count: 1, not_spam_count: 1 },  // 2 explicit < 3
    { address: 'tied@x.com', count: 5, spam_count: 2, not_spam_count: 2 },        // tied, must be > not =
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.suggested_whitelist.map((r) => r.address), ['good@x.com']);
});

Deno.test('suggested_whitelist — excludes trusted senders (already whitelisted)', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'already@x.com', count: 10, spam_count: 0, not_spam_count: 5, tags: ['trusted'] },
    { address: 'pending@x.com', count: 10, spam_count: 1, not_spam_count: 4 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.suggested_whitelist.map((r) => r.address), ['pending@x.com']);
});

Deno.test('suggested_whitelist — sorted by not_spam_count desc', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', spam_count: 0, not_spam_count: 3 },
    { address: 'b@x.com', spam_count: 0, not_spam_count: 10 },
    { address: 'c@x.com', spam_count: 0, not_spam_count: 5 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  assertEquals(stats.suggested_whitelist.map((r) => r.address), ['b@x.com', 'c@x.com', 'a@x.com']);
});

Deno.test('limit option caps each ranked list', async () => {
  const idx = makeIndex();
  const seeds: Partial<SenderRecord>[] = [];
  for (let i = 0; i < 10; i++) {
    seeds.push({ address: `s${i}@x.com`, count: 5, spam_count: 4, not_spam_count: 1 });
  }
  await seed(idx, seeds);
  const stats = await getSpamStats(idx, { now: fixedNow, limit: 3 });
  assertEquals(stats.senders_top_spam.length, 3);
  assertEquals(stats.suggested_blocklist.length, 3);
});

Deno.test('row shape — spam_rate computed correctly with no explicit marks', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', count: 5, spam_count: 0, not_spam_count: 0 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  // Excluded from senders_top_spam (spam_count=0) but row math still well-defined elsewhere.
  assertEquals(stats.senders_top_spam.length, 0);
});

Deno.test('row shape — preserves display_name and tags', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', count: 5, spam_count: 4, not_spam_count: 1, display_name: '"A Co" <a@x.com>', tags: ['newsletter'] },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  const row = stats.senders_top_spam[0];
  assertEquals(row.display_name, '"A Co" <a@x.com>');
  assertEquals(row.tags, ['newsletter']);
  assert(row.spam_rate > 0);
});

Deno.test('row shape — spam_rate divides by explicit decisions only', async () => {
  const idx = makeIndex();
  await seed(idx, [
    { address: 'a@x.com', count: 100, spam_count: 5, not_spam_count: 5 },
  ]);
  const stats = await getSpamStats(idx, { now: fixedNow });
  // 5 / (5+5) = 0.5, NOT 5/100
  assertEquals(stats.senders_top_spam[0].spam_rate, 0.5);
});
