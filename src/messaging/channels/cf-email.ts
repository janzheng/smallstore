/**
 * Cloudflare Email channel.
 *
 * Implements `Channel<EmailInput>` using `postal-mime` to parse raw .eml
 * bytes (the wire format CF Email Routing hands you in `email(msg, env, ctx)`).
 *
 * Field mapping (`InboxItem.fields`):
 *   - from_addr      "Name <addr>" or just addr
 *   - from_email     bare addr only (lowercased)
 *   - to_addrs       array of bare addrs (lowercased)
 *   - cc_addrs       array of bare addrs (lowercased)  [omitted if empty]
 *   - subject        Subject header (or "(no subject)")
 *   - message_id     RFC822 Message-ID (or null)
 *   - date_header    Date header as ISO-8601 (or null)
 *   - in_reply_to    In-Reply-To header (or omitted)
 *   - references     References header (or omitted)
 *   - inbox_addr     The address it was sent to (envelope_to)
 *   - has_attachments boolean
 *   - spf_pass / dkim_pass / dmarc_pass — booleans (or omitted if no verdicts)
 *
 * Body policy:
 *   - body_text inlined into `item.body` if < BODY_INLINE_THRESHOLD (64KB),
 *     otherwise stashed in `blobs[body/<id>.txt]` and `body_ref` set.
 *   - HTML body always to `blobs[html/<id>.html]` (referenced via body_ref
 *     when no text alternative exists) — never inlined.
 *
 * Raw .eml is always preserved at `raw/<id>.eml` (raw_ref).
 *
 * Attachments → `attachments/<id>/<safe-filename>` (one entry per attachment,
 * with metadata kept on `item.attachments` field — note this is NOT
 * `InboxItemFull.attachments`; that's the read-time hydration; this is the
 * field-level metadata serialized into the row).
 *
 * Bounce / OOO detection: tagged via `labels` so they don't pollute query
 * results. Heuristics in `detectAutoReply()`.
 *
 * Idempotency: id is content-addressed (sha256 of message_id || raw bytes,
 * truncated to 32 hex chars). Re-deliveries with the same Message-ID hash
 * to the same id; Inbox dedupes on `_ingest`.
 */

import type { Channel, ParseResult, InboxItem } from '../types.ts';

