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
 *     GET    /inbox/:name                  — list newest-first (cursor, limit, order, order_by)
 *     GET    /inbox/:name/items/:id        — read one (?full=true to inflate)
 *     GET    /inbox/:name/items/:id/attachments         — list attachments + download URLs
 *     GET    /inbox/:name/items/:id/attachments/:file   — stream one attachment (?download=1 forces download)
 *     POST   /inbox/:name/query            — body = InboxFilter
 *     GET    /inbox/:name/cursor           — current head cursor
 *     DELETE /inbox/:name/items/:id        — delete one item (audit-emit later)
 *
 *   Newsletter views (derived from `fields.newsletter_slug`):
 *     GET    /inbox/:name/newsletters                 — slugs + counts (latest-first)
 *     GET    /inbox/:name/newsletters/:slug           — profile dashboard (count, first/last seen, notes_count)
 *     GET    /inbox/:name/newsletters/:slug/items     — chronological reading list (?order=newest|oldest, default oldest)
 *     GET    /inbox/:name/newsletters/:slug/notes     — items with non-empty `forward_note`, slim shape
 *
 *   Webhook surface (no requireAuth — HMAC is the auth):
 *     POST   /webhook/:peer                — inbound webhook → channel.parse → inbox._ingest
 *
 *   Admin surface:
 *     POST   /admin/inboxes                — create a runtime inbox
 *     POST   /admin/inboxes/:name/replay   — re-run a registered hook over filtered items (retroactive backfill)
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
import type { InboxConfig, InboxFilter, InboxItem, ListOptions } from './types.ts';
import { listChannels, type InboxRegistry } from './registry.ts';
import type { SenderIndex } from './sender-index.ts';
import { unsubscribeSender } from './unsubscribe.ts';
import type { MailroomRule, RuleAction, RulesStore } from './rules.ts';
import type { AutoConfirmSendersStore } from './auto-confirm-senders.ts';
import { listQuarantined, restoreItem } from './quarantine.ts';
import { verifyHmac, webhookChannel, type WebhookConfig } from './channels/webhook.ts';
import { scanNoteForTodos } from './todos.ts';
import {
  renderAllNotes,
  renderNewsletterIndex,
  renderNewsletterNotes,
  renderNewsletterProfile,
} from './newsletter-markdown.ts';

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
  /**
   * Optional Worker-global auto-confirm sender store. When provided,
   * enables `/admin/auto-confirm/senders` admin routes. The store is
   * Worker-global (not per-inbox) — auto-confirm is a single allowlist
   * shared across every inbox the auto-confirm hook runs for.
   */
  autoConfirmSendersStore?: AutoConfirmSendersStore;
  /**
   * Optional peer lookup — when provided, enables the `/webhook/:peer`
   * route. Should return the peer's `metadata.webhook_config` (typed),
   * or `null` to 404. Opaque function rather than a PeerStore reference
   * to keep the messaging module from depending on the peers module.
   */
  webhookConfigFor?: (peerName: string) => Promise<WebhookConfig | null> | WebhookConfig | null;
  /**
   * Optional resolver for env-referenced HMAC secrets. Receives the env
   * var name from `webhook_config.hmac.secret_env` and returns the secret
   * value. In CF Workers, callers wrap `(name) => env[name]`. Required
   * when any registered webhook peer uses HMAC verification.
   */
  resolveHmacSecret?: (envName: string) => string | undefined;
  /**
   * Optional hook lookup — when provided, enables `POST /admin/inboxes/:name/replay`.
   * The factory receives the inbox name + a hook name and returns the
   * registered hook function (or undefined when the inbox has no hook by
   * that name). Powers the retroactive backfill system (see
   * `.brief/forward-notes-and-newsletter-profiles.md` Phase 3): re-running
   * a registered hook over filtered existing items is one curl call, not a
   * one-off script.
   */
  replayHookFor?: (
    inboxName: string,
    hookName: string,
  ) => import('./types.ts').PreIngestHook | undefined;
}

