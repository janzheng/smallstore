/**
 * HTTP integration tests for the auto-confirm-senders admin routes.
 *
 * Boots a Hono app wired against a MemoryAdapter-backed
 * AutoConfirmSendersStore and exercises the routes via app.fetch().
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import {
  createAutoConfirmSendersStore,
  type AutoConfirmSendersStore,
} from '../src/messaging/auto-confirm-senders.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import type { InboxConfig } from '../src/messaging/types.ts';

interface Fixture {
  app: Hono;
  store: AutoConfirmSendersStore;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildApp(opts: { withStore?: boolean } = {}): Fixture {
  const adapter = new MemoryAdapter();
  const itemsAdapter = new MemoryAdapter();
  const registry = new InboxRegistry();
  const store = createAutoConfirmSendersStore(adapter);

  const requireAuth = (_c: Context, next: Next) => next();

  const buildInbox = async (name: string, cfg: InboxConfig) =>
    createInbox({ name, channel: cfg.channel, storage: { items: itemsAdapter } });

  const app = new Hono();
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInbox,
    autoConfirmSendersStore: opts.withStore === false ? undefined : store,
  });

  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  return { app, store, fetch };
}

const jsonHeaders: HeadersInit = { 'content-type': 'application/json' };

// ============================================================================
// GET /admin/auto-confirm/senders
// ============================================================================

Deno.test('http — GET returns empty list initially', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/auto-confirm/senders');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.senders, []);
});

Deno.test('http — GET reflects rows added via the store', async () => {
  const fx = buildApp();
  await fx.store.add({ pattern: '*@substack.com' });
  await fx.store.add({ pattern: '*@beehiiv.com' });

  const res = await fx.fetch('/admin/auto-confirm/senders');
  const body = await res.json();
  assertEquals(body.senders.length, 2);
  const patterns = body.senders.map((s: any) => s.pattern).sort();
  assertEquals(patterns, ['*@beehiiv.com', '*@substack.com']);
});

Deno.test('http — GET 501 when no store wired', async () => {
  const fx = buildApp({ withStore: false });
  const res = await fx.fetch('/admin/auto-confirm/senders');
  assertEquals(res.status, 501);
});

// ============================================================================
// POST /admin/auto-confirm/senders
// ============================================================================

Deno.test('http — POST adds a pattern with source: runtime', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@beehiiv.com', notes: 'Beehiiv platform' }),
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.created.pattern, '*@beehiiv.com');
  assertEquals(body.created.source, 'runtime');
  assertEquals(body.created.notes, 'Beehiiv platform');
  assertExists(body.created.created_at);

  // Confirm it persisted.
  assertEquals((await fx.store.list()).length, 1);
});

Deno.test('http — POST is idempotent — second add returns existing row', async () => {
  const fx = buildApp();
  const a = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@beehiiv.com', notes: 'first' }),
  });
  const aBody = await a.json();

  const b = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@beehiiv.com', notes: 'second' }),
  });
  const bBody = await b.json();
  // Second call returns the same row (existing wins) — created_at unchanged.
  assertEquals(bBody.created.created_at, aBody.created.created_at);
  assertEquals(bBody.created.notes, 'first');
});

Deno.test('http — POST normalizes pattern (lowercase + trim)', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '  *@CONVERTKIT.COM  ' }),
  });
  const body = await res.json();
  assertEquals(body.created.pattern, '*@convertkit.com');
});

Deno.test('http — POST 400 on missing pattern', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ notes: 'orphan' }),
  });
  assertEquals(res.status, 400);
});

Deno.test('http — POST 400 on whitespace-only pattern', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '   ' }),
  });
  assertEquals(res.status, 400);
});

Deno.test('http — POST 400 when notes is not a string', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@x.com', notes: 42 }),
  });
  assertEquals(res.status, 400);
});

Deno.test('http — POST 501 when no store wired', async () => {
  const fx = buildApp({ withStore: false });
  const res = await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@x.com' }),
  });
  assertEquals(res.status, 501);
});

// ============================================================================
// DELETE /admin/auto-confirm/senders/:pattern
// ============================================================================

Deno.test('http — DELETE removes the pattern', async () => {
  const fx = buildApp();
  await fx.store.add({ pattern: '*@substack.com' });

  const res = await fx.fetch(
    `/admin/auto-confirm/senders/${encodeURIComponent('*@substack.com')}`,
    { method: 'DELETE' },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.deleted, '*@substack.com');
  assertEquals(await fx.store.get('*@substack.com'), null);
});

Deno.test('http — DELETE 404 when pattern not present', async () => {
  const fx = buildApp();
  const res = await fx.fetch(
    `/admin/auto-confirm/senders/${encodeURIComponent('*@missing.com')}`,
    { method: 'DELETE' },
  );
  assertEquals(res.status, 404);
});

Deno.test('http — DELETE handles URL-encoded patterns correctly', async () => {
  const fx = buildApp();
  // Pattern with `*` and `@` — both need encoding.
  await fx.store.add({ pattern: '*@beehiiv.com' });
  const encoded = encodeURIComponent('*@beehiiv.com');
  const res = await fx.fetch(`/admin/auto-confirm/senders/${encoded}`, {
    method: 'DELETE',
  });
  assertEquals(res.status, 200);
  assertEquals(await fx.store.get('*@beehiiv.com'), null);
});

Deno.test('http — DELETE 501 when no store wired', async () => {
  const fx = buildApp({ withStore: false });
  const res = await fx.fetch(
    `/admin/auto-confirm/senders/${encodeURIComponent('*@x.com')}`,
    { method: 'DELETE' },
  );
  assertEquals(res.status, 501);
});

// ============================================================================
// Round-trip — POST → GET → DELETE → GET
// ============================================================================

Deno.test('http — full lifecycle round-trip', async () => {
  const fx = buildApp();

  // Initially empty
  let list = await (await fx.fetch('/admin/auto-confirm/senders')).json();
  assertEquals(list.senders.length, 0);

  // Add two
  await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@a.com' }),
  });
  await fx.fetch('/admin/auto-confirm/senders', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ pattern: '*@b.com' }),
  });

  list = await (await fx.fetch('/admin/auto-confirm/senders')).json();
  assertEquals(list.senders.length, 2);

  // Remove one
  await fx.fetch(
    `/admin/auto-confirm/senders/${encodeURIComponent('*@a.com')}`,
    { method: 'DELETE' },
  );

  list = await (await fx.fetch('/admin/auto-confirm/senders')).json();
  assertEquals(list.senders.length, 1);
  assertEquals(list.senders[0].pattern, '*@b.com');
});
