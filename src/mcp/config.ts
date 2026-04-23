/**
 * Config validation for the MCP server — reads env vars, validates, and
 * exits with a clear error at startup rather than letting cryptic errors
 * surface on the first tool call.
 */

/** Parsed + validated env, immutable after module load. */
export interface McpConfig {
  /** Base URL of the smallstore HTTP server (no trailing slash). */
  url: string;
  /** Optional bearer token. Validated CR/LF-free to prevent header injection. */
  token?: string;
  /** Max bytes to buffer from a single HTTP response. Default 10MB. */
  maxResponseBytes: number;
}

export function loadConfig(): McpConfig {
  const rawUrl = Deno.env.get('SMALLSTORE_URL') ?? 'http://localhost:9998';
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`SMALLSTORE_URL must be http(s), got "${u.protocol}"`);
    }
  } catch (err) {
    console.error(
      `[smallstore-mcp] Invalid SMALLSTORE_URL "${rawUrl}": ${
        err instanceof Error ? err.message : err
      }`,
    );
    Deno.exit(1);
  }
  const url = rawUrl.replace(/\/+$/, '');

  const token = Deno.env.get('SMALLSTORE_TOKEN');
  if (token !== undefined && /[\r\n]/.test(token)) {
    console.error(
      '[smallstore-mcp] SMALLSTORE_TOKEN contains CR/LF — rejecting to avoid HTTP header injection.',
    );
    Deno.exit(1);
  }

  // Cap the response body buffered from the HTTP server. A huge sm_list or
  // sm_read on Notion/Airtable can otherwise OOM the MCP subprocess since the
  // body is buffered + re-stringified with 2-space indent.
  const maxResponseBytes = (() => {
    const raw = Deno.env.get('SMALLSTORE_MAX_RESPONSE_BYTES');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
  })();

  return { url, token, maxResponseBytes };
}
