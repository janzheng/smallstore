/**
 * Plus-addressing intent hook — explicit intent via `+suffix` email addresses.
 *
 * Companion to `forward-detect.ts`. Where forward-detection is a heuristic
 * ("looks like it came from the user's own inbox"), plus-addressing is the
 * **explicit, user-typed** intent surface:
 *
 *     mailroom+bookmark@labspace.ai    →  labels: ['bookmark', 'manual']
 *     mailroom+archive@labspace.ai     →  labels: ['archive',  'manual']
 *     mailroom+read-later@labspace.ai  →  labels: ['read-later','manual']
 *
 * Design decision D2 from `.brief/mailroom-curation.md`: **both paths work,
 * and plus-addressing wins on explicit intent.** When the user goes to the
 * trouble of typing `+bookmark`, they've said exactly what they want — we
 * honor it over any heuristic signal.
 *
 * Infrastructure note (D5): CF Email Routing needs a `mailroom+*@labspace.ai
 * → worker` rule; without it plus-addressed mail bounces before hitting the
 * hook. That's a one-time dashboard edit and is tracked separately.
 *
 * ## Shape
 *
 * - `extractPlusIntent(item, opts)` — pure function. Reads
 *   `item.fields.inbox_addr` (which the cf-email channel sets as lowercased
 *   `envelope_to`). Returns `{ intent, labels }` when plus-addressed AND the
 *   intent is on the allow-list; otherwise returns `{ labels: [] }` as a
 *   no-op signal.
 * - `createPlusAddrHook(opts)` — returns a `PreIngestHook` wired to the
 *   options. Mutates the item (adds labels + `fields.intent`) when plus-
 *   addressed; returns `'accept'` otherwise.
 *
 * ## Allow-list

 *
 * `allowedIntents` prevents junk tags from random `+anything@` addresses
 * (spammers probing; user typos). The default list covers the curation
 * vocabulary used by the mailroom brief. `'inbox'` is included so a user
 * can *explicitly* land mail in the main view even when rules would
 * otherwise auto-archive it.
 *
 * ## What this hook does NOT do
 *
 * - **Route to a different inbox.** Plus-addressing here is intent-tagging
 *   on the same inbox. Per-address routing to separate inboxes is a
 *   different feature (envelope_to routing, tracked elsewhere).
 * - **Verify the sender.** The hook trusts whoever typed the `+bookmark`
 *   suffix. Abuse mitigation (if needed) lives in forward-detect or a
 *   rate-limit hook — not here.
 * - **Preserve intent case for display.** Intents are normalized to
 *   lowercase. If we ever want human-facing capitalization, that's a
 *   display-layer concern; the label + field value stays lowercase for
 *   filter stability.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PreIngestHook,
} from './types.ts';

// ============================================================================
// Defaults
// ============================================================================

/**
 * Default allow-list of plus-addressing intents.
 *
 * Sourced from the mailroom-curation brief (bookmark, archive, read-later)
 * plus pragmatic additions:
 *
 * - `'star'`     — favorites / pin surface (parallel to `'bookmark'`)
 * - `'inbox'`    — explicit "land in main view" override when rules
 *                  would otherwise auto-archive
 * - `'snooze'`   — placeholder for the snooze/remind-later feature
 */
const DEFAULT_ALLOWED_INTENTS: readonly string[] = [
  'bookmark',
  'archive',
  'read-later',
  'star',
  'inbox',
  'snooze',
];

/**
 * Default extra labels applied alongside the intent label.
 *
 * `'manual'` marks items that were user-intentional (plus-addressed or
 * forwarded) so they can be distinguished from auto-ingested mail. Matches
 * the `'manual'` label the forward-detect hook applies.
 */
const DEFAULT_EXTRA_LABELS: readonly string[] = ['manual'];

/**
 * Maximum accepted intent length. Prevents someone mailing
 * `mailroom+<garbage 10000 chars>@...` and polluting the label set. The
 * default allow-list keeps this moot, but the bound matters when callers
 * pass their own `allowedIntents` list.
 */
const MAX_INTENT_LENGTH = 64;

// ============================================================================
// Options + result
// ============================================================================

export interface PlusAddressingOptions {
  /**
   * Local part that the worker owns (case-insensitive). For
   * `mailroom@labspace.ai`, this is `'mailroom'`. If the envelope local part
   * doesn't match, the hook is a no-op (the mail is for someone else — e.g.
   * a shared domain serving multiple workers).
   */
  baseLocal: string;
  /**
   * Allowed intent suffixes. Only tags the item if `+<intent>` matches one
   * of these (case-insensitive). Prevents junk tags from random
   * `+anything@` addresses. Default:
   * `['bookmark', 'archive', 'read-later', 'star', 'inbox', 'snooze']`.
   */
  allowedIntents?: string[];
  /**
   * Additional labels applied alongside the intent. Default: `['manual']`.
   * The intent itself becomes a label too — e.g. `+bookmark` →
   * `labels: ['bookmark', 'manual']`.
   */
  extraLabels?: string[];
}

