/**
 * Overlay Storage Adapter
 *
 * Copy-on-write (COW) adapter that wraps two adapters:
 * - **overlay** — receives all writes (e.g. MemoryAdapter)
 * - **base** — read fallback (e.g. SQLiteAdapter, LocalFileAdapter)
 *
 * Reads check overlay first, fall through to base on miss.
 * Deletes are tracked as tombstones so we distinguish
 * "deleted in this layer" from "never existed."
 *
 * Three states for any key:
 * | State       | Overlay has key? | Has tombstone? | Behavior              |
 * |-------------|------------------|----------------|-----------------------|
 * | Shadowed    | yes              | no             | Return overlay value  |
 * | Deleted     | no               | yes            | Return null           |
 * | Passthrough | no               | no             | Fall through to base  |
 */

import type { StorageAdapter } from './adapter.ts';
import type { AdapterCapabilities } from '../types.ts';

// ============================================================================
// Constants
// ============================================================================

const TOMBSTONE_PREFIX = '__overlay_deleted__:';

// ============================================================================
// Types
// ============================================================================

export interface OverlayAdapterOptions {
  /** Adapter that receives all writes (e.g. MemoryAdapter) */
  overlay: StorageAdapter;
  /** Read fallback adapter (e.g. SQLiteAdapter) */
  base: StorageAdapter;
  /** Optional layer identifier */
  id?: string;
}

export interface OverlayDiff {
  /** Keys in overlay that don't exist in base */
  added: string[];
  /** Keys in overlay that also exist in base */
  modified: string[];
  /** Tombstoned keys that exist in base */
  deleted: string[];
}

export interface CommitResult {
  added: number;
  modified: number;
  deleted: number;
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  keyCount: number;
}

// ============================================================================
// Internal snapshot storage
// ============================================================================

interface SnapshotData {
  id: string;
  createdAt: string;
  prefix?: string;
  entries: Map<string, any>;
}

// ============================================================================
// OverlayAdapter
// ============================================================================

export class OverlayAdapter implements StorageAdapter {
  private _overlay: StorageAdapter;
  private _base: StorageAdapter;
  private _id: string;
  private _snapshots: Map<string, SnapshotData> = new Map();

