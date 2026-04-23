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
