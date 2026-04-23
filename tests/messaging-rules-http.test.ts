/**
 * Messaging — rules HTTP integration tests.
 *
 * Boots a Hono app with the messaging routes + a `rulesStoreFor` resolver
 * wired against a MemoryAdapter, then exercises the full rules surface:
 *   GET /inbox/:name/rules           — list (+ 404 when missing rule id)
 *   POST /inbox/:name/rules          — create (+ ?apply_retroactive=true)
 *   GET /inbox/:name/rules/:id       — single read
 *   PUT /inbox/:name/rules/:id       — update
 *   DELETE /inbox/:name/rules/:id    — delete
 *   POST /inbox/:name/rules/:id/apply-retroactive
 *   501 when rulesStoreFor absent
 *   401 when bearer token missing
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createRulesStore, type RulesStore } from '../src/messaging/rules.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Fixtures
// ============================================================================

interface Fixture {
  app: Hono;
  registry: InboxRegistry;
  rulesByInbox: Record<string, RulesStore>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  seedItem: (inbox: string, item: Partial<InboxItem>) => Promise<void>;
}

function buildApp(opts: {
  token?: string;
  inboxes?: Record<string, InboxConfig>;
  withRulesStore?: boolean;
} = {}): Fixture {
  const itemsAdapter = new MemoryAdapter();
  const blobsAdapter = new MemoryAdapter();
  const registry = new InboxRegistry();
  const rulesByInbox: Record<string, RulesStore> = {};

  const requireAuth = (c: Context, next: Next) => {
    if (!opts.token) return next();
    const header = c.req.header('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== opts.token) {
      return c.json({ error: 'Unauthorized', message: 'Bad token' }, 401);
    }
    return next();
  };

  const buildInbox = async (name: string, cfg: InboxConfig) =>
    createInbox({ name, channel: cfg.channel, storage: { items: itemsAdapter, blobs: blobsAdapter } });

  if (opts.inboxes) {
    for (const [name, cfg] of Object.entries(opts.inboxes)) {
      const inbox = createInbox({ name, channel: cfg.channel, storage: { items: itemsAdapter, blobs: blobsAdapter } });
      registry.register(name, inbox, cfg, 'boot');
      if (opts.withRulesStore !== false) {
        let counter = 0;
        rulesByInbox[name] = createRulesStore(new MemoryAdapter(), {
          generateId: () => `rule-${name}-${String(++counter).padStart(3, '0')}`,
        });
      }
    }
  }

  const app = new Hono();
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInbox,
    rulesStoreFor: opts.withRulesStore === false ? undefined : (name) => rulesByInbox[name] ?? null,
  });

  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  const seedItem = async (inboxName: string, item: Partial<InboxItem>) => {
    const inbox = registry.get(inboxName);
    if (!inbox) throw new Error(`no inbox ${inboxName}`);
    const full: InboxItem = {
      id: item.id ?? 'seed-' + Math.random().toString(36).slice(2, 8),
      source: item.source ?? 'cf-email',
      received_at: item.received_at ?? '2026-04-22T12:00:00Z',
      summary: item.summary ?? 'seeded',
      body: item.body ?? 'body',
      fields: { from_email: 'sender@example.com', ...(item.fields ?? {}) },
      labels: item.labels,
      thread_id: item.thread_id,
    };
    await inbox._ingest(full);
  };

  return { app, registry, rulesByInbox, fetch, seedItem };
}

function jsonHeaders(extra: HeadersInit = {}): HeadersInit {
  return { 'content-type': 'application/json', ...(extra as Record<string, string>) };
}

function authHeaders(token: string, extra: HeadersInit = {}): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(extra as Record<string, string>) };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test('rules-http — POST /rules creates a rule, returns 201 with id', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { fields: { from_email: 'news@annoying.com' } },
      action: 'archive',
      priority: 100,
    }),
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  assertExists(body.created);
  assertExists(body.created.id);
  assertEquals(body.created.action, 'archive');
  assertEquals(body.created.priority, 100);
});

Deno.test('rules-http — POST /rules?apply_retroactive=true returns retroactive count', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  // Seed 3 matching + 1 non-matching items before creating the rule.
  for (let i = 0; i < 3; i++) {
    await fx.seedItem('mailroom', {
      id: `m${i}`,
      received_at: `2026-04-22T12:0${i}:00Z`,
      fields: { from_email: 'news@annoying.com' },
    });
  }
  await fx.seedItem('mailroom', {
    id: 'other',
    received_at: '2026-04-22T13:00:00Z',
    fields: { from_email: 'ok@example.com' },
  });

  const res = await fx.fetch('/inbox/mailroom/rules?apply_retroactive=true', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { fields: { from_email: 'news@annoying.com' } },
      action: 'tag',
      action_args: { tag: 'read-later' },
      priority: 100,
    }),
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  assertExists(body.created);
  assertExists(body.retroactive);
  assertEquals(body.retroactive.affected, 3);
});

Deno.test('rules-http — GET /rules lists; GET /rules/:id returns 404 when missing', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  // Create 2 rules
  await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { labels: ['spam'] },
      action: 'quarantine',
      priority: 10,
    }),
  });
  await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { labels: ['promo'] },
      action: 'archive',
      priority: 100,
    }),
  });

  const list = await fx.fetch('/inbox/mailroom/rules');
  assertEquals(list.status, 200);
  const listBody = await list.json();
  assertEquals(listBody.rules.length, 2);

  const miss = await fx.fetch('/inbox/mailroom/rules/nope-nope');
  assertEquals(miss.status, 404);
});

Deno.test('rules-http — PUT /rules/:id updates a rule', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const create = await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { labels: ['promo'] },
      action: 'archive',
      priority: 100,
    }),
  });
  const { created } = await create.json();

  const put = await fx.fetch(`/inbox/mailroom/rules/${created.id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({ priority: 5, notes: 'urgent' }),
  });
  assertEquals(put.status, 200);
  const body = await put.json();
  assertEquals(body.updated.id, created.id);
  assertEquals(body.updated.priority, 5);
  assertEquals(body.updated.notes, 'urgent');
  assertExists(body.updated.updated_at);
});

Deno.test('rules-http — PUT on unknown id returns 404', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/rules/missing', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({ priority: 1 }),
  });
  assertEquals(res.status, 404);
});

Deno.test('rules-http — DELETE /rules/:id deletes; 404 on missing', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const create = await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { labels: ['promo'] },
      action: 'archive',
      priority: 100,
    }),
  });
  const { created } = await create.json();

  const del = await fx.fetch(`/inbox/mailroom/rules/${created.id}`, { method: 'DELETE' });
  assertEquals(del.status, 200);
  const delBody = await del.json();
  assertEquals(delBody.deleted, created.id);

  const again = await fx.fetch(`/inbox/mailroom/rules/${created.id}`, { method: 'DELETE' });
  assertEquals(again.status, 404);
});

Deno.test('rules-http — POST /rules/:id/apply-retroactive returns affected count', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  // Seed items first
  for (let i = 0; i < 2; i++) {
    await fx.seedItem('mailroom', {
      id: `m${i}`,
      received_at: `2026-04-22T12:0${i}:00Z`,
      fields: { from_email: 'news@annoying.com' },
    });
  }

  // Create rule WITHOUT apply_retroactive
  const create = await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { fields: { from_email: 'news@annoying.com' } },
      action: 'archive',
      priority: 100,
    }),
  });
  const { created } = await create.json();

  // Then apply-retroactive separately.
  const res = await fx.fetch(`/inbox/mailroom/rules/${created.id}/apply-retroactive`, {
    method: 'POST',
    headers: jsonHeaders(),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.affected, 2);
  assertEquals(body.rule_id, created.id);
});

Deno.test('rules-http — 501 when rulesStoreFor resolver is absent', async () => {
  const fx = buildApp({
    inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } },
    withRulesStore: false,
  });
  const res = await fx.fetch('/inbox/mailroom/rules');
  assertEquals(res.status, 501);
  const body = await res.json();
  assertEquals(body.error, 'NotImplemented');
});

Deno.test('rules-http — auth: requests without bearer token are rejected', async () => {
  const fx = buildApp({
    token: 'sekret',
    inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } },
  });

  const noAuth = await fx.fetch('/inbox/mailroom/rules');
  assertEquals(noAuth.status, 401);

  const badAuth = await fx.fetch('/inbox/mailroom/rules', {
    headers: { Authorization: 'Bearer wrong' },
  });
  assertEquals(badAuth.status, 401);

  const ok = await fx.fetch('/inbox/mailroom/rules', { headers: authHeaders('sekret') });
  assertEquals(ok.status, 200);
});

Deno.test('rules-http — POST rejects malformed body (missing action)', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ match: { labels: ['spam'] } }),
  });
  assertEquals(res.status, 400);
});

Deno.test('rules-http — POST rejects invalid action verb', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/rules', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      match: { labels: ['spam'] },
      action: 'yeet',
    }),
  });
  assertEquals(res.status, 400);
});
