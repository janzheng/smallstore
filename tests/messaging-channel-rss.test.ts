/**
 * Messaging — RssChannel parser tests.
 *
 * Reads .xml fixtures from tests/fixtures/rss/, parses through the channel,
 * asserts on field mapping (RSS 2.0 + Atom), podcast iTunes extensions,
 * content-addressed ids, label defaults, malformed-entry resilience, and
 * format detection.
 */

import { assert, assertEquals, assertExists, assertNotEquals, assertRejects } from 'jsr:@std/assert';
import { RssChannel, rssChannel } from '../src/messaging/channels/rss.ts';

const FIXTURES_DIR = new URL('./fixtures/rss/', import.meta.url);

async function loadFixture(name: string): Promise<string> {
  const path = new URL(name, FIXTURES_DIR);
  return await Deno.readTextFile(path);
}

async function parseAll(name: string, feedUrl: string, config?: { default_labels?: string[] }) {
  const raw = await loadFixture(name);
  return await rssChannel.parseMany({ raw, feed_url: feedUrl }, config);
}

// ============================================================================
// Channel identity
// ============================================================================

Deno.test('rss channel — declares correct name/kind/source', () => {
  assertEquals(rssChannel.name, 'rss');
  assertEquals(rssChannel.kind, 'pull');
  assertEquals(rssChannel.source, 'rss/v1');
});

Deno.test('rss channel — singleton + new instance are interchangeable', () => {
  const other = new RssChannel();
  assertEquals(other.name, rssChannel.name);
  assertEquals(other.source, rssChannel.source);
});

// ============================================================================
// 01 — RSS 2.0 blog feed
// ============================================================================

Deno.test('rss — RSS 2.0: detects format and returns all items', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  assertEquals(results.length, 3);
});

Deno.test('rss — RSS 2.0: maps title/link/guid/pubDate → summary/fields/sent_at', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  const first = results[0].item;
  assertEquals(first.source, 'rss/v1');
  assertEquals(first.summary, 'Writing a durable execution layer from scratch');
  assertEquals(first.fields.entry_url, 'https://blog.example.com/2026/04/durable-execution');
  assertEquals(first.fields.entry_guid, 'https://blog.example.com/2026/04/durable-execution');
  assertEquals(first.fields.feed_url, 'https://blog.example.com/feed.xml');
  assertEquals(first.fields.feed_title, 'Example Engineering Blog');
  assertEquals(first.sent_at, '2026-04-21T10:00:00.000Z');
});

Deno.test('rss — RSS 2.0: body prefers content:encoded over description', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  const first = results[0].item;
  // content:encoded had <strong>HTML</strong>; description had "A quick summary..."
  assert(first.body?.includes('<strong>HTML</strong>'), `body was: ${first.body}`);
  assert(!first.body?.includes('A quick summary'), 'description should NOT override content:encoded');
});

Deno.test('rss — RSS 2.0: falls back to description when content:encoded absent', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  // Second entry has only description
  const second = results[1].item;
  assertEquals(second.summary, 'Type inference for structured logs');
  assert(second.body?.includes('inline html'), `body was: ${second.body}`);
});

Deno.test('rss — RSS 2.0: empty body returns null, does not throw', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  // Third entry has neither description nor content:encoded
  const third = results[2].item;
  assertEquals(third.body, null);
  // But other fields still populated
  assertEquals(third.summary, 'Notes on SQLite FTS5 tokenizers');
});

Deno.test('rss — RSS 2.0: categories extracted as string[]', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  assertEquals(results[0].item.fields.categories, ['engineering', 'workflows']);
  assertEquals(results[1].item.fields.categories, ['typescript']);
  assertEquals(results[2].item.fields.categories, ['sqlite', 'search']);
});

Deno.test('rss — RSS 2.0: authors normalized from RFC822 "email (Name)" and dc:creator', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  // RFC822 style "alice@example.com (Alice Jordan)" → ["Alice Jordan"]
  assertEquals(results[0].item.fields.authors, ['Alice Jordan']);
  // dc:creator → ["Rahul Mehta"]
  assertEquals(results[1].item.fields.authors, ['Rahul Mehta']);
});

// ============================================================================
// 02 — Atom feed (GitHub releases shape)
// ============================================================================

