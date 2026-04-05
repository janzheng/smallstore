// Sheetlog KV Adapter
//
// Wraps sheetlog as a true key-value store for the interview engine.
// Each KV pair is a row with columns: key, content (JSON), updatedAt.
//
// Strategy: preload the entire sheet into memory on first access, then
// serve all reads from cache. Writes update cache immediately and are
// flushed to the sheet in batched, debounced network calls.

import type { Smallstore } from "./store.ts";

// Minimal Sheetlog client inlined to avoid importing config.ts (which pulls in SQLite)
class Sheetlog {
  private sheetUrl: string;
  private sheet: string;

  constructor(config: { sheetUrl: string; sheet: string }) {
    this.sheetUrl = config.sheetUrl;
    this.sheet = config.sheet;
  }

  private async log(payload: unknown, options: Record<string, unknown> = {}): Promise<unknown> {
    const body = { method: "POST", sheet: this.sheet, payload, ...options };
    const res = await fetch(this.sheetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Sheetlog HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async list() { return this.log({}, { method: "GET" }) as Promise<{ data?: unknown[] }>; }
  async batchUpsert(idColumn: string, payload: unknown[]) {
    return this.log(payload, { method: "BATCH_UPSERT", idColumn });
  }
  async bulkDelete(ids: number[]) {
    return this.log({}, { method: "BULK_DELETE", ids });
  }
}

interface SheetlogKVConfig {
  sheetUrl: string;
  sheet: string;
}

/**
 * Creates a minimal Smallstore-compatible interface backed by a single
 * Google Sheet tab using sheetlog. Preloads all data into memory so
 * reads are instant. Writes are batched and flushed asynchronously.
 */
export function createSheetlogKV(config: SheetlogKVConfig): Smallstore {
  const client = new Sheetlog({
    sheetUrl: config.sheetUrl,
    sheet: config.sheet,
  });

  // In-memory cache: key → parsed content
  const cache = new Map<string, unknown>();
  // Row IDs from the sheet for delete operations
  const rowIds = new Map<string, number>();
  // Whether we've done the initial full load
  let loaded = false;
  let loadPromise: Promise<void> | null = null;

  // Pending writes queue — flushed in batches
  const dirtyKeys = new Set<string>();
  const deletedKeys = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const FLUSH_DELAY = 150; // ms

  /** Load ALL rows from the sheet into cache (one-time) */
  async function preload(): Promise<void> {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const result = await client.list();
        const rows = result?.data;
        if (Array.isArray(rows)) {
          for (const row of rows) {
            if (!row?.key) continue;
            if (row._id) rowIds.set(row.key, row._id);
            try {
              cache.set(row.key, JSON.parse(row.content));
            } catch {
              cache.set(row.key, row.content ?? null);
            }
          }
        }
        loaded = true;
        console.log(`  [sheetlog-kv] preloaded ${cache.size} keys`);
      } catch (err) {
        console.error("[sheetlog-kv] preload failed:", err);
        loaded = true; // Don't retry — work from empty cache
      }
    })();
    return loadPromise;
  }

  function makeResult(key: string, content: unknown) {
    return { reference: key, content: content ?? null, adapter: "sheetlog", dataType: "kv" };
  }

  /** Flush all dirty writes to the sheet */
  async function flush(): Promise<void> {
    // Collect dirty keys
    const toWrite = [...dirtyKeys].filter((k) => !deletedKeys.has(k));
    const toDelete = [...deletedKeys];
    dirtyKeys.clear();
    deletedKeys.clear();

    // Batch upsert
    if (toWrite.length > 0) {
      const batch = toWrite.map((key) => ({
        key,
        content: JSON.stringify(cache.get(key)),
      }));
      try {
        await client.batchUpsert("key", batch);
      } catch (err) {
        console.error("[sheetlog-kv] flush write error:", err);
      }
    }

    // Batch delete
    if (toDelete.length > 0) {
      const ids = toDelete.map((k) => rowIds.get(k)).filter(Boolean) as number[];
      if (ids.length > 0) {
        try {
          await client.bulkDelete(ids);
          for (const k of toDelete) rowIds.delete(k);
        } catch (err) {
          console.error("[sheetlog-kv] flush delete error:", err);
        }
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DELAY);
  }

  return {
    async get(key: string) {
      await preload();
      return makeResult(key, cache.get(key));
    },

    async set(key: string, value: unknown, _options?: { mode?: string }) {
      await preload();
      cache.set(key, value);
      dirtyKeys.add(key);
      deletedKeys.delete(key);
      scheduleFlush();
    },

    async delete(key: string) {
      await preload();
      cache.delete(key);
      dirtyKeys.delete(key);
      deletedKeys.add(key);
      scheduleFlush();
    },

    has: async (key: string) => {
      await preload();
      return cache.has(key) && cache.get(key) != null;
    },

    keys: async () => {
      await preload();
      return [...cache.keys()].filter((k) => cache.get(k) != null);
    },

    clear: async () => {
      cache.clear();
      rowIds.clear();
      loaded = false;
      loadPromise = null;
    },
  } as unknown as Smallstore;
}
