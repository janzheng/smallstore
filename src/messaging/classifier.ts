/**
 * Header-based classifier.
 *
 * Pure function: takes an `InboxItem`, reads its `fields.headers` map (and a
 * couple of related `fields.*` as fallbacks), returns an array of
 * classification labels. Does not mutate the input.
 *
 * Typically called in a post-parse hook; the caller merges the returned
 * labels into `item.labels`. `classifyAndMerge` is a convenience that does
 * that merge immutably and deduplicates.
 *
 * Labels produced:
 *
 * - `newsletter`  — `list-unsubscribe` header present
 * - `list`        — any of `list-id` / `list-post` / `list-help` present
 * - `bulk`        — `precedence` header equals `bulk` or `list` (case-insensitive)
 * - `auto-reply`  — any of:
 *                    - `auto-submitted` present AND value != `no`
 *                    - `precedence: auto_reply` (case-insensitive)
 *                    - `x-auto-response-suppress` present
 *                    - `x-autoreply` present
 * - `bounce`      — any of:
 *                    - `return-path` value is `<>` or empty
 *                    - `x-failed-recipients` present
 *                    - `content-type` starts with `multipart/report`
 *                    - `from` address starts with `mailer-daemon` or `postmaster`
 *                      (checked against `fields.from_email` first, falling back
 *                      to the raw `from` header).
 *
 * Header lookups are case-insensitive against the `headers` map (which is
 * itself stored lowercase-keyed — see `channels/cf-email.ts`). If
 * `fields.headers` is absent the classifier still inspects `fields.from_email`
 * for the bounce `mailer-daemon`/`postmaster` check; otherwise it returns
 * `[]`.
 */

import type { InboxItem } from './types.ts';

export function classify(item: InboxItem): string[] {
  const labels = new Set<string>();

  const headers = getHeaders(item);
  const fromEmail = String(item.fields?.from_email ?? '').toLowerCase();

  // Bounce: `from_email` is meaningful even without a headers map.
  if (isMailerDaemon(fromEmail)) labels.add('bounce');

  if (!headers) {
    return Array.from(labels);
  }

  // newsletter
  if (hasHeader(headers, 'list-unsubscribe')) labels.add('newsletter');

  // list
  if (
    hasHeader(headers, 'list-id') ||
    hasHeader(headers, 'list-post') ||
    hasHeader(headers, 'list-help')
  ) {
    labels.add('list');
  }

  // bulk  — precedence: bulk|list
  const precedence = getHeader(headers, 'precedence')?.trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'list') labels.add('bulk');

  // auto-reply
  const autoSubmitted = getHeader(headers, 'auto-submitted')?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') labels.add('auto-reply');
  if (precedence === 'auto_reply') labels.add('auto-reply');
  if (hasHeader(headers, 'x-auto-response-suppress')) labels.add('auto-reply');
  if (hasHeader(headers, 'x-autoreply')) labels.add('auto-reply');

  // bounce (header-driven signals)
  const returnPath = getHeader(headers, 'return-path');
  if (returnPath !== undefined) {
    const v = returnPath.trim();
    if (v === '' || v === '<>') labels.add('bounce');
  }
  if (hasHeader(headers, 'x-failed-recipients')) labels.add('bounce');
  const contentType = getHeader(headers, 'content-type')?.trim().toLowerCase();
  if (contentType && contentType.startsWith('multipart/report')) labels.add('bounce');

  // bounce: `from` header fallback (when `fields.from_email` wasn't populated)
  if (!labels.has('bounce')) {
    const fromHeader = getHeader(headers, 'from')?.toLowerCase() ?? '';
    if (isMailerDaemon(extractAddress(fromHeader))) labels.add('bounce');
  }

  return Array.from(labels);
}

export function classifyAndMerge(item: InboxItem): InboxItem {
  const classified = classify(item);
  const merged = Array.from(new Set([...(item.labels ?? []), ...classified]));
  return { ...item, labels: merged };
}

// ============================================================================
// Helpers
// ============================================================================

/** Narrow `item.fields.headers` to a string→string record, or null if absent/wrong shape. */
function getHeaders(item: InboxItem): Record<string, string> | null {
  const h = item.fields?.headers;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  return h as Record<string, string>;
}

/** Case-insensitive header lookup. The headers map is expected to be lowercase-keyed
 *  (as produced by `channels/cf-email.ts`), but we lowercase defensively in case a
 *  future channel author forgets. */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower in headers) return headers[lower];
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

function isMailerDaemon(addr: string): boolean {
  if (!addr) return false;
  return addr.startsWith('mailer-daemon') || addr.startsWith('postmaster');
}

/** Best-effort address extraction from a raw `From:` header value — handles
 *  `Name <addr@example>` and bare `addr@example`. Returns lowercased. */
function extractAddress(fromHeader: string): string {
  if (!fromHeader) return '';
  const angle = fromHeader.match(/<([^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  return fromHeader.trim().toLowerCase();
}