export function registerMessagingRoutes(
  app: Hono<any>,
  opts: RegisterMessagingRoutesOptions,
): void {
  const { registry, requireAuth, createInbox, senderIndexFor, rulesStoreFor, autoConfirmSendersStore, webhookConfigFor, resolveHmacSecret, replayHookFor } = opts;

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
    const order_by = parseOrderBy(c.req.query('order_by'));

    const result = await inbox.list({ cursor, limit, order, order_by });
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

  // --------------------------------------------------------------------------
  // Attachments — list + download
  // --------------------------------------------------------------------------
  // List route returns metadata + a relative `download_url` per attachment.
  // Download route streams the raw bytes through the Worker, gated on the
  // bearer token and validated against the item's attachments[] (no
  // path-traversal — only declared filenames resolve).
  // See `.brief/attachments.md` for the full story.

  app.get('/inbox/:name/items/:id/attachments', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const item = await inbox.read(id);
    if (!item) return notFound(c, `item "${id}" not in inbox "${name}"`);

    const raw = (item.fields as any)?.attachments;
    const attachments = Array.isArray(raw) ? raw : [];
    const result = attachments.map((a: any) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      content_id: a.content_id,
      download_url: `/inbox/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/attachments/${encodeURIComponent(a.filename)}`,
    }));
    return c.json({ inbox: name, item_id: id, attachments: result });
  });

  app.get('/inbox/:name/items/:id/attachments/:filename', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const filenameRaw = c.req.param('filename')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    if (typeof inbox.readAttachment !== 'function') {
      return c.json(
        { error: 'NotImplemented', message: 'inbox does not expose readAttachment' },
        501,
      );
    }

    let filename: string;
    try {
      filename = decodeURIComponent(filenameRaw);
    } catch {
      filename = filenameRaw;
    }

    const result = await inbox.readAttachment(id, filename);
    if (!result) return notFound(c, `attachment "${filename}" not found on item "${id}"`);

    const { attachment, content } = result;
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
    // Safe filename for the Content-Disposition header — strip control
    // chars + quotes so the header value can't be broken.
    const safe = attachment.filename.replace(/[\x00-\x1f"\\]/g, '_');

    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': attachment.content_type || 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'content-disposition': `${disposition}; filename="${safe}"`,
        // Don't cache aggressively — attachments can be replaced if the
        // item re-ingests under the same id (rare but possible).
        'cache-control': 'private, max-age=60',
      },
    });
  });

  app.post('/inbox/:name/query', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    const filter: InboxFilter = (body && typeof body === 'object') ? body.filter ?? body : {};
    const cursor = c.req.query('cursor') ?? body?.cursor;
    const limit = parseLimit(c.req.query('limit') ?? body?.limit);
    const order = (c.req.query('order') ?? body?.order) === 'oldest' ? 'oldest' : 'newest';
    const order_by = parseOrderBy(c.req.query('order_by') ?? body?.order_by);

    const result = await inbox.query(filter, { cursor, limit, order, order_by });
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

  // --------------------------------------------------------------------------
  // Newsletter views — derived from `fields.newsletter_slug`. Per
  // `.brief/forward-notes-and-newsletter-profiles.md` Phase 2.
  //
  //   GET /inbox/:name/newsletters                      list slugs + counts
  //   GET /inbox/:name/newsletters/:slug                profile dashboard
  //   GET /inbox/:name/newsletters/:slug/items          chronological reading list
  //   GET /inbox/:name/newsletters/:slug/notes          items with non-empty forward_note
  //
  // All read-only, derived from inbox queries — no new storage.
  // --------------------------------------------------------------------------

  app.get('/inbox/:name/newsletters', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    // Pull every item with a slug (via order_by 'received_at' default — but
    // we want all of them so we use a high limit). At inbox sizes < ~10K this
    // is fine; past that, see `_index` scaling cliff in TASKS-MESSAGING.md.
    const result = await inbox.query(
      { fields_regex: { newsletter_slug: '.+' } },
      { limit: 10_000 },
    );
    const counts = new Map<string, { count: number; latest_at?: string; display?: string }>();
    for (const item of result.items) {
      const slug = String(item.fields?.newsletter_slug ?? '');
      if (!slug) continue;
      const cur = counts.get(slug) ?? { count: 0 };
      cur.count++;
      const at = (item.fields?.original_sent_at as string | undefined) ?? item.received_at;
      if (!cur.latest_at || at > cur.latest_at) {
        cur.latest_at = at;
        const addr = item.fields?.original_from_addr as string | undefined;
        if (addr) cur.display = stripAngleAddr(addr);
      }
      counts.set(slug, cur);
    }
    const newsletters = [...counts.entries()]
      .map(([slug, v]) => ({ slug, count: v.count, latest_at: v.latest_at, display: v.display }))
      .sort((a, b) => (b.latest_at ?? '').localeCompare(a.latest_at ?? ''));

    if (c.req.query('format') === 'markdown') {
      return new Response(renderNewsletterIndex(name, newsletters), {
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      });
    }
    return c.json({ inbox: name, newsletters });
  });

  app.get('/inbox/:name/newsletters/:slug', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const slug = c.req.param('slug')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const result = await inbox.query(
      { fields_regex: { newsletter_slug: `^${escapeRegex(slug)}$` } },
      { limit: 10_000 },
    );
    if (result.items.length === 0) return notFound(c, `no items with newsletter_slug "${slug}" in "${name}"`);

    let firstAt: string | undefined;
    let lastAt: string | undefined;
    let lastNote: { text: string; at: string; subject?: string } | undefined;
    let notesCount = 0;
    let display: string | undefined;
    for (const item of result.items) {
      const at = (item.fields?.original_sent_at as string | undefined) ?? item.received_at;
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) {
        lastAt = at;
        const addr = item.fields?.original_from_addr as string | undefined;
        if (addr) display = stripAngleAddr(addr);
      }
      const note = item.fields?.forward_note as string | undefined;
      if (typeof note === 'string' && note.trim().length > 0) {
        notesCount++;
        if (!lastNote || at > lastNote.at) {
          lastNote = {
            text: note,
            at,
            subject: (item.fields?.original_subject as string | undefined),
          };
        }
      }
    }

    const profile = {
      slug,
      display,
      count: result.items.length,
      first_seen_at: firstAt,
      last_seen_at: lastAt,
      notes_count: notesCount,
    };

    if (c.req.query('format') === 'markdown') {
      const origin = new URL(c.req.url).origin;
      return new Response(
        renderNewsletterProfile(name, slug, profile, result.items, origin),
        {
          status: 200,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        },
      );
    }

    return c.json({
      inbox: name,
      ...profile,
      last_note: lastNote,
    });
  });

  app.get('/inbox/:name/newsletters/:slug/items', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const slug = c.req.param('slug')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const limit = parseLimit(c.req.query('limit'));
    const order = c.req.query('order') === 'newest' ? 'newest' : 'oldest';

    const result = await inbox.query(
      { fields_regex: { newsletter_slug: `^${escapeRegex(slug)}$` } },
      { limit, order, order_by: 'original_sent_at' },
    );
    return c.json({ inbox: name, slug, ...result });
  });

  app.get('/inbox/:name/newsletters/:slug/notes', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const slug = c.req.param('slug')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const limit = parseLimit(c.req.query('limit'));
    const order = c.req.query('order') === 'newest' ? 'newest' : 'oldest';

    const result = await inbox.query(
      {
        fields_regex: {
          newsletter_slug: `^${escapeRegex(slug)}$`,
          forward_note: '.+',
        },
      },
      { limit, order, order_by: 'original_sent_at' },
    );
    // Project down to a slim notes-only shape for cheap LLM summarization.
    const notes = result.items.map((item) => ({
      id: item.id,
      original_sent_at: item.fields?.original_sent_at as string | undefined,
      received_at: item.received_at,
      subject: (item.fields?.original_subject ?? item.summary) as string | undefined,
      from: item.fields?.original_from_addr as string | undefined,
      note: item.fields?.forward_note as string | undefined,
    }));

    if (c.req.query('format') === 'markdown') {
      // Derive a slim profile for the markdown header — display name from
      // the most-recent note, count from the notes themselves.
      const display = notes.length > 0 && notes[0].from
        ? stripAngleAddr(notes[0].from)
        : undefined;
      const profile = {
        slug,
        display,
        count: notes.length,
        notes_count: notes.length,
      };
      const origin = new URL(c.req.url).origin;
      return new Response(
        renderNewsletterNotes(name, slug, profile, notes, origin),
        {
          status: 200,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        },
      );
    }

    return c.json({ inbox: name, slug, count: notes.length, total: result.total, notes });
  });

  /**
   * Cross-newsletter notes — every item with a non-empty `forward_note`,
   * regardless of slug. The aggregation primitive: "give me all the things
   * I've written about anything." Same slim projection as the per-slug
   * notes route; pairs with `?text=` for free-text search across everything
   * I've ever annotated.
   *
   * GET /inbox/:name/notes
   *   ?text=<keyword>          Substring filter (case-insensitive) on forward_note.
   *   ?slug=<newsletter-slug>  Optional scope. (Equivalent to /newsletters/:slug/notes.)
   *   ?since=<iso>             Filter by received_at.
   *   ?order=newest|oldest     Sort order. Default newest (cross-publisher; "what did I write recently").
   *   ?limit=<n>               Default 100, max 500.
   *   ?format=markdown         Render as one markdown document grouped by slug.
   *
   * For per-publisher reading-list semantics (chronological by `original_sent_at`),
   * use `/inbox/:name/newsletters/:slug/notes` instead — different default sort
   * because the use case is "read this publisher in order" vs "what have I been
   * thinking about lately."
   */
  app.get('/inbox/:name/notes', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const text = c.req.query('text');
    const slug = c.req.query('slug');
    const since = c.req.query('since');
    const limit = parseLimit(c.req.query('limit')) ?? 100;
    const order = c.req.query('order') === 'oldest' ? 'oldest' : 'newest';

    const fieldsRegex: Record<string, string> = { forward_note: '.+' };
    if (slug) fieldsRegex.newsletter_slug = `^${escapeRegex(slug)}$`;

    const result = await inbox.query(
      {
        fields_regex: fieldsRegex,
        ...(since ? { since } : {}),
      },
      { limit: 500 },
    );

    const allNotes = result.items.map((item) => ({
      id: item.id,
      newsletter_slug: item.fields?.newsletter_slug as string | undefined,
      newsletter_display: (item.fields?.original_from_addr ?? item.fields?.from_addr) as
        | string
        | undefined,
      original_sent_at: item.fields?.original_sent_at as string | undefined,
      received_at: item.received_at,
      subject: (item.fields?.original_subject ?? item.summary) as string | undefined,
      from: item.fields?.original_from_addr as string | undefined,
      note: item.fields?.forward_note as string | undefined,
    }));

    // Sort by received_at — the filter path of inbox.query() honors index
    // order but ignores `order`, so we apply the sort here on the hydrated
    // slim shape. Same O(N) tradeoff as the rest of the cross-publisher
    // routes; bounded by the 500-item query cap above.
    allNotes.sort((a, b) => {
      const av = a.received_at ?? '';
      const bv = b.received_at ?? '';
      if (av === bv) return 0;
      return order === 'newest' ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
    });

    // Substring filter on forward_note only (NOT body — that's what the
    // existing `?text=` on /query already covers, and it's noisier).
    const filtered = text
      ? allNotes.filter((n) => (n.note ?? '').toLowerCase().includes(text.toLowerCase()))
      : allNotes;

    const notes = filtered.slice(0, limit);

    if (c.req.query('format') === 'markdown') {
      const origin = new URL(c.req.url).origin;
      return new Response(renderAllNotes(name, notes, origin, { text, slug, since }), {
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      });
    }

    return c.json({ inbox: name, count: notes.length, total: filtered.length, notes });
  });

  /**
   * Derived todo view — scans every item with `forward_note` for action-shaped
   * lines via a small regex set (markdown unchecked checkbox, `TODO:` /
   * `Action:` prefixes, "remind/remember", "sub me to", "follow up").
   *
   * GET /inbox/:name/todos
   *   ?slug=<newsletter-slug>     Scope to one publisher.
   *   ?since=<iso>                Only items received after this timestamp.
   *   ?limit=<n>                  Max todos to return. Default 100, max 500.
   *
   * Pure read-side — no schema change, no LLM. A note with multiple matching
   * lines emits multiple todos. Skips quoted-reply lines (`> ...`) and
   * checked checkboxes (`[x]`). Each todo includes `matched_pattern` (the
   * rule that fired) and `full_note` (entire forward_note for context).
   *
   * Pattern set + extension guidance: `.brief/notes-todos-and-mirror.md`
   * and `src/messaging/todos.ts`.
   */
  app.get('/inbox/:name/todos', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const slug = c.req.query('slug');
    const since = c.req.query('since');
    const limit = parseLimit(c.req.query('limit')) ?? 100;

    // Items must have a non-empty forward_note. Optionally scoped to one slug.
    const fieldsRegex: Record<string, string> = { forward_note: '.+' };
    if (slug) {
      fieldsRegex.newsletter_slug = `^${escapeRegex(slug)}$`;
    }

    // Hydrate a generous batch — todo emit is bounded by `limit` below.
    const result = await inbox.query(
      {
        fields_regex: fieldsRegex,
        ...(since ? { since } : {}),
      },
      { limit: 500, order: 'newest' },
    );

    const todos: Array<{
      item_id: string;
      newsletter_slug: string | undefined;
      newsletter_display: string | undefined;
      subject: string | undefined;
      original_sent_at: string | undefined;
      received_at: string;
      matched_line: string;
      matched_pattern: string;
      full_note: string;
    }> = [];

    for (const item of result.items) {
      const note = (item.fields as Record<string, unknown> | undefined)?.forward_note;
      if (typeof note !== 'string' || note.length === 0) continue;

      const matches = scanNoteForTodos(note);
      for (const m of matches) {
        todos.push({
          item_id: item.id,
          newsletter_slug: item.fields?.newsletter_slug as string | undefined,
          newsletter_display: (item.fields?.original_from_addr ?? item.fields?.from_addr) as
            | string
            | undefined,
          subject: (item.fields?.original_subject ?? item.summary) as string | undefined,
          original_sent_at: item.fields?.original_sent_at as string | undefined,
          received_at: item.received_at,
          matched_line: m.line,
          matched_pattern: m.pattern,
          full_note: note,
        });
        if (todos.length >= limit) break;
      }
      if (todos.length >= limit) break;
    }

    return c.json({ inbox: name, count: todos.length, todos });
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

  /**
   * After-the-fact annotation — set, append to, or surgically edit
   * `fields.forward_note` on an already-stored item. Pairs with the
   * forward-note flow: forwards landing via email get `forward_note`
   * populated automatically (anything typed before the forwarded block);
   * this endpoint covers the case where the forward had no note OR where
   * the user wants to revise/edit the note later.
   *
   * POST /inbox/:name/items/:id/note
   * Body shapes (mode determines required fields):
   *
   *   { note: string, mode?: 'replace' }    // default — overwrite
   *   { note: string, mode: 'append' }      // join via \n\n---\n\n
   *   { mode: 'edit', find: string, replace: string }   // line-level
   *
   * - `replace` mode: `note` required. Empty string clears.
   * - `append` mode: `note` required. Joins to existing via thematic break.
   * - `edit` mode: `find` + `replace` required. Finds the first line whose
   *   trimmed text equals `find` and rewrites it to `replace`. Other lines
   *   untouched. 404 if no matching line. Useful for marking a single todo
   *   line `[x]` done without overwriting the rest of the note. The /todos
   *   skip rule for `^- [x]` handles "done" lines automatically — so
   *   editing a todo line to start with `- [x]` self-cleans from the todo
   *   view on the next call.
   *
   * Stamps `fields.note_updated_at` (ISO) every call. Identity
   * (id, received_at, source, source_version, summary, body_ref) and
   * labels are preserved; only `fields` change.
   *
   * Returns `{ inbox, item }` or 404 if item id (or `edit`-mode line)
   * not found.
   */
  app.post('/inbox/:name/items/:id/note', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    if (!body || typeof body !== 'object') {
      return badRequest(
        c,
        'body must be { note, mode?: "replace"|"append" } or { mode: "edit", find, replace }',
      );
    }
    const mode = (body as { mode?: unknown }).mode ?? 'replace';
    if (mode !== 'replace' && mode !== 'append' && mode !== 'edit') {
      return badRequest(c, 'mode must be "replace", "append", or "edit"');
    }

    const existing = await inbox.read(id);
    if (!existing) return notFound(c, `item "${id}" not in inbox "${name}"`);

    let nextNote: string;

    if (mode === 'edit') {
      const find = (body as { find?: unknown }).find;
      const replace = (body as { replace?: unknown }).replace;
      if (typeof find !== 'string' || find.length === 0) {
        return badRequest(c, 'edit mode requires non-empty `find` (string)');
      }
      if (typeof replace !== 'string') {
        return badRequest(c, 'edit mode requires `replace` (string; empty string deletes the line)');
      }
      const prev = (existing.fields as Record<string, unknown> | undefined)?.forward_note;
      if (typeof prev !== 'string' || prev.length === 0) {
        return notFound(c, `item "${id}" has no forward_note to edit`);
      }
      // Find the first line whose trimmed content equals `find`.
      const findTrimmed = find.trim();
      const lines = prev.split(/\r?\n/);
      let hitIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === findTrimmed) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx === -1) {
        return notFound(c, `no line matching "${findTrimmed}" found in note`);
      }
      // Empty replace → delete the line entirely (don't leave a blank line).
      const out = [...lines];
      if (replace.length === 0) {
        out.splice(hitIdx, 1);
      } else {
        out[hitIdx] = replace;
      }
      nextNote = out.join('\n');
    } else {
      const note = (body as { note?: unknown }).note;
      if (typeof note !== 'string') {
        return badRequest(c, 'note must be a string (use "" to clear)');
      }
      nextNote = note;
      if (mode === 'append' && note.length > 0) {
        const prev = (existing.fields as Record<string, unknown> | undefined)?.forward_note;
        if (typeof prev === 'string' && prev.length > 0) {
          nextNote = `${prev}\n\n---\n\n${note}`;
        }
      }
    }

    const saved = await inbox._ingest({
      id,
      source: existing.source,
      received_at: existing.received_at,
      fields: {
        forward_note: nextNote,
        note_updated_at: new Date().toISOString(),
      },
    } as InboxItem, { fields_only: true });

    return c.json({ inbox: name, item: saved });
  });

  /**
   * Mark a single item read — removes the `unread` label.
   *
   * POST /inbox/:name/items/:id/read
   *
   * Idempotent: a no-op when the item already doesn't carry `unread`.
   * Returns the updated item + `{ changed: boolean }` so callers can
   * distinguish "did work" from "already read" without re-reading labels.
   * 404 if id not found.
   */
  app.post('/inbox/:name/items/:id/read', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const existing = await inbox.read(id);
    if (!existing) return notFound(c, `item "${id}" not in inbox "${name}"`);

    const labels = existing.labels ?? [];
    if (!labels.includes('unread')) {
      return c.json({ inbox: name, item: existing, changed: false });
    }
    const nextLabels = labels.filter((l) => l !== 'unread');
    const updated = {
      ...existing,
      labels: nextLabels.length > 0 ? nextLabels : undefined,
    };
    const saved = await inbox._ingest(updated, { force: true });
    return c.json({ inbox: name, item: saved, changed: true });
  });

  /**
   * Mark a single item unread — re-adds the `unread` label.
   *
   * POST /inbox/:name/items/:id/unread
   *
   * Idempotent: no-op if already unread. Returns `{ item, changed }`.
   * 404 if id not found.
   */
  app.post('/inbox/:name/items/:id/unread', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const existing = await inbox.read(id);
    if (!existing) return notFound(c, `item "${id}" not in inbox "${name}"`);

    const labels = existing.labels ?? [];
    if (labels.includes('unread')) {
      return c.json({ inbox: name, item: existing, changed: false });
    }
    const updated = {
      ...existing,
      labels: [...labels, 'unread'],
    };
    const saved = await inbox._ingest(updated, { force: true });
    return c.json({ inbox: name, item: saved, changed: true });
  });

  /**
   * Bulk mark-read by id.
   *
   * POST /inbox/:name/read
   * Body: { ids: string[] }
   *
   * Returns `{ total, changed, missing: string[] }` — total attempted,
   * count that actually had `unread` stripped, and ids that didn't
   * resolve to an item. Missing ids are reported, not fatal — the
   * whole batch still commits for the ones that exist.
   */
  app.post('/inbox/:name/read', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    const ids = (body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((s) => typeof s === 'string' && s.length > 0)) {
      return badRequest(c, 'body.ids must be a non-empty array of non-empty strings');
    }

    const missing: string[] = [];
    let changed = 0;
    for (const id of ids as string[]) {
      const item = await inbox.read(id);
      if (!item) {
        missing.push(id);
        continue;
      }
      const labels = item.labels ?? [];
      if (!labels.includes('unread')) continue;
      const nextLabels = labels.filter((l) => l !== 'unread');
      await inbox._ingest(
        { ...item, labels: nextLabels.length > 0 ? nextLabels : undefined },
        { force: true },
      );
      changed++;
    }

    return c.json({ inbox: name, total: ids.length, changed, missing });
  });

  /**
   * Bulk mark-read by filter.
   *
   * POST /inbox/:name/read-all
   * Body: optional InboxFilter — e.g. `{ labels: ["sender:jessica"] }`
   *       to mark-read every Jessica item. Empty body (or `{}`) marks
   *       every currently-unread item read — scoped by default to items
   *       actually carrying `unread` so this doesn't re-page through the
   *       whole inbox.
   *
   * Returns `{ matched, changed }`. Internally always intersects the
   * caller's filter with `{ labels: ["unread"] }` to avoid scanning
   * already-read items. Safe cap at 10,000 items per call — callers
   * wanting larger bulk should page manually via `sm_inbox_query` +
   * `sm_inbox_mark_read_many` with explicit ids.
   */
  app.post('/inbox/:name/read-all', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const body = await readJson(c);
    const userFilter: InboxFilter = (body && typeof body === 'object') ? (body as InboxFilter) : {};

    // Always intersect with `labels: ["unread"]`. If the caller also
    // passed labels, merge — every label must match.
    const mergedLabels = Array.from(
      new Set([...(userFilter.labels ?? []), 'unread']),
    );
    const filter: InboxFilter = { ...userFilter, labels: mergedLabels };

    const HARD_CAP = 10_000;
    const pageLimit = 500;
    let cursor: string | undefined;
    let matched = 0;
    let changed = 0;

    while (true) {
      const page = await inbox.query(filter, { cursor, limit: pageLimit });
      for (const item of page.items) {
        if (matched >= HARD_CAP) break;
        matched++;
        const labels = item.labels ?? [];
        if (!labels.includes('unread')) continue; // belt+braces
        const nextLabels = labels.filter((l) => l !== 'unread');
        await inbox._ingest(
          { ...item, labels: nextLabels.length > 0 ? nextLabels : undefined },
          { force: true },
        );
        changed++;
      }
      if (matched >= HARD_CAP || !page.next_cursor) break;
      cursor = page.next_cursor;
    }

    return c.json({ inbox: name, matched, changed, capped: matched >= HARD_CAP });
  });

  /**
   * Click a double-opt-in confirmation link for a stored item.
   *
   * POST /inbox/:name/confirm/:id
   * Optional query: ?dry-run=true — return the URL without clicking.
   *
   * The item must carry the `needs-confirm` label (set by the confirm-
   * detect hook at ingest time); this guards against the endpoint
   * being used to fetch arbitrary URLs. `fields.confirm_url` must also
   * be present.
   *
   * On successful GET (2xx/3xx): removes `needs-confirm`, adds
   * `confirmed`, writes `fields.confirmed_at` (ISO timestamp) + the
   * upstream status code at `fields.confirm_status`. Returns the
   * updated item + a `result` block with status + excerpt.
   *
   * On upstream failure (4xx/5xx from the provider or network error):
   * does NOT mutate labels — leaves `needs-confirm` so the user can
   * retry. Returns the upstream status under 502 with details.
   */
  app.post('/inbox/:name/confirm/:id', requireAuth, async (c) => {
    const name = c.req.param('name')!;
    const id = c.req.param('id')!;
    const inbox = registry.get(name);
    if (!inbox) return notFound(c, `inbox "${name}" not registered`);

    const existing = await inbox.read(id);
    if (!existing) return notFound(c, `item "${id}" not in inbox "${name}"`);

    const labels = existing.labels ?? [];
    if (!labels.includes('needs-confirm')) {
      return badRequest(
        c,
        `item "${id}" is not tagged "needs-confirm" — refusing to auto-click`,
      );
    }

    const url = (existing.fields as Record<string, unknown> | undefined)?.confirm_url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return badRequest(
        c,
        `item "${id}" has no fields.confirm_url — cannot auto-click`,
      );
    }

    if (c.req.query('dry-run') === 'true') {
      return c.json({ inbox: name, item: existing, dry_run: true, confirm_url: url });
    }

    // Follow redirects, 15s ceiling. Provider confirm endpoints are fast;
    // anything longer almost certainly means upstream is down.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let status: number;
    let excerpt: string;
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'smallstore-confirm/1.0' },
      });
      status = res.status;
      // Read enough to confirm success but don't store the whole page.
      const text = await res.text();
      excerpt = text.slice(0, 500);
      if (status >= 400) {
        return c.json(
          {
            error: 'UpstreamError',
            message: `confirm URL returned HTTP ${status}`,
            status,
            excerpt,
          },
          502,
        );
      }
    } catch (err) {
      return c.json(
        {
          error: 'FetchFailed',
          message: err instanceof Error ? err.message : String(err),
          url,
        },
        502,
      );
    } finally {
      clearTimeout(timer);
    }

    const nextLabels = Array.from(
      new Set([...labels.filter((l) => l !== 'needs-confirm'), 'confirmed']),
    );
    const updated = {
      ...existing,
      labels: nextLabels,
      fields: {
        ...(existing.fields ?? {}),
        confirmed_at: new Date().toISOString(),
        confirm_status: status,
      },
    };
    const saved = await inbox._ingest(updated, { force: true });
    return c.json({
      inbox: name,
      item: saved,
      result: { status, excerpt, confirm_url: url },
    });
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
  // Webhook ingest
  //
  // POST /webhook/:peer
  //   Inbound webhook handler. Looks up the peer's `webhook_config`, optionally
  //   verifies HMAC, parses the JSON body, and ingests via the configured
  //   `target_inbox`. Does NOT use `requireAuth` — HMAC is the auth mechanism.
  //   When a peer has no HMAC config, its webhook URL is unauthenticated by
  //   design (caller's choice; document the trade-off in your peer setup).
  // --------------------------------------------------------------------------

  app.post('/webhook/:peer', async (c) => {
    if (!webhookConfigFor) {
      return c.json({ error: 'webhook routes not enabled (webhookConfigFor not provided)' }, 501);
    }

    const peerName = c.req.param('peer')!;
    const config = await Promise.resolve(webhookConfigFor(peerName));
    if (!config) return notFound(c, `webhook peer "${peerName}" not registered`);
    if (!config.target_inbox) {
      return c.json({ error: `webhook peer "${peerName}" missing target_inbox in config` }, 500);
    }

    const inbox = registry.get(config.target_inbox);
    if (!inbox) return notFound(c, `target inbox "${config.target_inbox}" not registered`);

    // Read raw body once — needed both for HMAC verify and JSON parse.
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return badRequest(c, 'failed to read request body');
    }

    if (config.hmac) {
      if (!resolveHmacSecret) {
        return c.json({ error: 'webhook HMAC required but resolveHmacSecret not provided' }, 500);
      }
      const secret = resolveHmacSecret(config.hmac.secret_env);
      if (!secret) {
        return c.json({ error: `HMAC secret env "${config.hmac.secret_env}" not set` }, 500);
      }
      const headerVal = c.req.header(config.hmac.header) ?? '';
      const sig = config.hmac.prefix && headerVal.startsWith(config.hmac.prefix)
        ? headerVal.slice(config.hmac.prefix.length)
        : headerVal;
      const valid = await verifyHmac(rawBody, sig, secret, config.hmac.algorithm ?? 'sha256');
      if (!valid) {
        return c.json({ error: 'webhook signature verification failed' }, 401);
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return badRequest(c, 'webhook body must be valid JSON');
    }

    const result = await webhookChannel.parse(
      { payload, peer_name: peerName, received_at: new Date().toISOString() },
      config,
    );
    if (!result) {
      return c.json({ error: 'webhook channel returned no item' }, 500);
    }

    const stored = await inbox._ingest(result.item);
    return c.json({ inbox: config.target_inbox, peer: peerName, item: stored });
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

    // Runtime-created inboxes auto-namespace within their storage adapter so
    // multiple runtime inboxes can share one D1 table without `_index` rows
    // trampling each other. Boot-time inboxes (declared in .smallstore.json)
    // keep the historical bare-key layout — they get a dedicated adapter.
    const finalConfig: InboxConfig = {
      ...(config as InboxConfig),
      keyPrefix: (config as InboxConfig).keyPrefix ?? `inbox/${name}/`,
    };

    const inbox = await createInbox(name, finalConfig);
    registry.register(name, inbox, finalConfig, 'runtime');

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

  // --------------------------------------------------------------------------
  // Hook replay — retroactive field backfill
  //
  // POST /admin/inboxes/:name/replay
  //   Body: { hook: 'forward-detect' | ..., filter?: InboxFilter, dry_run?: boolean, limit?: number }
  //
  // Re-runs a registered hook over existing items matching `filter`. For each
  // verdict that's an item, merges fields + unions labels via fields_only
  // ingest. Identity (id/received_at/source) preserved; index untouched. The
  // generic version of `RulesStore.applyRetroactive` — works on any registered
  // hook. See `.brief/forward-notes-and-newsletter-profiles.md` Phase 3.
  //
  // Response shape:
  //   { inbox, hook, dry_run, scanned, matched, applied, skipped: { drop, quarantine },
  //     errors: [{ id, message }], samples?: [{ id, before_fields, after_fields, added_labels }] }
  //
  // dry_run=true: no writes; samples populated with up to 10 representative diffs.
  // --------------------------------------------------------------------------

  app.post('/admin/inboxes/:name/replay', requireAuth, async (c) => {
    const inboxName = c.req.param('name')!;
    const inbox = registry.get(inboxName);
    if (!inbox) return notFound(c, `inbox "${inboxName}" not registered`);

    if (!replayHookFor) {
      return c.json({ error: 'NotImplemented', message: 'replayHookFor not provided' }, 501);
    }

    const body = await readJson(c);
    const hookName = typeof body?.hook === 'string' ? body.hook : null;
    if (!hookName) return badRequest(c, 'body.hook (string) required');

    const hook = replayHookFor(inboxName, hookName);
    if (!hook) {
      return notFound(
        c,
        `no hook "${hookName}" registered on inbox "${inboxName}"`,
      );
    }

    const filter: InboxFilter = (body && typeof body.filter === 'object' && body.filter)
      ? body.filter
      : {};
    const dryRun = body?.dry_run === true;
    const limit = parseLimit(body?.limit) ?? 10_000;

    // Pull all matching items (no cursor; replay is bounded by limit).
    const queryResult = await inbox.query(filter, { limit });
    const matched = queryResult.items;

    let applied = 0;
    let dropCount = 0;
    let quarantineCount = 0;
    const errors: Array<{ id: string; message: string }> = [];
    const samples: Array<{
      id: string;
      added_fields: Record<string, unknown>;
      added_labels: string[];
    }> = [];

    const ctx = { channel: inbox.channel, registration: inboxName };

    const anyInbox = inbox as unknown as {
      _ingest: (
        item: import('./types.ts').InboxItem,
        opts?: import('./types.ts').IngestOptions,
      ) => Promise<import('./types.ts').InboxItem>;
    };

    for (const item of matched) {
      try {
        const verdict = await hook(item, ctx);
        if (verdict === 'accept') continue;
        if (verdict === 'drop') {
          dropCount++;
          continue;
        }
        if (verdict === 'quarantine') {
          quarantineCount++;
          continue;
        }
        // Verdict is an updated InboxItem — extract diff.
        const updatedItem = verdict as import('./types.ts').InboxItem;
        const beforeFields = (item.fields ?? {}) as Record<string, unknown>;
        const afterFields = (updatedItem.fields ?? {}) as Record<string, unknown>;
        const addedFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(afterFields)) {
          if (beforeFields[k] !== v) addedFields[k] = v;
        }
        const beforeLabels = new Set(item.labels ?? []);
        const addedLabels = (updatedItem.labels ?? []).filter((l) => !beforeLabels.has(l));

        if (Object.keys(addedFields).length === 0 && addedLabels.length === 0) continue;

        if (samples.length < 10) {
          samples.push({ id: item.id, added_fields: addedFields, added_labels: addedLabels });
        }
        if (!dryRun) {
          await anyInbox._ingest(
            { ...updatedItem, id: item.id }, // id pin guards against any hook bug
            { fields_only: true },
          );
        }
        applied++;
      } catch (err) {
        errors.push({
          id: item.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({
      inbox: inboxName,
      hook: hookName,
      dry_run: dryRun,
      scanned: matched.length,
      matched: matched.length,
      applied,
      skipped: { drop: dropCount, quarantine: quarantineCount },
      errors,
      ...(dryRun && { samples }),
    });
  });

  // --------------------------------------------------------------------------
  // Auto-confirm senders — runtime-editable allowlist (Worker-global)
  // --------------------------------------------------------------------------
  // The auto-confirm hook (postClassify on cf-email inboxes) reads this
  // store on every invocation (cached briefly). Adding a pattern here
  // takes effect within the cache TTL — no redeploy needed.

  app.get('/admin/auto-confirm/senders', requireAuth, async (c) => {
    if (!autoConfirmSendersStore) {
      return c.json(
        { error: 'NotImplemented', message: 'autoConfirmSendersStore not provided' },
        501,
      );
    }
    const senders = await autoConfirmSendersStore.list();
    return c.json({ senders });
  });

  app.post('/admin/auto-confirm/senders', requireAuth, async (c) => {
    if (!autoConfirmSendersStore) {
      return c.json(
        { error: 'NotImplemented', message: 'autoConfirmSendersStore not provided' },
        501,
      );
    }
    const body = await readJson(c);
    if (!body || typeof body !== 'object') return badRequest(c, 'body required');
    if (typeof body.pattern !== 'string' || body.pattern.trim().length === 0) {
      return badRequest(c, 'body.pattern (non-empty string) required');
    }
    if (body.notes !== undefined && typeof body.notes !== 'string') {
      return badRequest(c, 'body.notes must be a string when provided');
    }
    const created = await autoConfirmSendersStore.add({
      pattern: body.pattern,
      source: 'runtime',
      notes: body.notes,
    });
    return c.json({ created }, 201);
  });

  app.delete('/admin/auto-confirm/senders/:pattern', requireAuth, async (c) => {
    if (!autoConfirmSendersStore) {
      return c.json(
        { error: 'NotImplemented', message: 'autoConfirmSendersStore not provided' },
        501,
      );
    }
    // The pattern is URL-encoded by the caller (it contains `*` and `@`).
    // Hono's `c.req.param` returns the decoded value, but be defensive
    // for double-encoded callers.
    const raw = c.req.param('pattern')!;
    let pattern: string;
    try {
      pattern = decodeURIComponent(raw);
    } catch {
      pattern = raw;
    }
    const removed = await autoConfirmSendersStore.delete(pattern);
    if (!removed) return notFound(c, `pattern "${pattern}" not found`);
    return c.json({ deleted: pattern });
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

const VALID_ORDER_BY = new Set(['received_at', 'sent_at', 'original_sent_at']);
function parseOrderBy(raw: string | undefined): ListOptions['order_by'] {
  if (!raw) return undefined;
  return VALID_ORDER_BY.has(raw) ? (raw as ListOptions['order_by']) : undefined;
}

/** Strip "<addr@host>" tail from a "Display Name <addr@host>" form. */
function stripAngleAddr(raw: string): string {
  const lt = raw.indexOf('<');
  return lt === -1 ? raw.trim() : raw.slice(0, lt).trim().replace(/^["']|["']$/g, '');
}

/** Escape regex meta-chars so a slug can be embedded in a regex pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
