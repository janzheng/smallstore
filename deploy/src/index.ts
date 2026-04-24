/**
 * smallstore — Cloudflare Worker entry.
 *
 * Composes a Hono app with:
 *   - Smallstore's universal `/api/*` CRUD surface
 *   - The messaging plugin family (`/inbox/*`, `/admin/*`)
 *   - The CF Email Routing `email()` handler
 *
 * Deploys to `smallstore.labspace.ai` (route in wrangler.toml).
 *
 * Bindings (declared in wrangler.toml):
 *   - SMALLSTORE_TOKEN — bearer token for /api + /inbox + /admin (secret)
 *   - MAILROOM_D1      — D1 database backing the mailroom inbox's items
 *   - MAILROOM_R2      — R2 bucket backing the mailroom inbox's blobs
 *
 * Initialization is lazy + cached at module scope: the first request (or
 * the first `email()` invocation) builds the Hono app + smallstore +
 * inbox registry, and subsequent requests reuse it for the lifetime of
 * the isolate (typical: minutes, may be days). CF spins up a fresh
 * isolate on cold start, which re-runs init.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
// Import from `factory-slim` (not root `@yawnxyz/smallstore`) to avoid pulling
// the full adapter barrel — the root re-exports SQLite/local-file etc that
// reference `Deno` at module init and break in the Workers runtime.
import { createSmallstore } from '@yawnxyz/smallstore/factory-slim';
import { createHonoRoutes } from '@yawnxyz/smallstore/http';
import { createMemoryAdapter } from '@yawnxyz/smallstore/adapters/memory';
import { createCloudflareD1Adapter } from '@yawnxyz/smallstore/adapters/cloudflare-d1';
import { createCloudflareR2Adapter } from '@yawnxyz/smallstore/adapters/cloudflare-r2';
import {
  createInbox,
  createEmailHandler,
  cloudflareEmailChannel,
  createSenderAliasHook,
  createSenderIndex,
  createForwardDetectHook,
  createPlusAddrHook,
  createRulesStore,
  createRulesHook,
  createRssPullRunner,
  parseSelfAddresses,
  parseSenderAliases,
  registerChannel,
  registerMessagingRoutes,
  rssChannel,
  InboxRegistry,
  type HookContext,
  type HookVerdict,
  type InboxConfig,
  type InboxItem,
  type PullRunner,
  type RulesStore,
  type SenderIndex,
} from '@yawnxyz/smallstore/messaging';
import {
  createPeerStore,
  registerPeersRoutes,
  type PeerStore,
} from '@yawnxyz/smallstore/peers';

// ============================================================================
// Env shape
// ============================================================================

export interface Env {
  /** Bearer token for all routes; if unset, routes are open (NOT recommended). */
  SMALLSTORE_TOKEN?: string;
  /** D1 binding for the mailroom inbox's structured rows. */
  MAILROOM_D1: D1Database;
  /** R2 binding for the mailroom inbox's blobs (raw .eml, html, attachments). */
  MAILROOM_R2: R2Bucket;
  /**
   * Comma-separated list of the user's own email addresses. Used by the
   * forward-detection hook to recognize mail the user forwarded from their
   * own account (e.g. from Gmail) as "manual / forwarded" bookmarks.
   * Example: `jan@phage.directory,hello@janzheng.com`. Optional — if unset,
   * the hook falls back to header-only detection (X-Forwarded-For etc).
   */
  SELF_ADDRESSES?: string;
  /**
   * Comma-separated sender-name aliases — `pattern:name,pattern:name`.
   * Each entry maps a sender-address glob (`*` wildcard) to a canonical
   * display name. First-match-wins. The hook writes `fields.sender_name`
   * and merges a `sender:<slug>` label onto every match.
   *
   * Example:
   *   `jessica.c.sacher@*:Jessica,jan@phage.directory:Jan,janzheng@*:Jan`
   *
   * Optional — unset disables the hook.
   */
  SENDER_ALIASES?: string;
}

// ============================================================================
// Lazy-init container
// ============================================================================

interface AppHandle {
  app: Hono;
  email: ReturnType<typeof createEmailHandler>;
  senderIndexes: Map<string, SenderIndex>;
  rulesStores: Map<string, RulesStore>;
  peerStore: PeerStore;
  rssRunner: PullRunner;
}

let appHandle: AppHandle | null = null;

