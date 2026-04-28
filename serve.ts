/**
 * Smallstore Standalone Server
 *
 * Boots a Hono server with all smallstore routes.
 * Reads configuration from .smallstore.json, env vars, or sensible defaults.
 *
 * Usage:
 *   deno task serve                     # Start with defaults (memory + local, port 9999)
 *   SM_PORT=8080 deno task serve        # Custom port
 *   deno task serve:watch               # Dev mode with file watching
 *
 * @example .smallstore.json
 * ```json
 * {
 *   "port": 9999,
 *   "dataDir": "./data",
 *   "adapters": {
 *     "memory": {},
 *     "local": { "baseDir": "./data" },
 *     "upstash": { "url": "$UPSTASH_REDIS_REST_URL", "token": "$UPSTASH_REDIS_REST_TOKEN" }
 *   },
 *   "defaultAdapter": "local",
 *   "mounts": {
 *     "cache/*": "memory",
 *     "media/*": "local"
 *   }
 * }
 * ```
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { createSmallstore } from './mod.ts';
import { createHonoRoutes } from './src/http/integrations/hono.ts';
import { loadConfig, buildAdapters, resolveInboxStorage, type SmallstoreServerConfig, type InboxConfigEntry } from './config.ts';
import { resolvePreset, type PresetName } from './presets.ts';
import { syncAdapters, type SyncAdapterOptions } from './src/sync.ts';
import type { StorageAdapter } from './src/adapters/adapter.ts';
import { createJobLog, generateJobId, listJobs, summarizeJob, tailJobLog } from './src/utils/job-log.ts';
import { createInbox as createMessagingInbox } from './src/messaging/inbox.ts';
import { InboxRegistry, registerChannel } from './src/messaging/registry.ts';
import { registerMessagingRoutes } from './src/messaging/http-routes.ts';
import { cloudflareEmailChannel } from './src/messaging/channels/cf-email.ts';
import { createEmailHandler } from './src/messaging/email-handler.ts';
import type { InboxConfig } from './src/messaging/types.ts';

// ============================================================================
// Build Routing Config from Mounts
// ============================================================================

function buildRouting(config: SmallstoreServerConfig): Record<string, { adapter: string }> | undefined {
  if (!config.mounts) return undefined;

  const routing: Record<string, { adapter: string }> = {};
  for (const [pattern, adapter] of Object.entries(config.mounts)) {
    routing[pattern] = { adapter };
  }
  return routing;
}

// ============================================================================
// Main
// ============================================================================

const config = await loadConfig();

let smallstore;
let adapterNames: string[];
let defaultAdapter: string;
let activeMounts: Record<string, string> = {};
// Hold raw adapters so /_sync can pass StorageAdapter instances to syncAdapters().
let rawAdapters: Record<string, StorageAdapter> = {};

if (config.preset) {
  // Preset mode: resolve preset, merging any explicit adapters from config file
  const hasExplicitAdapters = Object.keys(config.adapters).length > 0;
  const manualAdapters = hasExplicitAdapters ? await buildAdapters(config.adapters, { dataDir: config.dataDir }) : undefined;

  // A243: narrow the preset name from `config.preset: string | undefined`
  // to the typed `PresetName` union. `loadConfig` reads from a JSON config
  // so we can't statically guarantee the value at the source — runtime
  // validation throws with the allowed names if it doesn't match, instead
  // of letting `resolvePreset` silently accept something arbitrary.
  const VALID_PRESETS: readonly PresetName[] = [
    'memory', 'local', 'local-sqlite', 'deno-fs', 'cloud', 'hybrid', 'structured',
  ];
  if (!VALID_PRESETS.includes(config.preset as PresetName)) {
    throw new Error(
      `config.preset "${config.preset}" not recognized — expected one of: ${VALID_PRESETS.join(', ')}`,
    );
  }
  const presetName = config.preset as PresetName;

  const resolved = resolvePreset({
    preset: presetName,
    ...(manualAdapters ? { adapters: manualAdapters } : {}),
    ...(config.mounts ? { mounts: config.mounts } : {}),
    ...(config.typeRouting ? { typeRouting: config.typeRouting } : {}),
  });

  smallstore = createSmallstore(resolved);
  adapterNames = Object.keys(resolved.adapters);
  defaultAdapter = resolved.defaultAdapter;
  activeMounts = resolved.mounts || {};
  rawAdapters = resolved.adapters;
  console.log(`[Smallstore] Using preset: ${config.preset}`);
} else {
  // Manual mode: build adapters from config
  const adapters = await buildAdapters(config.adapters, { dataDir: config.dataDir });
  adapterNames = Object.keys(adapters);

  defaultAdapter = adapters[config.defaultAdapter]
    ? config.defaultAdapter
    : adapterNames[0];

  smallstore = createSmallstore({
    adapters,
    defaultAdapter,
    routing: buildRouting(config),
    typeRouting: config.typeRouting,
  });
  activeMounts = config.mounts || {};
  rawAdapters = adapters;
}

// Create Hono app
const app = new Hono();

// CORS
app.use('*', cors());

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Info endpoint
app.get('/', (c) => {
  return c.json({
    name: '@smallstore/core',
    version: '0.1.0',
    adapters: adapterNames,
    defaultAdapter,
    mounts: activeMounts,
    port: config.port,
    endpoints: {
      info: 'GET /',
      health: 'GET /health',
      collections: 'GET /api/collections',
      get: 'GET /api/:collection',
      set: 'POST /api/:collection',
      overwrite: 'PUT /api/:collection',
      merge: 'PATCH /api/:collection',
      delete: 'DELETE /api/:collection',
      keys: 'GET /api/:collection/keys',
      search: 'GET /api/:collection/search?q=',
      query: 'POST /api/:collection/query',
      metadata: 'GET /api/:collection/metadata',
      schema: 'GET /api/:collection/schema',
      tree: 'GET /api/tree',
      namespaces: 'GET /api/namespaces',
    },
  });
});

// Optional bearer-token auth for the admin endpoints below. If
// SMALLSTORE_TOKEN is set, callers must send `Authorization: Bearer <token>`.
// Unset → open (backwards compatible for local dev).
const expectedToken = Deno.env.get('SMALLSTORE_TOKEN');
function requireAuth(c: Context, next: Next) {
  if (!expectedToken) return next();
  const header = c.req.header('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== expectedToken) {
    return c.json({ error: 'Unauthorized', message: 'Missing or invalid Authorization bearer token' }, 401);
  }
  return next();
}

// Whitelist of safe JSON-serializable SyncAdapterOptions keys. `baseline` and
// `baselineAdapter` are rejected because a malformed baseline can mis-classify
// every key as a conflict and silently destroy data under source-wins; and
// `baselineAdapter` can't be passed over HTTP anyway (needs a StorageAdapter).
const SYNC_OPTION_WHITELIST = new Set<keyof SyncAdapterOptions>([
  'mode', 'conflictResolution', 'dryRun', 'prefix', 'syncId',
]);

// In-process lock for /_sync — prevents interleaved writes that corrupt
// baselines when two callers fire sync on the same source+target pair.
const syncLocks = new Map<string, Promise<unknown>>();

// Adapter + mount introspection (used by the MCP server's sm_adapters tool).
app.get('/_adapters', requireAuth, (c) => {
  return c.json({
    adapters: adapterNames,
    defaultAdapter,
    mounts: activeMounts,
    preset: config.preset ?? null,
  });
});

// Adapter-to-adapter sync (wraps syncAdapters() with named adapters).
// Default mode is BACKGROUND: the request returns immediately with a jobId +
// log path; progress is appended line-by-line to `<dataDir>/jobs/<jobId>.jsonl`
// so callers can `tail -f` the file or poll `/_sync/jobs/:id` for the last
// events. Pass `?wait=true` to block the request until sync completes (the
// previous synchronous behavior) — useful for scripts and tests.
app.post('/_sync', requireAuth, async (c) => {
  let body: { source?: string; target?: string; options?: SyncAdapterOptions };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'BadRequest', message: 'Invalid JSON body' }, 400);
  }
  const { source, target, options = {} } = body;
  if (!source || !target) {
    return c.json({ error: 'BadRequest', message: 'Body must include "source" and "target" adapter names' }, 400);
  }
  if (source === target) {
    return c.json({ error: 'BadRequest', message: 'source and target adapters must differ (self-sync would corrupt baselines)' }, 400);
  }
  const src = rawAdapters[source];
  const tgt = rawAdapters[target];
  if (!src) return c.json({ error: 'NotFound', message: `Unknown source adapter "${source}"`, available: adapterNames }, 404);
  if (!tgt) return c.json({ error: 'NotFound', message: `Unknown target adapter "${target}"`, available: adapterNames }, 404);

  // Whitelist options — drop anything not explicitly supported over HTTP.
  const safeOptions: SyncAdapterOptions = {};
  for (const [k, v] of Object.entries(options)) {
    if (SYNC_OPTION_WHITELIST.has(k as keyof SyncAdapterOptions)) {
      (safeOptions as Record<string, unknown>)[k] = v;
    }
  }

  const lockKey = `${source}→${target}`;
  if (syncLocks.has(lockKey)) {
    return c.json({ error: 'Conflict', message: `sync already running for ${lockKey}` }, 409);
  }

  const wait = c.req.query('wait') === 'true';
  const jobId = generateJobId('sync');
  const dataDir = config.dataDir ?? './data';
  const logPath = `${dataDir.replace(/\/+$/, '')}/jobs/${jobId}.jsonl`;

  // Claim the lock synchronously — no awaits between has() and set() — so
  // two concurrent POSTs on the same pair can't both pass the check. The
  // file open happens inside the IIFE so it runs under the lock.
  const run = (async () => {
    const log = await createJobLog({ jobId, dataDir });
    await log.append({ event: 'started', source, target, options: safeOptions });
    try {
      const result = await syncAdapters(src, tgt, {
        ...safeOptions,
        onProgress: (evt) => { log.append({ event: 'progress', ...evt }); },
      });
      await log.append({ event: 'completed', result });
      return result;
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const message = err instanceof Error ? err.message : String(err);
      await log.append({ event: 'failed', error: name, message });
      throw err;
    } finally {
      await log.close();
      syncLocks.delete(lockKey);
    }
  })();
  syncLocks.set(lockKey, run);

  if (wait) {
    try {
      const result = await run;
      return c.json({ jobId, logPath, source, target, result });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      return c.json({ error: 'InternalServerError', message: `sync failed (${name})`, jobId, logPath }, 500);
    }
  }

  // Background mode — fire-and-forget at the HTTP level. Attach a handler so
  // an unhandled rejection doesn't trip Deno; the error is already in the log.
  run.catch(() => { /* already written to JSONL */ });
  return c.json({ jobId, logPath, source, target, status: 'running' }, 202);
});

