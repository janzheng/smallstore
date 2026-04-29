/**
 * Sprint 3 HTTP integration tests for the spam-stats endpoints:
 *   - GET  /inbox/:name/spam-stats
 *   - POST /inbox/:name/spam-stats/promote-rule
 *
 * Uses the same MemoryAdapter-backed Hono fixture as
 * tests/messaging-spam-triage.test.ts (Sprint 1).
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import {
  createSenderIndex,
  type SenderIndex,
  type SenderRecord,
} from '../src/messaging/sender-index.ts';
import { createRulesStore, type RulesStore } from '../src/messaging/rules.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

interface Fixture {
  app: Hono;
  registry: InboxRegistry;
  inbox: ReturnType<typeof createInbox>;
  senderIndex: SenderIndex;
  rulesStore: RulesStore;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildFixture(
  opts: { wireSenderIndex?: boolean; wireRulesStore?: boolean } = {},
): Fixture {
  const wireSenderIndex = opts.wireSenderIndex !== false;
  const wireRulesStore = opts.wireRulesStore !== false;

  const itemsAdapter = new MemoryAdapter();
  const senderAdapter = new MemoryAdapter();
  const rulesAdapter = new MemoryAdapter();

  const inbox = createInbox({
    name: 'mailroom',
    channel: 'cf-email',
    storage: { items: itemsAdapter },
  });
  const senderIndex = createSenderIndex(senderAdapter);
  const rulesStore = createRulesStore(rulesAdapter);

  const registry = new InboxRegistry();
  const config: InboxConfig = { channel: 'cf-email', storage: 'items' };
  registry.register('mailroom', inbox, config, 'boot');

  const requireAuth = (_c: Context, next: Next) => next();
  const buildInbox = async () => inbox;

  const app = new Hono();
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInbox,
    senderIndexFor: wireSenderIndex ? () => senderIndex : undefined,
    rulesStoreFor: wireRulesStore ? () => rulesStore : undefined,
  });

  return {
    app,
    registry,
    inbox,
    senderIndex,
    rulesStore,
    fetch: (path, init) => app.fetch(new Request(`http://localhost${path}`, init)),
  };
}

async function seed(senderIndex: SenderIndex, records: Partial<SenderRecord>[]): Promise<void> {
  for (const r of records) {
    await senderIndex.setRecord({
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
    });
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ============================================================================
// GET /inbox/:name/spam-stats
// ============================================================================

Deno.test('GET spam-stats — returns four lists and the inbox name', async () => {
  const fx = buildFixture();
  await seed(fx.senderIndex, [
    { address: 'spammy@x.com', count: 10, spam_count: 8, not_spam_count: 2, marked_at: '2026-04-25T00:00:00Z' },
    { address: 'good@x.com', count: 5, spam_count: 0, not_spam_count: 4 },
  ]);

  const res = await fx.fetch('/inbox/mailroom/spam-stats');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.inbox, 'mailroom');
  assert(Array.isArray(body.senders_top_spam));
  assert(Array.isArray(body.senders_recently_marked));
  assert(Array.isArray(body.suggested_blocklist));
  assert(Array.isArray(body.suggested_whitelist));
  assertEquals(body.senders_top_spam[0].address, 'spammy@x.com');
  assertEquals(body.suggested_blocklist[0].address, 'spammy@x.com');
  assertEquals(body.suggested_whitelist[0].address, 'good@x.com');
});

Deno.test('GET spam-stats — empty index returns four empty lists', async () => {
  const fx = buildFixture();
  const res = await fx.fetch('/inbox/mailroom/spam-stats');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.senders_top_spam, []);
  assertEquals(body.senders_recently_marked, []);
  assertEquals(body.suggested_blocklist, []);
  assertEquals(body.suggested_whitelist, []);
});

Deno.test('GET spam-stats — window_days query param honored', async () => {
  const fx = buildFixture();
  await seed(fx.senderIndex, [
    { address: 'a@x.com', spam_count: 1, marked_at: '2026-04-26T00:00:00Z' },
    { address: 'b@x.com', spam_count: 1, marked_at: '2026-03-01T00:00:00Z' },
  ]);

  const wide = await fx.fetch('/inbox/mailroom/spam-stats?window_days=90');
  const wideBody = await wide.json();
  assertEquals(wideBody.senders_recently_marked.length, 2);

  const narrow = await fx.fetch('/inbox/mailroom/spam-stats?window_days=7');
  const narrowBody = await narrow.json();
  assertEquals(narrowBody.senders_recently_marked.length, 1);
  assertEquals(narrowBody.senders_recently_marked[0].address, 'a@x.com');
});

Deno.test('GET spam-stats — limit query param caps each list', async () => {
  const fx = buildFixture();
  const seeds: Partial<SenderRecord>[] = [];
  for (let i = 0; i < 8; i++) {
    seeds.push({ address: `s${i}@x.com`, count: 5, spam_count: 4, not_spam_count: 1 });
  }
  await seed(fx.senderIndex, seeds);

  const res = await fx.fetch('/inbox/mailroom/spam-stats?limit=3');
  const body = await res.json();
  assertEquals(body.senders_top_spam.length, 3);
  assertEquals(body.suggested_blocklist.length, 3);
});

Deno.test('GET spam-stats — 501 when senderIndexFor not wired', async () => {
  const fx = buildFixture({ wireSenderIndex: false });
  const res = await fx.fetch('/inbox/mailroom/spam-stats');
  assertEquals(res.status, 501);
});

Deno.test('GET spam-stats — 404 for unknown inbox', async () => {
  const fx = buildFixture();
  const res = await fx.fetch('/inbox/nonexistent/spam-stats');
  assertEquals(res.status, 404);
});

// ============================================================================
// POST /inbox/:name/spam-stats/promote-rule
// ============================================================================

Deno.test('POST promote-rule — blocklist creates priority-100 quarantine rule', async () => {
  const fx = buildFixture();
  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ sender: 'spammy@x.com', kind: 'blocklist' }),
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.created.action, 'quarantine');
  assertEquals(body.created.priority, 100);
  assertEquals(body.created.match.from_email, 'spammy@x.com');
  assert(typeof body.created.id === 'string');
  // Quarantine is terminal — applyRetroactive is a no-op + returns an error string.
  assertEquals(body.items_affected, 0);
});

Deno.test('POST promote-rule — whitelist creates priority-0 trusted-tag rule', async () => {
  const fx = buildFixture();
  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ sender: 'curator@x.com', kind: 'whitelist' }),
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.created.action, 'tag');
  assertEquals(body.created.action_args.tag, 'trusted');
  assertEquals(body.created.priority, 0);
  assertEquals(body.created.match.from_email, 'curator@x.com');
});

Deno.test('POST promote-rule — whitelist runs retroactive apply (items_affected)', async () => {
  const fx = buildFixture();
  // Ingest two items from curator@x.com so applyRetroactive has work to do.
  await fx.inbox._ingest({
    id: 'i1',
    source: 'cf-email',
    received_at: '2026-04-28T10:00:00Z',
    summary: 'test',
    body: null,
    fields: { from_email: 'curator@x.com' },
    labels: [],
  } as InboxItem);
  await fx.inbox._ingest({
    id: 'i2',
    source: 'cf-email',
    received_at: '2026-04-28T11:00:00Z',
    summary: 'test 2',
    body: null,
    fields: { from_email: 'curator@x.com' },
    labels: [],
  } as InboxItem);

  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ sender: 'curator@x.com', kind: 'whitelist' }),
  );
  const body = await res.json();
  assertEquals(body.items_affected, 2);

  // Verify the items now carry the 'trusted' label.
  const i1 = await fx.inbox.read('i1');
  assert(i1!.labels?.includes('trusted'));
});

Deno.test('POST promote-rule — invalid kind returns 400', async () => {
  const fx = buildFixture();
  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ sender: 'a@x.com', kind: 'graylist' }),
  );
  assertEquals(res.status, 400);
});

Deno.test('POST promote-rule — missing sender returns 400', async () => {
  const fx = buildFixture();
  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ kind: 'blocklist' }),
  );
  assertEquals(res.status, 400);
});

Deno.test('POST promote-rule — sender lowercased before storage', async () => {
  const fx = buildFixture();
  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ sender: 'MIXEDcase@X.COM', kind: 'blocklist' }),
  );
  const body = await res.json();
  assertEquals(body.created.match.from_email, 'mixedcase@x.com');
});

Deno.test('POST promote-rule — 501 when rulesStoreFor not wired', async () => {
  const fx = buildFixture({ wireRulesStore: false });
  const res = await fx.fetch(
    '/inbox/mailroom/spam-stats/promote-rule',
    json({ sender: 'a@x.com', kind: 'blocklist' }),
  );
  assertEquals(res.status, 501);
});
