/**
 * Auto-confirm hook — follows double-opt-in URLs at ingest time for
 * senders the user has pre-allowlisted.
 *
 * Motivation: `confirm-detect.ts` tags incoming confirmation mail with
 * `needs-confirm` + `fields.confirm_url`, but clearing the queue still
 * requires a manual click. For senders the user has explicitly opted
 * into subscribing from (Substack, ConvertKit, common newsletter
 * platforms, own domain bulk-subs), auto-follow the URL so the
 * subscription activates without human-in-the-loop.
 *
 * ## Why an allowlist (not always-on)?
 *
 * `confirm-detect` is heuristic — subject + body pattern matching has
 * a non-zero false-positive rate. Auto-clicking *any* detected URL from
 * *any* sender is a phishing surface: a crafted email could ride the
 * heuristic to trigger outbound fetches from the Worker. Restricting
 * to allowlisted sender globs keeps the attack surface as "people I
 * already subscribed to on platforms I trust". Unknown senders still
 * land in the `needs-confirm` queue for explicit confirmation.
 *
 * ## What makes a URL safe to auto-follow
 *
 *   1. `https://` scheme (never `http://`)
 *   2. Host is a domain, not a raw IP (no `1.2.3.4` in the URL)
 *   3. Path does NOT contain `unsubscribe` / `opt-out` (defence-in-depth;
 *      the extractor already filters these)
 *
 * ## What the hook writes
 *
 * On success (2xx/3xx):
 *   - Strips `needs-confirm`, adds `auto-confirmed`
 *   - `fields.auto_confirmed_at` — ISO timestamp
 *   - `fields.auto_confirm_status` — upstream HTTP status code
 *
 * On upstream error (4xx/5xx or exception):
 *   - Labels unchanged (so retry via the manual endpoint still works)
 *   - `fields.auto_confirm_error` — message
 *   - `fields.auto_confirm_attempted_at` — ISO timestamp
 *
 * ## Placement
 *
 * postClassify, AFTER `confirm-detect` (needs `needs-confirm` +
 * `fields.confirm_url`), BEFORE the sender-index upsert (so the upsert
 * sees the final label set).
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

export interface AutoConfirmOptions {
  /**
   * Sender-address glob patterns that opt in to auto-confirmation. `*`
   * wildcards allowed; first-match semantics aren't needed here — we
   * only care whether *any* pattern matches.
   *
   * Accepts:
   *  - `string[]` (most explicit)
   *  - comma-separated CSV string (for env-var configs, e.g.
   *    `"*@substack.com,*@convertkit.com"`)
   *  - `undefined` / `""` → hook disabled (always 'accept') unless
   *    `getPatterns` is set
   *
   * Mutually exclusive with `getPatterns` — pick one. When both are set,
   * `getPatterns` wins (the dynamic source is what the runtime API mutates).
   */
  allowedSenders?: string[] | string;

  /**
   * Dynamic pattern source — called on every hook invocation, so adds /
   * deletes via `AutoConfirmSendersStore` take effect without restarts.
   * Result cached for `cacheTtlMs` (default 30s) to avoid hammering the
   * underlying adapter on busy ingest paths.
   *
   * Use this for the runtime-editable allowlist. Use `allowedSenders` for
   * static / test configs.
   */
  getPatterns?: () => Promise<string[]>;

  /**
   * Cache TTL for the `getPatterns` result. Default 30s. Lower if your
   * deploy has a leader/follower split where stale-by-30s is unacceptable.
   */
  cacheTtlMs?: number;

  /**
   * HTTP client — injectable for tests. Defaults to global `fetch`.
   */
  fetch?: typeof fetch;

  /**
   * Per-click timeout. Default 10s. Provider confirm endpoints are
   * typically sub-second; a long tail means upstream is down and we
   * shouldn't block ingest for 15+s.
   */
  timeoutMs?: number;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Normalize allowlist config into a pattern array. Mirrors
 * `parseSenderAliases` but with just patterns (no names).
 */
export function parseAllowedSenders(
  input: string | string[] | undefined,
): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((p) => String(p ?? '').trim().toLowerCase())
      .filter((p) => p.length > 0);
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0);
  }
  return [];
}

// ============================================================================
// Matching
// ============================================================================

/**
 * Glob → regex, anchored, case-insensitive. Only `*` has meaning; every
 * other regex metachar is escaped. Duplicates sender-aliases.ts intentionally
 * — these two modules should not cross-depend on internal helpers.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * True iff `address` matches any of the allowlist patterns. Empty or
 * missing address → false.
 */