export interface PlusAddressingResult {
  /** Extracted intent (lowercased), or undefined if not plus-addressed / not allowed. */
  intent?: string;
  /** Labels to merge. Empty if not plus-addressed OR intent not in allow-list. */
  labels: string[];
}

// ============================================================================
// Pure extraction
// ============================================================================

/**
 * Extract plus-addressing intent from an `InboxItem`. Pure — does not
 * mutate the input.
 *
 * Reads `item.fields.inbox_addr` (the cf-email channel writes this as the
 * lowercased envelope recipient). Returns an empty result (no intent, no
 * labels) when:
 *
 * - `inbox_addr` is missing
 * - The local part doesn't match `opts.baseLocal` (mail is for someone else)
 * - There's no `+` suffix (plain `mailroom@...`)
 * - The suffix is empty (`mailroom+@...`)
 * - The intent is longer than 64 chars (garbage guard)
 * - The intent is not in `allowedIntents`
 *
 * On a valid hit returns `{ intent, labels: [intent, ...extraLabels] }` with
 * the intent lowercased and deduped against `extraLabels`.
 *
 * ### Nested-plus handling
 *
 * `mailroom+foo+bar@labspace.ai` → intent is the full `"foo+bar"` (take
 * everything after the *first* `+`). If that composite isn't in the allow
 * list (it usually won't be), the hook no-ops. Users who want nested-plus
 * to mean something can add the composite to their `allowedIntents`.
 */
export function extractPlusIntent(
  item: InboxItem,
  opts: PlusAddressingOptions,
): PlusAddressingResult {
  const empty: PlusAddressingResult = { labels: [] };

  const addr = item.fields?.inbox_addr;
  if (typeof addr !== 'string' || addr.length === 0) return empty;

  // Split on '@' — take the last '@' so edge-case addresses like
  // `"quoted+plus"@domain` at least parse the domain right. Local part
  // is everything before the final '@'.
  const atIdx = addr.lastIndexOf('@');
  if (atIdx <= 0) return empty;
  const localPart = addr.slice(0, atIdx);

  const baseLocalLower = opts.baseLocal.toLowerCase();
  const localLower = localPart.toLowerCase();

  // Must be `<baseLocal>+<something>` — not a literal match, not a
  // different local part, not `+` with an empty intent.
  const prefix = baseLocalLower + '+';
  if (!localLower.startsWith(prefix)) return empty;

  const intentRaw = localPart.slice(prefix.length);
  if (intentRaw.length === 0) return empty;          // `mailroom+@...`
  if (intentRaw.length > MAX_INTENT_LENGTH) return empty;

  const intent = intentRaw.toLowerCase();

  const allowed = (opts.allowedIntents ?? DEFAULT_ALLOWED_INTENTS).map(
    (i) => i.toLowerCase(),
  );
  if (!allowed.includes(intent)) return empty;

  const extras = opts.extraLabels ?? DEFAULT_EXTRA_LABELS;
  // Dedupe while preserving order: intent first, then extras.
  const labelSet = new Set<string>([intent, ...extras]);

  return { intent, labels: Array.from(labelSet) };
}

// ============================================================================
// Hook factory
// ============================================================================

/**
 * Build a `PreIngestHook` from plus-addressing options.
 *
 * On a plus-addressed hit the hook returns a **mutated item** (the hook
 * pipeline's way of replacing the item for downstream stages) with:
 *
 * - `labels`: merged with the intent-derived labels (deduped, Set-based).
 * - `fields.intent`: set to the lowercased intent string, so rules and
 *   sinks can key off the field directly without re-parsing the address.
 *
 * Otherwise returns `'accept'` (pipeline continues unchanged).
 *
 * Never returns `'drop'` or `'quarantine'` — this hook only adds intent,
 * it never rejects mail. Spam / blocklist concerns live in other hooks.
 */
export function createPlusAddrHook(opts: PlusAddressingOptions): PreIngestHook {
  return (item: InboxItem, _ctx: HookContext): Promise<HookVerdict> => {
    const result = extractPlusIntent(item, opts);
    if (!result.intent || result.labels.length === 0) {
      return Promise.resolve('accept');
    }

    const mergedLabels = Array.from(
      new Set<string>([...(item.labels ?? []), ...result.labels]),
    );

    const mutated: InboxItem = {
      ...item,
      labels: mergedLabels,
      fields: {
        ...item.fields,
        intent: result.intent,
      },
    };

    return Promise.resolve(mutated);
  };
}
