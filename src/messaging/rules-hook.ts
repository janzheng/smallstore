/**
 * Rules preIngest hook factory.
 *
 * Wraps a `RulesStore` into a `PreIngestHook` that evaluates every enabled
 * rule against an incoming `InboxItem` and returns a `HookVerdict`:
 *
 * - Terminal `'drop'` → returns `'drop'` verdict; the pipeline aborts and
 *   the item is NOT stored.
 * - Terminal `'quarantine'` → returns a mutated item with any tag-style
 *   labels + the configured `quarantineLabel` merged in. The built-in
 *   quarantine verdict path in the email-handler will also dedupe the label
 *   if it fires, but we add it here too so the label is visible regardless
 *   of how the downstream caller treats the verdict.
 * - Tag-style matches only → returns a mutated item with `labelsToAdd`
 *   merged onto `item.labels` (deduped).
 * - No matches → returns `'accept'` (no mutation).
 *
 * See `.brief/mailroom-curation.md` § UC2 for the flow.
 */

import { DEFAULT_QUARANTINE_LABEL } from './quarantine.ts';
import type { RulesStore } from './rules.ts';
import type { HookContext, HookVerdict, InboxItem, PreIngestHook } from './types.ts';

export interface RulesHookOptions {
  /** The rules store to evaluate on each ingest. */
  rulesStore: RulesStore;
  /**
   * Label applied when a rule verdicts `quarantine`. Defaults to
   * `'quarantined'` — should match the surrounding email-handler's
   * `quarantineLabel` option so consumers have a single label to filter on.
   */
  quarantineLabel?: string;
}

/**
 * Build a preIngest hook that applies every matching rule to the item.
 *
 * @example
 * ```ts
 * const rules = createRulesStore(adapter);
 * const hook = createRulesHook({ rulesStore: rules });
 * registry.register('mailroom', inbox, cfg, 'boot', { preIngest: [hook] });
 * ```
 */
export function createRulesHook(opts: RulesHookOptions): PreIngestHook {
  const { rulesStore } = opts;
  const quarantineLabel = opts.quarantineLabel ?? DEFAULT_QUARANTINE_LABEL;

  return async function rulesHook(item: InboxItem, _ctx: HookContext): Promise<HookVerdict> {
    // B008 second-line: if the rules store throws (e.g. storage adapter
    // outage, malformed rule payload that escapes the per-rule try/catch in
    // `apply`, etc.) we must NOT crash the ingest pipeline. A single broken
    // rule wedging the mailroom for hours is the failure mode we're guarding
    // against — fall back to 'accept' and log the error so the operator can
    // see it surface in the Worker logs.
    let result;
    try {
      result = await rulesStore.apply(item);
    } catch (err) {
      console.error(
        `[rulesHook] rulesStore.apply threw for item ${item.id}; accepting item unmodified to keep ingest alive:`,
        err,
      );
      return 'accept';
    }

    // Drop wins unconditionally: item never reaches sinks.
    if (result.terminal === 'drop') {
      return 'drop';
    }

    // Nothing matched → let the pipeline continue untouched.
    if (result.terminal === undefined && result.labelsToAdd.length === 0) {
      return 'accept';
    }

    // Merge tag-style labels + (if quarantine) the quarantine label into the
    // item. Dedup via Set.
    const existing = item.labels ?? [];
    const next = new Set<string>(existing);
    for (const label of result.labelsToAdd) next.add(label);
    if (result.terminal === 'quarantine') next.add(quarantineLabel);

    const mutated: InboxItem = {
      ...item,
      labels: Array.from(next),
    };
    return mutated;
  };
}
