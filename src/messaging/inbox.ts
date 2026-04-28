/**
 * Reference Inbox implementation.
 *
 * Composes a `StorageAdapter` (items) + optional second adapter (blobs)
 * + content-addressed dedup + opaque cursor.
 *
 * Storage layout (under the items adapter):
 * - `<keyPrefix>items/<id>`  → InboxItem JSON
 * - `<keyPrefix>_index`      → JSON `{ entries: [{at, id}, ...], version: 1 }`
 *                              sorted newest-first; rebuilt on every ingest
 *
 * `keyPrefix` defaults to '' so a single-inbox-per-adapter deployment
 * stores at the bare `_index` and `items/<id>` keys (the historical layout).
 * Set `keyPrefix: 'inbox/<name>/'` (or any other unique string) to
 * namespace within a shared adapter — multiple inboxes can then back onto
 * one D1 table without their `_index` rows trampling each other. The
 * runtime-create surface (`POST /admin/inboxes`) auto-defaults the prefix
 * to `inbox/<name>/` so callers don't have to think about isolation.
 *
 * Concurrency: ingest does a read-modify-write on `_index`. In Worker
 * contexts where a single email handler runs at a time per request this
 * is fine; for high-concurrency push channels swap in a DO-backed Inbox
 * variant (future work).
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { evaluateFilter } from './filter.ts';
import type {
  Attachment,
  AttachmentReadResult,
  IngestOptions,
  Inbox as InboxInterface,
  InboxFilter,
  InboxItem,
  InboxItemFull,
  InboxStorage,
  ListOptions,
  ListResult,
  QueryOptions,
  ReadOptions,
} from './types.ts';

interface IndexEntry {
  at: string;
  id: string;
}

interface IndexFile {
  entries: IndexEntry[];
  version: number;
}

const INDEX_KEY = '_index';
const ITEM_PREFIX = 'items/';
const PENDING_PREFIX = '_pending/';
const INDEX_VERSION = 1;

export interface InboxOptions {
  /** Logical name. */
  name: string;
  /** Channel name backing this inbox. */
  channel: string;
  /** Storage handle (items + optional blobs). */
  storage: InboxStorage;
  /**
   * Optional namespace prefix prepended to every key this inbox writes
   * (`<keyPrefix>_index`, `<keyPrefix>items/<id>`). Default `''` — the
   * historical single-inbox-per-adapter layout. Set to e.g.
   * `'inbox/biorxiv/'` to share one adapter between multiple inboxes.
   * The blobs adapter is NOT prefixed (blob keys are content-addressed
   * and shareable across inboxes).
   */
  keyPrefix?: string;
}

/**
 * Sidecar pending entry — written before the item, cleared after the item
 * is in the index. Lets `recoverOrphans()` find ingests that crashed
 * mid-write (B004). Stored at `${keyPrefix}_pending/<id>`.
 */
interface PendingEntry {
  at: string;
  id: string;
  started_at: string;
}

export class Inbox implements InboxInterface {
  readonly name: string;
  readonly channel: string;
  readonly keyPrefix: string;
  private readonly storage: InboxStorage;
  private readonly indexKey: string;
  private readonly itemPrefix: string;
  private readonly pendingPrefix: string;
  /**
   * Index-write serialization chain (B014). Concurrent `appendIndex`
   * calls — same-id duplicates or different-id sibling ingests under
   * load — would otherwise race the read-modify-write on `_index` and
   * either lose entries or duplicate them. Chaining writes through one
   * promise serializes them at the price of in-Worker latency; for the
   * push-channel volumes the mailroom sees this is a non-issue.
   */
  private indexWriteChain: Promise<unknown> = Promise.resolve();

  constructor(opts: InboxOptions) {
    this.name = opts.name;
    this.channel = opts.channel;
    this.storage = opts.storage;
    this.keyPrefix = opts.keyPrefix ?? '';
    this.indexKey = `${this.keyPrefix}${INDEX_KEY}`;
    this.itemPrefix = `${this.keyPrefix}${ITEM_PREFIX}`;
    this.pendingPrefix = `${this.keyPrefix}${PENDING_PREFIX}`;
  }

