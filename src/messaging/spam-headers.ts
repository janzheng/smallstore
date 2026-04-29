/**
 * Header-heuristic helpers + postClassify hook for Layer 2 spam defense.
 *
 * Pure functions inspect message headers and body for cheap phishing /
 * bulk-spam markers (From/Reply-To mismatch, generic display names, bulk
 * mail without `List-Unsubscribe`, DMARC-fail). The hook stamps labels
 * (never verdicts) so the rules engine can compose them downstream.
 * `trusted`-tagged senders short-circuit the entire layer per
 * `.brief/spam-layers.md` decision #4.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
} from './types.ts';
import type { SenderIndex } from './sender-index.ts';

// ============================================================================
// Helpers
// ============================================================================

function getHeader(item: InboxItem, name: string): string | undefined {
  const headers = item.fields?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  const direct = (headers as Record<string, unknown>)[lower];
  if (typeof direct === 'string') return direct;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower && typeof v === 'string') return v;
  }
  return undefined;
}

function extractDomain(addr: string): string | null {
  const match = addr.match(/<([^>]+)>/);
  const raw = (match ? match[1] : addr).trim();
  const at = raw.lastIndexOf('@');
  if (at < 0 || at === raw.length - 1) return null;
  return raw.slice(at + 1).toLowerCase().trim();
}

export function hasFromReplyToMismatch(item: InboxItem): boolean {
  const fromEmail = item.fields?.from_email;
  if (typeof fromEmail !== 'string' || !fromEmail.trim()) return false;
  const replyTo = getHeader(item, 'reply-to');
  if (!replyTo || !replyTo.trim()) return false;
  const fromDomain = extractDomain(fromEmail);
  const replyDomain = extractDomain(replyTo);
  if (!fromDomain || !replyDomain) return false;
  return fromDomain !== replyDomain;
}

const GENERIC_DISPLAY_RE =
  /^(team|updates|newsletter|admin|support|info|noreply|no-reply|donotreply|do-not-reply)$/i;

export function hasGenericDisplayName(item: InboxItem): boolean {
  const fromAddr = item.fields?.from_addr;
  if (typeof fromAddr !== 'string' || !fromAddr.trim()) return false;
  const angle = fromAddr.indexOf('<');
  if (angle < 0) return false;
  const display = fromAddr.slice(0, angle).trim().replace(/^"|"$/g, '').trim();
  if (!display) return false;
  return GENERIC_DISPLAY_RE.test(display);
}

export function hasBulkWithoutListUnsubscribe(item: InboxItem): boolean {
  const body = item.body;
  if (typeof body !== 'string' || !body) return false;
  const hasAnchor = /<a\b[^>]*href=[^>]*>[^<]*unsubscribe/i.test(body);
  let hasClickNear = false;
  if (!hasAnchor) {
    const lower = body.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf('unsubscribe', idx)) !== -1) {
      const start = Math.max(0, idx - 50);
      if (lower.slice(start, idx).includes('click')) {
        hasClickNear = true;
        break;
      }
      idx += 'unsubscribe'.length;
    }
  }
  if (!hasAnchor && !hasClickNear) return false;
  const listUnsub = getHeader(item, 'list-unsubscribe');
  return !listUnsub || !listUnsub.trim();
}

export function hasDmarcFail(
  item: InboxItem,
): 'pass' | 'fail' | 'unknown' | 'none' {
  const header = getHeader(item, 'authentication-results');
  if (!header) return 'none';
  const match = header.match(/dmarc\s*=\s*(pass|fail|none)/i);
  if (!match) return 'unknown';
  return match[1].toLowerCase() as 'pass' | 'fail' | 'none';
}

// ============================================================================
// Hook
// ============================================================================

export interface HeaderHeuristicsHookOptions {
  /** Sender index for the trusted-tag short-circuit. Optional — when omitted, the hook never short-circuits. */
  senderIndex?: SenderIndex;
}

export function createHeaderHeuristicsHook(
  opts: HeaderHeuristicsHookOptions = {},
): PostClassifyHook {
  const { senderIndex } = opts;

  return async function headerHeuristicsHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    // Allowlist always wins (.brief/spam-layers.md decision #4) — a
    // user-flagged trusted sender bypasses every spam layer below.
    if (senderIndex) {
      const fromEmail = item.fields?.from_email;
      if (typeof fromEmail === 'string' && fromEmail.trim()) {
        const addr = fromEmail.trim().toLowerCase();
        try {
          const record = await senderIndex.get(addr);
          if (record?.tags?.includes('trusted')) return 'accept';
        } catch (err) {
          console.warn('[header-heuristics]', err);
        }
      }
    }

    const newLabels: string[] = [];
    if (hasFromReplyToMismatch(item)) newLabels.push('header:from-replyto-mismatch');
    if (hasGenericDisplayName(item)) newLabels.push('header:generic-display-name');
    if (hasBulkWithoutListUnsubscribe(item)) newLabels.push('header:bulk-without-listunsubscribe');
    if (hasDmarcFail(item) === 'fail') newLabels.push('header:dmarc-fail');

    const existing = item.labels ?? [];
    const toAdd = newLabels.filter((l) => !existing.includes(l));
    if (toAdd.length === 0) return 'accept';

    return {
      ...item,
      labels: [...existing, ...toAdd],
    };
  };
}
