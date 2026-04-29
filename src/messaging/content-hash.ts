/**
 * Content-hash — Layer 4 of the layered spam defense.
 *
 * Detects "campaign blast" mail: the same body landing from the same sender
 * within a sliding window. Body is normalized first (ESP tracking pixels,
 * per-recipient URL tokens, 1x1 imgs, salutations, whitespace) so two
 * recipients of the same campaign hash to the same sha256 even when their
 * raw bodies differ in tracking artifacts.
 *
 * **Storage is kv-shaped on the generic StorageAdapter.** No custom D1
 * schema — the existing generic adapter creates a kv table on first write
 * and we partition by sender via key prefix (`contenthash/<sender>/<sha>`).
 * For mailroom volume (dozens per sender per week) this is fine.
 *
 * **Decision #4 amplification:** trusted-sender repeats are amplified, not
 * deduplicated — they get label `repeated:trusted` instead of
 * `campaign-blast`. Trusted re-sends usually mean "make sure you see this."
 *
 * See `.brief/spam-layers.md` § Layer 4 + decision #5 (normalization spec).
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { HookContext, HookVerdict, InboxItem, PostClassifyHook } from './types.ts';
import type { SenderIndex } from './sender-index.ts';

// ============================================================================
// Types
// ============================================================================

export interface ContentHashRecord {
  sha256: string;
  sender: string;
  ingest_at: string;
}

export interface ContentHashStore {
  record(sender: string, sha256: string, ingest_at: string): Promise<ContentHashRecord | null>;
  isRepeatWithin(
    sender: string,
    sha256: string,
    now: string,
    windowMs: number,
  ): Promise<ContentHashRecord | null>;
  prune(cutoffISO: string): Promise<number>;
}

export interface ContentHashStoreOptions {
  keyPrefix?: string;
}

export interface ContentHashHookOptions {
  store: ContentHashStore;
  senderIndex?: SenderIndex;
  windowMs?: number;
  now?: () => string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PREFIX = 'contenthash/';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRUNE_CAP = 10_000;

const TRACKING_HOSTS: RegExp[] = [
  /https?:\/\/[^\s"'<>]*\.list-manage\.com\/track\/[^\s"'<>]*/gi,
  /https?:\/\/[^\s"'<>]*\.sendgrid\.net\/track\/[^\s"'<>]*/gi,
  /https?:\/\/email\.mg\.[^\s"'<>]+/gi,
  /https?:\/\/[^\s"'<>]*\.email\.beehiiv\.com\/c\/[^\s"'<>]*/gi,
  /https?:\/\/[^\s"'<>]*\.substackcdn\.com\/image\/[^\s"'<>]*?token=[^\s"'<>&]*[^\s"'<>]*/gi,
  /https?:\/\/[^\s"'<>]*\.convertkit\.com\/click\/[^\s"'<>]*/gi,
  /https?:\/\/[^\s"'<>]*\.email\.mailerlite\.com\/lt\/[^\s"'<>]*/gi,
];

const PIXEL_IMG = /<img[^>]*(?:width=["']?1["']?|height=["']?1["']?)[^>]*>/gi;
const SALUTATION = /^(Hi|Hello|Hey|Dear)[ \t]+[A-Za-z][\w'.-]*,[ \t]*/gim;
const TOKEN_PARAMS = /[?&](token|t|c|recipient|email|user|uid)=[^&\s"'<>#]*/gi;

// ============================================================================
// Body normalization
// ============================================================================

/**
 * Strip per-recipient query params (`token`, `t`, `c`, `recipient`, `email`,
 * `user`, `uid`) from URLs while preserving the rest of the URL. Cleans up
 * dangling `?` / `&` left behind.
 */
function stripPerRecipientParams(input: string): string {
  let out = input.replace(TOKEN_PARAMS, (match) => {
    return match.startsWith('?') ? '?' : '';
  });
  out = out.replace(/\?&/g, '?');
  out = out.replace(/&&+/g, '&');
  out = out.replace(/\?(?=\s|$|["'<>#])/g, '');
  out = out.replace(/&(?=\s|$|["'<>#])/g, '');
  return out;
}

/**
 * Normalize a message body for content-hashing. Pure; deterministic.
 * Empty input returns empty string.
 */
export function normalizeBody(body: string): string {
  if (!body) return '';
  let out = body;

  out = stripPerRecipientParams(out);

  for (const re of TRACKING_HOSTS) {
    out = out.replace(re, '');
  }

  out = out.replace(PIXEL_IMG, '');

  out = out.replace(SALUTATION, '');

  out = out.replace(/\s+/g, ' ');

  out = out.trim().toLowerCase();

  return out;
}

// ============================================================================
// Hash
// ============================================================================

/**
 * sha256 hex of the UTF-8 bytes of `normalized`. Uses Web Crypto.
 */
export async function hashBody(normalized: string): Promise<string> {
  const data = new TextEncoder().encode(normalized);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Store
// ============================================================================

export function createContentHashStore(
  adapter: StorageAdapter,
  opts: ContentHashStoreOptions = {},
): ContentHashStore {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const keyFor = (sender: string, sha256: string) => `${keyPrefix}${sender}/${sha256}`;

  return {
    async record(sender, sha256, ingest_at) {
      const key = keyFor(sender, sha256);
      const existing = (await adapter.get(key)) as ContentHashRecord | null;
      if (existing) return existing;
      const fresh: ContentHashRecord = { sha256, sender, ingest_at };
      await adapter.set(key, fresh);
      return null;
    },

    async isRepeatWithin(sender, sha256, now, windowMs) {
      const key = keyFor(sender, sha256);
      const existing = (await adapter.get(key)) as ContentHashRecord | null;
      if (!existing) return null;
      const age = Date.parse(now) - Date.parse(existing.ingest_at);
      if (Number.isNaN(age)) return null;
      if (age <= windowMs) return existing;
      return null;
    },

    async prune(cutoffISO) {
      const keys = await adapter.keys(keyPrefix);
      let removed = 0;
      const limit = Math.min(keys.length, PRUNE_CAP);
      for (let i = 0; i < limit; i++) {
        const key = keys[i];
        const rec = (await adapter.get(key)) as ContentHashRecord | null;
        if (!rec) continue;
        if (rec.ingest_at < cutoffISO) {
          await adapter.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };
}

// ============================================================================
// Hook
// ============================================================================

const CAMPAIGN_BLAST_LABEL = 'campaign-blast';
const REPEATED_TRUSTED_LABEL = 'repeated:trusted';

export function createContentHashHook(opts: ContentHashHookOptions): PostClassifyHook {
  const store = opts.store;
  const senderIndex = opts.senderIndex;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => new Date().toISOString());

  return async function contentHashHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    try {
      const fromEmail = item.fields?.from_email;
      if (typeof fromEmail !== 'string' || !fromEmail.trim()) return 'accept';
      if (!item.body || typeof item.body !== 'string') return 'accept';

      const sender = fromEmail.trim().toLowerCase();
      const normalized = normalizeBody(item.body);
      if (!normalized) return 'accept';

      const sha256 = await hashBody(normalized);
      const nowISO = now();

      const repeat = await store.isRepeatWithin(sender, sha256, nowISO, windowMs);

      if (!repeat) {
        await store.record(sender, sha256, nowISO);
        return 'accept';
      }

      let label = CAMPAIGN_BLAST_LABEL;
      if (senderIndex) {
        const senderRecord = await senderIndex.get(sender);
        if (senderRecord?.tags?.includes('trusted')) {
          label = REPEATED_TRUSTED_LABEL;
        }
      }

      const existing = item.labels ?? [];
      if (existing.includes(label)) return 'accept';

      return {
        ...item,
        labels: [...existing, label],
      };
    } catch (err) {
      console.warn('[content-hash]', err);
      return 'accept';
    }
  };
}