  private itemKey(id: string): string {
    return `${this.itemPrefix}${id}`;
  }

  private pendingKey(id: string): string {
    return `${this.pendingPrefix}${id}`;
  }

  // --------------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------------

  async list(options: ListOptions = {}): Promise<ListResult> {
    const index = await this.loadIndex();
    if (isCustomOrder(options.order_by)) {
      return this.listSortedByField(index.entries, undefined, options);
    }
    return this.paginateAndHydrate(index.entries, options);
  }

  async read(id: string, options: ReadOptions = {}): Promise<InboxItemFull | null> {
    const item = await this.storage.items.get(this.itemKey(id)) as InboxItem | null;
    if (!item) return null;
    if (!options.full) return item as InboxItemFull;

    const full: InboxItemFull = { ...item };

    if (item.body_ref && this.storage.blobs) {
      const inflated = await this.storage.blobs.get(item.body_ref).catch(() => null);
      if (typeof inflated === 'string') full.body_inflated = inflated;
    }

    return full;
  }

  async query(filter: InboxFilter, options: QueryOptions = {}): Promise<ListResult> {
    const index = await this.loadIndex();

    if (isCustomOrder(options.order_by)) {
      return this.listSortedByField(index.entries, filter, options);
    }

    // The default index is stored newest-first (most-recent ingest at index 0).
    // `order: 'oldest'` reverses iteration; cursor's `startIndex` finds by id so
    // it works on either direction. (Pre-2026-04-27 the filter path silently
    // ignored `options.order`; cross-newsletter routes worked around that with
    // an in-memory sort post-hydration. Now native.)
    const order = options.order ?? 'newest';
    const orderedEntries = order === 'newest' ? index.entries : [...index.entries].reverse();

    const matching: IndexEntry[] = [];
    const limit = options.limit ?? 50;
    const startIdx = startIndex(orderedEntries, decodeCursor(options.cursor));

    for (let i = startIdx; i < orderedEntries.length; i++) {
      const entry = orderedEntries[i];
      const item = await this.storage.items.get(this.itemKey(entry.id)) as InboxItem | null;
      if (!item) continue;
      if (!evaluateFilter(filter, item)) continue;
      matching.push(entry);
      if (matching.length >= limit + 1) break; // +1 to know if there's more
    }

    const hasMore = matching.length > limit;
    const page = hasMore ? matching.slice(0, limit) : matching;
    const items = await Promise.all(
      page.map(async e => (await this.storage.items.get(this.itemKey(e.id))) as InboxItem),
    );

    return {
      items,
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : undefined,
    };
  }

  /**
   * Sort-by-field path. Hydrates every item in the index, applies the filter
   * (if any), sorts by the chosen field (items missing the field tail), and
   * returns up to `limit` items. Cursor pagination is not supported in this
   * mode — `total` is set so callers can see the matching size.
   *
   * O(N) hydrations on the index. At inbox sizes < ~10K this is fine; past
   * that, see the `_index` scaling cliff in `TASKS-MESSAGING.md`.
   */
  private async listSortedByField(
    entries: IndexEntry[],
    filter: InboxFilter | undefined,
    options: ListOptions,
  ): Promise<ListResult> {
    const order = options.order ?? 'newest';
    const orderBy = options.order_by ?? 'received_at';
    const limit = options.limit ?? 50;

    if (options.cursor) {
      throw new Error(
        `Cursor pagination is not supported with order_by='${orderBy}'. ` +
          `Use limit alone or fall back to order_by='received_at' for cursor support.`,
      );
    }

    const items: InboxItem[] = [];
    for (const entry of entries) {
      const item = await this.storage.items.get(this.itemKey(entry.id)) as InboxItem | null;
      if (!item) continue;
      if (filter && !evaluateFilter(filter, item)) continue;
      items.push(item);
    }

    items.sort((a, b) => compareItemsByField(a, b, orderBy, order));
    const page = items.slice(0, limit);
    return {
      items: page,
      total: items.length,
    };
  }