// List recent sync jobs (newest first). Reads directly from the jobs
// directory — no in-memory state to reconcile across restarts.
//
// A204: summarizeJob hits each JSONL file with a full `Deno.readTextFile`,
// so unbounded `Promise.all` here would fan out 50+ concurrent file reads
// at default limits. Cap concurrency at 8 (heuristic: roughly one per
// reasonable filesystem queue depth; tunable if a real bottleneck appears).
const SUMMARIZE_CONCURRENCY = 8;

app.get('/_sync/jobs', requireAuth, async (c) => {
  const jobs = await listJobs(config.dataDir);
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : 50;
  const slice = jobs.slice(0, limit);

  const withSummaries: Array<typeof slice[number] & Awaited<ReturnType<typeof summarizeJob>>> = [];
  for (let i = 0; i < slice.length; i += SUMMARIZE_CONCURRENCY) {
    const chunk = slice.slice(i, i + SUMMARIZE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (j) => ({ ...j, ...(await summarizeJob(j.path)) })),
    );
    withSummaries.push(...results);
  }
  return c.json({ jobs: withSummaries, total: jobs.length, truncated: jobs.length > limit });
});

// Tail events from a specific job's JSONL log. ?tail=N returns the last N
// events (default 50); ?tail=all returns everything.
app.get('/_sync/jobs/:id', requireAuth, async (c) => {
  const jobId = c.req.param('id');
  // Reject traversal — jobId must be a plain filename segment.
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
    return c.json({ error: 'BadRequest', message: 'invalid jobId' }, 400);
  }
  const path = `${config.dataDir.replace(/\/+$/, '')}/jobs/${jobId}.jsonl`;
  try {
    await Deno.stat(path);
  } catch {
    return c.json({ error: 'NotFound', message: `no such job: ${jobId}` }, 404);
  }
  const tailParam = c.req.query('tail');
  const n = tailParam === 'all' ? Number.MAX_SAFE_INTEGER : Math.max(1, parseInt(tailParam ?? '50', 10));
  const events = await tailJobLog(path, n);
  const summary = await summarizeJob(path);
  return c.json({ jobId, path, ...summary, events });
});

