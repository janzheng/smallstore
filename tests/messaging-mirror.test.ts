/**
 * Phase 2b — peer-mediated cron mirror (per `.brief/notes-todos-and-mirror.md`).
 *
 * Tests the runMirror() engine in isolation with a mocked fetch — the
 * actual tigerflare push happens at deploy time. Covers:
 *
 *   - Iterates peers with metadata.mirror_config; skips others
 *   - Skips disabled peers entirely
 *   - Skips when source_inbox not registered
 *   - Skips when peer auth env var missing (graceful, no throw)
 *   - PUTs per-newsletter markdown to peer URL + path prefix
 *   - Includes index.md when include_index: true
 *   - Per-slug failures isolated (one bad slug doesn't tank others)
 *   - Auth headers from peer.auth.token_env injected on every request
 *   - Path prefix normalization (leading + trailing slash)
 *   - peer_name filter restricts to a single peer
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { runMirror } from '../src/messaging/mirror.ts';
import { createPeerStore } from '../src/peers/peer-registry.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';
import type { Peer } from '../src/peers/types.ts';

interface MockedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Build a fetch mock that records every call and returns a configurable
 * response. By default returns `200 OK`. Pass an `errorPaths` set to make
 * specific URLs return 500 — useful for per-slug failure isolation.
 */
function buildMockFetcher(opts: {
  errorPaths?: Set<string>;
} = {}): { fetcher: typeof fetch; calls: MockedFetchCall[] } {
  const calls: MockedFetchCall[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, headers, body });
    if (opts.errorPaths?.has(new URL(url).pathname)) {
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

interface Fixture {
  registry: InboxRegistry;
  inbox: ReturnType<typeof createInbox>;
  peerStore: ReturnType<typeof createPeerStore>;
  seed: (overrides: Partial<InboxItem>) => Promise<InboxItem>;
  registerPeer: (peer: Partial<Peer> & { name: string }) => Promise<Peer>;
}

async function buildFixture(): Promise<Fixture> {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'items' } as InboxConfig, 'boot');

  const peerAdapter = new MemoryAdapter();
  let counter = 0;
  const peerStore = createPeerStore(peerAdapter, {
    generateId: () => `peer-${++counter}`,
  });

  let itemCounter = 0;
  return {
    registry,
    inbox,
    peerStore,
    seed: async (overrides) => {
      const id = overrides.id ?? `item-${++itemCounter}`;
      const item: InboxItem = {
        id,
        source: 'email/v1',
        source_version: 'email/v1',
        received_at: '2026-04-26T10:00:00.000Z',
        summary: 'Test',
        labels: ['forwarded'],
        fields: {},
        ...overrides,
      };
      return await inbox._ingest(item, { force: true });
    },
    registerPeer: async (peer) => await peerStore.create({
      name: peer.name,
      type: peer.type ?? 'tigerflare',
      url: peer.url ?? 'https://tigerflare.example.com',
      auth: peer.auth ?? { kind: 'bearer', token_env: 'TF_TOKEN' },
      tags: peer.tags ?? [],
      metadata: peer.metadata ?? null,
      disabled: peer.disabled ?? false,
      description: peer.description,
    } as Parameters<typeof peerStore.create>[0]),
  };
}

// ---------------------------------------------------------------------
// Selection — which peers get mirrored
// ---------------------------------------------------------------------