// Lazy-load postal-mime so consumers who don't use the cf-email channel
// don't pay for the dep. Dynamic import is cached by the module system
// after the first call, so there's no per-parse cost beyond the first one.
let _PostalMime: any | undefined;
async function loadPostalMime() {
  if (_PostalMime) return _PostalMime;
  try {
    const mod = await import('postal-mime');
    _PostalMime = mod.default ?? mod;
    return _PostalMime;
  } catch (err) {
    throw new Error(
      "The cf-email channel requires 'postal-mime'. Install it:\n" +
      "  npm install postal-mime\n" +
      "  (or add to deno.json imports: \"postal-mime\": \"npm:postal-mime@^2.4.4\")\n" +
      `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ============================================================================
// Constants
// ============================================================================

const BODY_INLINE_THRESHOLD = 64 * 1024; // 64KB — text bodies under this go inline

// ============================================================================
// Input shape
// ============================================================================

/**
 * Inputs to the CF Email channel parser.
 *
 * In production, the orchestrator builds this from a CF
 * `ForwardableEmailMessage` (`emailHandler` in `email-handler.ts`).
 * Tests construct it directly from a raw .eml string.
 */
export interface EmailInput {
  /** Raw .eml bytes. */
  raw: Uint8Array;
  /** Envelope from (CF provides separately from From: header). */
  envelope_from?: string;
  /** Envelope to (CF provides separately from To: header). */
  envelope_to?: string;
  /** Auth verdicts (SPF/DKIM/DMARC) — typically parsed from Authentication-Results header. */
  verdicts?: {
    spf?: 'pass' | 'fail' | 'neutral';
    dkim?: 'pass' | 'fail' | 'neutral';
    dmarc?: 'pass' | 'fail' | 'neutral';
  };
}

// ============================================================================
// Channel
// ============================================================================

export class CloudflareEmailChannel implements Channel<EmailInput> {
  readonly name = 'cf-email';
  readonly kind = 'push' as const;
  readonly source = 'email/v1';

  async parse(input: EmailInput): Promise<ParseResult | null> {
    const PostalMime = await loadPostalMime();
    const parsed = await PostalMime.parse(input.raw);

    const id = await contentAddressedId(parsed.messageId, input.raw);

    const fromMailbox = toMailbox(parsed.from);
    const fromAddr = fromMailbox ? formatAddress(fromMailbox) : '';
    const fromEmail = (fromMailbox?.address ?? '').toLowerCase();
    const toAddrs = mailboxAddresses(parsed.to);
    const ccAddrs = mailboxAddresses(parsed.cc);

    const summary = parsed.subject?.trim() || '(no subject)';
    const text = parsed.text ?? '';
    const html = parsed.html ?? '';

    // Body inline-vs-ref policy
    const blobs: Record<string, { content: Uint8Array | string; content_type?: string }> = {};
    const rawRef = `raw/${id}.eml`;
    blobs[rawRef] = { content: input.raw, content_type: 'message/rfc822' };

    let body: string | null = null;
    let body_ref: string | undefined;
    if (text.length > 0 && text.length < BODY_INLINE_THRESHOLD) {
      body = text;
    } else if (text.length >= BODY_INLINE_THRESHOLD) {
      const key = `body/${id}.txt`;
      blobs[key] = { content: text, content_type: 'text/plain' };
      body_ref = key;
    } else if (html.length > 0) {
      // No text body; point body_ref at the HTML
      body_ref = `html/${id}.html`;
    }

    if (html.length > 0) {
      const key = `html/${id}.html`;
      blobs[key] = { content: html, content_type: 'text/html' };
    }

    // Attachments
    const attachmentMeta: Array<{
      id: string;
      filename: string;
      content_type: string;
      size: number;
      ref: string;
      content_id?: string;
    }> = [];
    for (let i = 0; i < parsed.attachments.length; i++) {
      const att = parsed.attachments[i];
      const safeName = sanitizeFilename(att.filename || `att-${i}`);
      const attId = att.contentId ? stripBrackets(att.contentId) : `att-${i}`;
      const ref = `attachments/${id}/${safeName}`;
      const bytes = toUint8Array(att.content);
      blobs[ref] = { content: bytes, content_type: att.mimeType || 'application/octet-stream' };
      attachmentMeta.push({
        id: attId,
        filename: safeName,
        content_type: att.mimeType || 'application/octet-stream',
        size: bytes.byteLength,
        ref,
        content_id: att.contentId ? stripBrackets(att.contentId) : undefined,
      });
    }

    // Verdicts → bool fields
    const verdicts = input.verdicts ?? parseAuthResults(getHeader(parsed.headers, 'authentication-results'));

    // Threading
    const inReplyTo = stripBrackets(getHeader(parsed.headers, 'in-reply-to') ?? '');
    const referencesRaw = getHeader(parsed.headers, 'references') ?? '';
    const references = referencesRaw.split(/\s+/).map(stripBrackets).filter(Boolean);
    const threadId = computeThreadId(inReplyTo, references, parsed.messageId, summary);

    // Labels — bounce/OOO/etc
    const labels = detectAutoReply(parsed, getHeader(parsed.headers, 'auto-submitted'));

    const fields: Record<string, any> = {
      from_addr: fromAddr,
      from_email: fromEmail,
      to_addrs: toAddrs,
      subject: summary,
      message_id: parsed.messageId ? stripBrackets(parsed.messageId) : null,
      date_header: parsed.date ? new Date(parsed.date).toISOString() : null,
      inbox_addr: input.envelope_to?.toLowerCase() ?? null,
      has_attachments: attachmentMeta.length > 0,
    };
    if (ccAddrs.length > 0) fields.cc_addrs = ccAddrs;
    if (inReplyTo) fields.in_reply_to = inReplyTo;
    if (references.length > 0) fields.references = references;
    if (verdicts.spf) fields.spf_pass = verdicts.spf === 'pass';
    if (verdicts.dkim) fields.dkim_pass = verdicts.dkim === 'pass';
    if (verdicts.dmarc) fields.dmarc_pass = verdicts.dmarc === 'pass';
    if (attachmentMeta.length > 0) fields.attachments = attachmentMeta;

    const item: InboxItem = {
      id,
      source: this.source,
      source_version: this.source,
      received_at: new Date().toISOString(),
      sent_at: parsed.date ? new Date(parsed.date).toISOString() : undefined,
      summary,
      body,
      body_ref,
      raw_ref: rawRef,
      thread_id: threadId,
      labels: labels.length > 0 ? labels : undefined,
      fields,
    };

    return { item, blobs };
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function contentAddressedId(messageId: string | undefined, raw: Uint8Array): Promise<string> {
  // Prefer Message-ID + raw size as the hash input — this makes re-deliveries
  // (same headers, same body) collide deterministically. Fall back to raw bytes
  // if no Message-ID present.
  const enc = new TextEncoder();
  const seed: BufferSource = messageId
    ? enc.encode(`${stripBrackets(messageId)}|${raw.byteLength}`)
    : (raw as unknown as BufferSource);
  const buf = await crypto.subtle.digest('SHA-256', seed);
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32);
}

interface Mailbox {
  name?: string;
  address: string;
}

/** Coerce a postal-mime Address (which can be a group with no `address`) to a mailbox or null. */
function toMailbox(a: unknown): Mailbox | null {
  if (!a || typeof a !== 'object') return null;
  const obj = a as { name?: string; address?: string };
  if (typeof obj.address !== 'string' || obj.address.length === 0) return null;
  return { name: obj.name, address: obj.address };
}

function mailboxAddresses(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const mb = toMailbox(entry);
    if (mb) out.push(mb.address.toLowerCase());
  }
  return out;
}

function formatAddress(addr: Mailbox): string {
  if (addr.name && addr.name !== addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address;
}

function getHeader(headers: Array<{ key: string; value: string }>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(h => h.key.toLowerCase() === lower)?.value;
}

function stripBrackets(s: string): string {
  return s.replace(/^<+|>+$/g, '').trim();
}

function sanitizeFilename(name: string): string {
  // Strip path separators + control chars + leading dots
  let safe = name.replace(/[\x00-\x1f/\\]/g, '_').replace(/^\.+/, '');
  if (!safe) safe = 'unnamed';
  // Cap length so R2 keys stay reasonable
  if (safe.length > 200) safe = safe.slice(0, 200);
  return safe;
}

function toUint8Array(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(content);
}

/**
 * Parse `Authentication-Results:` header into per-mechanism verdicts.
 * Format: `mx.example.com; spf=pass smtp.mailfrom=...; dkim=pass header.d=...; dmarc=pass`
 */
function parseAuthResults(header: string | undefined): { spf?: 'pass' | 'fail' | 'neutral'; dkim?: 'pass' | 'fail' | 'neutral'; dmarc?: 'pass' | 'fail' | 'neutral' } {
  if (!header) return {};
  const out: any = {};
  for (const part of header.split(';')) {
    const m = part.trim().match(/^(spf|dkim|dmarc)\s*=\s*(\w+)/i);
    if (!m) continue;
    const verdict = m[2].toLowerCase();
    if (verdict === 'pass' || verdict === 'fail' || verdict === 'neutral') {
      out[m[1].toLowerCase()] = verdict;
    }
  }
  return out;
}

/**
 * Threading: prefer the first References header entry (root of the thread).
 * Fall back to In-Reply-To, then to a synthetic id keyed on the subject.
 */
function computeThreadId(
  inReplyTo: string,
  references: string[],
  messageId: string | undefined,
  subject: string,
): string | undefined {
  if (references.length > 0) return references[0];
  if (inReplyTo) return inReplyTo;
  if (messageId) return stripBrackets(messageId);
  // Subject-based fallback for thread continuity when headers are missing
  const cleaned = subject.replace(/^(re|fwd?|aw):\s*/i, '').trim().toLowerCase();
  return cleaned ? `subject:${cleaned}` : undefined;
}

/**
 * Heuristics for automated mail. Used to add labels so callers can filter
 * these out of the main inbox view.
 */
function detectAutoReply(parsed: any, autoSubmitted: string | undefined): string[] {
  const labels: string[] = [];
  const subject = (parsed.subject ?? '').toLowerCase();
  const fromAddr = (parsed.from?.address ?? '').toLowerCase();

  // RFC 3834 — auto-submitted header is the canonical signal
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    labels.push('auto');
    if (autoSubmitted.toLowerCase().includes('auto-replied')) labels.push('ooo');
  }

  // Bounces
  if (
    fromAddr.startsWith('mailer-daemon@') ||
    fromAddr.startsWith('postmaster@') ||
    /\b(undeliver|delivery (status|failure)|returned mail|mail delivery failed)\b/.test(subject)
  ) {
    labels.push('bounce');
  }

  // OOO patterns (when auto-submitted didn't already signal)
  if (
    !labels.includes('ooo') &&
    /\b(out of office|away from|on vacation|i'?m out|automatic reply)\b/.test(subject)
  ) {
    labels.push('ooo');
  }

  return labels;
}

// ============================================================================
// Singleton + registration
// ============================================================================

export const cloudflareEmailChannel = new CloudflareEmailChannel();
