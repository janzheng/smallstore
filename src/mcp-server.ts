#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
/**
 * Backwards-compat shim — delegates to `src/mcp/mod.ts`.
 *
 * Kept as an entry point so existing `~/.claude.json` configs that reference
 * this exact path (`.../smallstore/src/mcp-server.ts`) continue to work after
 * the 2026-04-25 reorg that split the monolithic MCP server into `src/mcp/`
 * with per-family tool files (core, inbox, peers).
 *
 * New registrations can point at `src/mcp/mod.ts` directly.
 *
 * @module
 */

import './mcp/mod.ts';
