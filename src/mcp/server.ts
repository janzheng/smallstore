/**
 * Smallstore MCP server — composition layer.
 *
 * Each tool family (core, inbox, peers) exports `X_TOOLS: Tool[]` + a
 * `handleXTool(name, args, http)` function. This module wires them together,
 * registers the combined tool list with the MCP SDK, and dispatches each
 * `tools/call` to the right family handler.
 *
 * Adding a new tool family:
 *   1. Create `src/mcp/tools/<family>.ts` exporting `X_TOOLS` + `handleXTool`.
 *   2. Import both in this file.
 *   3. Add the family's names to the dispatch map.
 *
 * Nothing else changes (tests, skill docs, etc).
 *
 * Entry: `src/mcp/mod.ts` calls `runServer()`. Or the legacy
 * `src/mcp-server.ts` shim imports `mod.ts` for backwards compat with
 * existing `~/.claude.json` configs.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.ts';
import { createHttpFn } from './http.ts';
import type { Args, Tool } from './tools/types.ts';
import { CORE_TOOLS, CORE_TOOL_NAMES, handleCoreTool } from './tools/core.ts';
import { INBOX_TOOLS, handleInboxTool } from './tools/inbox.ts';
import { PEERS_TOOLS, handlePeersTool } from './tools/peers.ts';

// ============================================================================
// Tool registry — the combined list + per-family dispatch map
// ============================================================================

const INBOX_TOOL_NAMES: ReadonlySet<string> = new Set(
  INBOX_TOOLS.map((t) => t.name),
);
const PEERS_TOOL_NAMES: ReadonlySet<string> = new Set(
  PEERS_TOOLS.map((t) => t.name),
);

const ALL_TOOLS: Tool[] = [...CORE_TOOLS, ...INBOX_TOOLS, ...PEERS_TOOLS];

// ============================================================================
// Server setup
// ============================================================================

/**
 * Build + start the MCP server over stdio. Blocks forever until a SIGTERM /
 * SIGINT closes the transport.
 */
export async function runServer(): Promise<void> {
  const config = loadConfig();
  const http = createHttpFn(config);

  const server = new Server(
    { name: 'smallstore', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: ALL_TOOLS };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req: { params: { name: string; arguments?: Args } }) => {
      const { name, arguments: rawArgs } = req.params;
      const args = (rawArgs ?? {}) as Args;
      try {
        // Dispatch by family — each family claims a disjoint set of names.
        let result: unknown;
        if (CORE_TOOL_NAMES.has(name)) {
          result = await handleCoreTool(name, args, http);
        } else if (INBOX_TOOL_NAMES.has(name)) {
          result = await handleInboxTool(name, args, http);
        } else if (PEERS_TOOL_NAMES.has(name)) {
          result = await handlePeersTool(name, args, http);
        } else {
          // MethodNotFound surfaces as a proper JSON-RPC error (code -32601)
          // instead of an isError result content block.
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        const text = typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        if (err instanceof McpError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
    },
  );

  const transport = new StdioServerTransport();

  // Graceful shutdown — close the transport + server on SIGTERM / SIGINT so
  // in-flight fetches get a chance to cancel instead of the process being
  // killed mid-request. Claude Code normally kills the subprocess; this is
  // a best-effort drain.
  async function shutdown(signal: string) {
    try { await server.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
    Deno.exit(signal === 'SIGINT' ? 130 : 143);
  }
  try {
    Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM'));
  } catch { /* unsupported on some platforms */ }
  try {
    Deno.addSignalListener('SIGINT', () => shutdown('SIGINT'));
  } catch { /* unsupported on some platforms */ }

  await server.connect(transport);
}