function buildApp(env: Env): AppHandle {
  // Adapters
  const d1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'mailroom_items' });
  const r2 = createCloudflareR2Adapter({ binding: env.MAILROOM_R2 });
  const memory = createMemoryAdapter();
  // D1 in generic k/v mode (messaging: false is default) for sender-index
  // persistence. Same MAILROOM_D1 binding, different table. Cheap —
  // ensureTable() creates mailroom_senders lazily on first write. Replaces
  // the earlier memory-backed sender-index which reset on every isolate
  // cold-start.
  const senderD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'mailroom_senders' });
  // Rules table — same D1 binding, generic k/v mode. Table created lazily.
  const rulesD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'mailroom_rules' });
  // Peers table — runtime-configurable registry of external data sources
  // (tigerflare, sheetlogs, other smallstores, etc.). Same D1 binding.
  // See `.brief/peer-registry.md`.
  const peersD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'peers' });

  // Per-inbox D1 adapters. Each inbox needs its OWN table because the
  // Inbox class uses hardcoded keys ('_index', 'items/<id>') that would
  // collide if multiple inboxes shared one adapter. Until the planned
  // `keyPrefix` option lands on Inbox, register one adapter per inbox here.
  // See `.brief/rss-as-mailbox.md` § correction.
  const biorxivD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'biorxiv_items' });
  const podcastsD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'podcasts_items' });

  // Smallstore — D1 as default (objects), R2 mounted at blobs/*
  const smallstore = createSmallstore({
    adapters: {
      memory,
      mailroom_d1: d1,
      mailroom_r2: r2,
    },
    defaultAdapter: 'memory',
    routing: {
      'mailroom/*': { adapter: 'mailroom_d1' },
      'blobs/*': { adapter: 'mailroom_r2' },
    },
    typeRouting: { blob: 'mailroom_r2' },
  });

  // Auth middleware (reused by both /api and /inbox + /admin)
  const requireAuth = (c: Context, next: Next) => {
    const token = env.SMALLSTORE_TOKEN;
    if (!token) return next();
    const header = c.req.header('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== token) {
      return c.json({ error: 'Unauthorized', message: 'Missing or invalid Authorization bearer token' }, 401);
    }
    return next();
  };

  // Channel registration (idempotent across isolates — already-registered throws is caught).
  // cf-email is the push channel; rss is the pull channel used by the scheduled()
  // handler to iterate `type: 'rss'` peers and dispatch parsed items into the
  // inbox named in each peer's `metadata.feed_config.target_inbox`.
  try { registerChannel(cloudflareEmailChannel); } catch { /* noop */ }
  try { registerChannel(rssChannel); } catch { /* noop */ }

  // Messaging registry — boot-time inbox: mailroom (cf-email + d1 items + r2 blobs)
  const registry = new InboxRegistry();

  // Adapter pool by name (matches the smallstore.adapters keys above).
  // Runtime-created inboxes (via POST /admin/inboxes) reference adapters
  // by name in their `storage:` config; we resolve here.
  const adapterByName: Record<string, any> = {
    mailroom_d1: d1,
    mailroom_r2: r2,
    biorxiv_d1: biorxivD1,  // dedicated table to avoid index collision with mailroom
    podcasts_d1: podcastsD1,  // same rationale — podcast feeds land here
    memory,
  };

  const buildInboxFromConfig = async (name: string, cfg: InboxConfig) => {
    const ref = cfg.storage;
    const items = typeof ref === 'string' ? adapterByName[ref] : adapterByName[ref.items];
    const blobs = typeof ref === 'string' ? undefined : ref.blobs ? adapterByName[ref.blobs] : undefined;
    if (!items) throw new Error(`Inbox storage references unknown adapter`);
    return createInbox({ name, channel: cfg.channel, storage: { items, blobs } });
  };

  const mailroomConfig: InboxConfig = {
    channel: 'cf-email',
    storage: { items: 'mailroom_d1', blobs: 'mailroom_r2' },
  };
  const mailroom = createInbox({
    name: 'mailroom',
    channel: 'cf-email',
    storage: { items: d1, blobs: r2 },
  });

  // Sender index — per-sender aggregates (count, first_seen, last_seen,
  // list_unsubscribe_url, spam_count, tags). Persisted in D1 via senderD1
  // (table mailroom_senders) so aggregates survive Worker cold-starts.
  // The keyPrefix isolates sender keys within the table in case we later
  // register a second sender-index scope under the same table.
  const senderIndexes = new Map<string, SenderIndex>();
  const mailroomSenderIndex = createSenderIndex(senderD1, { keyPrefix: 'senders/' });
  senderIndexes.set('mailroom', mailroomSenderIndex);

  // Rules store — runtime-editable archive/bookmark/tag/drop/quarantine
  // rules per inbox. Same D1 binding, dedicated table. Rules are matched
  // against InboxItem via the existing filter DSL (including regex).
  const rulesStores = new Map<string, RulesStore>();
  const mailroomRulesStore = createRulesStore(rulesD1, { keyPrefix: 'rules/' });
  rulesStores.set('mailroom', mailroomRulesStore);

  // -------------------------------------------------------------------------
  // Hook pipeline (curation-aware)
  // -------------------------------------------------------------------------
  //
  // preIngest order matters:
  //   1. forward-detect — detects mail the user forwarded from Gmail (via
  //      SELF_ADDRESSES match or X-Forwarded-* headers), tags 'forwarded' +
  //      'manual', extracts original_from_* + forward_note into fields.
  //      Runs first so plus-addressing intent (next) can OVERRIDE the
  //      'manual' label when the user explicitly typed mailroom+bookmark@...
  //      — and so sender-aliases can key off `original_from_email`.
  //   2. sender-aliases — maps a sender-address glob (including the
  //      extracted original sender on forwards) to a canonical display name,
  //      writes `fields.sender_name` and a `sender:<slug>` label. Non-
  //      destructive — existing from_email filters keep working.
  //   3. plus-addr — reads inbox_addr for +intent suffix, tags accordingly.
  //      Explicit intent wins over auto-detection.
  //   4. rules — evaluates user-configured archive/bookmark/tag/drop/quarantine
  //      rules against the (possibly-already-mutated) item. Tag-style rules
  //      stack; terminal rules (drop/quarantine) short-circuit.
  //
  // postClassify hooks run AFTER the built-in classifier emits its labels,
  // so sender-index upsert sees canonical tags.
  const selfAddresses = parseSelfAddresses(env.SELF_ADDRESSES);
  const senderAliases = parseSenderAliases(env.SENDER_ALIASES);
  const forwardDetectHook = createForwardDetectHook({ selfAddresses });
  const senderAliasHook = createSenderAliasHook({ aliases: senderAliases });
  const plusAddrHook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const rulesHook = createRulesHook({ rulesStore: mailroomRulesStore });

  // Side-effect postClassify hook — updates sender-index on every ingest.
  const senderUpsertHook = async (item: InboxItem, _ctx: HookContext): Promise<HookVerdict> => {
    try {
      await mailroomSenderIndex.upsert(item);
    } catch (err) {
      console.log(`[sender-upsert] failed for ${item.id}:`, err instanceof Error ? err.message : err);
    }
    return 'accept';
  };

  registry.registerSinks('mailroom', {
    inbox: mailroom,
    hooks: {
      preIngest: [forwardDetectHook, senderAliasHook, plusAddrHook, rulesHook],
      postClassify: [senderUpsertHook],
    },
    config: mailroomConfig,
    origin: 'boot',
  });

  // Boot-time RSS inbox: biorxiv. Has its own D1 table (`biorxiv_items`)
  // because the Inbox class uses hardcoded `_index` + `items/` keys that
  // would collide if it shared an adapter with mailroom. The pull-runner
  // dispatches every `metadata.feed_config.target_inbox: 'biorxiv'` peer
  // here on the cron tick. Promoted from runtime → boot so it survives
  // Worker isolate restarts.
  const biorxivConfig: InboxConfig = {
    channel: 'rss',
    storage: 'biorxiv_d1',
  };
  const biorxivInbox = createInbox({
    name: 'biorxiv',
    channel: 'rss',
    storage: { items: biorxivD1 },
  });
  registry.register('biorxiv', biorxivInbox, biorxivConfig, 'boot');

  // Boot-time RSS inbox: podcasts. Same shape as biorxiv — dedicated D1
  // table (`podcasts_items`) to keep the `_index` + `items/` keyspace
  // isolated. Every `metadata.feed_config.target_inbox: 'podcasts'`
  // peer dispatches here.
  const podcastsConfig: InboxConfig = {
    channel: 'rss',
    storage: 'podcasts_d1',
  };
  const podcastsInbox = createInbox({
    name: 'podcasts',
    channel: 'rss',
    storage: { items: podcastsD1 },
  });
  registry.register('podcasts', podcastsInbox, podcastsConfig, 'boot');

  // Hono app
  const app = new Hono();

  const VERSION = '0.2.0';
  app.get('/health', (c) => c.json({ status: 'ok', service: 'smallstore', version: VERSION }));
  app.get('/', (c) =>
    c.json({
      name: 'smallstore',
      version: VERSION,
      inboxes: registry.list(),
      endpoints: {
        api: 'GET/POST /api/:collection',
        inbox_list: 'GET /inbox/:name',
        inbox_query: 'POST /inbox/:name/query',
        inbox_rules: 'GET/POST /inbox/:name/rules',
        inbox_export: 'GET /inbox/:name/export?format=jsonl',
        admin_inboxes: 'GET /admin/inboxes',
        peers: 'GET/POST /peers',
        peers_proxy: 'GET /peers/:name/fetch?path=... | POST /peers/:name/query',
      },
    }),
  );

  // Messaging routes (mount before /api so wildcards stay disjoint).
  // `senderIndexFor` resolves the per-inbox sender index for the unsubscribe
  // route (POST /inbox/:name/unsubscribe); `rulesStoreFor` unlocks the
  // /rules CRUD + retroactive-apply endpoints per inbox. Both return null
  // for inboxes without those resources, in which case the routes 501.
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInboxFromConfig,
    senderIndexFor: (name: string) => senderIndexes.get(name) ?? null,
    rulesStoreFor: (name: string) => rulesStores.get(name) ?? null,
  });

  // Peer registry routes — /peers CRUD + /peers/:name/{health,fetch,query}
  // proxy surface. env is passed so the proxy can resolve env-referenced
  // auth secrets (e.g. `{ kind: 'bearer', token_env: 'TF_TOKEN' }` →
  // Authorization: Bearer ${env.TF_TOKEN}).
  const peerStore = createPeerStore(peersD1, { keyPrefix: 'peers/' });
  registerPeersRoutes(app, {
    peerStore,
    requireAuth,
    env: env as unknown as Record<string, string | undefined>,
  });

  // RSS pull-runner — the in-Worker feed poller. Iterates every peer with
  // type='rss', fetches the feed, and dispatches parsed items through the
  // inbox named in metadata.feed_config.target_inbox. Invoked by the
  // scheduled() handler on the cron in wrangler.toml; also exposed at
  // POST /admin/rss/poll[/:peer] for manual triggering.
  const rssRunner = createRssPullRunner({
    peerStore,
    registry,
    env: env as unknown as Record<string, string | undefined>,
    log: (msg, extra) => console.log(`[rss-runner] ${msg}`, JSON.stringify(extra ?? {})),
  });

  // Manual triggers — handy for debugging without waiting for cron, and for
  // ad-hoc "pull this one feed right now" flows (Shortcuts, MCP clients, etc).
  app.post('/admin/rss/poll', requireAuth, async (c) => {
    const summary = await rssRunner.pollAll();
    return c.json(summary);
  });
  app.post('/admin/rss/poll/:peer', requireAuth, async (c) => {
    const name = c.req.param('peer') ?? '';
    if (!name) {
      return c.json({ error: 'Bad Request', message: 'peer name required' }, 400);
    }
    const result = await rssRunner.pollOne(name);
    if (!result) {
      return c.json({ error: 'Not Found', message: `no rss peer named "${name}"` }, 404);
    }
    return c.json(result);
  });

  // Universal CRUD surface at /api/*
  createHonoRoutes(app, smallstore, '/api');

  // email() handler: runs the parse → preIngest → classify → postClassify
  // → sinks → postStore pipeline. Built-in classify emits label set so
  // consumers can filter by `newsletter` / `list` / `bulk` / `auto-reply` /
  // `bounce` out of the box.
  const email = createEmailHandler({
    registry,
    log: (msg, extra) => console.log(`[email] ${msg}`, JSON.stringify(extra ?? {})),
  });

  return { app, email, senderIndexes, rulesStores, peerStore, rssRunner };
}

