/**
 * Forward-detection hook — identifies incoming mail that was forwarded by
 * the user (from their own address) and best-effort extracts the ORIGINAL
 * sender's metadata from the forwarded body.
 *
 * Design (see `.brief/mailroom-curation.md` § UC1, UC2, D4, D6):
 *
 * - The user forwards mail from their own inbox (Gmail/Outlook/Apple Mail)
 *   to a shared mailroom address. The item's `from_email` then matches the
 *   user, not the original sender — which confuses downstream filters and
 *   sender-index entries.
 * - This hook detects the forward, tags the item (`forwarded` + `manual`
 *   by default), and tries to recover the original sender metadata so it
 *   can be stored under `fields.original_from_email`,
 *   `fields.original_from_addr`, `fields.original_subject`.
 * - Extraction is **best-effort**. If parsing fails we still tag the item
 *   as forwarded — losing the original sender is an acceptable degradation
 *   (per D4). The hook must never throw.
 *
 * Detection signals (any ONE fires):
 *
 * 1. `fields.from_email` matches any `selfAddresses` (strongest)
 * 2. `x-forwarded-for` header present
 * 3. `x-forwarded-from` header present
 * 4. `resent-from` header present (RFC 5322 Resent-)
 * 5. Subject starts with `Fwd:` / `Fw:` — weaker; only combined with (1)
 *    or with a recognizable forward body separator.
 *
 * Original-sender extraction prefers headers (`resent-from`,
 * `x-forwarded-from`) when present; otherwise falls back to parsing the
 * body for Gmail/Outlook/Apple Mail forward separators.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PreIngestHook,
} from './types.ts';

// ============================================================================
// Public API
// ============================================================================

export interface ForwardDetectOptions {
  /**
   * Addresses that count as "self" — if `from_email` matches any of these,
   * this mail was forwarded by the user. Pass an array or a comma-separated
   * string (e.g. from `SELF_ADDRESSES` env var). All lowercased on init.
   */
  selfAddresses: string[] | string;
  /**
   * Labels applied when a forward is detected. Default `['forwarded', 'manual']`.
   * The second label is the user-action marker; the first is the technical signal.
   */
  labels?: string[];
}

export interface ForwardDetectResult {
  /** True iff at least one detection signal fired. */
  isForwarded: boolean;
  /** Labels to merge into the item (empty when not forwarded). */
  labels: string[];
  /** Best-effort original sender email (lowercased). */
  original_from_email?: string;
  /** Best-effort display form: "Name <addr@x.com>" or bare address. */
  original_from_addr?: string;
  /** Best-effort original subject with leading Re:/Fwd: prefixes stripped. */
  original_subject?: string;
  /**
   * Best-effort original send date, ISO-8601 UTC. Parsed from the
   * forwarded body's `Date:` line. Tolerates the major mail-client
   * shapes (Gmail's `Sun, Apr 26, 2026 at 10:16 AM`, RFC 5322,
   * Outlook's `Sunday, April 26, 2026 10:16 AM`). When parsing fails,
   * absent rather than approximate. See
   * `.brief/forward-notes-and-newsletter-profiles.md`.
   */
  original_sent_at?: string;
  /** Best-effort original Message-ID from the forwarded body's `Message-ID:` line. */
  original_message_id?: string;
  /** Best-effort original Reply-To address (lowercased) from the forwarded body. */
  original_reply_to?: string;
  /**
   * Slug derived from the original sender's display name — durable across
   * ESP migrations (a publication that changes from Substack to Beehiiv
   * keeps the same slug as long as the display name is consistent).
   * Powers the `newsletters/<slug>` aggregate views. Slugified via
   * `slugifySenderName` from sender-aliases.
   */
  newsletter_slug?: string;
  /**
   * User-typed commentary above the forwarded block. Captured when a
   * forward separator is present and the text above it is non-empty
   * after trimming. Populated on forwards only. Absent when there's no
   * separator or nothing was typed. See `.brief/mailroom-curation.md`.
   */
  forward_note?: string;
}

const DEFAULT_LABELS = ['forwarded', 'manual'];

