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
  registerChannel,
  registerMessagingRoutes,
  InboxRegistry,
  type InboxConfig,
} from '@yawnxyz/smallstore/messaging';

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
}

// ============================================================================
// Lazy-init container
// ============================================================================

interface AppHandle {
  app: Hono;
  email: ReturnType<typeof createEmailHandler>;
}

let appHandle: AppHandle | null = null;

function buildApp(env: Env): AppHandle {
  // Adapters
  const d1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'mailroom_items' });
  const r2 = createCloudflareR2Adapter({ binding: env.MAILROOM_R2 });
  const memory = createMemoryAdapter();

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
  registry.register('mailroom', mailroom, mailroomConfig, 'boot');

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
        admin_inboxes: 'GET /admin/inboxes',
      },
    }),
  );

  // Messaging routes (mount before /api so wildcards stay disjoint)
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInboxFromConfig,
  });

  // Universal CRUD surface at /api/*
  createHonoRoutes(app, smallstore, '/api');

  const email = createEmailHandler({
    registry,
    log: (msg, extra) => console.log(`[email] ${msg}`, JSON.stringify(extra ?? {})),
  });

  return { app, email };
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
