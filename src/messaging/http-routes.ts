/**
 * HTTP route registration for the messaging plugin family.
 *
 * Mounts inbox + admin routes onto a Hono app. Caller supplies:
 *   - registry: in-memory inbox registry
 *   - requireAuth: middleware (or pass-through if no auth configured)
 *   - createInbox: factory that resolves InboxConfig → Inbox (knows adapters)
 *
 * Routes mounted (all behind `requireAuth`):
 *
 *   Reader / writer surface (per inbox):
 *     POST   /inbox/:name/items            — ingest a parsed InboxItem
 *     GET    /inbox/:name                  — list newest-first (cursor, limit)
 *     GET    /inbox/:name/items/:id        — read one (?full=true to inflate)
 *     POST   /inbox/:name/query            — body = InboxFilter
 *     GET    /inbox/:name/cursor           — current head cursor
 *     DELETE /inbox/:name/items/:id        — delete one item (audit-emit later)
 *
 *   Admin surface:
 *     POST   /admin/inboxes                — create a runtime inbox
 *     GET    /admin/inboxes                — list all inboxes (registrations)
 *     GET    /admin/inboxes/:name          — get one registration
 *     DELETE /admin/inboxes/:name          — remove an inbox
 *     GET    /admin/channels               — list registered channels (debug aid)
 *
 * Path note: routes mount at the ROOT of the Hono app, NOT under `/api`.
 * `/api/*` is the collection-CRUD surface; `/inbox/*` is the messaging surface.
 * Register BEFORE `createHonoRoutes(app, smallstore, '/api')` so wildcard
 * matching in `/api` doesn't shadow them (since they're disjoint prefixes
 * this is defensive — the order doesn't actually matter for correctness).
 */

import type { Context, Hono, Next } from 'hono';
import type { InboxConfig, InboxFilter } from './types.ts';
import { listChannels, type InboxRegistry } from './registry.ts';

export type RequireAuth = (c: Context, next: Next) => Promise<Response | void> | Response | void;

export interface RegisterMessagingRoutesOptions {
  registry: InboxRegistry;
  requireAuth: RequireAuth;
  /**
   * Factory: given a name + InboxConfig, return a fully-wired Inbox instance.
   * Caller resolves the storage adapter refs (e.g. `"d1:MAILROOM_D1"`) into
   * actual StorageAdapter instances.
   */
  createInbox: (name: string, config: InboxConfig) => Promise<import('./types.ts').Inbox>;
}

export function registerMessagingRoutes(
  app: Hono<any>,
  opts: RegisterMessagingRoutesOptions,
): void {
  const { registry, requireAuth, createInbox } = opts;

  // --------------------------------------------------------------------------
  // Per-inbox surface
  // --------------------------------------------------------------------------

  app.post('/inbox/:name/items', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(c, 'body must be an InboxItem object');
    }
    if (!body.id || !body.source || !body.received_at) {
      return badRequest(c, 'InboxItem requires id, source, received_at');
    }
    if (!body.fields || typeof body.fields !== 'object') {
      return badRequest(c, 'InboxItem.fields must be an object');
    }

    const stored = await inbox._ingest(body);
    return c.json({ inbox: name, item: stored });
  });

  app.get('/inbox/:name', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const cursor = c.req.query('cursor');
    const limit = parseLimit(c.req.query('limit'));
    const order = (c.req.query('order') === 'oldest') ? 'oldest' : 'newest';

    const result = await inbox.list({ cursor, limit, order });
    return c.json({ inbox: name, ...result });
  });

  app.get('/inbox/:name/items/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const full = c.req.query('full') === 'true';
    const item = await inbox.read(id, { full });
    if (!item) return notFound(c, `item "${id}" not in inbox "${name}"`);
    return c.json({ inbox: name, item });
  });

  app.post('/inbox/:name/query', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    const filter: InboxFilter = (body && typeof body === 'object') ? body.filter ?? body : {};
    const cursor = c.req.query('cursor') ?? body?.cursor;
    const limit = parseLimit(c.req.query('limit') ?? body?.limit);

    const result = await inbox.query(filter, { cursor, limit });
    return c.json({ inbox: name, ...result });
  });

  app.get('/inbox/:name/cursor', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const cursor = await inbox.cursor();
    return c.json({ inbox: name, cursor });
  });

  // --------------------------------------------------------------------------
  // Admin surface
  // --------------------------------------------------------------------------

  app.post('/admin/inboxes', requireAuth, async (c) => {
    const body = await readJson(c) as ({ name?: string } & InboxConfig) | null;
    if (!body || typeof body !== 'object') return badRequest(c, 'body required');
    const { name, ...config } = body;
    if (!name || typeof name !== 'string') {
      return badRequest(c, 'body.name (string) required');
    }
    if (!config.channel || !config.storage) {
      return badRequest(c, 'body must include channel and storage');
    }
    if (registry.get(name)) {
      return c.json({ error: 'Conflict', message: `inbox "${name}" already exists` }, 409);
    }

    const inbox = await createInbox(name, config as InboxConfig);
    registry.register(name, inbox, config as InboxConfig, 'runtime');

    const reg = registry.getRegistration(name)!;
    return c.json({ created: serializeRegistration(name, reg) }, 201);
  });

  app.get('/admin/inboxes', requireAuth, (c) => {
    const all = registry.listRegistrations().map((reg) =>
      serializeRegistration(reg.inbox.name, reg),
    );
    return c.json({ inboxes: all });
  });

  app.get('/admin/inboxes/:name', requireAuth, (c) => {
    const name = c.req.param('name')!;
    const reg = registry.getRegistration(name);
    if (!reg) return notFound(c, `inbox "${name}" not registered`);
    return c.json(serializeRegistration(name, reg));
  });

  app.delete('/admin/inboxes/:name', requireAuth, (c) => {
    const name = c.req.param('name')!;
    if (!registry.unregister(name)) {
      return notFound(c, `inbox "${name}" not registered`);
    }
    return c.json({ deleted: name });
  });

  app.get('/admin/channels', requireAuth, (c) => {
    return c.json({ channels: listChannels() });
  });
}

// ============================================================================
// Helpers
// ============================================================================

async function readJson(c: Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function badRequest(c: Context, message: string) {
  return c.json({ error: 'BadRequest', message }, 400);
}

function notFound(c: Context, message: string) {
  return c.json({ error: 'NotFound', message }, 404);
}

function parseLimit(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 500);
}

function serializeRegistration(name: string, reg: import('./registry.ts').InboxRegistration) {
  return {
    name,
    channel: reg.config.channel,
    origin: reg.origin,
    created_at: new Date(reg.created_at).toISOString(),
    config: { ...reg.config },
  };
}
