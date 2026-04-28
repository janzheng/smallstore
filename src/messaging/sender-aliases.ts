/**
 * Sender-name alias hook — attach a canonical display name to ingested
 * items so filter-by-person works without memorizing address variants.
 *
 * Motivation: a single human (e.g. Jessica) sends mail from
 * `jessica.c.sacher@gmail.com`, `jessica@phage.directory`, and
 * `jessica.c.sacher@iee.org`. Filtering by address requires remembering
 * each variant. With a sender alias map we collapse them to a single
 * `sender:jessica` label and a `fields.sender_name = "Jessica"` field,
 * so queries like `labels: ['sender:jessica']` hit every address.
 *
 * ## Shape
 *
 *   const aliases: SenderAliasRule[] = [
 *     { pattern: 'jessica.c.sacher@*', name: 'Jessica' },
 *     { pattern: 'jan@phage.directory', name: 'Jan' },
 *     { pattern: 'janzheng@*',          name: 'Jan' },
 *   ];
 *
 * Glob support: `*` matches any sequence of characters (including empty
 * or `@`). Patterns are compared case-insensitively. Exact matches work
 * fine with no wildcard.
 *
 * Specificity: `parseSenderAliases` sorts rules by literal-prefix length
 * (longest first) with insertion order as a stable tie-breaker, so the
 * most-specific rule wins regardless of how the user wrote the config —
 * `[*@example.com:Generic, jan@example.com:Jan]` correctly matches
 * `jan@example.com` to `Jan`, not `Generic` (B029).
 *
 * ## Which address does the hook check?
 *
 * `fields.original_from_email` (set by forward-detect.ts when the mail
 * was forwarded from the user's own inbox) takes precedence over
 * `fields.from_email`. This keeps the alias accurate when Jessica's mail
 * arrives via forward — `from_email` is `me@...` but `original_from_email`
 * is Jessica's actual address.
 *
 * ## What the hook writes
 *
 * - `fields.sender_name` — the canonical display name (e.g. "Jessica")
 * - `labels` — merges a `sender:<slug>` label (e.g. `sender:jessica`).
 *   Slug is lowercase, alphanumeric + dashes.
 *
 * The hook NEVER rewrites `from_email` or `original_from_email` — aliases
 * are additive metadata, not substitution. Existing filters keyed on the
 * raw address keep working.
 *
 * ## What this hook does NOT do
 *
 * - **Rename the sender for outgoing replies.** This is a display-side
 *   label, not an identity change.
 * - **Store aliases server-side.** Config lives in whatever wires the
 *   hook (static boot config today; admin CRUD later).
 * - **Wildcard matching beyond `*`.** No regex escape sequences, no `?`,
 *   no character classes. Keep the mental model small; if real needs
 *   outgrow it, swap for regex patterns later.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PreIngestHook,
} from './types.ts';

// ============================================================================
// Types
// ============================================================================

export interface SenderAliasRule {
  /** Glob pattern matched (case-insensitive) against the sender address. `*` = any chars. */
  pattern: string;
  /** Canonical display name (e.g. "Jessica"). Slugified for the label. */
  name: string;
}

export interface SenderAliasesOptions {
  /**
   * Alias rules. Accept several shapes for convenience:
   *  - Array of `{ pattern, name }` (most explicit; controls order)
   *  - Record of `pattern -> name` (order follows insertion)
   */
  aliases: SenderAliasRule[] | Record<string, string>;
}

