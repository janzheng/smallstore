/**
 * Pull-runner tests — exercises the in-Worker RSS poller end-to-end against
 * MemoryAdapter-backed peer + inbox stores. The fetch is monkey-patched per
 * test so we can simulate happy paths, HTTP errors, malformed XML, and
 * missing-target-inbox cases without hitting the network.
 *
 * Covers (per `.brief/rss-as-mailbox.md` § "Pull-runner success criteria"):
 *   - Iterates only `type: 'rss'` peers (not other types).
 *   - Skips disabled peers.
 *   - Skips peers missing `metadata.feed_config.target_inbox`.
 *   - Skips when target inbox isn't registered.
 *   - Dispatches into the named inbox with classifier off (RSS default).
 *   - Per-feed errors don't kill the run.
 *   - Summary stats are accurate (feeds_seen, feeds_polled, items_stored).
 *   - Idempotent re-poll: same feed twice → same item count.
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { createRssPullRunner } from '../src/messaging/pull-runner.ts';
import { createPeerStore } from '../src/peers/peer-registry.ts';
import type { PeerStore } from '../src/peers/types.ts';

// ============================================================================
// Test harness
// ============================================================================

const FIXTURES_DIR = new URL('./fixtures/rss/', import.meta.url);

async function loadFixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES_DIR));
}

interface Harness {
  peerStore: PeerStore;
  registry: InboxRegistry;
  inbox: ReturnType<typeof createInbox>;
  /** Restores the original global fetch. Call in test cleanup. */
  restoreFetch(): void;
}

/**
 * Stand up an empty peer store + a target inbox named `target_inbox` (or
 * whatever the caller passes). The fetch handler returns the mapping the
 * caller provides, keyed by URL. Unmapped URLs return 404.
 */
