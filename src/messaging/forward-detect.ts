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
    if (body && (!original_from_email || !original_from_addr || !original_subject)) {
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

  return {
    isForwarded: true,
    labels: labelsToApply,
    original_from_email,
    original_from_addr,
    original_subject,
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
 * Parse a forwarded body for From:/Subject: lines following a recognized
 * separator. Returns partial results on best-effort basis. Never throws.
 */
export interface ParsedForwardBody {
  from?: string;
  subject?: string;
}

function parseForwardedBody(body: string): ParsedForwardBody | null {
  if (!body) return null;

  // Find the earliest separator occurrence.
  let sepIndex = -1;
  for (const re of FORWARD_SEPARATOR_PATTERNS) {
    const m = re.exec(body);
    if (m && m.index !== undefined) {
      const idx = m.index + m[0].length;
      if (sepIndex === -1 || idx < sepIndex) sepIndex = idx;
    }
  }

  // If no separator found, still try to parse the first N lines looking
  // for "From:" / "Subject:" headers — some forwards (forwarded-as-attachment
  // or minimal clients) skip the decorative separator.
  const scanStart = sepIndex === -1 ? 0 : sepIndex;

  // Only look at the first ~40 lines after the separator — forwards always
  // put the pseudo-headers near the top. Prevents false positives from a
  // quoted "From:" deeper in a thread.
  const slice = body.slice(scanStart).split(/\r?\n/).slice(0, 40);

  let from: string | undefined;
  let subject: string | undefined;

  for (const line of slice) {
    // Strip common quote markers: "> ", ">> ", etc.
    const cleaned = line.replace(/^[>\s]*/, '');
    if (!from) {
      const m = cleaned.match(/^From\s*:\s*(.+?)\s*$/i);
      if (m) from = m[1].trim();
    }
    if (!subject) {
      const m = cleaned.match(/^Subject\s*:\s*(.+?)\s*$/i);
      if (m) subject = m[1].trim();
    }
    if (from && subject) break;
  }

  if (!from && !subject) return null;
  return { from, subject };
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