export interface SenderAliasResult {
  /** The matched canonical name (e.g. "Jessica"); `null` if no rule fired. */
  name: string | null;
  /** `sender:<slug>` label to merge onto the item, or `null` if no match. */
  label: string | null;
  /** The sender address the match was made against (for logging/debug). */
  matched_address?: string;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Length of the literal (non-glob) prefix of an alias pattern. Used by
 * `parseSenderAliases` to sort rules by specificity (longest literal
 * prefix wins). The only glob char supported by `globToRegex` is `*`,
 * so we measure the prefix before the first `*`.
 */
function literalPrefixLength(pattern: string): number {
  const star = pattern.indexOf('*');
  return star === -1 ? pattern.length : star;
}

/**
 * Sort alias rules by literal-prefix length descending (most specific
 * first), with insertion order as a stable tie-breaker. Same shape as
 * `router.ts` B017 for routing patterns.
 *
 * **B029**: pre-fix, `matchSenderAlias` iterated rules in insertion order
 * and returned on first match — broad patterns added first ate narrower
 * ones added later (e.g. `[*@example.com:Generic, jan@example.com:Jan]`
 * incorrectly returned `Generic` for `jan@example.com`). Sorting once at
 * parse time gives the matcher a predictable specificity order regardless
 * of how the user wrote the config.
 */
function sortRulesBySpecificity(rules: SenderAliasRule[]): SenderAliasRule[] {
  return rules
    .map((rule, index) => ({ rule, index, prefixLen: literalPrefixLength(rule.pattern) }))
    .sort((a, b) => {
      if (b.prefixLen !== a.prefixLen) return b.prefixLen - a.prefixLen;
      return a.index - b.index;
    })
    .map((entry) => entry.rule);
}

/**
 * Normalize a user-provided alias config into `SenderAliasRule[]`.
 *
 * Accepts:
 *  - `undefined` → `[]`
 *  - `SenderAliasRule[]` → passed through (pattern lowercased, name trimmed)
 *  - `Record<string, string>` → `[{pattern, name}, ...]` in insertion order
 *  - a comma-separated string like `"jessica.c.sacher@*:Jessica,jan@phage.directory:Jan"`
 *    (intended for env-var configs; colon separates pattern from name)
 *
 * Empty patterns or names are dropped. Patterns are lowercased; names are
 * trimmed but keep their original case.
 *
 * **B029 ordering:** the returned array is sorted by literal-prefix length
 * (longest first) with insertion order as a stable tie-breaker, so
 * `matchSenderAlias`'s first-match-wins iteration honors specificity
 * regardless of how the user wrote the config. Sort happens once here at
 * parse time, NOT on every match call.
 */
export function parseSenderAliases(
  input: string | Record<string, string> | SenderAliasRule[] | undefined,
): SenderAliasRule[] {
  if (!input) return [];

  // Rule-array form
  if (Array.isArray(input)) {
    const out: SenderAliasRule[] = [];
    for (const rule of input) {
      if (!rule || typeof rule !== 'object') continue;
      const pattern = String(rule.pattern ?? '').trim().toLowerCase();
      const name = String(rule.name ?? '').trim();
      if (!pattern || !name) continue;
      out.push({ pattern, name });
    }
    return sortRulesBySpecificity(out);
  }

  // CSV string form: "pattern:name,pattern:name"
  if (typeof input === 'string') {
    const out: SenderAliasRule[] = [];
    for (const entry of input.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon === -1) continue; // malformed — skip silently
      const pattern = trimmed.slice(0, colon).trim().toLowerCase();
      const name = trimmed.slice(colon + 1).trim();
      if (!pattern || !name) continue;
      out.push({ pattern, name });
    }
    return sortRulesBySpecificity(out);
  }

  // Record form
  if (typeof input === 'object') {
    const out: SenderAliasRule[] = [];
    for (const [rawPattern, rawName] of Object.entries(input)) {
      const pattern = String(rawPattern ?? '').trim().toLowerCase();
      const name = String(rawName ?? '').trim();
      if (!pattern || !name) continue;
      out.push({ pattern, name });
    }
    return sortRulesBySpecificity(out);
  }

  return [];
}

// ============================================================================
// Matching
// ============================================================================

/**
 * Compile a glob-style pattern (with `*` wildcards) into a regex. Any other
 * regex metacharacters in the pattern are escaped — only `*` has meaning.
 * Anchored on both ends so partial matches never fire.
 */