function createHarness(opts: {
  fetchByUrl?: Record<string, { status: number; body: string }>;
  target_inbox?: string;
} = {}): Harness {
  const targetName = opts.target_inbox ?? 'target_inbox';

  // Peer store
  const peersAdapter = new MemoryAdapter();
  const peerStore = createPeerStore(peersAdapter, { keyPrefix: 'peers/' });

  // Inbox
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const inbox = createInbox({
    name: targetName,
    channel: 'rss',
    storage: { items, blobs },
  });

  const registry = new InboxRegistry();
  registry.register(targetName, inbox, { channel: 'rss', storage: 'memory' }, 'boot');

  // Patch global fetch
  const originalFetch = globalThis.fetch;
  const map = opts.fetchByUrl ?? {};
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const entry = map[url];
    if (!entry) {
      return new Response('not found', { status: 404 });
    }
    return new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': 'application/xml' },
    });
  }) as typeof fetch;

  return {
    peerStore,
    registry,
    inbox,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test('pull-runner — happy path: dispatches RSS items into the named inbox', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'example-blog',
      type: 'rss',
      url,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {/* silent */},
    });

    const summary = await runner.pollAll();

    assertEquals(summary.feeds_seen, 1);
    assertEquals(summary.feeds_polled, 1);
    assertEquals(summary.feeds_errored, 0);
    assert(summary.items_stored > 0, 'at least one item stored');
    assertEquals(summary.items_dropped, 0);

    const list = await h.inbox.list();
    assertEquals(list.items.length, summary.items_stored);
    // Every item carries source = 'rss/v1'
    for (const item of list.items) {
      assertEquals(item.source, 'rss/v1');
      assertExists(item.fields.feed_url);
    }
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — only iterates type=rss peers (skips smallstore/tigerflare)', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const rssUrl = 'https://blog.example.com/feed.xml';
  const tfUrl = 'https://tigerflare.example.com/';

  const h = createHarness({
    fetchByUrl: {
      [rssUrl]: { status: 200, body: xml },
      // tigerflare URL would 200 with non-XML, but it shouldn't be fetched.
      [tfUrl]: { status: 200, body: '<html>not xml</html>' },
    },
  });
  try {
    await h.peerStore.create({
      name: 'rss-peer',
      type: 'rss',
      url: rssUrl,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });
    await h.peerStore.create({
      name: 'tigerflare-peer',
      type: 'tigerflare',
      url: tfUrl,
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_seen, 1, 'only one rss peer');
    assert(summary.items_stored > 0);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — skips disabled peers', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'disabled-feed',
      type: 'rss',
      url,
      disabled: true,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_seen, 0, 'disabled peer not seen');
    const list = await h.inbox.list();
    assertEquals(list.items.length, 0);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — feed missing target_inbox is skipped (logged as error)', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'no-target',
      type: 'rss',
      url,
      // metadata omitted on purpose
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_seen, 1);
    assertEquals(summary.feeds_polled, 0);
    assertEquals(summary.feeds_errored, 1);
    assertEquals(summary.feeds[0].error, 'missing metadata.feed_config.target_inbox');
    assertEquals(summary.items_stored, 0);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — target_inbox not registered is skipped (logged as error)', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'wrong-target',
      type: 'rss',
      url,
      metadata: { feed_config: { target_inbox: 'does-not-exist' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_polled, 0);
    assertEquals(summary.feeds_errored, 1);
    assert(summary.feeds[0].error?.includes('not registered'));
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — HTTP error captured per-feed without killing the run', async () => {
  const goodXml = await loadFixture('01-rss2-blog.xml');
  const goodUrl = 'https://good.example.com/feed.xml';
  const badUrl = 'https://bad.example.com/feed.xml';

  const h = createHarness({
    fetchByUrl: {
      [goodUrl]: { status: 200, body: goodXml },
      [badUrl]: { status: 503, body: 'service unavailable' },
    },
  });
  try {
    await h.peerStore.create({
      name: 'good-feed',
      type: 'rss',
      url: goodUrl,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });
    await h.peerStore.create({
      name: 'bad-feed',
      type: 'rss',
      url: badUrl,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_seen, 2);
    assertEquals(summary.feeds_polled, 1);
    assertEquals(summary.feeds_errored, 1);
    assert(summary.items_stored > 0, 'good feed still ingested items');
    const badResult = summary.feeds.find((f) => f.peer === 'bad-feed');
    assertExists(badResult);
    assertEquals(badResult.status, 503);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — malformed feed captured per-feed without killing the run', async () => {
  const goodXml = await loadFixture('01-rss2-blog.xml');
  const goodUrl = 'https://good.example.com/feed.xml';
  const malformedUrl = 'https://malformed.example.com/feed.xml';

  const h = createHarness({
    fetchByUrl: {
      [goodUrl]: { status: 200, body: goodXml },
      // Plausible-looking-but-broken XML that fails XMLValidator.
      [malformedUrl]: { status: 200, body: '<rss><channel><item><title>unclosed' },
    },
  });
  try {
    await h.peerStore.create({
      name: 'good-feed',
      type: 'rss',
      url: goodUrl,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });
    await h.peerStore.create({
      name: 'malformed-feed',
      type: 'rss',
      url: malformedUrl,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_seen, 2);
    assertEquals(summary.feeds_polled, 1);
    assertEquals(summary.feeds_errored, 1);
    assert(summary.items_stored > 0);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — re-poll is idempotent (same items, no duplicates)', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'example-blog',
      type: 'rss',
      url,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });

    const first = await runner.pollAll();
    const second = await runner.pollAll();

    // First poll: every item is new (stored>0, collided=0).
    assert(first.items_stored > 0);
    assertEquals(first.items_collided, 0);
    // Second poll: every item is a dedup-collision (B031: counted in
    // items_collided, NOT items_stored). The on-disk inbox count stays put.
    assertEquals(second.items_stored, 0);
    assertEquals(second.items_collided, first.items_stored);
    const list = await h.inbox.list();
    // Inbox count should equal first.items_stored (not 2x — idempotent dedup).
    assertEquals(list.items.length, first.items_stored);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — default_labels from peer metadata applied to ingested items', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'tagged-feed',
      type: 'rss',
      url,
      metadata: {
        feed_config: {
          target_inbox: 'target_inbox',
          default_labels: ['blog', 'engineering'],
        },
      },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    await runner.pollAll();

    const list = await h.inbox.list();
    assert(list.items.length > 0);
    for (const item of list.items) {
      assert(item.labels?.includes('blog'), `item ${item.id} missing 'blog' label`);
      assert(item.labels?.includes('engineering'), `item ${item.id} missing 'engineering' label`);
    }
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — pollOne polls a single peer by name', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://blog.example.com/feed.xml';

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: xml } } });
  try {
    await h.peerStore.create({
      name: 'example-blog',
      type: 'rss',
      url,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });

    const result = await runner.pollOne('example-blog');
    assertExists(result);
    assertEquals(result.peer, 'example-blog');
    assertEquals(result.status, 200);
    assert(result.items_stored > 0);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — pollOne returns null for unknown peer', async () => {
  const h = createHarness({});
  try {
    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const result = await runner.pollOne('does-not-exist');
    assertEquals(result, null);
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — pollOne returns null for non-rss peer', async () => {
  const h = createHarness({});
  try {
    await h.peerStore.create({
      name: 'tigerflare-peer',
      type: 'tigerflare',
      url: 'https://tigerflare.example.com/',
    });
    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const result = await runner.pollOne('tigerflare-peer');
    assertEquals(result, null, 'non-rss peer not pollable via rss runner');
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — peer auth (bearer) injects Authorization header on fetch', async () => {
  const xml = await loadFixture('01-rss2-blog.xml');
  const url = 'https://private.example.com/feed.xml';

  const h = createHarness({});
  // Replace the harness fetch to capture the headers passed in.
  let capturedAuth: string | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    if (u === url) {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get('authorization');
      return new Response(xml, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    await h.peerStore.create({
      name: 'private-feed',
      type: 'rss',
      url,
      auth: { kind: 'bearer', token_env: 'API_FEED_TOKEN' },
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: { API_FEED_TOKEN: 'secret-token-xyz' },
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_polled, 1);
    assertEquals(capturedAuth, 'Bearer secret-token-xyz');
  } finally {
    h.restoreFetch();
  }
});

Deno.test('pull-runner — peer auth missing env var: feed errors out without fetching', async () => {
  const url = 'https://private.example.com/feed.xml';

  const h = createHarness({});
  let fetchCalled = false;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    if (u === url) fetchCalled = true;
    return new Response('', { status: 200 });
  }) as typeof fetch;

  try {
    await h.peerStore.create({
      name: 'private-feed',
      type: 'rss',
      url,
      auth: { kind: 'bearer', token_env: 'API_MISSING_TOKEN' },
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {/* API_MISSING_TOKEN unset */},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_errored, 1);
    assertEquals(fetchCalled, false, 'no fetch when auth resolution fails');
    assert(summary.feeds[0].error?.includes('API_MISSING_TOKEN'));
  } finally {
    h.restoreFetch();
  }
});

// ============================================================================
// B031 — items_collided counter (in-feed dedup-collision visibility)
// ============================================================================

Deno.test('pull-runner — B031: two items sharing same guid collide → one stored, one collided', async () => {
  // Two feed entries that both publish the *same* <guid>. The dedup key is
  // sha256(feed_url + ':' + guid), so both items collapse to the same
  // content-addressed id. The first lands as items_stored=1; the second hits
  // dedup inside _ingest and is reported as items_collided=1. items_dropped
  // stays 0 (that counter is for hook rejections, not dedup collisions).
  const url = 'https://collide.example.com/feed.xml';
  const collidingXml = `<?xml version="1.0"?>
    <rss version="2.0"><channel><title>Collision Feed</title>
      <item>
        <title>First with shared guid</title>
        <link>https://collide.example.com/1</link>
        <guid isPermaLink="false">shared-guid-12345</guid>
        <pubDate>Mon, 21 Apr 2026 10:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Second with same guid (different content)</title>
        <link>https://collide.example.com/2</link>
        <guid isPermaLink="false">shared-guid-12345</guid>
        <pubDate>Tue, 22 Apr 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  const h = createHarness({ fetchByUrl: { [url]: { status: 200, body: collidingXml } } });
  try {
    await h.peerStore.create({
      name: 'collision-feed',
      type: 'rss',
      url,
      metadata: { feed_config: { target_inbox: 'target_inbox' } },
    });

    const runner = createRssPullRunner({
      peerStore: h.peerStore,
      registry: h.registry,
      env: {},
      log: () => {},
    });
    const summary = await runner.pollAll();

    assertEquals(summary.feeds_polled, 1);
    assertEquals(summary.feeds_errored, 0);
    assertEquals(summary.feeds[0].items_parsed, 2, 'parser still emits both entries');
    assertEquals(summary.feeds[0].items_stored, 1, 'first entry lands as fresh store');
    assertEquals(summary.feeds[0].items_collided, 1, 'second entry trips dedup → collision');
    assertEquals(summary.feeds[0].items_dropped, 0, 'collision is NOT a hook drop');
    // Summary aggregation matches per-feed.
    assertEquals(summary.items_collided, 1);
    assertEquals(summary.items_stored, 1);

    // Inbox holds exactly one item (the dedup gate worked).
    const list = await h.inbox.list();
    assertEquals(list.items.length, 1);
  } finally {
    h.restoreFetch();
  }
});
