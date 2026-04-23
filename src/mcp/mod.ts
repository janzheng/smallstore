#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
/**
 * Smallstore MCP Server — entry point.
 *
 * Stdio MCP server that forwards tool calls to a running Smallstore HTTP server
 * (started via `deno task serve`). Three tool families:
 *
 *   - core  (sm_read/write/delete/append/list/query/sync/sync_status/sync_jobs/adapters)
 *   - inbox (sm_inbox_*)   — mailroom + rules + tag + restore + export + unsubscribe
 *   - peers (sm_peers_*)   — peer registry CRUD + proxy fetch/query + health
 *
 * Env vars:
 *   SMALLSTORE_URL    Base URL of the running server (default: http://localhost:9998)
 *   SMALLSTORE_TOKEN  Optional Bearer token; sent as `Authorization: Bearer ...`
 *   SMALLSTORE_MAX_RESPONSE_BYTES  Response buffer cap (default: 10MB)
 *
 * Run:
 *   deno task mcp
 *
 * Register in ~/.claude.json under "mcpServers.smallstore":
 *   {
 *     "command": "deno",
 *     "args": ["run", "--allow-net", "--allow-read", "--allow-env",
 *              "/absolute/path/to/smallstore/src/mcp-server.ts"],
 *     "env": { "SMALLSTORE_URL": "http://localhost:9998" }
 *   }
 *
 * (The path `src/mcp-server.ts` is a backwards-compat shim; it imports from
 * here. New registrations can point at `src/mcp/mod.ts` directly.)
 *
 * @module
 */

import { runServer } from './server.ts';

await runServer();
