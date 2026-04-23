/**
 * Inbox filter evaluator.
 *
 * Pure function: takes a parsed `InboxFilter` + an `InboxItem`, returns boolean.
 *
 * Semantics (mirrors `InboxFilter` doc):
 * - All top-level keys AND together
 * - Within an array value, entries OR
 * - `fields.<key>` matches partial substring (case-insensitive) on string values
 * - `text` substring-matches across `summary` + `body`
 * - `labels`/`exclude_labels` test the `labels` array (whole-tag match)
 * - `since`/`until` compare ISO timestamps against `received_at`
 * - `source`/`thread_id` whole-string match (or OR within array)
 * - `fields_regex.<key>` tests case-insensitive JS regex against stringified field
 * - `text_regex` tests case-insensitive JS regex against summary + body
 * - `headers.<name>` matches against item.fields.headers (lowercase-keyed):
 *   'present' | 'absent' | regex pattern
 * - Invalid regex in any *_regex / headers rule → no-match (never throws)
 */

import type { InboxFilter, InboxItem } from './types.ts';

export function evaluateFilter(filter: InboxFilter, item: InboxItem): boolean {
  if (filter.source !== undefined && !matchOneOf(filter.source, item.source)) return false;
  if (filter.thread_id !== undefined) {
    if (item.thread_id === undefined) return false;
    if (!matchOneOf(filter.thread_id, item.thread_id)) return false;
  }

  if (filter.since !== undefined && item.received_at < filter.since) return false;
  if (filter.until !== undefined && item.received_at > filter.until) return false;

  if (filter.labels?.length) {
    const has = new Set(item.labels ?? []);
    for (const required of filter.labels) {
      if (!has.has(required)) return false;
    }
  }

  if (filter.exclude_labels?.length) {
    const has = new Set(item.labels ?? []);
    for (const banned of filter.exclude_labels) {
      if (has.has(banned)) return false;
    }
  }

  if (filter.text !== undefined && filter.text.length > 0) {
    const needle = filter.text.toLowerCase();
    const hay = `${item.summary ?? ''}\n${item.body ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }

  if (filter.fields) {
    for (const [key, expected] of Object.entries(filter.fields)) {
      const actual = item.fields?.[key];
      if (actual === undefined || actual === null) return false;
      if (!matchFieldPartial(expected, actual)) return false;
    }
  }

  if (filter.fields_regex) {
    for (const [key, expected] of Object.entries(filter.fields_regex)) {
      const actual = item.fields?.[key];
      if (actual === undefined || actual === null) return false;
      if (!matchFieldRegex(expected, actual)) return false;
    }
  }

  if (filter.text_regex !== undefined && filter.text_regex.length > 0) {
    const re = compileRegex(filter.text_regex);
    if (!re) return false;
    const hay = `${item.summary ?? ''}\n${item.body ?? ''}`;
    if (!re.test(hay)) return false;
  }

  if (filter.headers) {
    const headers = (item.fields?.headers ?? {}) as Record<string, any>;
    for (const [rawName, rule] of Object.entries(filter.headers)) {
      const name = rawName.toLowerCase();
      const has = Object.prototype.hasOwnProperty.call(headers, name);
      if (rule === 'present') {
        if (!has) return false;
        continue;
      }
      if (rule === 'absent') {
        if (has) return false;
        continue;
      }
      // regex rule
      const re = compileRegex(rule);
      if (!re) return false;
      const value = has ? String(headers[name] ?? '') : '';
      if (!value) return false;
      if (!re.test(value)) return false;
    }
  }

  return true;
}

// ============================================================================
// Helpers
// ============================================================================

/** Whole-string match against a single string or OR-of-array. */
function matchOneOf(expected: string | string[], actual: string): boolean {
  if (Array.isArray(expected)) {
    return expected.some(e => e === actual);
  }
  return expected === actual;
}

/**
 * Partial (case-insensitive substring) match for `fields.<key>`.
 *
 * - Field value is stringified before compare (numbers become "42", etc.).
 * - Field value array → ANY entry matches.
 * - Expected array → ANY entry must substring-match the field.
 */
function matchFieldPartial(expected: string | string[], actual: any): boolean {
  const haystacks = Array.isArray(actual)
    ? actual.map(v => String(v).toLowerCase())
    : [String(actual).toLowerCase()];

  const needles = (Array.isArray(expected) ? expected : [expected]).map(n => n.toLowerCase());

  // OR within expected, OR across haystacks
  return needles.some(n => haystacks.some(h => h.includes(n)));
}

/**
 * Regex match for `fields_regex.<key>`.
 *
 * - Patterns compiled case-insensitive.
 * - Invalid patterns → skipped (no-match) rather than throwing.
 * - Field value array → ANY entry matches.
 * - Expected array → ANY pattern must match (OR).
 */
function matchFieldRegex(expected: string | string[], actual: any): boolean {
  const patterns = (Array.isArray(expected) ? expected : [expected])
    .map(compileRegex)
    .filter((r): r is RegExp => r !== null);

  if (patterns.length === 0) return false;

  const haystacks = Array.isArray(actual)
    ? actual.map(v => String(v))
    : [String(actual)];

  return patterns.some(re => haystacks.some(h => re.test(h)));
}

/** Compile a regex pattern, case-insensitive; return null on SyntaxError. */
function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

// ============================================================================
// mainViewFilter — ergonomic helper for "the default inbox view"
// ============================================================================

/** Labels excluded from a main inbox view by default. Override via opts.hiddenLabels. */
export const DEFAULT_HIDDEN_LABELS: string[] = ['archived', 'quarantined'];

/**
 * Build a filter that excludes the default "hidden" labels (archived +
 * quarantined) while preserving any existing filter conditions. Prevents
 * the "forgot to hide archived" footgun when querying the main inbox view.
 *
 * Behavior:
 * - If `base` has `exclude_labels`, the helper merges them with hidden
 *   labels (Set union, deduped)
 * - All other `base` fields pass through unchanged
 * - `base` is NOT mutated — a new filter object is returned
 *
 * Use `opts.hiddenLabels` to override the default (e.g. to also hide
 * `read-later`, or to only hide `quarantined` but show `archived`).
 *
 * Example:
 * ```ts
 * // Main view: exclude archived + quarantined from newsletters
 * const filter = mainViewFilter({ labels: ['newsletter'] });
 * // → { labels: ['newsletter'], exclude_labels: ['archived', 'quarantined'] }
 *
 * const result = await inbox.query(filter);
 * ```
 */
export function mainViewFilter(
  base?: InboxFilter,
  opts?: { hiddenLabels?: string[] },
): InboxFilter {
  const hidden = opts?.hiddenLabels ?? DEFAULT_HIDDEN_LABELS;
  const existing = base?.exclude_labels ?? [];
  const merged = Array.from(new Set([...existing, ...hidden]));
  return {
    ...base,
    exclude_labels: merged,
  };
}
