/**
 * HTTP forwarder used by all MCP tool families. Wraps fetch with:
 *
 *   - auth header injection (Bearer ${SMALLSTORE_TOKEN})
 *   - JSON body serialization with a clear "not serializable" error
 *   - response body size cap (configurable via SMALLSTORE_MAX_RESPONSE_BYTES)
 *   - content-type sniffing (JSON parsed to object, text returned as string)
 *
 * Returns a permissive `HttpResult` — callers check `.ok` and either return
 * `.body` as the tool result or throw a `formatHttpError` message.
 */

import type { HttpFn, HttpResult } from './tools/types.ts';
import type { McpConfig } from './config.ts';

/**
 * Build an `HttpFn` bound to the given config. The MCP server calls this
 * once at startup and passes the returned function to every tool family.
 */
export function createHttpFn(config: McpConfig): HttpFn {
  return async function http(method, path, body): Promise<HttpResult> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

    const url = `${config.url}${path}`;

    // Serialize upfront so BigInt / circular refs / other non-JSON values
    // fail with a clear "bad argument" message instead of a cryptic TypeError
    // from deep inside fetch().
    let serializedBody: string | undefined;
    if (body !== undefined) {
      try {
        serializedBody = JSON.stringify(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Request body is not JSON-serializable: ${msg}`,
        );
      }
    }

    const res = await fetch(url, { method, headers, body: serializedBody });
    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');

    const text = await readCapped(res, config.maxResponseBytes);

    let parsed: unknown;
    if (isJson) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Server claimed JSON but body didn't parse — surface as a string so
        // the agent can see what came back instead of a cryptic parse error.
        parsed = text;
      }
    } else {
      parsed = text;
    }

    return { ok: res.ok, status: res.status, body: parsed };
  };
}

/**
 * Read a Response body as text, but cap at `maxBytes` to avoid OOM'ing the
 * MCP subprocess on accidentally-huge adapter responses. Returns whatever
 * fits; does not throw on overrun (agents can still see the truncated
 * response + status code).
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
          // Stop reading; cancel the stream so the connection can close.
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const remaining = joined.length - offset;
    if (remaining <= 0) break;
    const slice = c.byteLength <= remaining ? c : c.subarray(0, remaining);
    joined.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder().decode(joined);
}