Deno.test('mirror: skips peers without metadata.mirror_config', async () => {
  const f = await buildFixture();
  await f.registerPeer({ name: 'plain-tigerflare' }); // no mirror_config
  const { fetcher, calls } = buildMockFetcher();

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test('mirror: skips disabled peers even with mirror_config', async () => {
  const f = await buildFixture();
  await f.seed({ fields: { newsletter_slug: 'pub-a', forward_note: 'note' } });
  await f.registerPeer({
    name: 'tf-disabled',
    disabled: true,
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  const { fetcher, calls } = buildMockFetcher();

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test('mirror: peer_name filter restricts to one peer', async () => {
  const f = await buildFixture();
  await f.seed({ fields: { newsletter_slug: 'pub', forward_note: 'note' } });
  await f.registerPeer({
    name: 'tf-a',
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  await f.registerPeer({
    name: 'tf-b',
    url: 'https://tf-b.example.com',
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  const { fetcher } = buildMockFetcher();

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    peer_name: 'tf-a',
    fetcher,
  });

  assertEquals(results.length, 1);
  assertEquals(results[0].peer_name, 'tf-a');
});

// ---------------------------------------------------------------------
// Skip reasons (graceful failure)
// ---------------------------------------------------------------------

Deno.test('mirror: skip reason when source_inbox not registered', async () => {
  const f = await buildFixture();
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'no-such-inbox' } },
  });
  const { fetcher, calls } = buildMockFetcher();

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results.length, 1);
  assertStringIncludes(results[0].skipped ?? '', 'no-such-inbox');
  assertEquals(results[0].pushed, 0);
  assertEquals(calls.length, 0);
});

Deno.test('mirror: skip reason when auth env var missing', async () => {
  const f = await buildFixture();
  await f.seed({ fields: { newsletter_slug: 'pub', forward_note: 'note' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  const { fetcher, calls } = buildMockFetcher();

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { /* no TF_TOKEN */ },
    fetcher,
  });

  assertEquals(results.length, 1);
  assertStringIncludes(results[0].skipped ?? '', 'TF_TOKEN');
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------
// Happy path — push markdown
// ---------------------------------------------------------------------

Deno.test('mirror: PUTs one file per newsletter slug', async () => {
  const f = await buildFixture();
  await f.seed({
    id: 'a',
    fields: {
      newsletter_slug: 'pub-a',
      original_from_addr: 'Pub A',
      original_subject: 'first',
      original_sent_at: '2026-04-26T10:00:00.000Z',
      forward_note: 'a',
    },
  });
  await f.seed({
    id: 'b',
    fields: {
      newsletter_slug: 'pub-b',
      original_from_addr: 'Pub B',
      original_subject: 'first',
      original_sent_at: '2026-04-26T10:00:00.000Z',
      forward_note: 'b',
    },
  });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  const { fetcher, calls } = buildMockFetcher();

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results.length, 1);
  assertEquals(results[0].pushed, 2);
  assertEquals(results[0].failed, []);
  assertEquals(calls.length, 2);

  // Default path prefix is `/<peer.name>/`
  const paths = calls.map((c) => new URL(c.url).pathname).sort();
  assertEquals(paths, ['/tf/pub-a.md', '/tf/pub-b.md']);

  // All requests are PUT
  assertEquals(new Set(calls.map((c) => c.method)), new Set(['PUT']));

  // Bearer auth header injected
  assertEquals(calls[0].headers['Authorization'], 'Bearer secret');

  // Body is markdown
  assertStringIncludes(calls[0].headers['Content-Type'], 'text/markdown');
});

Deno.test('mirror: include_index emits index.md alongside per-slug files', async () => {
  const f = await buildFixture();
  await f.seed({
    fields: {
      newsletter_slug: 'pub-a',
      original_from_addr: 'Pub A',
      original_sent_at: '2026-04-26T10:00:00.000Z',
      forward_note: 'a',
    },
  });
  await f.registerPeer({
    name: 'tf',
    metadata: {
      mirror_config: { source_inbox: 'mailroom', include_index: true },
    },
  });
  const { fetcher, calls } = buildMockFetcher();

  await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  const paths = calls.map((c) => new URL(c.url).pathname).sort();
  assertEquals(paths, ['/tf/index.md', '/tf/pub-a.md']);

  // Index body has a publishers table; per-slug body has a profile header
  const index = calls.find((c) => c.url.endsWith('/index.md'))!;
  assertStringIncludes(index.body, '# Mailroom newsletters');
  assertStringIncludes(index.body, '[pub-a]');

  const slug = calls.find((c) => c.url.endsWith('/pub-a.md'))!;
  assertStringIncludes(slug.body, '# Pub A');
  assertStringIncludes(slug.body, '> a');
});

Deno.test('mirror: target_path_prefix overrides default', async () => {
  const f = await buildFixture();
  await f.seed({
    fields: { newsletter_slug: 'pub', forward_note: 'note' },
  });
  await f.registerPeer({
    name: 'tf',
    metadata: {
      mirror_config: {
        source_inbox: 'mailroom',
        target_path_prefix: '/scratch/mailroom-mirror/',
      },
    },
  });
  const { fetcher, calls } = buildMockFetcher();

  await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(new URL(calls[0].url).pathname, '/scratch/mailroom-mirror/pub.md');
});

Deno.test('mirror: target_path_prefix without trailing slash gets normalized', async () => {
  const f = await buildFixture();
  await f.seed({ fields: { newsletter_slug: 'pub', forward_note: 'note' } });
  await f.registerPeer({
    name: 'tf',
    metadata: {
      mirror_config: { source_inbox: 'mailroom', target_path_prefix: '/folder' },
    },
  });
  const { fetcher, calls } = buildMockFetcher();

  await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(new URL(calls[0].url).pathname, '/folder/pub.md');
});

Deno.test('mirror: link_origin propagates to "View item →" links', async () => {
  const f = await buildFixture();
  await f.seed({
    id: 'item-x',
    fields: {
      newsletter_slug: 'pub',
      original_subject: 'subj',
      original_sent_at: '2026-04-26T10:00:00.000Z',
      forward_note: 'note',
    },
  });
  await f.registerPeer({
    name: 'tf',
    metadata: {
      mirror_config: {
        source_inbox: 'mailroom',
        link_origin: 'https://smallstore.labspace.ai',
      },
    },
  });
  const { fetcher, calls } = buildMockFetcher();

  await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertStringIncludes(
    calls[0].body,
    '[View item →](https://smallstore.labspace.ai/inbox/mailroom/items/item-x)',
  );
});

// ---------------------------------------------------------------------
// Per-slug failure isolation
// ---------------------------------------------------------------------

Deno.test('mirror: one bad slug does not tank others', async () => {
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.seed({ id: 'b', fields: { newsletter_slug: 'pub-b', forward_note: 'b' } });
  await f.seed({ id: 'c', fields: { newsletter_slug: 'pub-c', forward_note: 'c' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  const { fetcher, calls } = buildMockFetcher({
    errorPaths: new Set(['/tf/pub-b.md']), // simulate per-slug failure
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results.length, 1);
  assertEquals(results[0].pushed, 2);
  assertEquals(results[0].failed.length, 1);
  assertEquals(results[0].failed[0].slug, 'pub-b');
  assertStringIncludes(results[0].failed[0].error, '500');
  // All three were attempted
  assertEquals(calls.length, 3);
});