/**
 * Normalize a comma-separated env-var string or an array into a lowercased
 * `string[]`. Trims whitespace, filters empty, deduplicates.
 */
export function parseSelfAddresses(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Pure detection — examines an InboxItem's fields and body and returns what
 * it found. Does NOT mutate the input. Returns `isForwarded: false` with
 * empty labels when the item is not a forward.
 */
export function detectForward(
  item: InboxItem,
  opts: ForwardDetectOptions,
): ForwardDetectResult {
  const selfAddresses = parseSelfAddresses(opts.selfAddresses);
  const labelsToApply = opts.labels ?? DEFAULT_LABELS;

  const headers = getHeaders(item);
  const fromEmail = String(item.fields?.from_email ?? '').trim().toLowerCase();
  const subject = String(item.fields?.subject ?? item.summary ?? '');
  const body = typeof item.body === 'string' ? item.body : '';

  // --- Signals --------------------------------------------------------------
  const fromSelf = fromEmail !== '' && selfAddresses.includes(fromEmail);
  const hasXForwardedFor = headers ? hasHeader(headers, 'x-forwarded-for') : false;
  const hasXForwardedFrom = headers ? hasHeader(headers, 'x-forwarded-from') : false;
  const hasResentFrom = headers ? hasHeader(headers, 'resent-from') : false;
  const subjectLooksFwd = hasFwdPrefix(subject);
  const bodyHasSeparator = hasForwardSeparator(body);

  // Subject "Fwd:" alone is a weak signal — only count it if combined with
  // self-from OR a recognizable forward body.
  const subjectSignal = subjectLooksFwd && (fromSelf || bodyHasSeparator);

  const isForwarded =
    fromSelf ||
    hasXForwardedFor ||
    hasXForwardedFrom ||
    hasResentFrom ||
    subjectSignal;

  if (!isForwarded) {
    return { isForwarded: false, labels: [] };
  }

  // --- Original-sender extraction (best-effort) -----------------------------
  let original_from_email: string | undefined;
  let original_from_addr: string | undefined;
  let original_subject: string | undefined;
  let original_sent_at: string | undefined;
  let original_message_id: string | undefined;
  let original_reply_to: string | undefined;

  try {
    // Priority 1 — trust explicit headers.
    if (headers) {
      const resentFrom = getHeader(headers, 'resent-from');
      if (resentFrom && resentFrom.trim()) {
        original_from_addr = resentFrom.trim();
        const extracted = extractEmailAddress(resentFrom);
        if (extracted) original_from_email = extracted;
      }

      if (!original_from_email) {
        const xff = getHeader(headers, 'x-forwarded-from');
        if (xff && xff.trim()) {
          const extracted = extractEmailAddress(xff);
          if (extracted) original_from_email = extracted;
          if (!original_from_addr) original_from_addr = xff.trim();
        }
      }
    }

    // Priority 2 — parse the body.
    if (body) {
      const parsed = parseForwardedBody(body);
      if (parsed) {
        if (!original_from_addr && parsed.from) original_from_addr = parsed.from;
        if (!original_from_email && parsed.from) {
          const extracted = extractEmailAddress(parsed.from);
          if (extracted) original_from_email = extracted;
        }
        if (!original_subject && parsed.subject) {
          original_subject = stripSubjectPrefixes(parsed.subject);
        }
        if (!original_sent_at && parsed.date) {
          const iso = parseForwardDate(parsed.date);
          if (iso) original_sent_at = iso;
        }
        if (!original_message_id && parsed.message_id) {
          original_message_id = parsed.message_id;
        }
        if (!original_reply_to && parsed.reply_to) {
          const extracted = extractEmailAddress(parsed.reply_to);
          original_reply_to = extracted ?? parsed.reply_to.trim().toLowerCase();
        }
      }
    }

    // Also try stripping the incoming subject as a last resort for original_subject
    // (useful when body parsing didn't turn up a Subject: line).
    if (!original_subject && subjectLooksFwd) {
      const stripped = stripSubjectPrefixes(subject);
      if (stripped && stripped !== subject) {
        original_subject = stripped;
      }
    }
  } catch {
    // Extraction is best-effort — never let a parse failure block tagging.
  }

  // --- Newsletter slug derivation -------------------------------------------
  // Pure function of `original_from_addr` — durable across ESP migrations as
  // long as the display name stays consistent.
  let newsletter_slug: string | undefined;
  if (original_from_addr) {
    const slug = deriveNewsletterSlug(original_from_addr, original_from_email);
    if (slug) newsletter_slug = slug;
  } else if (original_from_email) {
    // No display name — fall back to slugifying the domain so the item still
    // groups with other items from the same source.
    const slug = deriveNewsletterSlug(undefined, original_from_email);
    if (slug) newsletter_slug = slug;
  }

  // Forward-note extraction: whatever the user typed above the forwarded
  // block. Only meaningful when there's a separator to split on; without one
  // we can't distinguish commentary from the forwarded body itself.
  let forward_note: string | undefined;
  if (body) {
    try {
      const note = extractForwardNote(body);
      if (note) forward_note = note;
    } catch {
      // never let note extraction block the verdict
    }
  }

  return {
    isForwarded: true,
    labels: labelsToApply,
    original_from_email,
    original_from_addr,
    original_subject,
    original_sent_at,
    original_message_id,
    original_reply_to,
    newsletter_slug,
    forward_note,
  };
}

/**
 * Returns a PreIngestHook wired to the options. When the item is a forward,
 * merges labels and populates `fields.original_from_email`,
 * `fields.original_from_addr`, `fields.original_subject` on a NEW item
 * (input untouched). Returns the new item as the HookVerdict so later
 * stages see the mutation.
 *
 * When not a forward: returns `'accept'` verdict untouched.
 */
export function createForwardDetectHook(opts: ForwardDetectOptions): PreIngestHook {
  // Pre-parse selfAddresses once so the hook body stays cheap.
  const normalizedOpts: ForwardDetectOptions = {
    selfAddresses: parseSelfAddresses(opts.selfAddresses),
    labels: opts.labels ?? DEFAULT_LABELS,
  };

  return async function forwardDetectHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    const result = detectForward(item, normalizedOpts);
    if (!result.isForwarded) return 'accept';

    const mergedLabels = Array.from(
      new Set([...(item.labels ?? []), ...result.labels]),
    );

    const nextFields: Record<string, any> = { ...(item.fields ?? {}) };
    if (result.original_from_email !== undefined) {
      nextFields.original_from_email = result.original_from_email;
    }
    if (result.original_from_addr !== undefined) {
      nextFields.original_from_addr = result.original_from_addr;
    }
    if (result.original_subject !== undefined) {
      nextFields.original_subject = result.original_subject;
    }
    if (result.original_sent_at !== undefined) {
      nextFields.original_sent_at = result.original_sent_at;
    }
    if (result.original_message_id !== undefined) {
      nextFields.original_message_id = result.original_message_id;
    }
    if (result.original_reply_to !== undefined) {
      nextFields.original_reply_to = result.original_reply_to;
    }
    if (result.newsletter_slug !== undefined) {
      nextFields.newsletter_slug = result.newsletter_slug;
    }
    if (result.forward_note !== undefined) {
      nextFields.forward_note = result.forward_note;
    }

    const nextItem: InboxItem = {
      ...item,
      fields: nextFields,
      labels: mergedLabels,
    };
    return nextItem;
  };
}

