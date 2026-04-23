/**
 * Messaging — HTTP integration tests.
 *
 * Boots a Hono app with the messaging routes wired against a memory-backed
 * inbox, then exercises the routes via app.fetch() (no real socket needed).
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Test fixtures
// ============================================================================

interface Fixture {
  app: Hono;
  registry: InboxRegistry;
  adapters: Record<string, MemoryAdapter>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildApp(opts: { token?: string; inboxes?: Record<string, InboxConfig> } = {}): Fixture {
  const adapters: Record<string, MemoryAdapter> = {
    items: new MemoryAdapter(),
    blobs: new MemoryAdapter(),
  };
  const registry = new InboxRegistry();

  const requireAuth = (c: Context, next: Next) => {
    if (!opts.token) return next();
    const header = c.req.header('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== opts.token) {
      return c.json({ error: 'Unauthorized', message: 'Bad token' }, 401);
    }
    return next();
  };

  const buildInbox = async (name: string, cfg: InboxConfig) => {
    return createInbox({
      name,
      channel: cfg.channel,
      storage: { items: adapters.items, blobs: adapters.blobs },
    });
  };

  if (opts.inboxes) {
    for (const [name, cfg] of Object.entries(opts.inboxes)) {
      // synchronous register because buildInbox here is in-memory
      const inbox = createInbox({ name, channel: cfg.channel, storage: { items: adapters.items, blobs: adapters.blobs } });
      registry.register(name, inbox, cfg, 'boot');
    }
  }

  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });

  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  return { app, registry, adapters, fetch };
}

function authHeaders(token: string, extra: HeadersInit = {}): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(extra as Record<string, string>) };
}

function jsonHeaders(extra: HeadersInit = {}): HeadersInit {
  return { 'content-type': 'application/json', ...(extra as Record<string, string>) };
}

function makeItem(id: string, receivedAt: string, fields: Record<string, any> = {}): InboxItem {
  return {
    id,
    source: 'cf-email',
    received_at: receivedAt,
    summary: `Subject ${id}`,
    body: `Body for ${id}`,
    fields: { from_email: 'sender@example.com', ...fields },
  };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test('http — POST /inbox/:name/items ingests, GET retrieves', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });

  const post = await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(makeItem('a1', '2026-04-22T12:00:00Z')),
  });
  assertEquals(post.status, 200);

  const list = await fx.fetch('/inbox/mailroom');
  assertEquals(list.status, 200);
  const listBody = await list.json();
  assertEquals(listBody.inbox, 'mailroom');
  assertEquals(listBody.items.length, 1);
  assertEquals(listBody.items[0].id, 'a1');
});

Deno.test('http — GET /inbox/:name/items/:id returns single item', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(makeItem('xyz', '2026-04-22T12:00:00Z')),
  });

  const res = await fx.fetch('/inbox/mailroom/items/xyz');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.item.id, 'xyz');
  assertEquals(body.item.summary, 'Subject xyz');
});

Deno.test('http — GET unknown item returns 404', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/items/nope');
  assertEquals(res.status, 404);
});

Deno.test('http — GET unknown inbox returns 404', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/missing');
  assertEquals(res.status, 404);
});

Deno.test('http — POST /inbox/:name/query filters items', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  for (const id of ['a', 'b', 'c']) {
    await fx.fetch('/inbox/mailroom/items', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(makeItem(id, `2026-04-22T12:0${id.charCodeAt(0)}:00Z`, {
        from_email: id === 'b' ? 'special@example.com' : 'normal@example.com',
      })),
    });
  }

  const res = await fx.fetch('/inbox/mailroom/query', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ filter: { fields: { from_email: 'special' } } }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].id, 'b');
});

Deno.test('http — POST /query accepts bare filter (no `filter:` wrapper)', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(makeItem('a', '2026-04-22T12:00:00Z')),
  });

  const res = await fx.fetch('/inbox/mailroom/query', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ fields: { from_email: 'sender' } }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
});

Deno.test('http — GET /inbox/:name/cursor returns head watermark', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(makeItem('a', '2026-04-22T12:00:00Z')),
  });
  const res = await fx.fetch('/inbox/mailroom/cursor');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.cursor);
  assertEquals(typeof body.cursor, 'string');
});

Deno.test('http — list pagination via cursor query param', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  for (let i = 0; i < 5; i++) {
    await fx.fetch('/inbox/mailroom/items', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(makeItem(`m${i}`, `2026-04-22T12:0${i}:00Z`)),
    });
  }
  const page1 = await fx.fetch('/inbox/mailroom?limit=2');
  const p1 = await page1.json();
  assertEquals(p1.items.length, 2);
  assertExists(p1.next_cursor);

  const page2 = await fx.fetch(`/inbox/mailroom?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`);
  const p2 = await page2.json();
  assertEquals(p2.items.length, 2);

  // No id overlap between pages
  const ids1 = new Set(p1.items.map((i: InboxItem) => i.id));
  for (const it of p2.items) assertEquals(ids1.has(it.id), false);
});

Deno.test('http — POST /inbox rejects malformed body', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/items', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ id: 'x' }), // missing source, received_at, fields
  });
  assertEquals(res.status, 400);
});

Deno.test('http — auth: requests without bearer token are rejected', async () => {
  const fx = buildApp({ token: 'sekret', inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const noAuth = await fx.fetch('/inbox/mailroom');
  assertEquals(noAuth.status, 401);

  const badAuth = await fx.fetch('/inbox/mailroom', {
    headers: { Authorization: 'Bearer wrong' },
  });
  assertEquals(badAuth.status, 401);

  const ok = await fx.fetch('/inbox/mailroom', {
    headers: authHeaders('sekret'),
  });
  assertEquals(ok.status, 200);
});

// ============================================================================
// Admin routes
// ============================================================================

Deno.test('admin — POST /admin/inboxes creates a runtime inbox', async () => {
  const fx = buildApp();

  const create = await fx.fetch('/admin/inboxes', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ name: 'adhoc', channel: 'cf-email', storage: 'items' }),
  });
  assertEquals(create.status, 201);
  const body = await create.json();
  assertEquals(body.created.name, 'adhoc');
  assertEquals(body.created.origin, 'runtime');

  // The new inbox is now reachable via the regular inbox surface
  const post = await fx.fetch('/inbox/adhoc/items', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(makeItem('one', '2026-04-22T12:00:00Z')),
  });
  assertEquals(post.status, 200);
});

Deno.test('admin — GET /admin/inboxes lists all registrations', async () => {
  const fx = buildApp({
    inboxes: {
      a: { channel: 'cf-email', storage: 'items' },
      b: { channel: 'webhook', storage: 'items' },
    },
  });
  const res = await fx.fetch('/admin/inboxes');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.inboxes.length, 2);
  const names = body.inboxes.map((i: any) => i.name).sort();
  assertEquals(names, ['a', 'b']);
});

Deno.test('admin — GET /admin/inboxes/:name returns the registration', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/admin/inboxes/mailroom');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.name, 'mailroom');
  assertEquals(body.channel, 'cf-email');
  assertEquals(body.origin, 'boot');
  assertExists(body.created_at);
});

Deno.test('admin — DELETE /admin/inboxes/:name removes the inbox', async () => {
  const fx = buildApp({ inboxes: { tmp: { channel: 'cf-email', storage: 'items' } } });
  const del = await fx.fetch('/admin/inboxes/tmp', { method: 'DELETE' });
  assertEquals(del.status, 200);

  const after = await fx.fetch('/inbox/tmp');
  assertEquals(after.status, 404);
});

Deno.test('admin — POST /admin/inboxes rejects duplicate names', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/admin/inboxes', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ name: 'mailroom', channel: 'cf-email', storage: 'items' }),
  });
  assertEquals(res.status, 409);
});

Deno.test('admin — POST /admin/inboxes rejects malformed body', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/inboxes', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ channel: 'cf-email' }), // missing name + storage
  });
  assertEquals(res.status, 400);
});

Deno.test('admin — GET /admin/channels returns registered channels', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/channels');
  assertEquals(res.status, 200);
  const body = await res.json();
  // No channels registered in this test (Phase 4 adds cf-email channel)
  assertEquals(Array.isArray(body.channels), true);
});

// ============================================================================
// Export — bulk newsletter download endpoint
// ============================================================================

async function seedInbox(fx: Fixture, count: number, opts: { with_body_ref?: boolean } = {}) {
  const inbox = fx.registry.get('mailroom');
  if (!inbox) throw new Error('no mailroom inbox registered');
  for (let i = 0; i < count; i++) {
    const id = `item-${String(i).padStart(3, '0')}`;
    const labels = i % 3 === 0 ? ['newsletter'] : [];
    const item: InboxItem = {
      id,
      source: 'cf-email',
      received_at: new Date(Date.UTC(2026, 3, 24, 10, i, 0)).toISOString(),
      summary: `Subject ${i}`,
      body: opts.with_body_ref ? null : `Body for ${i}`,
      body_ref: opts.with_body_ref ? `bodies/${id}.txt` : undefined,
      fields: { from_email: i % 2 === 0 ? 'news@substack.com' : 'other@example.com' },
      labels,
    };
    if (opts.with_body_ref) {
      await fx.adapters.blobs.set(`bodies/${id}.txt`, `Inflated body ${i}`);
    }
    await inbox._ingest(item);
  }
}

Deno.test('export — JSONL format streams one item per line', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 5);

  const res = await fx.fetch('/inbox/mailroom/export');
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type')?.startsWith('application/x-ndjson'), true);

  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.length > 0);
  assertEquals(lines.length, 5);
  const first = JSON.parse(lines[0]);
  assertEquals(typeof first.id, 'string');
  assertEquals(typeof first.summary, 'string');
});

Deno.test('export — format=json returns a single array', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 3);

  const res = await fx.fetch('/inbox/mailroom/export?format=json');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.count, 3);
  assertEquals(Array.isArray(body.items), true);
  assertEquals(body.items.length, 3);
});

Deno.test('export — filter narrows to newsletter label', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 10);

  const filter = encodeURIComponent(JSON.stringify({ labels: ['newsletter'] }));
  const res = await fx.fetch(`/inbox/mailroom/export?format=json&filter=${filter}`);
  assertEquals(res.status, 200);
  const body = await res.json();
  // 10 items seeded; every 3rd gets 'newsletter' label → items 0, 3, 6, 9 = 4
  assertEquals(body.count, 4);
  for (const item of body.items) {
    assertEquals(item.labels?.includes('newsletter'), true);
  }
});

Deno.test('export — filter with regex operator matches sender domain', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 10);

  const filter = encodeURIComponent(JSON.stringify({
    fields_regex: { from_email: '^news@' },
  }));
  const res = await fx.fetch(`/inbox/mailroom/export?format=json&filter=${filter}`);
  assertEquals(res.status, 200);
  const body = await res.json();
  // 10 items; even-indexed ones use 'news@substack.com' = 5 matches
  assertEquals(body.count, 5);
});

Deno.test('export — limit caps total items returned', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 20);

  const res = await fx.fetch('/inbox/mailroom/export?format=json&limit=7');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.count, 7);
});

Deno.test('export — include=body inflates body_ref from blobs adapter', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 3, { with_body_ref: true });

  const res = await fx.fetch('/inbox/mailroom/export?format=json&include=body');
  assertEquals(res.status, 200);
  const body = await res.json();
  for (const item of body.items) {
    assertEquals(typeof item.body, 'string');
    assertEquals(item.body.startsWith('Inflated body'), true);
    // body_inflated field is stripped — body replaces it
    assertEquals(item.body_inflated, undefined);
  }
});

Deno.test('export — without include=body, body_ref stays as reference', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  await seedInbox(fx, 3, { with_body_ref: true });

  const res = await fx.fetch('/inbox/mailroom/export?format=json');
  assertEquals(res.status, 200);
  const body = await res.json();
  for (const item of body.items) {
    assertEquals(typeof item.body_ref, 'string');
    assertEquals(item.body, null);
  }
});

Deno.test('export — bad filter JSON returns 400', async () => {
  const fx = buildApp({ inboxes: { mailroom: { channel: 'cf-email', storage: 'items' } } });
  const res = await fx.fetch('/inbox/mailroom/export?filter=not-json');
  assertEquals(res.status, 400);
});

Deno.test('export — unknown inbox returns 404', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/nope/export');
  assertEquals(res.status, 404);
});
