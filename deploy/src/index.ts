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
  createSenderIndex,
  createForwardDetectHook,
  createPlusAddrHook,
  createRulesStore,
  createRulesHook,
  parseSelfAddresses,
  registerChannel,
  registerMessagingRoutes,
  InboxRegistry,
  type HookContext,
  type HookVerdict,
  type InboxConfig,
  type InboxItem,
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

  // Channel registration (idempotent across isolates — already-registered throws is caught)
  try { registerChannel(cloudflareEmailChannel); } catch { /* noop */ }

  // Messaging registry — boot-time inbox: mailroom (cf-email + d1 items + r2 blobs)
  const registry = new InboxRegistry();

  // Adapter pool by name (matches the smallstore.adapters keys above).
  // Runtime-created inboxes (via POST /admin/inboxes) reference adapters
  // by name in their `storage:` config; we resolve here.
  const adapterByName: Record<string, any> = {
    mailroom_d1: d1,
    mailroom_r2: r2,
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
  //      'manual', extracts original_from_* into fields. Runs first so plus-
  //      addressing intent (next) can OVERRIDE the 'manual' label when the
  //      user explicitly typed mailroom+bookmark@...
  //   2. plus-addr — reads inbox_addr for +intent suffix, tags accordingly.
  //      Explicit intent wins over auto-detection.
  //   3. rules — evaluates user-configured archive/bookmark/tag/drop/quarantine
  //      rules against the (possibly-already-mutated) item. Tag-style rules
  //      stack; terminal rules (drop/quarantine) short-circuit.
  //
  // postClassify hooks run AFTER the built-in classifier emits its labels,
  // so sender-index upsert sees canonical tags.
  const selfAddresses = parseSelfAddresses(env.SELF_ADDRESSES);
  const forwardDetectHook = createForwardDetectHook({ selfAddresses });
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
      preIngest: [forwardDetectHook, plusAddrHook, rulesHook],
      postClassify: [senderUpsertHook],
    },
    config: mailroomConfig,
    origin: 'boot',
  });

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

  return { app, email, senderIndexes, rulesStores, peerStore };
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
};
