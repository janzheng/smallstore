/**
 * Sender index — per-sender aggregate bookkeeping for messaging pipelines.
 *
 * Tracks aggregate stats (first/last seen, counts, tags, unsubscribe URL)
 * keyed by normalized email address. Designed to compose with the mailroom
 * pipeline as a post-classify hook, but usable standalone anywhere an
 * `InboxItem` lands.
 *
 * **Storage:** any `StorageAdapter`. Does NOT require D1. In dev/test use
 * `MemoryAdapter`; in prod pick whatever fits (D1, Upstash, KV, etc).
 *
 * **Local types:** `SenderRecord` lives in this file (not
 * `src/messaging/types.ts`) so the sender-index module stays a self-contained
 * plugin. See `docs/design/PLUGIN-AUTHORING.md` § invariant 3.
 *
 * See `.brief/mailroom-pipeline.md` § Sender index for rationale.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { InboxItem } from './types.ts';

// ============================================================================
// Types (local to this module — do not re-export from messaging/types.ts)
// ============================================================================

/**
 * Aggregate record per sender address.
 *
 * Primary key is `address` — lowercase, trimmed email. `display_name` carries
 * the latest observed RFC-5322 display (`"Jane Doe" <jane@example.com>`-style).
 * Tags are merged across items; spam/quarantine labels bump `spam_count`.
 */
export interface SenderRecord {
  /** Normalized lowercase email address. Primary key. */
  address: string;
  /** Latest observed display name (e.g. `"Jane Doe <jane@x.com>"` source form). */
  display_name?: string;
  /** ISO timestamp of first observation. */
  first_seen: string;
  /** ISO timestamp of most recent observation. */
  last_seen: string;
  /** Total items observed from this sender. */
  count: number;
  /** Items from this sender tagged `spam` or `quarantine`. */
  spam_count: number;
  /** Merged tags: `newsletter`, `unsubscribed`, `trusted`, `bounce-source`, etc. */
  tags: string[];
  /** Parsed URL from the `List-Unsubscribe` header, if present. */
  list_unsubscribe_url?: string;
}

export interface SenderIndexOptions {
  /** Key prefix for stored sender records. Default: `'senders/'`. */
  keyPrefix?: string;
}

/**
 * Query filter for `SenderIndex.query`.
 */
export interface SenderQueryFilter {
  /** Record must have ALL of these tags. */
  tags?: string[];
  /** Maximum records to return. */
  limit?: number;
  /** Cursor = last address seen (exclusive). */
  cursor?: string;
}

export interface SenderQueryResult {
  senders: SenderRecord[];
  /** Pass back as `cursor` to continue. Absent = end of stream. */
  next_cursor?: string;
}

