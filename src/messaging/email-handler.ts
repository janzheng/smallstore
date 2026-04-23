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
import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
  PostStoreHook,
  PreIngestHook,
  SinkContext,
  SinkResult,
} from './types.ts';
import { CloudflareEmailChannel } from './channels/cf-email.ts';
import { classifyAndMerge } from './classifier.ts';

/**
 * What a preIngest / postClassify hook returned, in pipeline terms.
 * Used internally by the dispatcher to decide next action.
 */
type HookOutcome =
  | { action: 'continue'; item: InboxItem }
  | { action: 'drop'; reason?: string }
  | { action: 'quarantine'; item: InboxItem };

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
export function createEmailHandler(opts: CreateEmailHandlerOptions) {
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

    // Per-registration pipeline: preIngest hooks → classify → postClassify
    // hooks → sink fan-out → postStore hooks. Each stage can mutate, drop,
    // or quarantine the item independently per registration.
    for (const reg of registrations) {
      const regName = findRegistrationName(opts.registry, reg);
      const ctx: HookContext = { channel: channelName, registration: regName };

      // Start pipeline state
      let item: InboxItem = parsed.item;

      // ── Stage 1: preIngest hooks ─────────────────────────────────
      const preOutcome = await runHookChain(reg.hooks.preIngest, item, ctx, log, regName, 'preIngest');
      if (preOutcome.action === 'drop') {
        log('dropped by preIngest', { registration: regName, reason: preOutcome.reason });
        continue;
      }
      item = preOutcome.item;
      let isQuarantined = preOutcome.action === 'quarantine';

      // ── Stage 2: built-in classify ───────────────────────────────
      if (shouldClassify) {
        try {
          item = classifyAndMerge(item);
        } catch (err) {
          // Classifier is pure and shouldn't throw, but be safe.
          log('classify threw (bug in classifier)', {
            registration: regName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── Stage 3: postClassify hooks ──────────────────────────────
      const postOutcome = await runHookChain(
        reg.hooks.postClassify,
        item,
        ctx,
        log,
        regName,
        'postClassify',
      );
      if (postOutcome.action === 'drop') {
        log('dropped by postClassify', { registration: regName, reason: postOutcome.reason });
        continue;
      }
      item = postOutcome.item;
      if (postOutcome.action === 'quarantine') isQuarantined = true;

      // ── Quarantine tagging (persist-but-label for recovery) ──────
      if (isQuarantined) {
        item = {
          ...item,
          labels: Array.from(new Set([...(item.labels ?? []), quarantineLabel])),
        };
      }

      // ── Stage 4: sink fan-out ─────────────────────────────────────
      const sinkCtx: SinkContext = {
        blobs: parsed.blobs,
        channel: channelName,
        registration: regName,
      };
      const results: SinkResult[] = [];
      for (let i = 0; i < reg.sinks.length; i++) {
        const sink = reg.sinks[i];
        let result: SinkResult;
        try {
          result = await sink(item, sinkCtx);
        } catch (err) {
          // A throwing sink is a bug (they should return {stored:false, error})
          // but keep going with the remaining sinks.
          result = {
            stored: false,
            error: err instanceof Error ? err.message : String(err),
          };
          log('sink threw (bug in sink)', {
            registration: regName,
            sink_idx: i,
            error: result.error,
          });
        }
        results.push(result);
        if (result.stored) {
          log('sink ok', {
            registration: regName,
            sink_idx: i,
            id: result.id ?? item.id,
            quarantined: isQuarantined,
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
      }

      // ── Stage 5: postStore hooks ──────────────────────────────────
      for (const hook of reg.hooks.postStore) {
        try {
          await hook(item, ctx, results);
        } catch (err) {
          log('postStore hook threw', {
            registration: regName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  };
}

/**
 * Run a chain of preIngest / postClassify hooks. Each hook sees the item
 * from the previous hook's output (if that hook returned a mutated item).
 * Short-circuits on 'drop'. Collapses 'quarantine' into the final outcome
 * (any hook verdicting quarantine taints the chain regardless of later
 * hooks returning 'accept').
 */
async function runHookChain(
  hooks: Array<PreIngestHook | PostClassifyHook>,
  startItem: InboxItem,
  ctx: HookContext,
  log: (msg: string, extra?: Record<string, unknown>) => void,
  regName: string | undefined,
  stage: 'preIngest' | 'postClassify',
): Promise<HookOutcome> {
  let item = startItem;
  let quarantined = false;
  for (let i = 0; i < hooks.length; i++) {
    let verdict: HookVerdict;
    try {
      verdict = await hooks[i](item, ctx);
    } catch (err) {
      // A throwing hook is treated as pass-through (accept) with a log —
      // we don't want a buggy hook to kill the entire pipeline. Severe
      // failures should still surface via log inspection.
      log(`${stage} hook threw (bug in hook)`, {
        registration: regName,
        hook_idx: i,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (verdict === 'drop') {
      return { action: 'drop', reason: `hook[${i}] verdict=drop` };
    }
    if (verdict === 'quarantine') {
      quarantined = true;
      continue;
    }
    if (verdict === 'accept') {
      continue;
    }
    // Hook returned a mutated item
    item = verdict;
  }
  return quarantined ? { action: 'quarantine', item } : { action: 'continue', item };
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