function ensureApp(env: Env): AppHandle {
  if (!appHandle) appHandle = buildApp(env);
  return appHandle;
}

// ============================================================================
// Worker entry
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { app } = ensureApp(env);
    return app.fetch(request, env, ctx);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const { email } = ensureApp(env);
    return email(message as any, env, ctx);
  },

  /**
   * CF cron trigger. Fires on the schedule declared in wrangler.toml
   * (`*\/30 * * * *` at time of writing). Iterates every `type: 'rss'` peer,
   * fetches the feed, and dispatches parsed items into the inbox named in
   * each peer's `metadata.feed_config.target_inbox`. Non-throwing — the
   * runner captures per-feed errors in its summary, which we just log.
   *
   * `ctx.waitUntil` would allow long-running polls past the immediate
   * completion window but cron invocations get their own CPU budget; we
   * await directly for simpler error reporting.
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { rssRunner } = ensureApp(env);
    const summary = await rssRunner.pollAll();
    console.log('[scheduled] rss run complete', JSON.stringify({
      cron: event.cron,
      scheduled_time: new Date(event.scheduledTime).toISOString(),
      feeds_seen: summary.feeds_seen,
      feeds_polled: summary.feeds_polled,
      feeds_errored: summary.feeds_errored,
      items_stored: summary.items_stored,
      items_dropped: summary.items_dropped,
      duration_ms: summary.duration_ms,
    }));
  },
};
