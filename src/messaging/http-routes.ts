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
import type { SenderIndex } from './sender-index.ts';
import { unsubscribeSender } from './unsubscribe.ts';
import type { MailroomRule, RuleAction, RulesStore } from './rules.ts';
import { listQuarantined, restoreItem } from './quarantine.ts';

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
  /**
   * Optional per-inbox sender index resolver. When provided, enables the
   * unsubscribe action route. Return `null`/`undefined` if an inbox doesn't
   * carry a sender index (route will then 501).
   */
  senderIndexFor?: (name: string) => SenderIndex | null | undefined | Promise<SenderIndex | null | undefined>;
  /**
   * Optional per-inbox rules store resolver. When provided, enables the
   * mailroom rules routes (`/inbox/:name/rules/...`). Return `null`/
   * `undefined` if an inbox has no rules store wired (routes 501 in that
   * case, matching the `senderIndexFor` pattern).
   */
  rulesStoreFor?: (name: string) => RulesStore | null | undefined | Promise<RulesStore | null | undefined>;
}

export function registerMessagingRoutes(
  app: Hono<any>,
  opts: RegisterMessagingRoutesOptions,
): void {
  const { registry, requireAuth, createInbox, senderIndexFor, rulesStoreFor } = opts;

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

  /**
   * Bulk export — the "download newsletters for processing" affordance.
   *
   * `GET /inbox/:name/export?format=jsonl&filter=<url-encoded-json>&include=body&limit=N`
   *
   * - `format`: `jsonl` (default, streams one JSON object per line) or `json`
   *   (single array response — use only for small exports, holds all in memory)
   * - `filter`: URL-encoded JSON matching `InboxFilter` (regex + headers + text
   *   + labels supported). Optional — omit for all items.
   * - `include`: comma-separated. Currently honors `body` (inflates body_ref
   *   from blobs adapter into `body` field). `raw` and `attachments` keep
   *   their refs as-is for now (see follow-ups in TASKS-MESSAGING.md).
   * - `limit`: cap on total items returned. Optional.
   *
   * Use cases this enables: "give me every Substack newsletter from this
   * week as JSONL with inline body" (one curl); "feed last 50 newsletters
   * to LLM summarizer" (stream into the model); "archive month-old items
   * to R2" (export → re-upload).
   */
  app.get('/inbox/:name/export', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const format = (c.req.query('format') ?? 'jsonl').toLowerCase();
    if (format !== 'jsonl' && format !== 'json') {
      return badRequest(c, "format must be 'jsonl' or 'json'");
    }

    const includeRaw = c.req.query('include') ?? '';
    const include = new Set(includeRaw.split(',').map((s) => s.trim()).filter(Boolean));
    const inflateBody = include.has('body');

    const filterRaw = c.req.query('filter');
    let filter: InboxFilter | undefined;
    if (filterRaw) {
      try {
        filter = JSON.parse(filterRaw);
      } catch {
        return badRequest(c, "filter must be URL-encoded JSON matching InboxFilter shape");
      }
    }

    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    if (limit !== undefined && (Number.isNaN(limit) || limit < 0)) {
      return badRequest(c, 'limit must be a non-negative integer');
    }

    // Streaming JSONL response. For format=json, we collect into an array
    // (slower for large exports but simpler for small consumer scripts).
    if (format === 'jsonl') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const item of streamItems(inbox, filter, inflateBody, limit)) {
              controller.enqueue(encoder.encode(JSON.stringify(item) + '\n'));
            }
            controller.close();
          } catch (err) {
            // Surface the error inline as the last line so consumers can
            // detect partial-export failures (vs HTTP 500 mid-stream which
            // is harder to diagnose).
            const message = err instanceof Error ? err.message : String(err);
            controller.enqueue(encoder.encode(JSON.stringify({ _error: message }) + '\n'));
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'X-Inbox': name,
          'Cache-Control': 'no-store',
        },
      });
    }

    // format === 'json': collect into array
    const items: any[] = [];
    for await (const item of streamItems(inbox, filter, inflateBody, limit)) {
      items.push(item);
    }
    return c.json({ inbox: name, items, count: items.length });
  });

  app.post('/inbox/:name/unsubscribe', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    if (!senderIndexFor) {
      return c.json(
        { error: 'NotImplemented', message: 'senderIndexFor not provided — unsubscribe action unavailable' },
        501,
      );
    }

    const senderIndex = await senderIndexFor(name);
    if (!senderIndex) {
      return c.json(
        { error: 'NotImplemented', message: `no sender index wired for inbox "${name}"` },
        501,
      );
    }

    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(c, 'body must be { address: string }');
    }
    const address = (body as { address?: unknown }).address;
    if (typeof address !== 'string' || !address.trim()) {
      return badRequest(c, 'body.address (non-empty string) required');
    }

    const skipCall = (body as { skipCall?: unknown }).skipCall === true;
    const timeoutMs = typeof (body as { timeoutMs?: unknown }).timeoutMs === 'number'
      ? (body as { timeoutMs: number }).timeoutMs
      : undefined;

    const result = await unsubscribeSender(senderIndex, address, { skipCall, timeoutMs });
    return c.json({ inbox: name, result });
  });

  /**
   * List quarantined items in the inbox. Thin wrapper over
   * `Inbox.query({ labels: ['quarantined'] })` with cursor/limit support.
   * Returns the same shape as `GET /inbox/:name` but scoped to items
   * carrying the quarantine label.
   *
   * Custom label via `?label=<name>` (default: `quarantined`).
   */
  app.get('/inbox/:name/quarantine', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const label = c.req.query('label');
    const cursor = c.req.query('cursor');
    const limit = parseLimit(c.req.query('limit'));

    const result = await listQuarantined(inbox, { label, cursor, limit });
    return c.json({ inbox: name, ...result });
  });

  /**
   * Restore a quarantined item — removes the quarantine label, preserving
   * any other labels (classifier output, reason labels like 'spam' etc).
   * Item stays in storage; this is a soft action that takes it out of the
   * quarantine view.
   *
   * Returns the restored item on success. 404 if id not found OR if the
   * item wasn't quarantined (distinguishes "did something" from "was
   * already fine" per the restoreItem library contract).
   *
   * Custom label via `?label=<name>` (default: `quarantined`).
   */
  app.post('/inbox/:name/restore/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const label = c.req.query('label');
    const restored = await restoreItem(inbox, id, { label });
    if (!restored) {
      return notFound(c, `item "${id}" not in inbox "${name}" or not quarantined`);
    }
    return c.json({ inbox: name, item: restored });
  });

  /**
   * Hard-delete an item. Removes the item record, updates the inbox index,
   * and best-effort deletes blob refs (raw_ref, body_ref, attachments).
   * For *soft* removal that keeps the item queryable via `?labels=archived`,
   * use the tag endpoint or a rules-engine archive action instead.
   *
   * 204 on success, 404 if id not in the inbox.
   */
  app.delete('/inbox/:name/items/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const anyInbox = inbox as { delete?: (id: string) => Promise<boolean> };
    if (typeof anyInbox.delete !== 'function') {
      return c.json(
        { error: 'NotImplemented', message: `inbox "${name}" has no delete() method` },
        501,
      );
    }
    const ok = await anyInbox.delete(id);
    if (!ok) return notFound(c, `item "${id}" not in inbox "${name}"`);
    return c.json({ inbox: name, deleted: id });
  });

  /**
   * Manual label edit — add or remove labels on an already-stored item.
   *
   * POST /inbox/:name/items/:id/tag
   * Body: { add?: string[], remove?: string[] }
   *
   * Use cases:
   *   - Upgrade a `manual` forward to `bookmark` after the fact
   *   - Remove an `archived` label that got applied by an overzealous rule
   *   - Add `read-later` / `star` / custom taxonomy labels from a UI
   *
   * Labels are Set-merged: adding a duplicate is a no-op, removing an absent
   * label is a no-op. Returns the updated item or 404 if id not found.
   * Persists via `inbox._ingest({ force: true })` so the content-hash dedup
   * doesn't swallow the mutation.
   */
  app.post('/inbox/:name/items/:id/tag', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(c, 'body must be { add?: string[], remove?: string[] }');
    }
    const add = (body as { add?: unknown }).add;
    const remove = (body as { remove?: unknown }).remove;
    const validArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
    if (add !== undefined && !validArray(add)) {
      return badRequest(c, 'add must be an array of non-empty strings');
    }
    if (remove !== undefined && !validArray(remove)) {
      return badRequest(c, 'remove must be an array of non-empty strings');
    }
    if (!add?.length && !remove?.length) {
      return badRequest(c, 'at least one of add[] or remove[] must be non-empty');
    }

    const existing = await inbox.read(id);
    if (!existing) return notFound(c, `item "${id}" not in inbox "${name}"`);

    const current = new Set(existing.labels ?? []);
    for (const label of add ?? []) current.add(label);
    for (const label of remove ?? []) current.delete(label);
    const nextLabels = Array.from(current);

    const updated: typeof existing = {
      ...existing,
      labels: nextLabels.length > 0 ? nextLabels : undefined,
    };

    // force: true bypasses content-hash dedup so the label mutation persists.
    const saved = await inbox._ingest(updated, { force: true });
    return c.json({ inbox: name, item: saved });
  });

  // --------------------------------------------------------------------------
  // Mailroom rules surface
  //
  // CRUD + retroactive-apply for `MailroomRule`s (see `src/messaging/rules.ts`).
  // All routes require `rulesStoreFor(name)` to return a store; otherwise 501.
  // --------------------------------------------------------------------------

  async function resolveRulesStore(
    c: Context,
    name: string,
  ): Promise<{ inbox: import('./types.ts').Inbox; store: RulesStore } | Response> {
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);
    if (!rulesStoreFor) {
      return c.json(
        { error: 'NotImplemented', message: 'rulesStoreFor not provided — rules routes unavailable' },
        501,
      );
    }
    const store = await rulesStoreFor(name);
    if (!store) {
      return c.json(
        { error: 'NotImplemented', message: `no rules store wired for inbox "${name}"` },
        501,
      );
    }
    return { inbox, store };
  }

  app.get('/inbox/:name/rules', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const resolved = await resolveRulesStore(c, name);
    if (resolved instanceof Response) return resolved;

    const cursor = c.req.query('cursor');
    const limit = parseLimit(c.req.query('limit'));

    const result = await resolved.store.list({ cursor, limit });
    return c.json({ inbox: name, rules: result.rules, next_cursor: result.next_cursor });
  });

  app.get('/inbox/:name/rules/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const resolved = await resolveRulesStore(c, name);
    if (resolved instanceof Response) return resolved;

    const rule = await resolved.store.get(id);
    if (!rule) return notFound(c, `rule "${id}" not in inbox "${name}"`);
    return c.json({ inbox: name, rule });
  });

  app.post('/inbox/:name/rules', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const resolved = await resolveRulesStore(c, name);
    if (resolved instanceof Response) return resolved;

    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(c, 'body must be a MailroomRule object (match, action, [priority, ...])');
    }
    const validation = validateRuleInput(body);
    if (validation) return badRequest(c, validation);

    const rule = await resolved.store.create({
      match: body.match,
      action: body.action as RuleAction,
      action_args: body.action_args,
      priority: body.priority,
      notes: body.notes,
      disabled: body.disabled,
    });

    const applyRetroactive = c.req.query('apply_retroactive') === 'true';
    if (applyRetroactive) {
      const retro = await resolved.store.applyRetroactive(rule, resolved.inbox);
      return c.json({ created: rule, retroactive: retro }, 201);
    }
    return c.json({ created: rule }, 201);
  });

  app.put('/inbox/:name/rules/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const resolved = await resolveRulesStore(c, name);
    if (resolved instanceof Response) return resolved;

    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(c, 'body must be a partial MailroomRule patch');
    }
    // Ignore id/created_at if clients accidentally send them — the store
    // already protects those via its update signature, but filter defensively.
    const { id: _ignoreId, created_at: _ignoreCreated, ...patch } = body as Partial<MailroomRule>;
    const updated = await resolved.store.update(id, patch);
    if (!updated) return notFound(c, `rule "${id}" not in inbox "${name}"`);
    return c.json({ inbox: name, updated });
  });

  app.delete('/inbox/:name/rules/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const resolved = await resolveRulesStore(c, name);
    if (resolved instanceof Response) return resolved;

    const existed = await resolved.store.delete(id);
    if (!existed) return notFound(c, `rule "${id}" not in inbox "${name}"`);
    return c.json({ inbox: name, deleted: id });
  });

  app.post('/inbox/:name/rules/:id/apply-retroactive', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const resolved = await resolveRulesStore(c, name);
    if (resolved instanceof Response) return resolved;

    const rule = await resolved.store.get(id);
    if (!rule) return notFound(c, `rule "${id}" not in inbox "${name}"`);
    const result = await resolved.store.applyRetroactive(rule, resolved.inbox);
    return c.json({ inbox: name, rule_id: id, ...result });
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
    const all = [...registry.listEntries()].map(([name, reg]) =>
      serializeRegistration(name, reg),
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

const VALID_RULE_ACTIONS: ReadonlySet<string> = new Set([
  'archive',
  'bookmark',
  'tag',
  'drop',
  'quarantine',
]);

/** Validate a POST /rules body. Returns an error message on failure, null on success. */
function validateRuleInput(body: any): string | null {
  if (!body.match || typeof body.match !== 'object') {
    return 'body.match (InboxFilter object) required';
  }
  if (typeof body.action !== 'string' || !VALID_RULE_ACTIONS.has(body.action)) {
    return `body.action must be one of: archive, bookmark, tag, drop, quarantine`;
  }
  if (body.priority !== undefined && (typeof body.priority !== 'number' || !Number.isFinite(body.priority))) {
    return 'body.priority must be a finite number when provided';
  }
  if (body.action_args !== undefined && (body.action_args === null || typeof body.action_args !== 'object')) {
    return 'body.action_args must be an object when provided';
  }
  if (body.action === 'tag' && body.action_args?.tag !== undefined && typeof body.action_args.tag !== 'string') {
    return 'body.action_args.tag must be a string when provided';
  }
  return null;
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

/**
 * Async generator that yields items from an inbox, optionally inflating the
 * body via `inbox.read({ full: true })`. Walks the cursor until exhaustion
 * or `limit` items yielded. Used by the export route.
 */
async function* streamItems(
  inbox: import('./types.ts').Inbox,
  filter: import('./types.ts').InboxFilter | undefined,
  inflateBody: boolean,
  limit: number | undefined,
): AsyncGenerator<Record<string, any>> {
  let cursor: string | undefined;
  let yielded = 0;
  const pageLimit = 100; // server-side page size; client sees one continuous stream

  while (true) {
    const result = filter
      ? await inbox.query(filter, { cursor, limit: pageLimit })
      : await inbox.list({ cursor, limit: pageLimit });

    for (const item of result.items) {
      if (limit !== undefined && yielded >= limit) return;

      if (inflateBody && item.body_ref) {
        // read({ full: true }) fetches the body_ref content from blobs adapter.
        // If it fails (blob missing, adapter down), fall through to the
        // uninflated item rather than killing the entire stream.
        const full = await inbox.read(item.id, { full: true }).catch(() => null);
        if (full?.body_inflated) {
          yield { ...full, body: full.body_inflated, body_inflated: undefined };
        } else {
          yield item;
        }
      } else {
        yield item;
      }
      yielded++;
    }

    if (!result.next_cursor) return;
    cursor = result.next_cursor;
  }
}