export interface SenderIndex {
  /** Upsert sender row from an inbox item. Returns null when item has no sender. */
  upsert(item: InboxItem): Promise<SenderRecord | null>;
  /** Fetch a sender by address (case-insensitive). */
  get(address: string): Promise<SenderRecord | null>;
  /** List senders, optionally filtered by tags, with cursor pagination. */
  query(filter?: SenderQueryFilter): Promise<SenderQueryResult>;
  /** Remove a sender record. Returns true if a row existed. */
  delete(address: string): Promise<boolean>;
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_PREFIX = 'senders/';

function normalizeAddress(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * Parse a `List-Unsubscribe` header value.
 *
 * The header is a comma-separated list of `<url>` entries per RFC 2369.
 * Preference: first `https:`, else first `mailto:`, else the raw value.
 */
export function parseListUnsubscribe(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Extract all <...> bracket-wrapped entries.
  const matches = Array.from(trimmed.matchAll(/<([^>]+)>/g)).map((m) => m[1].trim()).filter(Boolean);
  const urls = matches.length > 0 ? matches : [trimmed];

  const https = urls.find((u) => /^https:/i.test(u));
  if (https) return https;
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  if (mailto) return mailto;
  return urls[0];
}

/**
 * Merge tags from an item into the sender record.
 *
 * Rules:
 * - Every item label is added (dedup).
 * - `newsletter` label promotes to a sender tag of the same name.
 * - `bounce` label promotes to `bounce-source` sender tag.
 * - `unsubscribed` is NOT auto-added — set via a separate action.
 */
function mergeTags(existing: string[], labels: string[] | undefined): string[] {
  const out = new Set<string>(existing);
  if (!labels) return Array.from(out);
  for (const label of labels) {
    if (!label) continue;
    out.add(label);
    if (label === 'bounce') out.add('bounce-source');
    // 'newsletter' is already added via the generic `out.add(label)` branch.
  }
  return Array.from(out);
}

function isSpamLabel(label: string): boolean {
  return label === 'spam' || label === 'quarantine';
}

function extractListUnsubscribeHeader(item: InboxItem): string | undefined {
  const headers = item.fields?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  // Case-insensitive lookup — headers may be stored as-received.
  const direct = (headers as Record<string, unknown>)['list-unsubscribe'];
  if (direct !== undefined) return parseListUnsubscribe(direct);
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === 'list-unsubscribe') return parseListUnsubscribe(v);
  }
  return undefined;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a `SenderIndex` backed by any `StorageAdapter`.
 *
 * @example
 * ```ts
 * const adapter = new MemoryAdapter();
 * const senders = createSenderIndex(adapter);
 * await senders.upsert(item);
 * const record = await senders.get('jane@example.com');
 * ```
 */
export function createSenderIndex(
  adapter: StorageAdapter,
  opts: SenderIndexOptions = {},
): SenderIndex {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const keyFor = (address: string) => keyPrefix + address;

  return {
    async upsert(item: InboxItem): Promise<SenderRecord | null> {
      const address = normalizeAddress(item.fields?.from_email);
      if (!address) return null; // No sender — skip silently (rss etc).

      const key = keyFor(address);
      const existing = (await adapter.get(key)) as SenderRecord | null;

      const labels = item.labels ?? [];
      const receivedAt = item.received_at;
      const displayName =
        typeof item.fields?.from_addr === 'string' && item.fields.from_addr.length > 0
          ? item.fields.from_addr
          : undefined;

      const baseTags = existing?.tags ?? [];
      const mergedTags = mergeTags(baseTags, labels);

      const spamDelta = labels.some(isSpamLabel) ? 1 : 0;
      const parsedUnsubUrl = extractListUnsubscribeHeader(item);

      const record: SenderRecord = {
        address,
        display_name: displayName ?? existing?.display_name,
        first_seen: existing?.first_seen ?? receivedAt,
        last_seen: receivedAt,
        count: (existing?.count ?? 0) + 1,
        spam_count: (existing?.spam_count ?? 0) + spamDelta,
        tags: mergedTags,
        // Preserve an existing unsub URL rather than overwrite with a fresh parse.
        list_unsubscribe_url: existing?.list_unsubscribe_url ?? parsedUnsubUrl,
      };

      await adapter.set(key, record);
      return record;
    },

    async get(address: string): Promise<SenderRecord | null> {
      const norm = normalizeAddress(address);
      if (!norm) return null;
      const record = (await adapter.get(keyFor(norm))) as SenderRecord | null;
      return record ?? null;
    },

    async query(filter: SenderQueryFilter = {}): Promise<SenderQueryResult> {
      const keys = await adapter.keys(keyPrefix);
      // Stable order — sort ascending by address so `cursor` has deterministic semantics.
      keys.sort();

      const cursor = filter.cursor;
      const tags = filter.tags ?? [];
      const limit = filter.limit;

      const results: SenderRecord[] = [];
      let lastAddress: string | undefined;

      for (const key of keys) {
        const address = key.slice(keyPrefix.length);
        if (cursor && address <= cursor) continue;

        const record = (await adapter.get(key)) as SenderRecord | null;
        if (!record) continue;

        // Tag filter — all requested tags must be present on record.
        if (tags.length > 0 && !tags.every((t) => record.tags.includes(t))) continue;

        results.push(record);
        lastAddress = address;

        if (limit !== undefined && results.length >= limit) break;
      }

      // Emit next_cursor only when limit was provided AND we hit it AND more keys remain.
      let next_cursor: string | undefined;
      if (limit !== undefined && results.length >= limit && lastAddress) {
        const remaining = keys.some((k) => k.slice(keyPrefix.length) > lastAddress!);
        if (remaining) next_cursor = lastAddress;
      }

      return { senders: results, next_cursor };
    },

    async delete(address: string): Promise<boolean> {
      const norm = normalizeAddress(address);
      if (!norm) return false;
      const key = keyFor(norm);
      const existed = await adapter.has(key);
      await adapter.delete(key);
      return existed;
    },
  };
}
