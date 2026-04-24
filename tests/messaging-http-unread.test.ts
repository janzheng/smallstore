/**
 * Mark-read HTTP endpoint tests — exercises the /read, /unread,
 * /read-all, and /items/:id/(un)read routes against an in-memory
 * inbox wired through the full Hono stack.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Fixture
// ============================================================================

function buildApp() {
  const adapters = { items: new MemoryAdapter(), blobs: new MemoryAdapter() };
  const registry = new InboxRegistry();

  const requireAuth = (_c: Context, next: Next) => next();

  const buildInbox = async (name: string, cfg: InboxConfig) =>
    createInbox({ name, channel: cfg.channel, storage: { items: adapters.items, blobs: adapters.blobs } });

  const cfg: InboxConfig = { channel: 'cf-email', storage: 'items' };
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items: adapters.items, blobs: adapters.blobs } });
  registry.register('mailroom', inbox, cfg, 'boot');

  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });

  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  return { app, registry, inbox, fetch };
}

function makeItem(id: string, labels: string[] = []): InboxItem {
  return {
    id,
    source: 'cf-email',
    received_at: '2026-04-24T12:00:00Z',
    summary: `Subject ${id}`,
    body: null,
    fields: { from_email: `${id}@example.com` },
    labels,
  };
}

async function seed(fx: ReturnType<typeof buildApp>, items: InboxItem[]) {
  for (const item of items) {
    await fx.inbox._ingest(item);
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// ============================================================================
// Single-item mark-read
// ============================================================================

Deno.test('http mark-read — /read strips `unread`', async () => {
  const fx = buildApp();
  await seed(fx, [makeItem('a', ['unread', 'newsletter'])]);

  const res = await fx.fetch('/inbox/mailroom/items/a/read', { method: 'POST' });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.changed, true);
  assertEquals(body.item.labels, ['newsletter']);
});

Deno.test('http mark-read — idempotent on already-read item', async () => {
  const fx = buildApp();
  await seed(fx, [makeItem('a', ['newsletter'])]);

  const res = await fx.fetch('/inbox/mailroom/items/a/read', { method: 'POST' });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.changed, false);
  assertEquals(body.item.labels, ['newsletter']);
});

Deno.test('http mark-read — removes label entirely when unread was the only one', async () => {
  const fx = buildApp();
  await seed(fx, [makeItem('a', ['unread'])]);

  const res = await fx.fetch('/inbox/mailroom/items/a/read', { method: 'POST' });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.changed, true);
  // Either undefined or empty array is acceptable — both signal "no labels".
  assert(!body.item.labels || body.item.labels.length === 0);
});

Deno.test('http mark-read — 404 on unknown item', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/mailroom/items/missing/read', { method: 'POST' });
  assertEquals(res.status, 404);
});

Deno.test('http mark-read — 404 on unknown inbox', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/nope/items/a/read', { method: 'POST' });
  assertEquals(res.status, 404);
});

// ============================================================================
// Single-item mark-unread
// ============================================================================

Deno.test('http mark-unread — /unread re-adds `unread`', async () => {
  const fx = buildApp();
  await seed(fx, [makeItem('a', ['newsletter'])]);

  const res = await fx.fetch('/inbox/mailroom/items/a/unread', { method: 'POST' });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.changed, true);
  assertEquals(new Set(body.item.labels), new Set(['newsletter', 'unread']));
});

Deno.test('http mark-unread — idempotent on already-unread', async () => {
  const fx = buildApp();
  await seed(fx, [makeItem('a', ['unread', 'newsletter'])]);

  const res = await fx.fetch('/inbox/mailroom/items/a/unread', { method: 'POST' });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.changed, false);
});

Deno.test('http mark-unread — 404 on unknown item', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/mailroom/items/missing/unread', { method: 'POST' });
  assertEquals(res.status, 404);
});

// ============================================================================
// Bulk by ids
// ============================================================================

Deno.test('http bulk-read — marks each id, reports changed + missing', async () => {
  const fx = buildApp();
  await seed(fx, [
    makeItem('a', ['unread']),
    makeItem('b', ['unread', 'newsletter']),
    makeItem('c', ['newsletter']), // already read
  ]);

  const res = await fx.fetch('/inbox/mailroom/read', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids: ['a', 'b', 'c', 'missing-id'] }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total, 4);
  assertEquals(body.changed, 2); // a + b
  assertEquals(body.missing, ['missing-id']);
});

Deno.test('http bulk-read — empty ids array → 400', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/mailroom/read', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids: [] }),
  });
  assertEquals(res.status, 400);
});

Deno.test('http bulk-read — non-string in ids → 400', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/inbox/mailroom/read', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids: ['ok', 42] }),
  });
  assertEquals(res.status, 400);
});

// ============================================================================
// Bulk by filter (read-all)
// ============================================================================

Deno.test('http read-all — empty filter marks every unread read', async () => {
  const fx = buildApp();
  await seed(fx, [
    makeItem('a', ['unread']),
    makeItem('b', ['unread', 'newsletter']),
    makeItem('c', ['newsletter']), // already read — not counted as matched
  ]);

  const res = await fx.fetch('/inbox/mailroom/read-all', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matched, 2);
  assertEquals(body.changed, 2);
  assertEquals(body.capped, false);
});

Deno.test('http read-all — scoped filter intersects with unread', async () => {
  const fx = buildApp();
  await seed(fx, [
    makeItem('a', ['unread', 'sender:jan']),
    makeItem('b', ['unread', 'sender:jessica']),
    makeItem('c', ['unread', 'newsletter']),
  ]);

  const res = await fx.fetch('/inbox/mailroom/read-all', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ labels: ['sender:jan'] }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matched, 1);
  assertEquals(body.changed, 1);

  // Verify b + c still have unread
  const list = await fx.fetch('/inbox/mailroom/query', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ labels: ['unread'] }),
  });
  const listBody = await list.json();
  assertEquals(listBody.items.length, 2);
  assertEquals(new Set(listBody.items.map((it: InboxItem) => it.id)), new Set(['b', 'c']));
});

Deno.test('http read-all — no unread items → 0/0/false', async () => {
  const fx = buildApp();
  await seed(fx, [makeItem('a', ['newsletter'])]);

  const res = await fx.fetch('/inbox/mailroom/read-all', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matched, 0);
  assertEquals(body.changed, 0);
  assertEquals(body.capped, false);
});

// ============================================================================
// Query interaction — the user's actual workflow
// ============================================================================

Deno.test('http unread workflow — list, mark-read, list again, reappears via mark-unread', async () => {
  const fx = buildApp();
  await seed(fx, [
    makeItem('a', ['unread']),
    makeItem('b', ['unread']),
  ]);

  // Initial unread count
  let res = await fx.fetch('/inbox/mailroom/query', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ labels: ['unread'] }),
  });
  assertEquals((await res.json()).items.length, 2);

  // Mark a read
  res = await fx.fetch('/inbox/mailroom/items/a/read', { method: 'POST' });
  assertEquals(res.status, 200);

  // Now only b is unread
  res = await fx.fetch('/inbox/mailroom/query', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ labels: ['unread'] }),
  });
  const after = await res.json();
  assertEquals(after.items.length, 1);
  assertEquals(after.items[0].id, 'b');

  // Mark a unread again
  res = await fx.fetch('/inbox/mailroom/items/a/unread', { method: 'POST' });
  assertEquals(res.status, 200);

  // Both unread again
  res = await fx.fetch('/inbox/mailroom/query', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ labels: ['unread'] }),
  });
  assertEquals((await res.json()).items.length, 2);
});
