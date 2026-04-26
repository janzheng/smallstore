/**
 * Webhook channel — generic HTTP receiver.
 *
 * Push-shape companion to cf-email and the rss pull-channel. External tools
 * POST arbitrary JSON to `/webhook/<peer-name>`; the peer's `metadata.
 * webhook_config` describes how to extract `id`/`summary`/`body`/etc. from
 * the payload and which inbox to deposit into.
 *
 * Why a channel rather than just calling `POST /inbox/:name/items`:
 *   - HMAC verification (per-peer secret, env-resolved) before the body is
 *     parsed — protects against unauthenticated POSTs to public webhook URLs.
 *   - JSON-path field mapping — sources publish wildly different payload
 *     shapes (GitHub, Stripe, generic schemas). The peer config tells the
 *     channel where in the payload to find the InboxItem fields.
 *   - Default labels + source-version stamping per peer.
 *   - Content-addressed dedup using the source's stable id, so retries +
 *     duplicate webhook deliveries land on the same InboxItem.
 *
 * Field mapping (`InboxItem.fields`):
 *   - All payload top-level keys are copied into `fields` by default.
 *   - Mapped fields (id, summary, body, sent_at, thread_id) are PROMOTED to
 *     the InboxItem level and ALSO retained in `fields` for traceability.
 *   - Channel-specific config goes under `fields._webhook` namespace if
 *     callers want to inspect peer / mapping decisions later.
 *
 * Idempotency:
 *   - If `config.fields.id` is set and the path resolves to a value, the
 *     content-addressed id = sha256(peer_name + ':' + extracted_id). Retries
 *     of the same logical event land on the same InboxItem.
 *   - Otherwise, id = sha256(peer_name + ':' + canonical_json(payload)). De-
 *     dupes byte-identical re-deliveries; a payload with shifting timestamps
 *     would create new items each time (so callers SHOULD configure `fields.
 *     id` whenever the source provides a stable id).
 *
 * HMAC verification (`verifyHmac` helper):
 *   - sha256 + sha1 supported. The peer config names the header to read from
 *     and an optional prefix to strip ("sha256=" GitHub-style). The route
 *     handler resolves the secret from `env[secret_env]` before calling.
 *   - Constant-time comparison via Web Crypto's `crypto.subtle.verify`.
 *   - The channel itself does NOT read request headers — that's the route's
 *     job. The channel exposes the verifier as a pure helper so route + test
 *     code can call it the same way.
 */

import type { Channel, ParseResult, InboxItem } from '../types.ts';

// ============================================================================
// Input + config shapes
// ============================================================================

/**
 * Inputs to the webhook channel parser. The HTTP route builds this after
 * (optionally) verifying the HMAC and parsing the JSON body.
 */
export interface WebhookInput {
  /** Parsed JSON payload from the request body. */
  payload: unknown;
  /** ISO-8601 timestamp the webhook was received (defaults to now if omitted). */
  received_at?: string;
  /** Peer name (drives id-namespacing — different peers with same upstream id don't collide). */
  peer_name: string;
}

/**
 * Per-webhook configuration. Stored under `peer.metadata.webhook_config`.
 */
export interface WebhookConfig {
  /** Inbox name to ingest into (looked up by the route). */
  target_inbox: string;
  /** Labels every webhook item gets at ingest. Merged into `item.labels`. */
  default_labels?: string[];
  /** Override `source` on the InboxItem (e.g. "github", "stripe"). Defaults to "webhook". */
  source?: string;
  /** Override `source_version` (e.g. "github-pr/v1"). Defaults to "webhook/v1". */
  source_version?: string;
  /**
   * JSON-path mappings — extract InboxItem-level fields from the payload.
   * Paths are dot-separated (`pull_request.id`, `data.object.amount`). Bracket
   * notation is not supported in v1; all path segments are object keys.
   */
  fields?: {
    /** Path to a stable upstream id. When set, used for content-addressed dedup. */
    id?: string;
    /** Path to a short summary line (e.g. PR title, event type). */
    summary?: string;
    /** Path to the body / description. */
    body?: string;
    /** Path to a timestamp the upstream system claims is when the event happened. */
    sent_at?: string;
    /** Path to a thread_id (e.g. PR id, conversation id). */
    thread_id?: string;
  };
  /**
   * HMAC verification config. The channel does not read request headers
   * itself — the HTTP route resolves the env-referenced secret and reads
   * the signature header, then calls `verifyHmac`. This config is the
   * descriptor the route uses to know what to do.
   */
  hmac?: WebhookHmacConfig;
}

export interface WebhookHmacConfig {
  /** Header to read the signature from (e.g. "X-Hub-Signature-256"). */
  header: string;
  /** Hash algorithm. Default sha256. */
  algorithm?: 'sha256' | 'sha1';
  /** Optional prefix to strip from the header value (e.g. "sha256="). */
  prefix?: string;
  /** Env var name holding the secret (resolved by the route, never inline). */
  secret_env: string;
}