Deno.test('rss — Atom: detects format and maps updated → sent_at', async () => {
  const results = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  assertEquals(results.length, 2);
  assertEquals(results[0].item.summary, 'v1.4.0');
  assertEquals(results[0].item.sent_at, '2026-04-22T12:00:00.000Z');
  assertEquals(results[0].item.fields.feed_title, 'Release notes from project');
});

Deno.test('rss — Atom: picks link rel="alternate" href over other rels', async () => {
  const results = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  assertEquals(
    results[0].item.fields.entry_url,
    'https://github.com/example/project/releases/tag/v1.4.0',
  );
});

Deno.test('rss — Atom: author <name> normalized to string[]', async () => {
  const results = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  assertEquals(results[0].item.fields.authors, ['example-bot']);
  // Second entry has two authors
  assertEquals(results[1].item.fields.authors, ['maintainer-one', 'maintainer-two']);
});

Deno.test('rss — Atom: category term extracted as string[]', async () => {
  const results = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  assertEquals(results[0].item.fields.categories, ['release']);
  assertEquals(results[1].item.fields.categories, ['release', 'patch']);
});

Deno.test('rss — Atom: summary used as body when no content', async () => {
  const results = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  // First entry has <content>, second has <summary>
  assert(results[0].item.body?.includes("What's changed"), `v1.4.0 body: ${results[0].item.body}`);
  assertEquals(results[1].item.body, 'Patch release with a small fix for macOS.');
});

Deno.test('rss — Atom: id element used as entry_guid when present', async () => {
  const results = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  assertEquals(results[0].item.fields.entry_guid, 'tag:github.com,2008:Repository/123/v1.4.0');
});

// ============================================================================
// 03 — Podcast feed with iTunes namespace + enclosures
// ============================================================================

Deno.test('rss — podcast: enclosure url/type/length extracted', async () => {
  const results = await parseAll('03-podcast-itunes.xml', 'https://podcast.example.com/feed.xml');
  const ep42 = results[0].item;
  assertEquals(ep42.fields.audio_url, 'https://cdn.podcast.example.com/ep42.mp3');
  assertEquals(ep42.fields.audio_type, 'audio/mpeg');
  assertEquals(ep42.fields.audio_length_bytes, 58392104);
});

Deno.test('rss — podcast: itunes:duration HH:MM:SS parsed to seconds', async () => {
  const results = await parseAll('03-podcast-itunes.xml', 'https://podcast.example.com/feed.xml');
  // 00:58:23 → 58*60 + 23 = 3503
  assertEquals(results[0].item.fields.duration_seconds, 3503);
});

Deno.test('rss — podcast: itunes:duration MM:SS parsed to seconds', async () => {
  const results = await parseAll('03-podcast-itunes.xml', 'https://podcast.example.com/feed.xml');
  // 52:10 → 52*60 + 10 = 3130
  assertEquals(results[1].item.fields.duration_seconds, 3130);
});

Deno.test('rss — podcast: itunes:episode / season / explicit extracted', async () => {
  const results = await parseAll('03-podcast-itunes.xml', 'https://podcast.example.com/feed.xml');
  assertEquals(results[0].item.fields.episode_number, 42);
  assertEquals(results[0].item.fields.season, 3);
  assertEquals(results[0].item.fields.explicit, false);
  // "yes" also normalizes to true
  assertEquals(results[1].item.fields.explicit, true);
});

// ============================================================================
// 04 — Malformed entry resilience
// ============================================================================

Deno.test('rss — malformed entry (no title/link/guid) is skipped, siblings still returned', async () => {
  const results = await parseAll('04-malformed-entry.xml', 'https://mixed.example.com/feed.xml');
  assertEquals(results.length, 2);
  assertEquals(results[0].item.summary, 'Good entry one');
  assertEquals(results[1].item.summary, 'Good entry two');
});

// ============================================================================
// Content-addressed id + thread_id
// ============================================================================

Deno.test('rss — content-addressed id: stable across re-parses of the same bytes', async () => {
  const a = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  const b = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  assertEquals(a[0].item.id, b[0].item.id);
  assertEquals(a[1].item.id, b[1].item.id);
  assertEquals(a[2].item.id, b[2].item.id);
});

Deno.test('rss — id is 32 hex chars', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  for (const r of results) {
    assertEquals(r.item.id.length, 32);
    assert(/^[0-9a-f]+$/.test(r.item.id), `id not hex: ${r.item.id}`);
  }
});

