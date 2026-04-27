/**
 * Double-opt-in confirmation detector — tags incoming mail that is asking
 * the user to click a "confirm your subscription" link.
 *
 * Motivation: subscribing to a lot of newsletters means piling up double-
 * opt-in confirmation requests. They look like regular newsletters to the
 * classifier (`List-Unsubscribe` header, etc), so they get buried and the
 * user forgets to click the link — no issue ever sends. This hook:
 *
 *   1. Detects confirmation requests via subject + body heuristics.
 *   2. Extracts the first plausible confirmation URL from the body.
 *   3. Labels the item `needs-confirm` and writes `fields.confirm_url`.
 *
 * Downstream, the user queries `{ labels: ["needs-confirm"] }` to see
 * every pending subscription waiting on them, and optionally batch-
 * confirms via `POST /inbox/:name/confirm/:id` (which GETs the URL).
 *
 * ## Hook placement
 *
 * postClassify — we want the classifier's `newsletter` label in view so
 * we can narrow detection to newsletter-shaped mail (Confirmation URLs
 * in transactional mail from services you already use are NOT double-
 * opt-in; we'd false-positive on password-reset links otherwise).
 *
 * ## What counts as a "confirmation" subject
 *
 * Roughly: words from set A ("confirm", "verify", "activate") near
 * words from set B ("subscription", "email", "address", "sign-up").
 * The heuristic is deliberately loose — we'd rather tag a few false
 * positives than miss a pending sub. Drops (terminal) never happen here;
 * user can un-tag manually.
 *
 * ## Confirm URL extraction
 *
 * Scans the plaintext body (or HTML body as fallback) for the first
 * `https?://` URL. Preference rules:
 *
 *   1. URL inside/near a "Confirm / Subscribe me / Verify / Activate"
 *      anchor line — strong signal.
 *   2. Any URL with path containing `confirm`, `verify`, `activate`, or
 *      `subscribe` — common provider convention.
 *   3. First URL in the body — last resort.
 *
 * Never picks a `list-unsubscribe` URL (anti-pattern — unsubscribing is
 * the opposite of confirming).
 *
 * ## What this hook does NOT do
 *
 * - **Follow the URL.** That's an explicit user action via a separate
 *   endpoint. Auto-clicking would silently opt the user in to anything
 *   that mailed them.
 * - **Tag non-newsletter mail.** A transactional password-reset looks
 *   similar on paper but is not a subscription confirmation.
 * - **Handle multi-step confirmation flows.** Single URL GET only.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
} from './types.ts';

// ============================================================================
// Types
// ============================================================================

export interface ConfirmDetectResult {
  /** Whether this item looks like a confirmation request. */
  is_confirmation: boolean;
  /** Extracted confirmation URL, or null if nothing plausible found. */
  confirm_url: string | null;
  /** Which pattern fired (for logging / debug). */
  reason?: 'subject' | 'body-anchor' | 'none';
}

export interface ConfirmDetectOptions {
  /**
   * Require the `newsletter` label to be present before tagging. Default
   * true — prevents false positives on transactional "verify your email"
   * flows for signups you already intended. Disable for systems that
   * don't set `newsletter` reliably.
   */
  requireNewsletterLabel?: boolean;
}

// ============================================================================
// Detection
// ============================================================================

// Subject patterns — case-insensitive. First match wins; we don't need
// "strongest signal" — any match graduates the item to needs-confirm.
const SUBJECT_PATTERNS: RegExp[] = [
  /\bconfirm(?:\s+your)?\s+(subscription|email|sign[\s-]?up|address|account)/i,
  /\bplease\s+confirm\b/i,
  /\bverify\s+(your\s+)?(email|subscription|account|address)/i,
  /\bactivate\s+(your\s+)?(subscription|account|email)/i,
  /\bsubscription\s+confirmation\b/i,
  /\bone\s+more\s+step\b/i, // Substack pattern
  /^confirm(ing)?\b/i,
  // Ghost pattern: "🙌 Complete your sign up to <Publisher>!"
  /\bcomplete\s+(?:your\s+)?sign[\s-]?up\b/i,
];

export function isConfirmationSubject(subject: string | undefined | null): boolean {
  if (!subject) return false;
  const s = String(subject);
  return SUBJECT_PATTERNS.some((re) => re.test(s));
}

// ============================================================================
// URL extraction
// ============================================================================

/**
 * Anchor phrases near a confirmation URL. If a line has one of these and
 * a URL, that URL gets top priority.
 */
const ANCHOR_PHRASES = [
  'confirm your subscription',
  'confirm subscription',
  'confirm my subscription',
  'yes, subscribe me',
  'subscribe me to',
  'confirm your email',
  'confirm email',
  'verify your email',
  'verify email',
  'activate your',
  'click here to confirm',
  'click to confirm',
  'please click',
  "i'm in",
  // Ghost — "Tap the link below to complete the signup process for X"
  'complete the signup',
  'complete the sign-up',
  'complete the sign up',
  'complete your signup',
  'complete your sign up',
  'tap the link below',
];

/**
 * Path fragments that typically indicate a confirmation endpoint.
 */