export function isSenderAllowed(
  address: string | undefined | null,
  patterns: string[],
): boolean {
  if (!address) return false;
  if (patterns.length === 0) return false;
  const lower = String(address).trim().toLowerCase();
  if (!lower) return false;
  return patterns.some((p) => {
    try {
      return globToRegex(p).test(lower);
    } catch {
      return false;
    }
  });
}

// ============================================================================
// URL safety
// ============================================================================

/**
 * Gate for URLs we're willing to auto-follow. Checks:
 *
 *   - Non-empty string
 *   - `https:` scheme
 *   - Host is a named domain (not `1.2.3.4`, not `[::1]`)
 *   - Path + query doesn't contain `unsubscribe` / `opt-out` (belt-and-
 *     suspenders — confirm-detect already filters these)
 */
export function isSafeUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  // Reject IPv4 / IPv6 literals as hosts.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)) return false;
  if (/^\[.*\]$/.test(parsed.hostname)) return false;
  const lower = (parsed.pathname + parsed.search).toLowerCase();
  if (/unsubscribe|opt[-_]?out/.test(lower)) return false;
  return true;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns a `PostClassifyHook` that auto-follows confirmation URLs for
 * allowlisted senders.
 *
 * Pass-through (returns 'accept' untouched) when any guard fails:
 *   - allowlist empty
 *   - item lacks `needs-confirm`
 *   - item already `auto-confirmed` or `confirmed`
 *   - sender address missing or not in allowlist
 *   - `fields.confirm_url` missing or unsafe
 *
 * On fire: performs GET with timeout, writes result to labels + fields.
 */
export function createAutoConfirmHook(
  opts: AutoConfirmOptions,
): PostClassifyHook {
  const staticPatterns = parseAllowedSenders(opts.allowedSenders);
  const fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const cacheTtlMs = opts.cacheTtlMs ?? 30_000;

  // Lazy cache for the dynamic source. `getPatterns` is called at most
  // once per `cacheTtlMs` even under bursty ingest. The cache is keyed by
  // the hook closure so two hooks with different stores don't share state.
  let cachedPatterns: string[] | null = null;
  let cachedAt = 0;

  async function resolvePatterns(): Promise<string[]> {
    if (opts.getPatterns) {
      const now = Date.now();
      if (cachedPatterns !== null && now - cachedAt < cacheTtlMs) {
        return cachedPatterns;
      }
      try {
        const fresh = await opts.getPatterns();
        cachedPatterns = parseAllowedSenders(fresh);
        cachedAt = now;
        return cachedPatterns;
      } catch {
        // On failure, prefer a stale cache to opening the auto-confirm
        // door wide (empty allowlist = nothing auto-clicks). If we have
        // no cache yet, fall through to staticPatterns.
        if (cachedPatterns !== null) return cachedPatterns;
        return staticPatterns;
      }
    }
    return staticPatterns;
  }

  return async function autoConfirmHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    const patterns = await resolvePatterns();
    if (patterns.length === 0) return 'accept';

    const labels = item.labels ?? [];
    if (labels.includes('auto-confirmed') || labels.includes('confirmed')) {
      return 'accept'; // idempotent
    }
    if (!labels.includes('needs-confirm')) return 'accept';

    const sender = item.fields?.from_email;
    if (!isSenderAllowed(typeof sender === 'string' ? sender : null, patterns)) {
      return 'accept';
    }

    const url = item.fields?.confirm_url;
    if (typeof url !== 'string' || !isSafeUrl(url)) return 'accept';

    // Fire the click.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetcher(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'smallstore-auto-confirm/1.0' },
      });
      status = res.status;
      // Drain to release the socket. Body content is irrelevant — we only
      // care about status.
      try {
        await res.text();
      } catch { /* ignore drain errors */ }
      if (status >= 400) error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    const now = new Date().toISOString();

    if (error) {
      // Keep labels unchanged so the manual confirm endpoint still works
      // as a retry path. Record the attempt for debugging.
      return {
        ...item,
        fields: {
          ...(item.fields ?? {}),
          auto_confirm_error: error,
          auto_confirm_attempted_at: now,
        },
      };
    }

    return {
      ...item,
      labels: [
        ...labels.filter((l) => l !== 'needs-confirm'),
        'auto-confirmed',
      ],
      fields: {
        ...(item.fields ?? {}),
        auto_confirmed_at: now,
        auto_confirm_status: status,
      },
    };
  };
}
