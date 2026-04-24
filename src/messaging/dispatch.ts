/**
 * Shared pipeline dispatcher.
 *
 * A single `InboxItem` runs through the same five-stage pipeline whether it
 * was pushed in by `email()` (cf-email channel) or pulled in by the RSS
 * pull-runner: **preIngest → classify → postClassify → sinks → postStore**.
 *
 * `createEmailHandler` and the RSS pull-runner both delegate here so the
 * hook + sink + quarantine semantics stay identical. Channel-specific concerns
 * (which channel to match, how to read raw payload, what "drop" means for
 * logging) stay in the caller.
 *
 * Single-registration shape: the caller picks the registration to dispatch to
 * (by-channel lookup for push, by-name lookup for pull) and hands it here.
 * The dispatcher does NOT know about the registry itself — it takes the
 * already-resolved `InboxRegistration` + a resolved registration name.
 *
 * The function never throws — every hook + sink + postStore error is caught,
 * logged, and folded into the returned `DispatchResult`. Throwing hooks are a
 * bug, but one buggy hook shouldn't kill the whole ingest.
 */

import { classifyAndMerge } from './classifier.ts';
import type { InboxRegistration } from './registry.ts';
import type {
  BlobPayload,
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
  PreIngestHook,
  SinkContext,
  SinkResult,
} from './types.ts';

// ============================================================================
// Types
// ============================================================================

export interface DispatchOptions {
  /** Channel name written into HookContext + SinkContext (e.g. "cf-email", "rss"). */
  channel: string;
  /** Blobs produced by the channel parse. Passed through to sinks. */
  blobs?: Record<string, BlobPayload>;
  /**
   * Run the built-in classifier between `preIngest` and `postClassify`.
   * Default `true`. Benign for non-email items (classifier short-circuits
   * when `fields.headers` + `fields.from_email` are absent).
   */
  classify?: boolean;
  /**
   * Label applied when any hook verdicts 'quarantine'. Items still flow
   * through sinks; consumers filter via `exclude_labels: [label]`.
   * Default `'quarantined'`.
   */
  quarantineLabel?: string;
  /** Logger for structured events. Default: console.log. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface DispatchResult {
  /** Final item after hook mutations + quarantine-label merge. `null` if dropped. */
  item: InboxItem | null;
  /** True if any hook returned 'drop' — sinks were NOT invoked. */
  dropped: boolean;
  /** Reason attached to the drop verdict (hook index + stage). */
  drop_reason?: string;
  /** True if the quarantine label was applied. */
  quarantined: boolean;
  /** Per-sink results in sink-index order. Empty if dropped. */
  results: SinkResult[];
}

type HookOutcome =
  | { action: 'continue'; item: InboxItem }
  | { action: 'drop'; reason?: string }
  | { action: 'quarantine'; item: InboxItem };

// ============================================================================
// Public API
// ============================================================================

/**
 * Dispatch a parsed `InboxItem` through a single registration's pipeline.
 *
 * Stages:
 *   1. `reg.hooks.preIngest` — hooks can mutate, drop, or quarantine.
 *   2. Built-in `classifyAndMerge` (opt-out via `opts.classify = false`).
 *   3. `reg.hooks.postClassify` — same verdict surface as preIngest.
 *   4. Fan out to `reg.sinks` in order. Each sink is guarded with try/catch
 *      so one failing sink doesn't stop the others.
 *   5. `reg.hooks.postStore` — inspection-only; cannot alter the item.
 */
export async function dispatchItem(
  reg: InboxRegistration,
  regName: string | undefined,
  initialItem: InboxItem,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const log = opts.log ?? ((m, extra) => console.log(`[dispatch] ${m}`, extra ?? ''));
  const shouldClassify = opts.classify !== false;
  const quarantineLabel = opts.quarantineLabel ?? 'quarantined';

  const ctx: HookContext = { channel: opts.channel, registration: regName };
  let item: InboxItem = initialItem;

  // ── Stage 1: preIngest ──────────────────────────────────────────────
  const preOutcome = await runHookChain(reg.hooks.preIngest, item, ctx, log, regName, 'preIngest');
  if (preOutcome.action === 'drop') {
    return { item: null, dropped: true, drop_reason: preOutcome.reason, quarantined: false, results: [] };
  }
  item = preOutcome.item;
  let isQuarantined = preOutcome.action === 'quarantine';

  // ── Stage 2: built-in classifier ────────────────────────────────────
  if (shouldClassify) {
    try {
      item = classifyAndMerge(item);
    } catch (err) {
      log('classify threw (bug in classifier)', {
        registration: regName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Stage 3: postClassify ───────────────────────────────────────────
  const postOutcome = await runHookChain(
    reg.hooks.postClassify,
    item,
    ctx,
    log,
    regName,
    'postClassify',
  );
  if (postOutcome.action === 'drop') {
    return { item: null, dropped: true, drop_reason: postOutcome.reason, quarantined: false, results: [] };
  }
  item = postOutcome.item;
  if (postOutcome.action === 'quarantine') isQuarantined = true;

  // ── Quarantine tagging (persist-but-label for recovery) ─────────────
  if (isQuarantined) {
    item = {
      ...item,
      labels: Array.from(new Set([...(item.labels ?? []), quarantineLabel])),
    };
  }

  // ── Stage 4: sink fan-out ───────────────────────────────────────────
  const sinkCtx: SinkContext = {
    blobs: opts.blobs,
    channel: opts.channel,
    registration: regName,
  };
  const results: SinkResult[] = [];
  for (let i = 0; i < reg.sinks.length; i++) {
    let result: SinkResult;
    try {
      result = await reg.sinks[i](item, sinkCtx);
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
      });
    } else {
      log('sink failed (soft)', {
        registration: regName,
        sink_idx: i,
        error: result.error,
      });
    }
  }

  // ── Stage 5: postStore ──────────────────────────────────────────────
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

  return { item, dropped: false, quarantined: isQuarantined, results };
}

// ============================================================================
// Internals
// ============================================================================

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