  /**
   * Simple async mutex to serialize snapshot() and commit() operations.
   * Regular get/set/delete are NOT locked (too expensive).
   * Callers should avoid concurrent writes during snapshot/commit.
   */
  private _opLock: Promise<void> = Promise.resolve();
  private async _withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    const prev = this._opLock;
    this._opLock = next;
    await prev;
    try { return await fn(); } finally { release(); }
  }

  readonly capabilities: AdapterCapabilities;

  constructor(options: OverlayAdapterOptions) {
    this._overlay = options.overlay;
    this._base = options.base;
    this._id = options.id ?? 'overlay';

    // Merge capabilities: use overlay for performance (writes go there),
    // intersect supported types from both
    const overlayTypes = new Set(options.overlay.capabilities.supportedTypes);
    const baseTypes = new Set(options.base.capabilities.supportedTypes);
    const sharedTypes = [...overlayTypes].filter(t => baseTypes.has(t));

    this.capabilities = {
      name: this._id,
      supportedTypes: sharedTypes.length > 0
        ? sharedTypes as AdapterCapabilities['supportedTypes']
        : options.overlay.capabilities.supportedTypes,
      maxItemSize: minOrUndefined(
        options.overlay.capabilities.maxItemSize,
        options.base.capabilities.maxItemSize,
      ),
      maxTotalSize: undefined,
      cost: options.overlay.capabilities.cost,
      performance: options.overlay.capabilities.performance,
      features: {
        ...options.base.capabilities.features,
        ...options.overlay.capabilities.features,
      },
    };
  }

  /** The overlay adapter (receives writes) */
  get overlayAdapter(): StorageAdapter {
    return this._overlay;
  }

  /** The base adapter (read fallback) */
  get baseAdapter(): StorageAdapter {
    return this._base;
  }

  /** Get the base value for a key (bypassing overlay). Used by diff display. */
  async getBaseValue(key: string): Promise<any> {
    return this._base.get(key);
  }

  // ==========================================================================
  // StorageAdapter — CRUD
  // ==========================================================================

  async get(key: string): Promise<any> {
    // 1. Tombstone → null
    if (await this._overlay.has(TOMBSTONE_PREFIX + key)) {
      return null;
    }
    // 2. Overlay hit → return
    const overlayVal = await this._overlay.get(key);
    if (overlayVal !== null) {
      return overlayVal;
    }
    // 3. Fall through to base
    return this._base.get(key);
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    // Remove tombstone if it exists
    if (await this._overlay.has(TOMBSTONE_PREFIX + key)) {
      await this._overlay.delete(TOMBSTONE_PREFIX + key);
    }
    // Write to overlay
    await this._overlay.set(key, value, ttl);
  }

  async delete(key: string): Promise<void> {
    // Remove from overlay if present
    if (await this._overlay.has(key)) {
      await this._overlay.delete(key);
    }
    // Write tombstone
    await this._overlay.set(TOMBSTONE_PREFIX + key, true);
  }

  async has(key: string): Promise<boolean> {
    // Tombstone → false
    if (await this._overlay.has(TOMBSTONE_PREFIX + key)) {
      return false;
    }
    // Overlay hit → true
    if (await this._overlay.has(key)) {
      return true;
    }
    // Fall through to base
    return this._base.has(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    // Get overlay keys (exclude tombstone-prefixed keys)
    const allOverlayKeys = await this._overlay.keys(prefix);
    const overlayKeys = allOverlayKeys.filter(k => !k.startsWith(TOMBSTONE_PREFIX));

    // Get tombstoned real keys
    const tombstoneKeys = await this._overlay.keys(TOMBSTONE_PREFIX + (prefix ?? ''));
    const tombstonedRealKeys = new Set(
      tombstoneKeys.map(k => k.slice(TOMBSTONE_PREFIX.length)),
    );

    // Get base keys
    const baseKeys = await this._base.keys(prefix);

    // Union overlay + base, minus tombstoned
    const keySet = new Set<string>();
    for (const k of overlayKeys) keySet.add(k);
    for (const k of baseKeys) {
      if (!tombstonedRealKeys.has(k)) {
        keySet.add(k);
      }
    }

    return [...keySet].sort();
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      // Full clear: wipe everything (data + tombstones) in one call
      await this._overlay.clear();
      return;
    }
    // Prefixed clear: clear data within prefix, then clear matching tombstones
    await this._overlay.clear(prefix);
    await this._overlay.clear(TOMBSTONE_PREFIX + prefix);
  }

  // ==========================================================================
  // Overlay-specific methods
  // ==========================================================================

  /**
   * List keys that differ from base.
   * v1: "assume different" — if you wrote to overlay, it shows in diff.
   */
  async diff(prefix?: string): Promise<OverlayDiff> {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // Fetch base keys once into a Set (avoids N+1 has() calls)
    const baseKeySet = new Set(await this._base.keys(prefix));

    // Overlay keys (non-tombstone)
    const allOverlayKeys = await this._overlay.keys(prefix);
    const overlayKeys = allOverlayKeys.filter(k => !k.startsWith(TOMBSTONE_PREFIX));

    for (const key of overlayKeys) {
      if (baseKeySet.has(key)) {
        modified.push(key);
      } else {
        added.push(key);
      }
    }

    // Tombstoned keys — check against base Set
    const tombstoneKeys = await this._overlay.keys(TOMBSTONE_PREFIX + (prefix ?? ''));
    for (const tk of tombstoneKeys) {
      const realKey = tk.slice(TOMBSTONE_PREFIX.length);
      if (baseKeySet.has(realKey)) {
        deleted.push(realKey);
      }
    }

    return { added, modified, deleted };
  }

  /** Copy all overlay changes to base, then clear overlay.
   *  Serialized with snapshot() via _withLock to prevent torn reads and tombstone resurrection. */
  async commit(): Promise<CommitResult> {
    return this._withLock(async () => {
      // Single pass: classify keys and write to base in one loop
      const baseKeySet = new Set(await this._base.keys());
      const allOverlayKeys = await this._overlay.keys();
      let added = 0;
      let modified = 0;

      for (const key of allOverlayKeys) {
        if (key.startsWith(TOMBSTONE_PREFIX)) continue;
        const value = await this._overlay.get(key);
        if (value !== null) {
          await this._base.set(key, value);
        }
        if (baseKeySet.has(key)) {
          modified++;
        } else {
          added++;
        }
      }

      // Delete tombstoned keys from base
      const tombstoneKeys = await this._overlay.keys(TOMBSTONE_PREFIX);
      let deleted = 0;
      for (const tk of tombstoneKeys) {
        const realKey = tk.slice(TOMBSTONE_PREFIX.length);
        if (baseKeySet.has(realKey)) {
          await this._base.delete(realKey);
          deleted++;
        }
      }

      // Clear overlay entirely
      await this._overlay.clear();

      return { added, modified, deleted };
    });
  }

  /** Discard all overlay changes */
  async discard(): Promise<void> {
    await this._overlay.clear();
  }

  /** Check the state of a specific key */
  async keyState(key: string): Promise<'shadowed' | 'deleted' | 'passthrough'> {
    if (await this._overlay.has(TOMBSTONE_PREFIX + key)) {
      return 'deleted';
    }
    if (await this._overlay.has(key)) {
      return 'shadowed';
    }
    return 'passthrough';
  }

  /** Count of pending changes (overlay keys + tombstones) */
  async pendingCount(): Promise<number> {
    const allKeys = await this._overlay.keys();
    return allKeys.length;
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  /**
   * Capture the current merged view as a snapshot.
   * Stores copies of all visible keys (overlay + base as caller sees them).
   * Serialized with commit() via _withLock to prevent torn reads.
   */
  async snapshot(id: string, opts?: { prefix?: string }): Promise<SnapshotInfo> {
    return this._withLock(async () => {
      const allKeys = await this.keys(opts?.prefix);
      const entries = new Map<string, any>();

      for (const key of allKeys) {
        const value = await this.get(key);
        if (value !== null) {
          entries.set(key, structuredClone(value));
        }
      }

      const data: SnapshotData = {
        id,
        createdAt: new Date().toISOString(),
        prefix: opts?.prefix,
        entries,
      };
      this._snapshots.set(id, data);

      return { id, createdAt: data.createdAt, keyCount: entries.size };
    });
  }

  /**
   * Restore from a snapshot.
   * If the snapshot was prefix-scoped, only touches keys within that prefix.
   * Otherwise clears the entire overlay and replays all snapshot entries.
   */
  async restore(id: string): Promise<SnapshotInfo> {
    const snap = this._snapshots.get(id);
    if (!snap) {
      throw new Error(`Snapshot "${id}" not found`);
    }

    if (snap.prefix) {
      // Scoped restore: only clear overlay keys within the prefix
      await this._overlay.clear(snap.prefix);
      // Also clear tombstones for this prefix
      const tombstoneKeys = await this._overlay.keys(TOMBSTONE_PREFIX + snap.prefix);
      for (const k of tombstoneKeys) {
        await this._overlay.delete(k);
      }
    } else {
      // Full restore: clear entire overlay
      await this._overlay.clear();
    }

    // Write snapshot entries to overlay
    for (const [key, value] of snap.entries) {
      await this._overlay.set(key, structuredClone(value));
    }

    return { id: snap.id, createdAt: snap.createdAt, keyCount: snap.entries.size };
  }

  /** List all snapshots */
  listSnapshots(): SnapshotInfo[] {
    return [...this._snapshots.values()].map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      keyCount: s.entries.size,
    }));
  }

  /** Delete a snapshot */
  deleteSnapshot(id: string): boolean {
    return this._snapshots.delete(id);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function minOrUndefined(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

// ============================================================================
// Factory
// ============================================================================

export function createOverlayAdapter(options: OverlayAdapterOptions): OverlayAdapter {
  return new OverlayAdapter(options);
}
