/**
 * Sink factories — the standard ways to create a Sink.
 *
 * A Sink is `(item, ctx) => Promise<SinkResult>`. That's the whole interface.
 * Anything matching that signature is a valid sink. These factories cover the
 * common cases:
 *
 * - `inboxSink(inbox)` — wrap an Inbox as a sink (behavior-preserving default).
 *   Delegates to `inbox._ingest(item, { blobs })`.
 * - `httpSink({ url, token })` — POST the item as JSON to an external URL.
 *   Used for tigerflare bridge, Slack/Discord webhooks, arbitrary external
 *   sinks without needing an adapter.
 * - `functionSink(fn)` — inline callback. Good for cross-inbox mirroring,
 *   ad-hoc logging, pipeline testing.
 *
 * See `.brief/mailroom-pipeline.md` for the full motivation.
 */

import type { Inbox, InboxItem, Sink, SinkContext, SinkResult } from './types.ts';

// ============================================================================
// inboxSink — the default: wraps an Inbox as a Sink
// ============================================================================

/**
 * Wrap an Inbox as a Sink. The returned Sink delegates to `inbox._ingest()`,
 * passing through the blobs from SinkContext. This is the behavior-preserving
 * default — the original "for each inbox, inbox._ingest(item)" loop is
 * equivalent to fanning out to `inboxSink(inbox)` for each inbox.
 *
 * @param inbox - The Inbox instance to ingest into.
 */
export function inboxSink(inbox: Inbox): Sink {
  return async (item: InboxItem, ctx: SinkContext): Promise<SinkResult> => {
    try {
      const saved = await inbox._ingest(item, { blobs: ctx.blobs });
      return { stored: true, id: saved.id };
    } catch (err) {
      return {
        stored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// ============================================================================
// httpSink — POST the item to an external URL
// ============================================================================

export interface HttpSinkOptions {
  /** Destination URL. Item is POSTed as JSON. */
  url: string;
  /** Bearer token; if set, sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra headers to forward on every request. */
  headers?: Record<string, string>;
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

/**
 * POST the item as JSON to an external URL. Used for fan-out to any HTTP
 * endpoint: tigerflare bridge, Slack webhooks, generic sinks without a
 * smallstore adapter.
 *
 * Request body shape:
 * ```
 * {
 *   item: InboxItem,
 *   channel: string,           // ctx.channel
 *   registration?: string,     // ctx.registration
 *   blob_keys?: string[]       // blob names only (not bodies); consumer can
 *                              // GET them separately if they have a blobs URL
 * }
 * ```
 *
 * Blobs are NOT sent inline (could be tens of MB). If a consumer needs blob
 * bytes, they get the references and fetch them separately. For full blob
 * forwarding, use a `functionSink` that does the multipart upload.
 */
export function httpSink(opts: HttpSinkOptions): Sink {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (item: InboxItem, ctx: SinkContext): Promise<SinkResult> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const body = JSON.stringify({
      item,
      channel: ctx.channel,
      registration: ctx.registration,
      blob_keys: ctx.blobs ? Object.keys(ctx.blobs) : undefined,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        return {
          stored: false,
          error: `HTTP ${res.status} ${res.statusText}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`,
        };
      }
      return { stored: true };
    } catch (err) {
      return {
        stored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ============================================================================
// functionSink — inline callback
// ============================================================================

/**
 * Wrap an inline function as a Sink. Good for:
 * - Cross-inbox mirroring (`functionSink(async (item) => otherInbox._ingest(item))`)
 * - Conditional routing (`functionSink(async (item, ctx) => { if (...) ... })`)
 * - Testing pipelines without setting up real destinations
 * - Quick hooks that don't need the full Sink ceremony
 *
 * The function returns `void` or `Promise<void>`; success is implied. Thrown
 * errors become `stored: false` with the error message. For finer control
 * over the result, implement `Sink` directly instead.
 */
export function functionSink(
  fn: (item: InboxItem, ctx: SinkContext) => void | Promise<void>,
): Sink {
  return async (item: InboxItem, ctx: SinkContext): Promise<SinkResult> => {
    try {
      await fn(item, ctx);
      return { stored: true };
    } catch (err) {
      return {
        stored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