Deno.test('rss — different feeds → different thread_ids', async () => {
  const blog = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  const github = await parseAll(
    '02-atom-github.xml',
    'https://github.com/example/project/releases.atom',
  );
  assertExists(blog[0].item.thread_id);
  assertExists(github[0].item.thread_id);
  assertNotEquals(blog[0].item.thread_id, github[0].item.thread_id);
  // Same feed → same thread_id for all its items
  assertEquals(blog[0].item.thread_id, blog[1].item.thread_id);
  assertEquals(blog[0].item.thread_id, blog[2].item.thread_id);
});

Deno.test('rss — different feed URLs produce different ids for same guid', async () => {
  // Simulate the same entry guid showing up on two different feeds —
  // id should differ because feed_url is part of the hash input.
  const raw = await loadFixture('01-rss2-blog.xml');
  const a = await rssChannel.parseMany({ raw, feed_url: 'https://a.example.com/feed.xml' });
  const b = await rssChannel.parseMany({ raw, feed_url: 'https://b.example.com/feed.xml' });
  assertNotEquals(a[0].item.id, b[0].item.id);
});

// ============================================================================
// Config — default_labels
// ============================================================================

Deno.test('rss — default_labels from config applied to every item', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml', {
    default_labels: ['engineering', 'blogroll'],
  });
  for (const r of results) {
    assertEquals(r.item.labels, ['engineering', 'blogroll']);
  }
});

Deno.test('rss — default_labels from input.feed_config also applied', async () => {
  const raw = await loadFixture('01-rss2-blog.xml');
  const results = await rssChannel.parseMany({
    raw,
    feed_url: 'https://blog.example.com/feed.xml',
    feed_config: { default_labels: ['via-peer-registry'] },
  });
  assertEquals(results[0].item.labels, ['via-peer-registry']);
});

Deno.test('rss — no labels applied when config omitted', async () => {
  const results = await parseAll('01-rss2-blog.xml', 'https://blog.example.com/feed.xml');
  for (const r of results) {
    assertEquals(r.item.labels, undefined);
  }
});

// ============================================================================
// Malformed XML throws
// ============================================================================

Deno.test('rss — malformed XML throws with feed URL in message', async () => {
  await assertRejects(
    () =>
      rssChannel.parseMany({
        raw: '<rss><channel><item><title>unclosed',
        feed_url: 'https://broken.example.com/feed.xml',
      }),
    Error,
    'broken.example.com',
  );
});

Deno.test('rss — unrecognized root element throws', async () => {
  await assertRejects(
    () =>
      rssChannel.parseMany({
        raw: '<?xml version="1.0"?><html><body>not a feed</body></html>',
        feed_url: 'https://wrong.example.com/page.html',
      }),
    Error,
    'unrecognized feed format',
  );
});

// ============================================================================
// parse() single-item contract
// ============================================================================

Deno.test('rss — parse() returns first entry as ParseResult', async () => {
  const raw = await loadFixture('01-rss2-blog.xml');
  const result = await rssChannel.parse({ raw, feed_url: 'https://blog.example.com/feed.xml' });
  assertExists(result);
  assertEquals(result.item.summary, 'Writing a durable execution layer from scratch');
});

Deno.test('rss — parse() returns null for a feed with no entries', async () => {
  const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
  const result = await rssChannel.parse({ raw: empty, feed_url: 'https://empty.example.com/feed.xml' });
  assertEquals(result, null);
});

// ============================================================================
// RDF / RSS 1.0 — legacy publisher pipelines (bioRxiv, Slashdot, etc.)
// ============================================================================

Deno.test('rss — RDF feed parses items that sit as siblings of channel', async () => {
  const raw = await loadFixture('05-rdf-rss1.xml');
  const items = await rssChannel.parseMany({
    raw,
    feed_url: 'https://connect.biorxiv.org/biorxiv_xml.php?subject=neuroscience',
  });
  assert(items.length >= 1, `expected >= 1 item from RDF feed, got ${items.length}`);
  for (const r of items) {
    assertExists(r.item.fields.entry_url, 'each RDF item maps <link> to entry_url');
    assertEquals(r.item.source, 'rss/v1');
  }
  // bioRxiv entries carry dc:creator + dc:date — verify they map through.
  const first = items[0].item;
  assert(Array.isArray(first.fields.authors), 'authors normalized to array');
});