// ============================================================================
// Header helpers (mirrors classifier.ts patterns — intentional duplication to
// keep this module self-contained; the shared helpers live inside classifier.ts
// which the scope constraints forbid editing)
// ============================================================================

function getHeaders(item: InboxItem): Record<string, string> | null {
  const h = item.fields?.headers;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  return h as Record<string, string>;
}

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

// ============================================================================
// Subject helpers
// ============================================================================

const FWD_PREFIX_RE = /^\s*(fwd?|fw)\s*:\s*/i;
const LEADING_PREFIX_RE = /^\s*(re|fwd?|fw|aw)\s*:\s*/i;

function hasFwdPrefix(subject: string): boolean {
  return FWD_PREFIX_RE.test(subject);
}

/** Strip any leading chain of Re:/Fwd:/Fw:/AW: prefixes. */
function stripSubjectPrefixes(subject: string): string {
  let s = String(subject ?? '');
  // Peel off leading prefixes repeatedly (e.g. "Re: Fwd: Re: Foo").
  while (LEADING_PREFIX_RE.test(s)) {
    s = s.replace(LEADING_PREFIX_RE, '');
  }
  return s.trim();
}

// ============================================================================
// Body parsing
// ============================================================================

/**
 * Separators used by common mail clients to mark the start of a forwarded
 * block. Order is rough-longest-first so the most specific patterns win.
 */