// ============================================================================
// Channel
// ============================================================================

export class WebhookChannel implements Channel<WebhookInput, WebhookConfig> {
  readonly name = 'webhook';
  readonly kind = 'push' as const;
  readonly source = 'webhook/v1';

  async parse(input: WebhookInput, config?: WebhookConfig): Promise<ParseResult | null> {
    const { payload, peer_name } = input;
    const received_at = input.received_at ?? new Date().toISOString();
    const cfg = config ?? ({} as WebhookConfig);

    // Extract mapped fields (with safe fallbacks).
    const extractedId = cfg.fields?.id ? extractByPath(payload, cfg.fields.id) : undefined;
    const summary = cfg.fields?.summary ? coerceString(extractByPath(payload, cfg.fields.summary)) : undefined;
    const body = cfg.fields?.body ? coerceString(extractByPath(payload, cfg.fields.body)) : undefined;
    const sent_at = cfg.fields?.sent_at ? coerceIsoString(extractByPath(payload, cfg.fields.sent_at)) : undefined;
    const thread_id = cfg.fields?.thread_id ? coerceString(extractByPath(payload, cfg.fields.thread_id)) : undefined;

    // Content-addressed id. Prefer the upstream id if mapped + present;
    // otherwise hash the full canonicalized payload (replay-safe but not
    // semantically deduping).
    const idBasis = extractedId !== undefined && extractedId !== null
      ? `${peer_name}:${stringifyForHash(extractedId)}`
      : `${peer_name}:${canonicalJson(payload)}`;
    const id = (await sha256Hex(idBasis)).slice(0, 32);

    // Build fields. Top-level payload keys land here when payload is an
    // object; otherwise we wrap as { value: payload }.
    const fields: Record<string, unknown> = isPlainObject(payload)
      ? { ...payload }
      : { value: payload };

    // Stamp the peer + mapping decisions for traceability without burying
    // the actual payload.
    fields._webhook = {
      peer: peer_name,
      mapped: {
        id: cfg.fields?.id ?? null,
        summary: cfg.fields?.summary ?? null,
        body: cfg.fields?.body ?? null,
        sent_at: cfg.fields?.sent_at ?? null,
        thread_id: cfg.fields?.thread_id ?? null,
      },
    };

    const item: InboxItem = {
      id,
      source: cfg.source ?? 'webhook',
      source_version: cfg.source_version ?? 'webhook/v1',
      received_at,
      ...(sent_at !== undefined && { sent_at }),
      ...(summary !== undefined && { summary }),
      ...(body !== undefined && { body }),
      ...(thread_id !== undefined && { thread_id }),
      labels: cfg.default_labels ? [...cfg.default_labels] : [],
      fields,
    };

    return { item };
  }
}

export const webhookChannel: WebhookChannel = new WebhookChannel();

// ============================================================================
// HMAC verification — pure helper, used by the HTTP route + tests
// ============================================================================

/**
 * Constant-time HMAC verifier. `signature` is the value read from the request
 * header (with any prefix already stripped — the route does that). Returns
 * true iff the HMAC of `rawBody` under `secret` (using `algorithm`) matches.
 *
 * Catches all crypto / encoding errors and returns `false` rather than
 * throwing — a malformed signature MUST be a verification failure, never an
 * exception that crashes the route.
 */
export async function verifyHmac(
  rawBody: ArrayBuffer | Uint8Array | string,
  signatureHex: string,
  secret: string,
  algorithm: 'sha256' | 'sha1' = 'sha256',
): Promise<boolean> {
  if (!signatureHex || !secret) return false;
  const cleanHex = signatureHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleanHex)) return false;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(cleanHex);
  } catch {
    return false;
  }

  const algoName = algorithm === 'sha1' ? 'SHA-1' : 'SHA-256';
  const enc = new TextEncoder();
  const keyBuf = enc.encode(secret);
  const bodyBuf = typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBuf,
      { name: 'HMAC', hash: algoName },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('HMAC', key, signatureBytes as BufferSource, bodyBuf as BufferSource);
  } catch {
    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Walk a dotted path (`pull_request.user.login`). Returns the value at the
 * path, or `undefined` if any segment misses (or the input isn't an object).
 * Does NOT support array indexing — sources that need array access can flatten
 * upstream or extend this in v2.
 */
export function extractByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: any = obj;
  for (const segment of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[segment];
  }
  return cur;
}

function coerceString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  return String(v);
}

function coerceIsoString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    // Already ISO-shaped? Trust it. Otherwise try Date parse.
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return v; // Last resort: pass through; consumers can validate.
  }
  if (typeof v === 'number') {
    // Heuristic: < 2e10 is seconds, otherwise ms.
    const ms = v < 2e10 ? v * 1000 : v;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Canonical JSON (sorted keys, recursive) — so two payloads that differ only
 * in key order produce the same hash. Lightweight; not RFC 8785 strict.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as any)[k]));
  return '{' + parts.join(',') + '}';
}

function stringifyForHash(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return canonicalJson(v);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
