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
import { loadConfig, buildAdapters, type SmallstoreServerConfig } from './config.ts';
import { resolvePreset } from './presets.ts';
import { syncAdapters, type SyncAdapterOptions } from './src/sync.ts';
import type { StorageAdapter } from './src/adapters/adapter.ts';

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

  const resolved = resolvePreset({
    preset: config.preset as any,
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
  const job = (async () => {
    try {
      return await syncAdapters(src, tgt, safeOptions);
    } finally {
      syncLocks.delete(lockKey);
    }
  })();
  syncLocks.set(lockKey, job);

  try {
    const result = await job;
    return c.json({ source, target, result });
  } catch (err) {
    // Sanitize the error — adapter errors can contain tokens or paths.
    const name = err instanceof Error ? err.name : 'Error';
    return c.json({ error: 'InternalServerError', message: `sync failed (${name})` }, 500);
  }
});

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
