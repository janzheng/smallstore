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
import { createHonoRoutes, timingSafeEqualString } from '@yawnxyz/smallstore/http';
import { createMemoryAdapter } from '@yawnxyz/smallstore/adapters/memory';
import { createCloudflareD1Adapter } from '@yawnxyz/smallstore/adapters/cloudflare-d1';
import { createCloudflareR2Adapter } from '@yawnxyz/smallstore/adapters/cloudflare-r2';
import {
  createInbox,
  createEmailHandler,
  cloudflareEmailChannel,
  createAutoConfirmHook,
  createConfirmDetectHook,
  createNewsletterNameHook,
  createSenderAliasHook,
  createSenderIndex,
  createForwardDetectHook,
  createPlusAddrHook,
  createRulesStore,
  createRulesHook,
  createRssPullRunner,
  createAutoConfirmSendersStore,
  seedAutoConfirmFromEnv,
  createStampUnreadHook,
  parseSelfAddresses,
  parseSenderAliases,
  registerChannel,
  registerMessagingRoutes,
  rssChannel,
  runMirror,
  runUnreadSweep,
  InboxRegistry,
  type HookContext,
  type HookVerdict,
  type InboxConfig,
  type InboxItem,
  type PullRunner,
  type RulesStore,
  type AutoConfirmSendersStore,
  type SenderIndex,
} from '@yawnxyz/smallstore/messaging';
import {
  createPeerStore,
  defaultEnvAllowlist,
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
  /**
   * Comma-separated sender-address globs that opt into auto-confirmation
   * of double-opt-in subscription links. When a confirmation email from
   * one of these senders arrives, the worker GETs the extracted
   * `fields.confirm_url` automatically and swaps the `needs-confirm`
   * label for `auto-confirmed`.
   *
   * Safety: only HTTPS URLs with named-domain hosts (no raw IPs); paths
   * containing `unsubscribe` / `opt-out` are rejected even if the sender
   * is allowlisted. Non-allowlisted senders still land in the
   * `needs-confirm` queue for manual click via the confirm endpoint.
   *
   * Example (common newsletter platforms):
   *   `*@substack.com,*@convertkit.com,*@beehiiv.com,*@mailerlite.com,*@emailoctopus.com`
   *
   * Optional — unset disables auto-confirmation (all confirmations
   * become manual).
   */
  AUTO_CONFIRM_SENDERS?: string;
  /**
   * Days before stale unread items get auto-marked-read by the cron.
   * Items with `received_at < (now - N days)` AND the `unread` label
   * get the label removed. Set to `0` (or unset) to disable. Default
   * when unset: disabled. Recommended: `30`. Items remain queryable
   * post-sweep — only the `unread` label is removed.
   */
  UNREAD_SWEEP_DAYS?: string;
}

// ============================================================================
// Lazy-init container
// ============================================================================