  async cursor(): Promise<string> {
    const index = await this.loadIndex();
    if (index.entries.length === 0) return encodeCursor({ at: new Date(0).toISOString(), id: '' });
    const head = index.entries[0];
    return encodeCursor(head);
  }

  /**
   * Fetch a single attachment's raw bytes from the blobs adapter.
   *
   * Returns `null` if any of:
   *   - the item doesn't exist
   *   - the item has no `fields.attachments[]` (no attachments at all)
   *   - the supplied filename doesn't match an entry in that array
   *   - the inbox has no blobs adapter configured
   *   - the blob ref points at a missing object (partial-delete state)
   *
   * Filename validation is by exact match against `attachment.filename` —
   * arbitrary path components / traversal characters get rejected because
   * they won't appear in the metadata. The actual blob key (`attachment.ref`)
   * is the trusted lookup key, NOT the user-supplied filename.
   */
  async readAttachment(
    itemId: string,
    filename: string,
  ): Promise<AttachmentReadResult | null> {
    if (!this.storage.blobs) return null;
    const item = await this.storage.items.get(this.itemKey(itemId)) as InboxItem | null;
    if (!item) return null;

    const attachments = (item.fields as any)?.attachments as Attachment[] | undefined;
    if (!Array.isArray(attachments) || attachments.length === 0) return null;

    const match = attachments.find((a) => a?.filename === filename);
    if (!match || typeof match.ref !== 'string' || match.ref.length === 0) return null;

    const content = await this.storage.blobs.get(match.ref).catch(() => null);
    if (content === null || content === undefined) return null;

    return { attachment: match, content: content as Uint8Array | string };
  }

