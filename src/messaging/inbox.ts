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

export class Inbox implements InboxInterface {
  readonly name: string;
  readonly channel: string;
  readonly keyPrefix: string;
  private readonly storage: InboxStorage;
  private readonly indexKey: string;
  private readonly itemPrefix: string;

  constructor(opts: InboxOptions) {
    this.name = opts.name;
    this.channel = opts.channel;
    this.storage = opts.storage;
    this.keyPrefix = opts.keyPrefix ?? '';
    this.indexKey = `${this.keyPrefix}${INDEX_KEY}`;
    this.itemPrefix = `${this.keyPrefix}${ITEM_PREFIX}`;
  }

  private itemKey(id: string): string {
    return `${this.itemPrefix}${id}`;
  }

  // --------------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------------

  async list(options: ListOptions = {}): Promise<ListResult> {
    const index = await this.loadIndex();
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
    const matching: IndexEntry[] = [];
    const limit = options.limit ?? 50;
    const startIdx = startIndex(index.entries, decodeCursor(options.cursor));

    for (let i = startIdx; i < index.entries.length; i++) {
      const entry = index.entries[i];
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

  async cursor(): Promise<string> {
    const index = await this.loadIndex();
    if (index.entries.length === 0) return encodeCursor({ at: new Date(0).toISOString(), id: '' });
    const head = index.entries[0];
    return encodeCursor(head);
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

    await this.storage.items.set(this.itemKey(finalItem.id), finalItem);
    await this.appendIndex({ at: finalItem.received_at, id: finalItem.id });
    return finalItem;
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
    const index = await this.loadIndex();
    if (index.entries.some(e => e.id === entry.id)) return; // already indexed
    index.entries.push(entry);
    index.entries.sort(compareNewestFirst);
    await this.storage.items.set(this.indexKey, index);
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