function globToRegex(pattern: string): RegExp {
  // Escape regex metacharacters, then replace escaped `\*` back to `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Match `address` against the first rule in `aliases` whose pattern matches.
 * Returns `null` when nothing matches. Empty address → `null`.
 *
 * **B029 ordering note:** rules produced by `parseSenderAliases` are pre-
 * sorted by literal-prefix length (longest first), so "first match" here
 * implicitly means "most specific match." Callers passing a hand-built
 * array directly are responsible for ordering — the matcher does not
 * re-sort on every call.
 */
export function matchSenderAlias(
  address: string | undefined | null,
  aliases: SenderAliasRule[],
): SenderAliasRule | null {
  if (!address) return null;
  const lower = String(address).trim().toLowerCase();
  if (!lower) return null;
  for (const rule of aliases) {
    try {
      if (globToRegex(rule.pattern).test(lower)) return rule;
    } catch {
      // Malformed pattern — skip rather than throw.
    }
  }
  return null;
}

/**
 * Slugify a display name for use as a label suffix.
 *
 *   "Jessica"   → "jessica"
 *   "Jan C."    → "jan-c"
 *   "María"     → "maría"    (lowercase, non-ASCII preserved)
 *   "  foo bar " → "foo-bar"
 *
 * Rules:
 *  - Trim + lowercase
 *  - Collapse runs of whitespace/punctuation into a single `-`
 *  - Trim leading/trailing `-`
 *
 * Returns empty string for names that contain no slug-worthy characters.
 */
export function slugifySenderName(name: string): string {
  if (!name) return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\:;,!?@#$%^&*()+=<>"'`~|[\]{}]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// Item application
// ============================================================================

/**
 * Resolve which address to alias-match against for a given item. Forward-
 * detect populates `fields.original_from_email` when mail was forwarded
 * from the user's own inbox — in that case the original sender is the one
 * we actually want to tag (the user's own address is uninteresting).
 */
function resolveSenderAddress(item: InboxItem): string | undefined {
  const fields = item.fields ?? {};
  const original = fields.original_from_email;
  if (typeof original === 'string' && original.trim()) return original;
  const from = fields.from_email;
  if (typeof from === 'string' && from.trim()) return from;
  return undefined;
}

/**
 * Pure evaluation — returns the match result without mutating the item.
 * `label` is `sender:<slug>` when the slug is non-empty; otherwise `null`
 * even on a name match (we refuse to emit an empty-suffix label).
 */
export function applySenderAlias(
  item: InboxItem,
  aliases: SenderAliasRule[],
): SenderAliasResult {
  const address = resolveSenderAddress(item);
  const rule = matchSenderAlias(address, aliases);
  if (!rule) return { name: null, label: null, matched_address: address };

  const slug = slugifySenderName(rule.name);
  const label = slug ? `sender:${slug}` : null;
  return { name: rule.name, label, matched_address: address };
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns a `PreIngestHook` that:
 *  - resolves the sender address (original_from_email > from_email)
 *  - matches it against the alias rules (first match wins)
 *  - on hit: writes `fields.sender_name` and merges a `sender:<slug>` label
 *  - on miss: returns `'accept'` untouched
 *
 * Never throws. A malformed pattern inside `aliases` is silently skipped so
 * one bad rule doesn't break ingest for every item.
 */
export function createSenderAliasHook(opts: SenderAliasesOptions): PreIngestHook {
  const aliases = parseSenderAliases(opts.aliases);

  return async function senderAliasHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    if (aliases.length === 0) return 'accept';
    const result = applySenderAlias(item, aliases);
    if (!result.name) return 'accept';

    const nextFields: Record<string, any> = {
      ...(item.fields ?? {}),
      sender_name: result.name,
    };
    const nextLabels = result.label
      ? Array.from(new Set([...(item.labels ?? []), result.label]))
      : item.labels;

    return {
      ...item,
      fields: nextFields,
      labels: nextLabels,
    };
  };
}