  /**
   * Delete an item and remove it from the index. Best-effort cleanup of
   * blob refs (raw_ref, body_ref, attachments[].ref) when a blobs adapter
   * is configured — individual blob deletes swallow errors so a missing
   * blob doesn't block the item delete.
   *
   * Returns `true` if the item existed and was removed; `false` if the id
   * wasn't indexed. Not idempotent on blobs (calling twice may try to
   * re-delete already-gone blobs — harmless but noisy in logs).
   */
  async delete(id: string): Promise<boolean> {
    const index = await this.loadIndex();
    const entryIdx = index.entries.findIndex((e) => e.id === id);
    if (entryIdx < 0) return false;

    const existing = (await this.storage.items.get(this.itemKey(id))) as InboxItem | null;

    // Best-effort blob cleanup before we drop the item record.
    if (existing && this.storage.blobs) {
      const blobKeys: string[] = [];
      if (existing.raw_ref) blobKeys.push(existing.raw_ref);
      if (existing.body_ref) blobKeys.push(existing.body_ref);
      const attachments = (existing.fields as any)?.attachments;
      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          if (att?.ref && typeof att.ref === 'string') blobKeys.push(att.ref);
        }
      }
      for (const key of blobKeys) {
        await this.storage.blobs.delete(key).catch(() => {/* noop */});
      }
    }

    // Remove item, rewrite index.
    await this.storage.items.delete(this.itemKey(id));
    index.entries.splice(entryIdx, 1);
    await this.storage.items.set(this.indexKey, index);
    return true;
  }

  async _ingest(item: InboxItem, options: IngestOptions = {}): Promise<InboxItem> {
    // Fields-only merge — used by the hook-replay system for retroactive field
    // population. Identity fields and the index entry are preserved; only
    // `fields` (shallow-merge, new wins) and `labels` (union) change.
    if (options.fields_only) {
      const existing = await this.storage.items.get(this.itemKey(item.id)) as InboxItem | null;
      if (!existing) return item; // caller can detect "not stored" via id-mismatch
      const merged: InboxItem = {
        ...existing,
        fields: { ...(existing.fields ?? {}), ...(item.fields ?? {}) },
        labels: Array.from(new Set([...(existing.labels ?? []), ...(item.labels ?? [])])),
      };
      await this.storage.items.set(this.itemKey(existing.id), merged);
      return merged;
    }

    const finalItem = applyRefs(item, options.refs);

    if (!options.force) {
      const existing = await this.storage.items.get(this.itemKey(finalItem.id));
      if (existing) return existing as InboxItem;
    }

    if (options.blobs && Object.keys(options.blobs).length > 0) {
      if (!this.storage.blobs) {
        throw new Error(`Inbox "${this.name}" has no blobs adapter configured but blobs were supplied`);
      }
      for (const [key, payload] of Object.entries(options.blobs)) {
        await this.storage.blobs.set(key, payload.content);
      }
    }

    // B004 atomicity: write a pending-sidecar entry BEFORE the item, and
    // clear it AFTER the index update settles. Three crash windows are now
    // recoverable via `recoverOrphans()`:
    //
    //   1. Crash between pending-set and item-set:
    //      → recoverOrphans sees pending key with no item → reaps pending.
    //   2. Crash between item-set and appendIndex:
    //      → recoverOrphans sees pending + item, item NOT in index → re-indexes.
    //   3. Crash between appendIndex and pending-delete:
    //      → recoverOrphans sees pending + item + indexed → benign cleanup.
    //
    // Pending entries do NOT participate in `loadIndex` or any list/query
    // path, so the only cost in the steady state is one extra adapter
    // round-trip on each ingest. No O(N) loadIndex regression.
    const pendingEntry: PendingEntry = {
      at: finalItem.received_at,
      id: finalItem.id,
      started_at: new Date().toISOString(),
    };
    await this.storage.items.set(this.pendingKey(finalItem.id), pendingEntry);

    await this.storage.items.set(this.itemKey(finalItem.id), finalItem);
    await this.appendIndex({ at: finalItem.received_at, id: finalItem.id });

    // Clear the pending marker. Best-effort: a delete failure here just
    // means recoverOrphans() will see a benign-cleanup case on its next
    // sweep and idempotently remove the marker.
    await this.storage.items.delete(this.pendingKey(finalItem.id)).catch(() => {/* recoverable */});

    return finalItem;
  }

  /**
   * Recover ingests that crashed mid-write (B004). Scans pending sidecar
   * entries and brings each to a consistent state:
   *
   *   - pending key + no item       → reap pending (partial-write before items.set)
   *   - pending key + item + no idx → re-index (crashed between items.set + appendIndex)
   *   - pending key + item + idx    → cleanup pending (crashed before delete)
   *
   * Idempotent — safe to call from cron, an admin endpoint, or boot.
   * Returns a counter summary suitable for logging.
   */
  async recoverOrphans(): Promise<{ recovered: number; reaped: number; cleaned: number }> {
    const pendingKeys = await this.storage.items.keys(this.pendingPrefix);
    let recovered = 0;
    let reaped = 0;
    let cleaned = 0;

    for (const pkey of pendingKeys) {
      const pending = (await this.storage.items.get(pkey)) as PendingEntry | null;
      if (!pending || typeof pending.id !== 'string') {
        // Malformed pending entry — drop it.
        await this.storage.items.delete(pkey).catch(() => {/* noop */});
        continue;
      }

      const item = (await this.storage.items.get(this.itemKey(pending.id))) as InboxItem | null;
      if (!item) {
        await this.storage.items.delete(pkey).catch(() => {/* noop */});
        reaped++;
        continue;
      }

      const index = await this.loadIndex();
      const indexed = index.entries.some((e) => e.id === pending.id);
      if (!indexed) {
        await this.appendIndex({ at: pending.at, id: pending.id });
        recovered++;
      } else {
        cleaned++;
      }
      await this.storage.items.delete(pkey).catch(() => {/* noop */});
    }

    return { recovered, reaped, cleaned };
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async loadIndex(): Promise<IndexFile> {
    const raw = await this.storage.items.get(this.indexKey) as IndexFile | null;
    if (!raw || !Array.isArray(raw.entries)) {
      return { entries: [], version: INDEX_VERSION };
    }
    return raw;
  }

  private async appendIndex(entry: IndexEntry): Promise<void> {
    // Serialize on `indexWriteChain` so concurrent appendIndex calls don't
    // race the read-modify-write on `_index` (B014). Without this, two
    // sibling _ingest paths can both load the same pre-state, both decide
    // "not present", both push, both write — the later write wins and
    // the earlier entry's add is lost. Chaining promises trades a small
    // amount of latency for correctness.
    const next = this.indexWriteChain.then(async () => {
      const index = await this.loadIndex();
      if (index.entries.some((e) => e.id === entry.id)) return;
      index.entries.push(entry);
      index.entries.sort(compareNewestFirst);
      await this.storage.items.set(this.indexKey, index);
    });
    // Swallow chain errors so a single failed append doesn't poison every
    // subsequent appendIndex on this Inbox. The current call's caller
    // still sees the rejection via `next`.
    this.indexWriteChain = next.catch(() => {/* recoverable */});
    return next;
  }

  private async paginateAndHydrate(
    entries: IndexEntry[],
    options: ListOptions,
  ): Promise<ListResult> {
    const order = options.order ?? 'newest';
    const ordered = order === 'newest' ? entries : [...entries].reverse();
    const limit = options.limit ?? 50;
    const startIdx = startIndex(ordered, decodeCursor(options.cursor));
    const slice = ordered.slice(startIdx, startIdx + limit + 1);
    const hasMore = slice.length > limit;
    const page = hasMore ? slice.slice(0, limit) : slice;

    const items = await Promise.all(
      page.map(async e => (await this.storage.items.get(this.itemKey(e.id))) as InboxItem),
    );

    return {
      items: items.filter(Boolean),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : undefined,
      total: ordered.length,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createInbox(opts: InboxOptions): Inbox {
  return new Inbox(opts);
}

// ============================================================================
// Helpers
// ============================================================================

function compareNewestFirst(a: IndexEntry, b: IndexEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

function isCustomOrder(orderBy: string | undefined): boolean {
  return orderBy !== undefined && orderBy !== 'received_at';
}

/**
 * Resolve the sort-key value for a given order_by selector. Returns
 * `undefined` for items missing the field — those tail in the sort.
 */
function getSortValue(item: InboxItem, orderBy: string): string | undefined {
  if (orderBy === 'received_at') return item.received_at;
  if (orderBy === 'sent_at') return item.sent_at;
  if (orderBy === 'original_sent_at') {
    const v = (item.fields ?? {}).original_sent_at;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Compare two items by an arbitrary date-shaped field. Items missing the
 * field always tail (regardless of `order` direction) — they come AFTER
 * the field-bearing items in both 'newest' and 'oldest' orders so the
 * caller never has to filter them out to see the meaningful results first.
 */
function compareItemsByField(
  a: InboxItem,
  b: InboxItem,
  orderBy: string,
  order: 'newest' | 'oldest',
): number {
  const av = getSortValue(a, orderBy);
  const bv = getSortValue(b, orderBy);
  // Missing-field items always tail.
  if (av === undefined && bv === undefined) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  if (av === bv) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (order === 'newest') return av < bv ? 1 : -1;
  return av < bv ? -1 : 1;
}

/** Find the index of the first entry strictly AFTER the cursor position (cursor is exclusive). */
function startIndex(entries: IndexEntry[], cursor: { at: string; id: string } | null): number {
  if (!cursor) return 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].at === cursor.at && entries[i].id === cursor.id) return i + 1;
  }
  return 0;
}

function applyRefs(item: InboxItem, refs?: IngestOptions['refs']): InboxItem {
  if (!refs) return item;
  const out: InboxItem = { ...item };
  if (refs.raw_ref) out.raw_ref = refs.raw_ref;
  if (refs.body_ref) out.body_ref = refs.body_ref;
  return out;
}
