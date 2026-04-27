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
  /**
   * Existing files at the destination — what `GET <prefix>` returns when
   * the prune path lists the directory. Each entry becomes a
   * `{ name, path, isDirectory: false }` record. Default: empty (nothing
   * to prune). Pass an array of filenames to simulate previously-pushed
   * orphans the prune step should clean up.
   */
  existingFiles?: string[];
  /** When true, GET to directory paths returns 404 instead of empty list. */
  dirNotFound?: boolean;
} = {}): { fetcher: typeof fetch; calls: MockedFetchCall[] } {
  const calls: MockedFetchCall[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const pathname = new URL(url).pathname;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, headers, body });
    if (opts.errorPaths?.has(pathname)) {
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }
    // Directory listing — used by the prune step to find orphans.
    if (method === 'GET' && pathname.endsWith('/')) {
      if (opts.dirNotFound) return new Response('not found', { status: 404 });
      const entries = (opts.existingFiles ?? []).map((name) => ({
        name,
        path: `${pathname}${name}`,
        isDirectory: false,
      }));
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
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
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
  });
  await f.registerPeer({
    name: 'tf-b',
    url: 'https://tf-b.example.com',
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
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
    metadata: { mirror_config: { source_inbox: 'no-such-inbox', prune_orphans: false, include_recent: false } },
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
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
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
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
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
      mirror_config: { source_inbox: 'mailroom', include_index: true, prune_orphans: false, include_recent: false },
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
        target_path_prefix: '/scratch/mailroom-mirror/', prune_orphans: false, include_recent: false },
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
      mirror_config: { source_inbox: 'mailroom', target_path_prefix: '/folder', prune_orphans: false, include_recent: false },
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
        link_origin: 'https://smallstore.labspace.ai', prune_orphans: false, include_recent: false },
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
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
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

// ---------------------------------------------------------------------
// Recent feed — cross-publisher reading list
// ---------------------------------------------------------------------

Deno.test('mirror: emits recent.md by default with cross-publisher items', async () => {
  const f = await buildFixture();
  await f.seed({
    id: 'a',
    sent_at: new Date().toISOString(),
    fields: {
      newsletter_slug: 'pub-a',
      original_subject: 'Today A',
      original_sent_at: new Date().toISOString(),
    },
  });
  await f.seed({
    id: 'b',
    sent_at: new Date().toISOString(),
    fields: {
      newsletter_slug: 'pub-b',
      original_subject: 'Today B',
      original_sent_at: new Date().toISOString(),
    },
  });
  await f.registerPeer({
    name: 'tf',
    // recent defaults on; opt out of prune so we can assert on PUTs without
    // a directory listing GET muddying the call set.
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false } },
  });
  const { fetcher, calls } = buildMockFetcher();

  await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  const paths = calls.filter((c) => c.method === 'PUT').map((c) => new URL(c.url).pathname).sort();
  assertEquals(paths, ['/tf/pub-a.md', '/tf/pub-b.md', '/tf/recent.md']);
  const recent = calls.find((c) => c.url.endsWith('/recent.md'))!;
  assertStringIncludes(recent.body, 'Today A');
  assertStringIncludes(recent.body, 'Today B');
  assertStringIncludes(recent.body, '# Mailroom — recent');
});

Deno.test('mirror: include_recent: false skips recent.md', async () => {
  const f = await buildFixture();
  await f.seed({
    id: 'a',
    sent_at: new Date().toISOString(),
    fields: { newsletter_slug: 'pub-a', original_sent_at: new Date().toISOString() },
  });
  await f.registerPeer({
    name: 'tf',
    metadata: {
      mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false },
    },
  });
  const { fetcher, calls } = buildMockFetcher();

  await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  const paths = calls.filter((c) => c.method === 'PUT').map((c) => new URL(c.url).pathname);
  assertEquals(paths.includes('/tf/recent.md'), false);
});

