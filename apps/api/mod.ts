#!/usr/bin/env -S deno run --allow-all
/**
 * Smallstore API Server
 *
 * Simple REST API for the "micro-app shared storage" use case.
 * Any small app can POST/GET data to a shared smallstore over HTTP.
 *
 * Usage:
 *   deno task api                          Start with defaults (local-sqlite, port 8787)
 *   deno task api --preset=memory          Use memory preset
 *   deno task api --port=3000              Custom port
 *   deno task api --api-key=SECRET         Require Bearer token auth
 */

import { createSmallstore } from '../../mod.ts';
import type { PresetName } from '../../presets.ts';
import { createApiApp } from './app.ts';

// ============================================================================
// Parse CLI Flags
// ============================================================================

function parseFlags(): { preset: PresetName; port: number; apiKey?: string } {
  let preset: PresetName = 'local-sqlite';
  let port = 8787;
  let apiKey: string | undefined;

  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg.startsWith('--preset=')) preset = arg.split('=')[1] as PresetName;
    else if (arg === '--preset' && i + 1 < Deno.args.length) preset = Deno.args[++i] as PresetName;
    else if (arg.startsWith('--port=')) port = parseInt(arg.split('=')[1], 10);
    else if (arg === '--port' && i + 1 < Deno.args.length) port = parseInt(Deno.args[++i], 10);
    else if (arg.startsWith('--api-key=')) apiKey = arg.split('=')[1];
    else if (arg === '--api-key' && i + 1 < Deno.args.length) apiKey = Deno.args[++i];
  }

  return { preset, port, apiKey };
}

const flags = parseFlags();
const store = createSmallstore({ preset: flags.preset });
const app = createApiApp(store, { apiKey: flags.apiKey });

console.log(`
  Smallstore API
  Port:    ${flags.port}
  Preset:  ${flags.preset}
  Auth:    ${flags.apiKey ? 'Bearer token' : 'none'}

  CRUD
    GET    /store/:path            Get data
    POST   /store/:path            Set data
    PUT    /store/:path            Overwrite data
    PATCH  /store/:path            Merge data
    DELETE /store/:path            Delete data

  Discovery
    GET    /                       Server info + collections
    GET    /health                 Health check
    GET    /collections            List collections
    GET    /store/:col/_keys       List keys
    GET    /store/:col/_has        Check existence
    GET    /store/:col/_metadata   Get metadata
    GET    /store/:col/_schema     Get schema
    GET    /tree                   Browse tree
    GET    /namespaces             List namespaces

  Query / Search
    GET    /store/:col/_search?q=  Full-text search
    POST   /store/:col/_query      Structured query
    POST   /store/:col/_upsert     Upsert by key

  Batch
    POST   /_batch/get             Batch get
    POST   /_batch/set             Batch set
    POST   /_batch/delete          Batch delete

  Webhooks
    POST   /hooks/:col             Webhook (auto-timestamped)
`);

Deno.serve({ port: flags.port }, app.fetch);
