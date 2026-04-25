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
import { dispatchItem } from './dispatch.ts';
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
  /**
   * Run the built-in header-based classifier between `preIngest` and
   * `postClassify` hook stages. Default `true`. Emits the standard
   * `newsletter` / `list` / `bulk` / `auto-reply` / `bounce` labels on
   * the item. Set to `false` if you want to run your own classification
   * logic as a preIngest or postClassify hook instead.
   */
  classify?: boolean;
  /**
   * Label applied to items that a hook verdicts 'quarantine'. Consumers
   * filter these out of main views via `exclude_labels: [quarantineLabel]`.
   * Default `'quarantined'`.
   */
  quarantineLabel?: string;
}

/**
 * Build an `email()` handler bound to the given registry. Reusable across
 * Workers if you have multiple deployments sharing the same registry shape.
 */
export function createEmailHandler(
  opts: CreateEmailHandlerOptions,
): (msg: ForwardableEmailMessage, env?: unknown, ctx?: unknown) => Promise<void> {
  const channelName = opts.channelName ?? 'cf-email';
  const channel = new CloudflareEmailChannel();
  const log = opts.log ?? ((m, extra) => console.log(`[email] ${m}`, extra ?? ''));
  const shouldClassify = opts.classify !== false;
  const quarantineLabel = opts.quarantineLabel ?? 'quarantined';

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

    // Per-registration pipeline — delegated to the shared dispatcher so the
    // pull-runner (RSS) uses the same five-stage flow (preIngest → classify
    // → postClassify → sinks → postStore). We wrap the dispatcher's log so
    // every line carries the email envelope (from/to) without the dispatcher
    // needing to know about it.
    for (const reg of registrations) {
      const regName = findRegistrationName(opts.registry, reg);
      const envelopeLog = (m: string, extra?: Record<string, unknown>) =>
        log(m, { ...(extra ?? {}), from: msg.from, to: msg.to });
      const result = await dispatchItem(reg, regName, parsed.item, {
        channel: channelName,
        blobs: parsed.blobs,
        classify: shouldClassify,
        quarantineLabel,
        log: envelopeLog,
      });
      if (result.dropped) {
        envelopeLog('dropped', { registration: regName, reason: result.drop_reason });
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
