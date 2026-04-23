/**
 * Unsubscribe surface — action layer over the sender-index's
 * `list_unsubscribe_url` detection.
 *
 * Detection already lives in `sender-index.ts` (parses `List-Unsubscribe`
 * headers on upsert, https > mailto > raw, preserved across later upserts).
 * This module is the *action* half: given a sender address, try to actually
 * unsubscribe (one-click HTTPS POST per RFC 8058, or surface the mailto:
 * target for an outbox to send later) and tag the sender `unsubscribed` so
 * future items are filterable.
 *
 * Tagging is always applied when the sender exists — even when no URL is
 * known. Callers who want a purely-manual mark-as-unsubscribed flow can
 * pass `{ skipCall: true }` to skip the network POST but still tag.
 *
 * **Important:** this module intentionally does NOT auto-drop future mail
 * from unsubscribed senders. The tag is advisory; filtering is a caller
 * concern (cheap storage, easy rollback — see `.brief/mailroom-pipeline.md`
 * § Unsubscribe).
 *
 * See `docs/design/PLUGIN-AUTHORING.md` — no new runtime deps; uses global
 * `fetch` (injectable for tests).
 */

import type { SenderIndex, SenderRecord } from './sender-index.ts';

// ============================================================================
// Types
// ============================================================================

export interface UnsubscribeResult {
  /** The sender address, normalized to lowercase. */
  address: string;
  /** Which path was attempted. `none` = no URL known (or skipCall=true). */
  method: 'https' | 'mailto' | 'none';
  /** The URL/mailto: target that was hit (or would be hit). */
  attempted_url?: string;
  /** True only when the underlying action succeeded (HTTPS 2xx). */
  ok: boolean;
  /** HTTP status when `method === 'https'`. */
  status?: number;
  /** Non-fatal error message. */
  error?: string;
  /** ISO timestamp when the `unsubscribed` tag was applied, or undefined if not tagged. */
  tagged_at?: string;
}

export interface UnsubscribeOptions {
  /** Custom fetch impl for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Timeout for the HTTPS POST in ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Skip the actual network call and just tag the sender as unsubscribed.
   * Useful when the user wants to mark manually or when running in dry-run.
   */
  skipCall?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// ============================================================================
// Tag helper
// ============================================================================

/**
 * Add a tag to a sender's record. Idempotent — tag is deduplicated. Returns
 * the updated record, or `null` if the sender isn't in the index (no auto-create).
 */
export async function addSenderTag(
  senderIndex: SenderIndex,
  address: string,
  tag: string,
): Promise<SenderRecord | null> {
  const existing = await senderIndex.get(address);
  if (!existing) return null;
  if (existing.tags.includes(tag)) {
    return existing;
  }
  const updated: SenderRecord = {
    ...existing,
    tags: [...existing.tags, tag],
  };
  await senderIndex.setRecord(updated);
  return updated;
}

// ============================================================================
// Unsubscribe action
// ============================================================================

/**
 * Attempt to unsubscribe a sender. Behavior:
 *
 * 1. Look up the sender record via `senderIndex.get(address)`. If missing,
 *    return `method='none'`, `ok=false` without tagging (no auto-create).
 * 2. If `list_unsubscribe_url` is missing → `method='none'`, `ok=false`,
 *    but tag the sender anyway so callers can filter them out.
 * 3. If `https://` URL → POST with body `List-Unsubscribe=One-Click`
 *    (RFC 8058) as `application/x-www-form-urlencoded`, honoring
 *    `opts.timeoutMs` (default 10s).
 * 4. If `mailto:` URL → `method='mailto'`, `ok=false` (caller wires an
 *    outbox). `attempted_url` carries the target so they can send it.
 * 5. Always tag the sender `unsubscribed` (idempotent) when the sender exists,
 *    even if the network call failed — the user's intent is what matters.
 */
export async function unsubscribeSender(
  senderIndex: SenderIndex,
  address: string,
  opts: UnsubscribeOptions = {},
): Promise<UnsubscribeResult> {
  const existing = await senderIndex.get(address);
  const normalizedAddress = existing?.address ?? (typeof address === 'string' ? address.trim().toLowerCase() : '');

  if (!existing) {
    return {
      address: normalizedAddress,
      method: 'none',
      ok: false,
      error: 'sender not found in index',
    };
  }

  const url = existing.list_unsubscribe_url;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let method: UnsubscribeResult['method'] = 'none';
  let ok = false;
  let status: number | undefined;
  let error: string | undefined;
  let attempted_url: string | undefined;

  if (opts.skipCall) {
    // Skip network — tag only. attempted_url reflects what we *would* have used.
    attempted_url = url;
    method = 'none';
    ok = false;
  } else if (!url) {
    method = 'none';
    ok = false;
    error = 'no list_unsubscribe_url on sender record';
  } else if (/^https:/i.test(url)) {
    method = 'https';
    attempted_url = url;
    try {
      const result = await httpsOneClick(url, fetchImpl, timeoutMs);
      status = result.status;
      ok = result.ok;
      if (!result.ok && result.error) {
        error = result.error;
      }
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
  } else if (/^mailto:/i.test(url)) {
    // mailto: requires an outbox we don't own — surface the target and mark
    // not-ok so the caller knows to wire follow-up.
    method = 'mailto';
    attempted_url = url;
    ok = false;
    error = 'mailto: unsubscribe requires an outbox to actually send (not wired here)';
  } else {
    // Unknown scheme — treat as 'none' + error.
    method = 'none';
    attempted_url = url;
    ok = false;
    error = `unsupported unsubscribe URL scheme: ${url.slice(0, 16)}`;
  }

  // Always tag (sender exists).
  let tagged_at: string | undefined;
  const tagged = await addSenderTag(senderIndex, normalizedAddress, 'unsubscribed');
  if (tagged) {
    tagged_at = new Date().toISOString();
  }

  return {
    address: normalizedAddress,
    method,
    attempted_url,
    ok,
    status,
    error,
    tagged_at,
  };
}

// ============================================================================
// HTTPS one-click helper
// ============================================================================

async function httpsOneClick(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // RFC 8058 § 3.1 — one-click unsubscribe body.
      body: 'List-Unsubscribe=One-Click',
      signal: controller.signal,
    });
    return {
      ok: resp.ok,
      status: resp.status,
      error: resp.ok ? undefined : `HTTP ${resp.status}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = controller.signal.aborted || /abort/i.test(msg);
    return {
      ok: false,
      status: 0,
      error: aborted ? `timeout after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
