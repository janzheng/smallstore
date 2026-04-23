/**
 * CF Workers `email()` orchestrator.
 *
 * Wraps the messaging registry + cf-email channel into a function with the
 * shape Cloudflare expects from `email(msg, env, ctx)`. Reads the raw .eml
 * stream, parses through the channel, and ingests into every inbox
 * configured for the matching channel name.
 *
 * Used by `deploy/worker.ts` (Phase 1):
 *
 *   import { createEmailHandler } from '@yawnxyz/smallstore/messaging';
 *   export default {
 *     fetch: app.fetch,
 *     email: createEmailHandler({ registry: messagingRegistry }),
 *   };
 *
 * Not used by the local Deno `serve.ts` — that runs `Deno.serve` over
 * `app.fetch`; Cloudflare Email Routing only fires `email()` on the
 * deployed Worker.
 *
 * `setReject` semantics: if no inbox is configured for the channel, the
 * orchestrator calls `msg.setReject(reason)` so CF returns the message as
 * undeliverable instead of silently dropping it.
 */

import type { InboxRegistry } from './registry.ts';
import { CloudflareEmailChannel } from './channels/cf-email.ts';

/**
 * The fields of CF's `ForwardableEmailMessage` we actually use.
 *
 * Re-declared here as a structural interface so we don't take a hard
 * dependency on `@cloudflare/workers-types` — the Worker side imports the
 * real types if it wants stricter typing.
 */
export interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

export interface CreateEmailHandlerOptions {
  /** The in-memory inbox registry. */
  registry: InboxRegistry;
  /** Channel name to dispatch through. Default: 'cf-email'. */
  channelName?: string;
  /** Optional logger for visibility from `wrangler tail`. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Build an `email()` handler bound to the given registry. Reusable across
 * Workers if you have multiple deployments sharing the same registry shape.
 */
export function createEmailHandler(opts: CreateEmailHandlerOptions) {
  const channelName = opts.channelName ?? 'cf-email';
  const channel = new CloudflareEmailChannel();
  const log = opts.log ?? ((m, extra) => console.log(`[email] ${m}`, extra ?? ''));

  return async function email(msg: ForwardableEmailMessage, _env?: unknown, _ctx?: unknown): Promise<void> {
    const inboxes = opts.registry.findByChannel(channelName);
    if (inboxes.length === 0) {
      const reason = `no inbox configured for channel "${channelName}"`;
      log(reason, { from: msg.from, to: msg.to });
      msg.setReject(reason);
      return;
    }

    // Read full raw .eml. CF's `rawSize` is authoritative.
    const raw = await readStream(msg.raw, msg.rawSize);

    const parsed = await channel.parse({
      raw,
      envelope_from: msg.from,
      envelope_to: msg.to,
    });

    if (!parsed) {
      log('channel returned null (dropping)', { from: msg.from, to: msg.to });
      return;
    }

    // Ingest into every inbox configured for this channel.
    // Same parsed item + blobs go into each — the dedup is per-inbox so
    // multiple fan-out destinations are intentional.
    for (const reg of inboxes) {
      try {
        await reg.inbox._ingest(parsed.item, { blobs: parsed.blobs });
        log('ingested', { inbox: reg.inbox.name, id: parsed.item.id, from: msg.from, to: msg.to });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('ingest failed', { inbox: reg.inbox.name, error: message });
      }
    }
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function readStream(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  // Single allocation for the joined result. Use expectedSize as the hint when
  // it matches; otherwise prefer total (CF's rawSize is wire-accurate but
  // belt-and-braces).
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
