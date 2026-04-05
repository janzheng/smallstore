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
import { cors } from 'hono/cors';
import { createSmallstore } from './mod.ts';
import { createHonoRoutes } from './src/http/integrations/hono.ts';
import { loadConfig, buildAdapters, type SmallstoreServerConfig } from './config.ts';
import { resolvePreset } from './presets.ts';

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