const FORWARD_SEPARATOR_PATTERNS: RegExp[] = [
  // Gmail: "---------- Forwarded message ----------" (variable dash counts)
  /-{2,}\s*Forwarded\s+message\s*-{2,}/i,
  // Outlook variant: "----- Forwarded Message -----"
  /-{2,}\s*Forwarded\s+Message\s*-{2,}/i,
  // Apple Mail: "Begin forwarded message:"
  /Begin\s+forwarded\s+message\s*:/i,
  // Outlook "Original Message"
  /-{2,}\s*Original\s+Message\s*-{2,}/i,
];

function hasForwardSeparator(body: string): boolean {
  if (!body) return false;
  for (const re of FORWARD_SEPARATOR_PATTERNS) {
    if (re.test(body)) return true;
  }
  return false;
}

/**
 * Find the earliest forward-separator match index (start of the separator
 * text, NOT the end). Returns -1 if none present. Exported so the note
 * extractor and the parser can share the same anchor.
 */
function findEarliestSeparatorStart(body: string): number {
  let best = -1;
  for (const re of FORWARD_SEPARATOR_PATTERNS) {
    const m = re.exec(body);
    if (m && m.index !== undefined) {
      if (best === -1 || m.index < best) best = m.index;
    }
  }
  return best;
}

/**
 * Extract the user-typed note above the forwarded block.
 *
 * Anchors on the earliest forward-separator match. If no separator is
 * present we return `undefined` — without the anchor, there's no reliable
 * way to tell commentary from the forwarded body itself, and the
 * `forward_note` contract is specifically "text the user typed above the
 * forward marker."
 *
 * After slicing off the tail, common client quirks are cleaned up:
 *   - Gmail's "On <date>, <Sender> wrote:" line that clients prepend
 *     sometimes appears ABOVE the "--- Forwarded message ---" banner.
 *     That's metadata, not commentary — drop it.
 *   - Trailing blank lines and leading blank lines are trimmed.
 *
 * Returns `undefined` when the resulting note is empty after cleanup.
 */
