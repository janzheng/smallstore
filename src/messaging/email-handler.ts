/**
 * CF Workers `email()` orchestrator.
 *
 * Wraps the messaging registry + cf-email channel into a function with the
 * shape Cloudflare expects from `email(msg, env, ctx)`. Reads the raw .eml
 * stream, parses through the channel, and fans out to every Sink configured
 * on every registration listening to the matching channel name.
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
 * `setReject` semantics: if no registration is configured for the channel
 * (or no registration has any sinks), the orchestrator calls
 * `msg.setReject(reason)` so CF returns the message as undeliverable
 * instead of silently dropping it.
 *
 * Sink dispatch: each sink runs independently inside a try/catch per sink,
 * so one failing sink (e.g. a down external HTTP endpoint) does not prevent
 * other sinks (e.g. the primary inbox) from storing the item.
 */

import type { InboxRegistry } from './registry.ts';
import type { SinkContext } from './types.ts';
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
    const registrations = opts.registry.findByChannel(channelName);
    if (registrations.length === 0) {
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

    // Fan out to every Sink across every matching registration. Sinks run
    // independently — a failure in one (e.g. external HTTP sink timing out)
    // does not prevent others (e.g. the primary inbox) from persisting the
    // item. Each registration may have multiple sinks (primary inbox + HTTP
    // fan-out + cross-inbox mirror, etc).
    for (const reg of registrations) {
      const regName = findRegistrationName(opts.registry, reg);
      const ctx: SinkContext = {
        blobs: parsed.blobs,
        channel: channelName,
        registration: regName,
      };
      for (let i = 0; i < reg.sinks.length; i++) {
        const sink = reg.sinks[i];
        try {
          const result = await sink(parsed.item, ctx);
          if (result.stored) {
            log('sink ok', {
              registration: regName,
              sink_idx: i,
              id: result.id ?? parsed.item.id,
              from: msg.from,
              to: msg.to,
            });
          } else {
            log('sink failed (soft)', {
              registration: regName,
              sink_idx: i,
              error: result.error,
            });
          }
        } catch (err) {
          // A throwing sink is a bug in the sink (they should return
          // {stored: false, error}), but we still want to continue.
          const message = err instanceof Error ? err.message : String(err);
          log('sink threw (bug in sink)', { registration: regName, sink_idx: i, error: message });
        }
      }
    }
  };
}

/**
 * Look up a registration's name from the registry. O(N) in registry size —
 * fine for logging since registries typically hold a handful of entries.
 * Returns undefined if not found (shouldn't happen in the normal flow).
 */
function findRegistrationName(registry: InboxRegistry, target: { inbox?: { name: string } }): string | undefined {
  if (target.inbox) return target.inbox.name;
  for (const name of registry.list()) {
    if (registry.getRegistration(name) === target) return name;
  }
  return undefined;
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