// ============================================================================
// Messaging plugin — Inbox + Channel + (later) Outbox
// ============================================================================
// Routes mount at root (/inbox/*, /admin/*) before /api/* so the surfaces
// stay disjoint. Inboxes are constructed from config at boot and registered
// into an in-memory registry; the /admin/inboxes API can add more at runtime.

const messagingRegistry = new InboxRegistry();

// Register built-in channels. Adding a new channel = import + register here.
try {
  registerChannel(cloudflareEmailChannel);
} catch {
  // Idempotent for Deno --watch reloads
}

async function buildInboxFromConfig(name: string, cfg: InboxConfig): Promise<ReturnType<typeof createMessagingInbox>> {
  const storage = resolveInboxStorage(cfg.storage, rawAdapters);
  return createMessagingInbox({
    name,
    channel: cfg.channel,
    storage,
    keyPrefix: cfg.keyPrefix,
  });
}

if (config.inboxes) {
  for (const [name, entry] of Object.entries(config.inboxes)) {
    try {
      const cfg = entry as InboxConfig;
      const inbox = await buildInboxFromConfig(name, cfg);
      messagingRegistry.register(name, inbox, cfg, 'boot');
      console.log(`[Smallstore] Registered inbox "${name}" (channel: ${cfg.channel})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Smallstore] Failed to register inbox "${name}": ${msg}`);
    }
  }
}