Deno.test('mirror: prune does NOT delete recent.md (it is part of the active set)', async () => {
  const f = await buildFixture();
  await f.seed({
    id: 'a',
    sent_at: new Date().toISOString(),
    fields: { newsletter_slug: 'pub-a', original_sent_at: new Date().toISOString() },
  });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } }, // prune on, recent on
  });
  const { fetcher, calls } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'recent.md', 'orphan.md'],
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  // Only orphan.md should be pruned; recent.md is kept.
  assertEquals(results[0].pruned, ['orphan.md']);
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname);
  assertEquals(deletes, ['/tf/orphan.md']);
});

// ---------------------------------------------------------------------
// Prune (orphan garbage collection) — default-on cleanup
// ---------------------------------------------------------------------

Deno.test('prune: deletes orphan .md files at the destination', async () => {
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } }, // prune defaults on
  });
  // Destination already has two stale files from a prior run.
  const { fetcher, calls } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'old-pub.md', 'gone-pub.md'],
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  // pub-a is active → not pruned. The other two have no live items → deleted.
  assertEquals(results[0].pruned?.sort(), ['gone-pub.md', 'old-pub.md']);
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname);
  assertEquals(deletes.sort(), ['/tf/gone-pub.md', '/tf/old-pub.md']);
});

Deno.test('prune: preserves index.md when include_index is set', async () => {
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom', include_index: true } },
  });
  const { fetcher } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'index.md', 'orphan.md'],
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  // index.md stays, orphan goes
  assertEquals(results[0].pruned, ['orphan.md']);
});

Deno.test('prune: deletes index.md as orphan when include_index is NOT set', async () => {
  // Edge case: a previous mirror run had include_index, then config changed.
  // The leftover index.md becomes an orphan and should be cleaned.
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } }, // no include_index
  });
  const { fetcher } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'index.md'],
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results[0].pruned, ['index.md']);
});

Deno.test('prune: opt-out via prune_orphans: false', async () => {
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom', prune_orphans: false, include_recent: false } },
  });
  const { fetcher, calls } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'orphan.md'],
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results[0].pruned, undefined); // didn't run
  // No GET on the directory, no DELETE on anything.
  assertEquals(calls.filter((c) => c.method === 'DELETE').length, 0);
  assertEquals(calls.filter((c) => c.method === 'GET').length, 0);
});

Deno.test('prune: ignores non-.md files at the destination', async () => {
  // The mirror only owns .md files; binary or other content in the same
  // directory is left alone.
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom' } },
  });
  const { fetcher, calls } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'shopping.list', 'image.png', 'README.txt'],
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results[0].pruned, []); // nothing to prune
  assertEquals(calls.filter((c) => c.method === 'DELETE').length, 0);
});

Deno.test('prune: 404 on listing → skipped gracefully (first run, no dir yet)', async () => {
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom', include_recent: false } },
  });
  const { fetcher } = buildMockFetcher({ dirNotFound: true });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  // Push still happens; prune ran but found an empty directory.
  assertEquals(results[0].pushed, 1);
  assertEquals(results[0].pruned, []);
  assertEquals(results[0].prune_error, undefined);
});

Deno.test('prune: failed delete recorded in failed[], does not tank push', async () => {
  const f = await buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', forward_note: 'a' } });
  await f.registerPeer({
    name: 'tf',
    metadata: { mirror_config: { source_inbox: 'mailroom', include_recent: false } },
  });
  const { fetcher } = buildMockFetcher({
    existingFiles: ['pub-a.md', 'cursed.md'],
    errorPaths: new Set(['/tf/cursed.md']), // DELETE returns 500
  });

  const results = await runMirror({
    registry: f.registry,
    peerStore: f.peerStore,
    env: { TF_TOKEN: 'secret' },
    fetcher,
  });

  assertEquals(results[0].pushed, 1);
  assertEquals(results[0].pruned, []); // delete failed, not counted as pruned
  assertEquals(results[0].failed.length, 1);
  assertStringIncludes(results[0].failed[0].slug, '__prune:cursed.md');
});