interface AppHandle {
  app: Hono;
  email: ReturnType<typeof createEmailHandler>;
  senderIndexes: Map<string, SenderIndex>;
  rulesStores: Map<string, RulesStore>;
  autoConfirmSendersStore: AutoConfirmSendersStore;
  peerStore: PeerStore;
  rssRunner: PullRunner;
  /** Trigger the cron mirror over every peer with `metadata.mirror_config`. */
  runMirror: () => ReturnType<typeof runMirror>;
  /**
   * Inbox registry — needed at the cron-handler scope so the unread-sweep
   * can iterate registered inboxes without re-building the app.
   */
  registry: InboxRegistry;
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
  // Auto-confirm senders table — Worker-global allowlist (one row per pattern).
  // Same D1 binding, dedicated table. Mutated via `/admin/auto-confirm/senders`
  // and the `sm_auto_confirm_*` MCP tools; seeded from `AUTO_CONFIRM_SENDERS`
  // env var on first boot (idempotent — patterns deleted via API stay deleted).
  const autoConfirmD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'mailroom_auto_confirm' });
  // Peers table — runtime-configurable registry of external data sources
  // (tigerflare, sheetlogs, other smallstores, etc.). Same D1 binding.
  // See `.brief/peer-registry.md`.
  const peersD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'peers' });

  // Per-inbox D1 adapters. These boot-time inboxes were created BEFORE
  // `Inbox.keyPrefix` shipped, so each owns a dedicated table to keep the
  // historical bare `_index` + `items/<id>` keys non-colliding. Newer
  // runtime-created inboxes (via POST /admin/inboxes) auto-namespace via
  // `keyPrefix: 'inbox/<name>/'` and can share a single adapter.
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

  // Auth middleware (reused by both /api and /inbox + /admin).
  //
  // Three-state token handling (B001):
  //   - undefined  → routes open. Documented dev-mode behavior; keep for
  //                  back-compat with local wrangler dev workflows.
  //   - "" / "  "  → fail closed. Operator clearly intended auth on but the
  //                  value is botched (CI mistake, accidental clobber). The
  //                  pre-fix behavior here was to silently open the routes
  //                  because empty string is falsy — that's the bug.
  //   - non-empty  → require bearer match (constant-time, B011).
  const tokenRaw = env.SMALLSTORE_TOKEN;
  const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : undefined;
  const tokenMisconfigured = typeof tokenRaw === 'string' && !token;
  if (tokenMisconfigured) {
    console.error('[auth] SMALLSTORE_TOKEN is set but empty/whitespace — failing closed on protected routes');
  }
  const requireAuth = (c: Context, next: Next) => {
    if (tokenRaw === undefined) return next();
    if (!token) {
      // Set-but-empty: never open routes silently.
      return c.json({ error: 'Unauthorized', message: 'Server token misconfigured' }, 401);
    }
    const header = c.req.header('authorization') ?? '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeEqualString(m[1], token)) {
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
    return createInbox({ name, channel: cfg.channel, storage: { items, blobs }, keyPrefix: cfg.keyPrefix });
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

  // Auto-confirm sender allowlist — runtime-editable, Worker-global. The
  // postClassify auto-confirm hook reads this on every invocation (cached
  // for 30s). Boot-time seed: any pattern in AUTO_CONFIRM_SENDERS that
  // isn't already in the store is added as `source: 'env'`. Runtime
  // deletes win — the seed will not re-add a pattern the user removed.
  const autoConfirmSendersStore = createAutoConfirmSendersStore(autoConfirmD1, {
    keyPrefix: 'auto-confirm/',
  });

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
  // postClassify order:
  //   1. newsletter-name — if the classifier tagged `newsletter` and there's
  //      no manual `sender:*` label, derive `newsletter:<slug>` from the
  //      From display name (e.g. `"Sidebar.io" <...>` → `newsletter:sidebar-io`).
  //   2. confirm-detect — subject heuristic + URL extraction. Tags
  //      `needs-confirm` + writes `fields.confirm_url` for double-opt-in
  //      confirmation mail. Gated on `newsletter` label to avoid false
  //      positives from password-reset / account-verification flows.
  //   3. auto-confirm — for senders matching AUTO_CONFIRM_SENDERS globs,
  //      GETs the extracted confirm_url at ingest time; on success swaps
  //      `needs-confirm` → `auto-confirmed`. Non-allowlisted senders fall
  //      through to manual confirmation via POST /inbox/:name/confirm/:id.
  //   4. stamp-unread — adds `unread` to new items so `{labels:["unread"]}`
  //      queries work. Idempotent + skips terminal labels (archived,
  //      quarantined) so re-ingests from /tag or /confirm don't resurrect it.
  //   5. sender-index upsert — final, so the upsert sees every label above.
  const selfAddresses = parseSelfAddresses(env.SELF_ADDRESSES);
  const senderAliases = parseSenderAliases(env.SENDER_ALIASES);
  const forwardDetectHook = createForwardDetectHook({ selfAddresses });
  const senderAliasHook = createSenderAliasHook({ aliases: senderAliases });
  const plusAddrHook = createPlusAddrHook({ baseLocal: 'mailroom' });
  const rulesHook = createRulesHook({ rulesStore: mailroomRulesStore });

  // postClassify hooks — run AFTER the classifier emits labels, so these
  // can key off `newsletter` (classifier-applied) without ordering pain.
  const newsletterNameHook = createNewsletterNameHook();
  const confirmDetectHook = createConfirmDetectHook();
  // Auto-confirm: dynamic source (D1-backed store). Hook calls
  // `getPatterns()` on every invocation, cached for 30s. Adding a
  // pattern via `POST /admin/auto-confirm/senders` takes effect within
  // the cache window — no redeploy. Env var still seeds the store on
  // first boot (see `seedAutoConfirmFromEnv` below).
  const autoConfirmHook = createAutoConfirmHook({
    getPatterns: () => autoConfirmSendersStore.patterns(),
    // Wire the store's mutation channel into the hook's cache invalidation
    // so a `DELETE /admin/auto-confirm/senders/:pattern` takes effect on
    // the next ingest, not after the 30s cache TTL elapses (B015).
    subscribeInvalidations: (cb) => autoConfirmSendersStore.subscribe(cb),
  });

  // Boot-time env seed — fire-and-forget so the hook is constructed
  // before D1 returns. The first invocation may see a stale (empty)
  // cache while seeding completes; subsequent invocations are correct.
  // Any seed errors get logged; we don't block boot on D1.
  void seedAutoConfirmFromEnv(env.AUTO_CONFIRM_SENDERS, autoConfirmSendersStore, autoConfirmD1)
    .then((added) => {
      if (added.length > 0) {
        console.log(`[auto-confirm] seeded ${added.length} env pattern(s):`, added);
      }
    })
    .catch((err) => {
      console.error('[auto-confirm] env seed failed:', err instanceof Error ? err.message : err);
    });
  const stampUnreadHook = createStampUnreadHook();

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
      postClassify: [newsletterNameHook, confirmDetectHook, autoConfirmHook, stampUnreadHook, senderUpsertHook],
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
  // RSS items get the same unread stamp as emails — lets `{labels:["unread"]}`
  // queries work across mailroom + rss inboxes uniformly.
  registry.addHook('biorxiv', 'postClassify', stampUnreadHook);

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
  registry.addHook('podcasts', 'postClassify', stampUnreadHook);

  // Hono app
  const app = new Hono();

  const VERSION = '0.2.0';
  // Minimal public heartbeat — enough to verify "the worker is up and is the
  // expected version." Deliberately does NOT enumerate registered inboxes or
  // the endpoint surface — those would be a free roadmap for any unauth'd
  // visitor. The full manifest lives behind auth at /admin/inboxes (inbox
  // list) + /admin/manifest (endpoint catalog).
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/', (c) =>
    c.json({
      name: 'smallstore',
      version: VERSION,
      status: 'ok',
    }),
  );

  app.get('/admin/manifest', requireAuth, (c) =>
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
        inbox_newsletters: 'GET /inbox/:name/newsletters[/:slug[/items|notes]]',
        inbox_todos: 'GET /inbox/:name/todos',
        inbox_note: 'POST /inbox/:name/items/:id/note',
        inbox_replay: 'POST /admin/inboxes/:name/replay',
        admin_inboxes: 'GET /admin/inboxes',
        admin_auto_confirm: 'GET/POST/DELETE /admin/auto-confirm/senders',
        peers: 'GET/POST /peers',
        peers_proxy: 'GET /peers/:name/fetch?path=... | POST /peers/:name/query',
        webhook: 'POST /webhook/:peer (HMAC-authed, peer-specific)',
      },
    }),
  );

  // Messaging routes (mount before /api so wildcards stay disjoint).
  // `senderIndexFor` resolves the per-inbox sender index for the unsubscribe
  // route (POST /inbox/:name/unsubscribe); `rulesStoreFor` unlocks the
  // Peer store — created before messaging routes so the webhook handler can
  // look up peers by name. (Was created later in earlier revisions; moved up
  // to support webhookConfigFor closure on registerMessagingRoutes.)
  const peerStore = createPeerStore(peersD1, { keyPrefix: 'peers/' });

  // /rules CRUD + retroactive-apply endpoints per inbox. Both return null
  // for inboxes without those resources, in which case the routes 501.
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInboxFromConfig,
    senderIndexFor: (name: string) => senderIndexes.get(name) ?? null,
    rulesStoreFor: (name: string) => rulesStores.get(name) ?? null,
    autoConfirmSendersStore,
    // Webhook ingest. Looks up the peer, returns its `metadata.webhook_config`
    // when present + valid; null otherwise (route 404s). HMAC secrets are
    // resolved from the Worker env at request time.
    webhookConfigFor: async (peerName: string) => {
      const peer = await peerStore.get(peerName);
      if (!peer || peer.type !== 'webhook' || peer.disabled) return null;
      const cfg = (peer.metadata as any)?.webhook_config;
      if (!cfg || typeof cfg !== 'object' || !cfg.target_inbox) return null;
      return cfg;
    },
    // HMAC secret resolver — gated through the same env-var allowlist that
    // peer auth uses. A webhook config with `secret_env: "SMALLSTORE_TOKEN"`
    // (or any reserved name) returns undefined here; the caller logs +
    // responds with a generic configuration-error 500. Defense-in-depth:
    // the webhook channel's HMAC config is also subject to validateAuthShape-
    // adjacent checks at peer-create time once peer-side webhook validators
    // adopt the same gate.
    resolveHmacSecret: (envName: string) => {
      if (!defaultEnvAllowlist.isAllowed(envName)) {
        console.warn(`[webhook] HMAC secret_env "${envName}" rejected — not on allowlist`);
        return undefined;
      }
      return (env as unknown as Record<string, string | undefined>)[envName];
    },
    // Hook replay — register the hooks that are safe to re-run retroactively.
    // The forward-detect hook is the first concrete use case (back-fills
    // `original_sent_at` / `newsletter_slug` etc. on existing items). New
    // hooks become replayable by adding them here.
    replayHookFor: (inboxName: string, hookName: string) => {
      if (inboxName !== 'mailroom') return undefined;
      switch (hookName) {
        case 'forward-detect':
          return forwardDetectHook;
        case 'sender-aliases':
          return senderAliasHook;
        case 'plus-addr':
          return plusAddrHook;
        case 'newsletter-name':
          return newsletterNameHook;
        default:
          return undefined;
      }
    },
    // On-demand mirror trigger. Same engine the scheduled() cron runs
    // (every 30 min); exposed via POST /admin/inboxes/:name/mirror[/:peer]
    // for verification + after-annotation flushes that shouldn't wait
    // for the next cron tick. peerName filter optional; inboxName filter
    // currently unused (mirror dispatches based on each peer's
    // mirror_config.source_inbox, not the URL inbox name) but accepted
    // for forward compat.
    runMirror: async ({ peerName }) => {
      return await runMirror({
        registry,
        peerStore,
        env: env as unknown as Record<string, string | undefined>,
        peer_name: peerName,
      });
    },
  });

  // Peer registry routes — /peers CRUD + /peers/:name/{health,fetch,query}
  // proxy surface. env is passed so the proxy can resolve env-referenced
  // auth secrets (e.g. `{ kind: 'bearer', token_env: 'TF_TOKEN' }` →
  // Authorization: Bearer ${env.TF_TOKEN}).
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

  const runMirrorAll = () =>
    runMirror({
      registry,
      peerStore,
      env: env as unknown as Record<string, string | undefined>,
    });

  return {
    app,
    email,
    senderIndexes,
    rulesStores,
    autoConfirmSendersStore,
    peerStore,
    rssRunner,
    runMirror: runMirrorAll,
    registry,
  };
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
    const { rssRunner, runMirror, registry } = ensureApp(env);

    // RSS poll first — runs against external feeds, network-bound.
    const rssSummary = await rssRunner.pollAll();
    console.log('[scheduled] rss run complete', JSON.stringify({
      cron: event.cron,
      scheduled_time: new Date(event.scheduledTime).toISOString(),
      feeds_seen: rssSummary.feeds_seen,
      feeds_polled: rssSummary.feeds_polled,
      feeds_errored: rssSummary.feeds_errored,
      items_stored: rssSummary.items_stored,
      items_dropped: rssSummary.items_dropped,
      duration_ms: rssSummary.duration_ms,
    }));

    // Mirror after — purely outbound writes to peers with mirror_config.
    // Per-peer + per-slug failures already isolated inside runMirror;
    // any unexpected error is logged but doesn't tank the cron.
    try {
      const mirrorResults = await runMirror();
      for (const r of mirrorResults) {
        if (r.skipped) {
          console.log('[scheduled] mirror skipped', JSON.stringify({
            peer: r.peer_name,
            reason: r.skipped,
          }));
        } else {
          console.log('[scheduled] mirror run', JSON.stringify({
            peer: r.peer_name,
            pushed: r.pushed,
            failed: r.failed.length,
            ...(r.failed.length > 0 && { failures: r.failed }),
          }));
        }
      }
    } catch (err) {
      console.error('[scheduled] mirror error', err);
    }

    // Stale-unread sweep — best-effort cleanup so the unread surface
    // stays useful as a "what's new" view. Disabled when
    // UNREAD_SWEEP_DAYS is unset, "0", or non-numeric. Runs across every
    // registered inbox; per-inbox failures are isolated and logged.
    const sweepDays = parseSweepDays(env.UNREAD_SWEEP_DAYS);
    if (sweepDays > 0) {
      for (const name of registry.list()) {
        const inbox = registry.get(name);
        if (!inbox) continue;
        try {
          const result = await runUnreadSweep({ inbox, cutoffDays: sweepDays });
          if (result.changed > 0 || result.matched > 0) {
            console.log('[scheduled] unread-sweep', JSON.stringify({
              inbox: name,
              cutoff_days: sweepDays,
              cutoff_iso: result.cutoff_iso,
              matched: result.matched,
              changed: result.changed,
              capped: result.capped,
            }));
          }
        } catch (err) {
          console.error(`[scheduled] unread-sweep error for ${name}`, err);
        }
      }
    }
  },
};

/**
 * Parse the UNREAD_SWEEP_DAYS env var to a positive integer day count, or
 * `0` to mean disabled. Treats unset / empty / non-numeric / negative as
 * disabled — we only mark items read on an explicit, sensible threshold.
 */
function parseSweepDays(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
