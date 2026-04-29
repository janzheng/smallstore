/**
 * Sender reputation hook — Layer 3 of the layered spam defense.
 *
 * Reads aggregate stats from the sender-index and emits a
 * `spam-suspect:<level>` LABEL on items from senders whose explicit
 * spam_rate crosses configurable thresholds. The hook NEVER makes a
 * verdict — the rules engine decides whether `spam-suspect:high`
 * means "quarantine" for a given user.
 *
 * Trusted-sender bypass is mandatory (`.brief/spam-layers.md`
 * decision #4): a sender carrying the `trusted` tag never receives
 * the suspect label, even if their spam_count is high. The mark-spam
 * endpoint still bumps the counter so `computeConsiderDemote` can
 * prompt the operator to revisit the trust call once the pattern
 * crosses the demote threshold.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
} from './types.ts';
import type { SenderIndex } from './sender-index.ts';

export interface SpamReputationHookOptions {
  /** Sender index to read reputation from. Required — without it, the hook is a no-op. */
  senderIndex: SenderIndex;
  /** Min count threshold before any spam-suspect label fires. Default 3. */
  minCount?: number;
  /** spam_rate threshold for 'high' label. Default 0.7. */
  highThreshold?: number;
  /** spam_rate threshold for 'medium' label. Default 0.4. */
  mediumThreshold?: number;
}

/**
 * True when a trusted sender's spam pattern crosses the demote-prompt
 * threshold (decision #4): the sender carries 'trusted', has at least
 * 5 explicit user marks (spam + not-spam combined), and >50% are spam.
 *
 * Pure function — no I/O. Pass in the SenderRecord (already loaded
 * by the caller).
 */
export function computeConsiderDemote(
  record: { tags?: string[]; spam_count: number; not_spam_count: number } | null,
): boolean {
  if (!record) return false;
  if (!record.tags?.includes('trusted')) return false;
  const total = (record.spam_count ?? 0) + (record.not_spam_count ?? 0);
  if (total < 5) return false;
  const spam_rate = total > 0 ? (record.spam_count ?? 0) / total : 0;
  return spam_rate > 0.5;
}

const HIGH_LABEL = 'spam-suspect:high';
const MEDIUM_LABEL = 'spam-suspect:medium';

export function createSenderReputationHook(
  opts: SpamReputationHookOptions,
): PostClassifyHook {
  const senderIndex = opts.senderIndex;
  const minCount = opts.minCount ?? 3;
  const highThreshold = opts.highThreshold ?? 0.7;
  const mediumThreshold = opts.mediumThreshold ?? 0.4;

  return async function senderReputationHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    const fromEmail = item.fields?.from_email;
    if (typeof fromEmail !== 'string' || !fromEmail) return 'accept';

    let record;
    try {
      record = await senderIndex.get(fromEmail);
    } catch (err) {
      console.warn('[spam-reputation]', err);
      return 'accept';
    }
    if (!record) return 'accept';

    // Trusted bypass — never label a trusted sender as a spam suspect.
    // The mark-spam counter still bumps elsewhere; the demote-prompt
    // path uses computeConsiderDemote to surface drift.
    if (record.tags?.includes('trusted')) return 'accept';

    if ((record.count ?? 0) < minCount) return 'accept';

    // Explicit-decisions denominator per the brief — auto-tagged spam
    // (which inflates spam_count only) gets weight, but explicit
    // not-spam marks dilute the rate. `Math.max(1, ...)` guards against
    // div-by-zero when count >= minCount but neither counter has moved.
    const explicit = (record.spam_count ?? 0) + (record.not_spam_count ?? 0);
    const spam_rate = (record.spam_count ?? 0) / Math.max(1, explicit);

    let label: string | null = null;
    if (spam_rate >= highThreshold) label = HIGH_LABEL;
    else if (spam_rate >= mediumThreshold) label = MEDIUM_LABEL;
    if (!label) return 'accept';

    const existing = item.labels ?? [];
    if (existing.includes(label)) return 'accept';

    return {
      ...item,
      labels: [...existing, label],
    };
  };
}