registerMessagingRoutes(app, {
  registry: messagingRegistry,
  requireAuth,
  createInbox: buildInboxFromConfig,
});

/**
 * CF Workers email() handler. Bound to the local registry; consumed by
 * `deploy/worker.ts` (Phase 1 — `export { email } from '../serve.ts'`).
 * Doesn't fire under local `Deno.serve`; CF Email Routing only triggers
 * on the deployed Worker.
 */
export const email = createEmailHandler({ registry: messagingRegistry });

// Mount smallstore routes at /api
createHonoRoutes(app, smallstore, '/api');

// Start server
console.log(`\n  Smallstore server`);
console.log(`  Port:     ${config.port}`);
console.log(`  Adapters: ${adapterNames.join(', ')}`);
console.log(`  Default:  ${defaultAdapter}`);
if (Object.keys(activeMounts).length > 0) {
  console.log(`  Mounts:`);
  for (const [pattern, adapter] of Object.entries(activeMounts)) {
    console.log(`    ${pattern} → ${adapter}`);
  }
}
console.log(`\n  GET  /           Server info`);
console.log(`  GET  /api/collections    List collections`);
console.log(`  POST /api/:collection    Store data`);
console.log(`  GET  /api/:collection    Retrieve data`);
console.log(`\n`);

Deno.serve({ port: config.port }, app.fetch);