export function extractForwardNote(body: string): string | undefined {
  if (!body) return undefined;
  const sepStart = findEarliestSeparatorStart(body);
  if (sepStart <= 0) return undefined;

  let head = body.slice(0, sepStart);

  // Strip a trailing "On <date>, <Sender> wrote:" line — mail clients
  // insert this as the quote header for the forwarded block. It's not
  // something the user typed. Multiline tolerant since the date portion
  // can wrap.
  head = head.replace(/\n?\s*On\s[^\n]{0,160}?\s+wrote:\s*$/i, '');

  // Collapse runs of blank lines and trim whitespace at both ends.
  const trimmed = head.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a forwarded body for From:/Subject:/Date:/Message-ID:/Reply-To: lines
 * following a recognized separator. Returns partial results on best-effort
 * basis. Never throws.
 *
 * Mail clients can wrap long header values onto continuation lines (RFC 5322
 * "folded" headers — a leading whitespace line continues the previous one),
 * but Gmail's plaintext forward format does that for `From:` only and the
 * other headers stay on a single line. We handle the From: continuation;
 * other headers are taken as single-line for now.
 */
export interface ParsedForwardBody {
  from?: string;
  subject?: string;
  date?: string;
  message_id?: string;
  reply_to?: string;
}

function parseForwardedBody(body: string): ParsedForwardBody | null {
  if (!body) return null;

  // Find the earliest separator occurrence and skip past it to begin scanning
  // for pseudo-headers. If no separator is found, scan from the top — some
  // forwards (as-attachment, minimal clients) skip the banner.
  const sepStart = findEarliestSeparatorStart(body);
  let scanStart = 0;
  if (sepStart !== -1) {
    for (const re of FORWARD_SEPARATOR_PATTERNS) {
      const m = re.exec(body);
      if (m && m.index === sepStart) {
        scanStart = sepStart + m[0].length;
        break;
      }
    }
  }

  // Only look at the first ~40 lines after the separator — forwards always
  // put the pseudo-headers near the top. Prevents false positives from a
  // quoted "From:" deeper in a thread.
  const lines = body.slice(scanStart).split(/\r?\n/).slice(0, 40);

  let from: string | undefined;
  let subject: string | undefined;
  let date: string | undefined;
  let message_id: string | undefined;
  let reply_to: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    // Strip common quote markers: "> ", ">> ", etc.
    const cleaned = lines[i].replace(/^[>\s]*/, '');
    if (!from) {
      const m = cleaned.match(/^From\s*:\s*(.+?)\s*$/i);
      if (m) {
        // Gmail wraps the From: value when the address is long. The next
        // line, if it doesn't introduce a new pseudo-header, is the
        // continuation. Stitch them.
        let value = m[1].trim();
        const next = lines[i + 1];
        if (next !== undefined) {
          const nextCleaned = next.replace(/^[>\s]*/, '');
          if (
            nextCleaned &&
            !/^(Subject|Date|To|Cc|Bcc|Reply-To|Message-ID|From)\s*:/i.test(nextCleaned)
          ) {
            value = (value + ' ' + nextCleaned.trim()).trim();
          }
        }
        from = value;
      }
    }
    if (!subject) {
      const m = cleaned.match(/^Subject\s*:\s*(.+?)\s*$/i);
      if (m) subject = m[1].trim();
    }
    if (!date) {
      const m = cleaned.match(/^Date\s*:\s*(.+?)\s*$/i);
      if (m) date = m[1].trim();
    }
    if (!message_id) {
      const m = cleaned.match(/^Message-ID\s*:\s*(.+?)\s*$/i);
      if (m) message_id = m[1].trim();
    }
    if (!reply_to) {
      const m = cleaned.match(/^Reply-To\s*:\s*(.+?)\s*$/i);
      if (m) reply_to = m[1].trim();
    }
    if (from && subject && date && message_id && reply_to) break;
  }

  if (!from && !subject && !date && !message_id && !reply_to) return null;
  return { from, subject, date, message_id, reply_to };
}

/**
 * Parse a forwarded `Date:` value into ISO-8601 UTC. Tolerates the major
 * mail-client shapes:
 *
 *   - Gmail plaintext:    "Sun, Apr 26, 2026 at 10:16 AM"
 *   - Outlook longform:   "Sunday, April 26, 2026 10:16 AM"
 *   - RFC 5322:           "Sun, 26 Apr 2026 10:16:00 -0700"
 *   - Bare ISO:           "2026-04-26T10:16:00.000Z"
 *
 * Returns `undefined` when no parser succeeds (rather than approximating).
 */
export function parseForwardDate(raw: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim();
  if (!cleaned) return undefined;

  // Try Date.parse on the cleaned value first — handles RFC 5322 and ISO.
  const direct = Date.parse(cleaned);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();

  // Gmail's "at " infix — strip it and retry.
  const gmail = cleaned.replace(/\s+at\s+/i, ' ');
  if (gmail !== cleaned) {
    const t = Date.parse(gmail);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }

  // Outlook full weekday (some locales) — Date.parse handles "Sunday, April
  // 26, 2026 10:16 AM" natively; tried above. No further fallback today.

  return undefined;
}

/**
 * Filler tokens that don't carry publication identity. Stripped before
 * slugifying so "Steph at Internet Pipes" → "internet-pipes" (not
 * "steph-at-internet-pipes"), but only when the result is still meaningful.
 *
 * Conservative — we'd rather have a verbose-but-correct slug than aggressively
 * trim and lose identity. The fallback is "slug the whole display name."
 */