const PATH_HINTS = [
  '/subscribe/confirm',
  '/confirm',
  '/verify',
  '/activate',
  'doubleoptin',
  'double-opt-in',
  'confirmsubscription',
  'optin',
  // Ghost — /members/?token=...&action=signup&r=...
  'action=signup',
];

const URL_RE = /https?:\/\/[^\s<>"'`)]+/gi;

/**
 * Return true if a URL path/query signals "unsubscribe" — we never want to
 * confuse unsubscribe links with confirmation links.
 */
function isUnsubscribeUrl(url: string): boolean {
  return /unsubscribe|list-unsubscribe|opt[-_]?out/i.test(url);
}

/**
 * Find the strongest confirmation URL in a body. Returns `null` if nothing
 * plausible. Strategy:
 *
 *   1. Split body into lines. Find lines containing any ANCHOR_PHRASES;
 *      extract the first non-unsubscribe URL from those lines, or the
 *      lines immediately following.
 *   2. Failing that, scan all URLs — first one whose path matches
 *      PATH_HINTS wins.
 *   3. Failing that, return null. (We deliberately don't fall back to
 *      "first URL in body" — too high a false-positive rate on
 *      footer links, social icons, etc.)
 */
export function extractConfirmUrl(body: string | undefined | null): string | null {
  if (!body) return null;
  const text = String(body);
  if (!text) return null;

  // Strategy 1: anchor-line URL.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (!ANCHOR_PHRASES.some((p) => line.includes(p))) continue;

    // Same line first, then the next 3 lines (emails often wrap URL onto
    // its own line immediately after the anchor).
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const matches = lines[j].match(URL_RE);
      if (!matches) continue;
      const pick = matches.find((u) => !isUnsubscribeUrl(u));
      if (pick) return stripTrailingPunct(pick);
    }
  }

  // Strategy 1.5: "Links: [1] <url>" footnote section — common in
  // plaintext-converted HTML. If any earlier ANCHOR_PHRASE appeared,
  // pick the first footnote URL whose path hints at confirmation.
  const hasAnchorAbove = ANCHOR_PHRASES.some((p) => text.toLowerCase().includes(p));
  if (hasAnchorAbove) {
    const allUrls = text.match(URL_RE) ?? [];
    for (const u of allUrls) {
      if (isUnsubscribeUrl(u)) continue;
      const lower = u.toLowerCase();
      if (PATH_HINTS.some((h) => lower.includes(h))) return stripTrailingPunct(u);
    }
  }

  // Strategy 2: any URL with confirmation path hints.
  const all = text.match(URL_RE) ?? [];
  for (const u of all) {
    if (isUnsubscribeUrl(u)) continue;
    const lower = u.toLowerCase();
    if (PATH_HINTS.some((h) => lower.includes(h))) return stripTrailingPunct(u);
  }

  return null;
}

/**
 * Trailing punctuation commonly bleeds into URL matches (`url.` at end
 * of sentence, `(url)` in parens, etc). Strip the easy ones.
 */
function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)}\]'"`>]+$/, '');
}

// ============================================================================
// Item application
// ============================================================================

/**
 * Pure evaluation. Returns `{is_confirmation, confirm_url, reason}`.
 * Reads subject from `fields.subject`, body from `fields.body_text` or
 * `body.text` or `body` (string). Falls through each in order.
 */
export function detectConfirmation(item: InboxItem): ConfirmDetectResult {
  const subject = item.fields?.subject ?? item.summary;
  if (!isConfirmationSubject(subject)) {
    return { is_confirmation: false, confirm_url: null, reason: 'none' };
  }

  const body = resolveBodyText(item);
  const url = extractConfirmUrl(body);
  return {
    is_confirmation: true,
    confirm_url: url,
    reason: url ? 'body-anchor' : 'subject',
  };
}

function resolveBodyText(item: InboxItem): string | null {
  const fields = item.fields ?? {};
  if (typeof fields.body_text === 'string') return fields.body_text;
  const b = item.body as unknown;
  if (typeof b === 'string') return b;
  if (b && typeof b === 'object') {
    const obj = b as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.html === 'string') return obj.html;
  }
  return null;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns a `PostClassifyHook` that tags confirmation emails.
 *
 *   - When detection fires, adds `needs-confirm` label + `fields.confirm_url`.
 *   - `requireNewsletterLabel: true` (default) skips items not already
 *     tagged `newsletter` by the classifier, avoiding false positives on
 *     password-reset etc.
 *   - Idempotent — re-running is a noop when `needs-confirm` is already
 *     present.
 */
export function createConfirmDetectHook(
  opts: ConfirmDetectOptions = {},
): PostClassifyHook {
  const requireNewsletterLabel = opts.requireNewsletterLabel ?? true;

  return async function confirmDetectHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    const labels = item.labels ?? [];
    if (labels.includes('needs-confirm')) return 'accept'; // idempotent
    if (requireNewsletterLabel && !labels.includes('newsletter')) return 'accept';

    const result = detectConfirmation(item);
    if (!result.is_confirmation) return 'accept';

    const nextLabels = Array.from(new Set([...labels, 'needs-confirm']));
    const nextFields: Record<string, any> = { ...(item.fields ?? {}) };
    if (result.confirm_url) nextFields.confirm_url = result.confirm_url;

    return { ...item, labels: nextLabels, fields: nextFields };
  };
}