const NEWSLETTER_FILLER_PREFIXES: RegExp[] = [
  // Parenthesized publisher: "Fabricio (from Sidebar.io)" → "Sidebar.io".
  // Tried first because it's the most specific shape and would otherwise
  // get clobbered by `slugifySenderName` of the full string.
  /^.+?\s*[(\[]\s*(?:from|at|by)\s+(.+?)\s*[)\]]\s*$/i,
  // "Steph at Internet Pipes" → "Internet Pipes" (publisher after "at").
  /^.*?\s+at\s+(.+)$/i,
  // "Stratechery by Ben Thompson" → "Stratechery" (the brand precedes "by").
  /^(.+)\s+by\s+.+$/i,
  // "Updates from FooCo" / "Daily News from Acme" → "FooCo" / "Acme"
  // (publisher follows "from"). Captures the right half — the part after
  // "from" is the brand; the part before is filler ("Updates", "Daily News").
  /^.+\s+from\s+(.+)$/i,
];

/**
 * Derive a stable newsletter slug from the original sender's display name.
 * Falls back to the email domain (without TLD-stripping) when no display
 * name is available.
 *
 * Examples:
 *   "Steph at Internet Pipes <internetpipes@...>" → "internet-pipes"
 *   "Sidebar.io <hello@uxdesign.cc>"               → "sidebar-io"
 *   "Stratechery by Ben Thompson <stratechery@...>" → "stratechery"
 *   "<hello@every.to>" / undefined display + "hello@every.to" → "every-to"
 *
 * Returns `undefined` when nothing slug-worthy can be derived.
 */
export function deriveNewsletterSlug(
  fromAddr: string | undefined,
  fromEmail: string | undefined,
): string | undefined {
  // 1. Try the display-name portion of `fromAddr`.
  if (fromAddr) {
    let display = fromAddr;
    // Strip the angle-bracketed address if present.
    const lt = display.indexOf('<');
    if (lt !== -1) display = display.slice(0, lt);
    display = display.trim().replace(/^["']|["']$/g, '').trim();

    if (display) {
      // Try filler-prefix patterns first.
      for (const re of NEWSLETTER_FILLER_PREFIXES) {
        const m = display.match(re);
        if (m && m[1]) {
          const slug = slugifyNewsletterDisplayName(m[1]);
          if (slug) return slug;
        }
      }
      // Otherwise slugify the full display name.
      const slug = slugifyNewsletterDisplayName(display);
      if (slug) return slug;
    }
  }

  // 2. Fall back to the email domain.
  if (fromEmail) {
    const at = fromEmail.indexOf('@');
    if (at !== -1) {
      const domain = fromEmail.slice(at + 1).trim().toLowerCase();
      if (domain) {
        // Slugify the whole domain so dots become dashes (every.to → every-to).
        return domain.replace(/\./g, '-').replace(/^-+|-+$/g, '');
      }
    }
  }

  return undefined;
}

/**
 * Slugify a publication display name. Matches `slugifySenderName` from
 * `sender-aliases.ts` semantics so manual `sender:<slug>` aliases line up
 * with auto-derived `newsletter:<slug>` labels when the same display name
 * is used in both contexts.
 */
function slugifyNewsletterDisplayName(name: string): string {
  if (!name) return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\:;,!?@#$%^&*()+=<>"'`~|[\]{}]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// Email extraction
// ============================================================================

/**
 * Conservative email-address extractor. Handles:
 * - "Name <addr@example.com>" → addr@example.com
 * - "addr@example.com"        → addr@example.com
 * - "Name (comment) addr@example.com" → addr@example.com
 *
 * Returns lowercased address or undefined if none found.
 */
function extractEmailAddress(raw: string): string | undefined {
  if (!raw) return undefined;
  // Prefer the angle-bracketed form first.
  const angle = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  // Otherwise hunt for a bare address.
  const bare = raw.match(/([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})/i);
  if (bare) return bare[1].trim().toLowerCase();
  return undefined;
}
