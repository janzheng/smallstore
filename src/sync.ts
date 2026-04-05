/**
 * Generic adapter-to-adapter sync for Smallstore.
 *
 * Works between any two StorageAdapter instances with directional control.
 *
 * @example Push obsidian notes to Notion
 * ```typescript
 * await syncAdapters(obsidian, notion, {
 *   mode: 'push',
 *   transform: (key, note) => ({
 *     key,
 *     value: { Name: note.title, status: note.properties?.status },
 *   }),
 *   batchDelay: 400,
 * });
 * ```
 *
 * @example Bidirectional sync with change detection
 * ```typescript
 * const result = await syncAdapters(obsidian, notion, {
 *   mode: 'sync',
 *   syncId: 'obsidian-notion',
 *   conflictResolution: 'source-wins',
 * });
 * // result.baseline is saved automatically for next sync
 * ```
 */

import type { StorageAdapter } from './adapters/adapter.ts';

// ── Types ───────────────────────────────────────────────────────

export type SyncMode = 'push' | 'pull' | 'sync';

export type ConflictResolution =
  | 'source-wins'
  | 'target-wins'
  | 'skip'
  | ((key: string, sourceValue: any, targetValue: any) =>
      { value: any; writeTo: 'source' | 'target' | 'both' } | null);

export interface SyncBaseline {
  syncId: string;
  syncedAt: string;
  entries: Record<string, { sourceHash: string; targetHash: string }>;
}

export interface SyncAdapterOptions {
  /** Direction: push=source→target, pull=target→source, sync=bidirectional */
  mode?: SyncMode;
  /** Filter source keys by prefix */
  prefix?: string;
  /** Prefix to add on target keys (push) or strip when reading (pull) */
  targetPrefix?: string;
  /** Transform key/value before writing. Return null to skip a key. */
  transform?: (key: string, value: any) => { key: string; value: any } | null;
  /** Overwrite existing keys on target (default: true) */
  overwrite?: boolean;
  /**
   * Skip writing if source and target values are identical (JSON deep compare).
   * Saves expensive writes on rate-limited APIs. Requires one extra target.get()
   * per key, but avoids unnecessary set() calls.
   * Default: false
   */
  skipUnchanged?: boolean;
  /** Return what would happen without writing */
  dryRun?: boolean;
  /** Progress callback */
  onProgress?: (event: SyncProgressEvent) => void;
  /** Delay in ms between write operations (for rate-limited APIs) */
  batchDelay?: number;

  // ── Bidirectional sync options (mode: 'sync') ──

  /** Unique ID for this sync pair. Required to enable baseline tracking. */
  syncId?: string;
  /** How to resolve conflicts when both sides changed. Default: 'skip' */
  conflictResolution?: ConflictResolution;
  /** Detect deletions via baseline. Default: true when baseline exists. */
  detectDeletions?: boolean;
  /** Explicit baseline (skips auto-load/save when provided). */
  baseline?: SyncBaseline;
  /** Adapter to store baseline in. Default: source adapter. */
  baselineAdapter?: StorageAdapter;
}

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  conflicts: number;
  errors: SyncError[];
  keys: {
    created: string[];
    updated: string[];
    skipped: string[];
    deleted: string[];
    conflicts: string[];
    errors: string[];
  };
  dryRun: boolean;
  baseline?: SyncBaseline;
}

export interface SyncError {
  key: string;
  error: string;
}

export interface SyncProgressEvent {
  phase: 'push' | 'pull' | 'delete' | 'conflict';
  key: string;
  index: number;
  total: number;
}

// ── Helpers ─────────────────────────────────────────────────────

function emptyResult(dryRun: boolean): SyncResult {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    conflicts: 0,
    errors: [],
    keys: { created: [], updated: [], skipped: [], deleted: [], conflicts: [], errors: [] },
    dryRun,
  };
}

function mergeResults(a: SyncResult, b: SyncResult): SyncResult {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    skipped: a.skipped + b.skipped,
    deleted: a.deleted + b.deleted,
    conflicts: a.conflicts + b.conflicts,
    errors: [...a.errors, ...b.errors],
    keys: {
      created: [...a.keys.created, ...b.keys.created],
      updated: [...a.keys.updated, ...b.keys.updated],
      skipped: [...a.keys.skipped, ...b.keys.skipped],
      deleted: [...a.keys.deleted, ...b.keys.deleted],
      conflicts: [...a.keys.conflicts, ...b.keys.conflicts],
      errors: [...a.keys.errors, ...b.keys.errors],
    },
    dryRun: a.dryRun,
    baseline: b.baseline ?? a.baseline,
  };
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
}

/** Stable JSON string for comparing values across adapters. */
function stableHash(value: any): string {
  try {
    return JSON.stringify(value, Object.keys(value ?? {}).sort());
  } catch {
    return String(value);
  }
}

/** Compact hash (8-char hex) for baseline storage. Uses djb2 for speed. */
function compactHash(value: any): string {
  const str = stableHash(value);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return stableHash(a) === stableHash(b);
}

// ── Baseline storage ────────────────────────────────────────────

const BASELINE_PREFIX = '__sync_baseline:';

function baselineKey(syncId: string): string {
  return `${BASELINE_PREFIX}${syncId}`;
}

async function loadBaseline(
  adapter: StorageAdapter,
  syncId: string,
): Promise<SyncBaseline | null> {
  try {
    const raw = await adapter.get(baselineKey(syncId));
    if (!raw || typeof raw !== 'object') return null;

    // entries may be a JSON string if stored in a flat-field adapter (e.g. Notion)
    let entries = raw.entries;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { return null; }
    }
    if (!entries || typeof entries !== 'object') return null;

    return {
      syncId: raw.syncId ?? syncId,
      syncedAt: raw.syncedAt ?? '',
      entries,
    };
  } catch {
    return null;
  }
}

async function saveBaseline(
  adapter: StorageAdapter,
  baseline: SyncBaseline,
): Promise<void> {
  // Serialize entries as JSON string so flat-field adapters (e.g. Notion rich
  // text) don't lose the nested structure. Include a Name field for adapters
  // with schema constraints (e.g. Notion requiring a title property).
  const key = baselineKey(baseline.syncId);
  await adapter.set(key, {
    Name: key,
    syncId: baseline.syncId,
    syncedAt: baseline.syncedAt,
    entries: JSON.stringify(baseline.entries),
  });
}

// ── 3-way diff for bidirectional sync ───────────────────────────

interface SyncDiffResult {
  toPush: string[];
  toPull: string[];
  deleteFromSource: string[];
  deleteFromTarget: string[];
  conflicts: string[];
  unchanged: string[];
}

function computeSyncDiff(
  sourceHashes: Map<string, string>,
  targetHashes: Map<string, string>,
  baseline: SyncBaseline | null,
  detectDeletions: boolean,
): SyncDiffResult {
  const baseEntries = baseline?.entries ?? {};

  const allKeys = new Set([
    ...sourceHashes.keys(),
    ...targetHashes.keys(),
    ...Object.keys(baseEntries),
  ]);

  const result: SyncDiffResult = {
    toPush: [],
    toPull: [],
    deleteFromSource: [],
    deleteFromTarget: [],
    conflicts: [],
    unchanged: [],
  };

  for (const key of allKeys) {
    const sHash = sourceHashes.get(key) ?? null;
    const tHash = targetHashes.get(key) ?? null;
    const base = baseEntries[key] ?? null;

    // Both exist with same hash — unchanged
    if (sHash && tHash && sHash === tHash) {
      result.unchanged.push(key);
      continue;
    }

    // Neither exists (only in baseline) — both deleted, skip
    if (!sHash && !tHash) {
      continue;
    }

    // Source only (target doesn't have it)
    if (sHash && !tHash) {
      if (base && detectDeletions) {
        // Was in baseline → target deleted it
        if (sHash === base.sourceHash) {
          // Source unchanged → propagate target's deletion
          result.deleteFromSource.push(key);
        } else {
          // Source changed AND target deleted → conflict
          result.conflicts.push(key);
        }
      } else {
        // New on source → push
        result.toPush.push(key);
      }
      continue;
    }

    // Target only (source doesn't have it)
    if (!sHash && tHash) {
      if (base && detectDeletions) {
        // Was in baseline → source deleted it
        if (tHash === base.targetHash) {
          // Target unchanged → propagate source's deletion
          result.deleteFromTarget.push(key);
        } else {
          // Target changed AND source deleted → conflict
          result.conflicts.push(key);
        }
      } else {
        // New on target → pull
        result.toPull.push(key);
      }
      continue;
    }

    // Both exist, different hashes
    if (sHash && tHash) {
      if (base) {
        const sourceChanged = sHash !== base.sourceHash;
        const targetChanged = tHash !== base.targetHash;

        if (sourceChanged && targetChanged) {
          result.conflicts.push(key);
        } else if (sourceChanged) {
          result.toPush.push(key);
        } else if (targetChanged) {
          result.toPull.push(key);
        } else {
          // Neither changed relative to baseline but hashes differ
          // (e.g. transform changed) — treat as unchanged
          result.unchanged.push(key);
        }
      } else {
        // No baseline — can't determine which side changed → conflict
        result.conflicts.push(key);
      }
    }
  }

  return result;
}

// ── Core: one-way copy ──────────────────────────────────────────

async function copyKeys(
  from: StorageAdapter,
  to: StorageAdapter,
  opts: {
    prefix?: string;
    targetPrefix?: string;
    transform?: SyncAdapterOptions['transform'];
    overwrite: boolean;
    skipUnchanged: boolean;
    dryRun: boolean;
    phase: 'push' | 'pull';
    onProgress?: SyncAdapterOptions['onProgress'];
    batchDelay: number;
    /** If provided, only copy these specific keys (already mapped to source-side) */
    filterKeys?: Set<string>;
  },
): Promise<SyncResult> {
  const result = emptyResult(opts.dryRun);

  const sourceKeys = await from.keys(opts.prefix);
  const keys = opts.filterKeys
    ? sourceKeys.filter(k => opts.filterKeys!.has(k))
    : sourceKeys;

  for (let i = 0; i < keys.length; i++) {
    const sourceKey = keys[i];

    // Map source key → target key
    let targetKey = opts.targetPrefix
      ? opts.targetPrefix + sourceKey
      : sourceKey;

    opts.onProgress?.({ phase: opts.phase, key: sourceKey, index: i, total: keys.length });

    try {
      // Get value from source
      const value = await from.get(sourceKey);
      if (value === null || value === undefined) {
        result.skipped++;
        result.keys.skipped.push(sourceKey);
        continue;
      }

      // Transform
      let finalKey = targetKey;
      let finalValue = value;
      if (opts.transform) {
        const transformed = opts.transform(sourceKey, value);
        if (transformed === null) {
          result.skipped++;
          result.keys.skipped.push(sourceKey);
          continue;
        }
        finalKey = transformed.key;
        finalValue = transformed.value;
      }

      // Check if exists on target
      const exists = await to.has(finalKey);

      if (exists && !opts.overwrite) {
        result.skipped++;
        result.keys.skipped.push(sourceKey);
        continue;
      }

      // Skip unchanged: compare source and target values before writing
      if (exists && opts.skipUnchanged) {
        const targetValue = await to.get(finalKey);
        if (valuesEqual(finalValue, targetValue)) {
          result.skipped++;
          result.keys.skipped.push(sourceKey);
          continue;
        }
      }

      if (!opts.dryRun) {
        await to.set(finalKey, finalValue);
        await delay(opts.batchDelay);
      }

      if (exists) {
        result.updated++;
        result.keys.updated.push(finalKey);
      } else {
        result.created++;
        result.keys.created.push(finalKey);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ key: sourceKey, error: msg });
      result.keys.errors.push(sourceKey);
    }
  }

  return result;
}

// ── Bidirectional sync with 3-way merge ─────────────────────────

async function syncBidirectional(
  source: StorageAdapter,
  target: StorageAdapter,
  options: SyncAdapterOptions,
): Promise<SyncResult> {
  const {
    prefix,
    targetPrefix,
    transform,
    dryRun = false,
    onProgress,
    batchDelay = 0,
    syncId,
    conflictResolution = 'skip',
    detectDeletions: detectDeletionsOpt,
    baseline: explicitBaseline,
    baselineAdapter,
  } = options;

  const result = emptyResult(dryRun);
  const targetKeyPrefix = targetPrefix ?? '';

  // 1. Get all keys from both sides
  const sourceKeyList = await source.keys(prefix);
  const targetKeyList = await target.keys(targetKeyPrefix + (prefix ?? ''));

  // 2. Build hash maps (source-space keys → hash of raw value)
  //    Skip internal baseline keys so they don't get synced
  const sourceHashes = new Map<string, string>();
  const sourceValues = new Map<string, any>();
  for (const key of sourceKeyList) {
    if (key.startsWith(BASELINE_PREFIX)) continue;
    const value = await source.get(key);
    if (value != null) {
      sourceHashes.set(key, compactHash(value));
      sourceValues.set(key, value);
    }
  }

  // Map target keys to source-space and hash
  const targetHashes = new Map<string, string>();  // source-space key → hash
  const targetValues = new Map<string, any>();      // source-space key → value
  const targetKeyMap = new Map<string, string>();    // source-space key → target-space key
  for (const tKey of targetKeyList) {
    if (tKey.startsWith(BASELINE_PREFIX)) continue;
    const sKey = targetKeyPrefix ? tKey.slice(targetKeyPrefix.length) : tKey;
    const value = await target.get(tKey);
    if (value != null) {
      targetHashes.set(sKey, compactHash(value));
      targetValues.set(sKey, value);
      targetKeyMap.set(sKey, tKey);
    }
  }

  // 3. Load baseline
  let baseline: SyncBaseline | null = null;
  if (explicitBaseline) {
    baseline = explicitBaseline;
  } else if (syncId) {
    const adapter = baselineAdapter ?? source;
    baseline = await loadBaseline(adapter, syncId);
  }

  const detectDeletions = detectDeletionsOpt ?? (baseline != null);

  // 4. Compute diff
  const diff = computeSyncDiff(sourceHashes, targetHashes, baseline, detectDeletions);

  // Track what was actually written to each side (for accurate baseline)
  const writtenSourceHash = new Map<string, string>();  // key → hash of value written to source
  const writtenTargetHash = new Map<string, string>();  // key → hash of value written to target

  // 5. Execute pushes (source → target)
  for (let i = 0; i < diff.toPush.length; i++) {
    const key = diff.toPush[i];
    onProgress?.({ phase: 'push', key, index: i, total: diff.toPush.length });

    try {
      const value = sourceValues.get(key);
      let finalKey = targetKeyPrefix ? targetKeyPrefix + key : key;
      let finalValue = value;

      if (transform) {
        const t = transform(key, value);
        if (t === null) { result.skipped++; result.keys.skipped.push(key); continue; }
        finalKey = t.key;
        finalValue = t.value;
      }

      const exists = targetKeyMap.has(key);
      if (!dryRun) {
        await target.set(finalKey, finalValue);
        await delay(batchDelay);
      }

      // Record what target now has (the transformed value)
      writtenTargetHash.set(key, compactHash(finalValue));

      if (exists) {
        result.updated++;
        result.keys.updated.push(key);
      } else {
        result.created++;
        result.keys.created.push(key);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ key, error: msg });
      result.keys.errors.push(key);
    }
  }

  // 6. Execute pulls (target → source)
  for (let i = 0; i < diff.toPull.length; i++) {
    const key = diff.toPull[i];
    onProgress?.({ phase: 'pull', key, index: i, total: diff.toPull.length });

    try {
      const value = targetValues.get(key);
      let finalKey = key;
      let finalValue = value;

      if (transform) {
        const t = transform(key, value);
        if (t === null) { result.skipped++; result.keys.skipped.push(key); continue; }
        finalKey = t.key;
        finalValue = t.value;
      }

      const exists = sourceHashes.has(key);
      if (!dryRun) {
        await source.set(finalKey, finalValue);
        await delay(batchDelay);
      }

      // Record what source now has (the transformed value)
      writtenSourceHash.set(key, compactHash(finalValue));

      if (exists) {
        result.updated++;
        result.keys.updated.push(key);
      } else {
        result.created++;
        result.keys.created.push(key);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ key, error: msg });
      result.keys.errors.push(key);
    }
  }

  // 7. Execute deletions
  const allDeletions = [
    ...diff.deleteFromSource.map(k => ({ key: k, from: source, side: 'source' as const })),
    ...diff.deleteFromTarget.map(k => ({ key: k, from: target, side: 'target' as const })),
  ];
  for (let i = 0; i < allDeletions.length; i++) {
    const { key, from, side } = allDeletions[i];
    onProgress?.({ phase: 'delete', key, index: i, total: allDeletions.length });

    try {
      const deleteKey = side === 'target' && targetKeyPrefix
        ? targetKeyPrefix + key
        : key;
      if (!dryRun) {
        await from.delete(deleteKey);
        await delay(batchDelay);
      }
      result.deleted++;
      result.keys.deleted.push(key);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ key, error: msg });
      result.keys.errors.push(key);
    }
  }

  // 8. Handle conflicts
  for (let i = 0; i < diff.conflicts.length; i++) {
    const key = diff.conflicts[i];
    onProgress?.({ phase: 'conflict', key, index: i, total: diff.conflicts.length });

    const sourceVal = sourceValues.get(key);
    const targetVal = targetValues.get(key);

    try {
      if (conflictResolution === 'skip') {
        result.conflicts++;
        result.keys.conflicts.push(key);
      } else if (conflictResolution === 'source-wins') {
        let finalKey = targetKeyPrefix ? targetKeyPrefix + key : key;
        let finalValue = sourceVal;
        if (transform) {
          const t = transform(key, sourceVal);
          if (t === null) { result.skipped++; result.keys.skipped.push(key); continue; }
          finalKey = t.key;
          finalValue = t.value;
        }
        if (!dryRun) {
          await target.set(finalKey, finalValue);
          await delay(batchDelay);
        }
        writtenTargetHash.set(key, compactHash(finalValue));
        result.updated++;
        result.keys.updated.push(key);
      } else if (conflictResolution === 'target-wins') {
        let finalKey = key;
        let finalValue = targetVal;
        if (transform) {
          const t = transform(key, targetVal);
          if (t === null) { result.skipped++; result.keys.skipped.push(key); continue; }
          finalKey = t.key;
          finalValue = t.value;
        }
        if (!dryRun) {
          await source.set(finalKey, finalValue);
          await delay(batchDelay);
        }
        writtenSourceHash.set(key, compactHash(finalValue));
        result.updated++;
        result.keys.updated.push(key);
      } else if (typeof conflictResolution === 'function') {
        const resolution = conflictResolution(key, sourceVal, targetVal);
        if (resolution === null) {
          result.conflicts++;
          result.keys.conflicts.push(key);
        } else {
          const { value, writeTo } = resolution;
          const h = compactHash(value);
          if (!dryRun) {
            if (writeTo === 'source' || writeTo === 'both') {
              await source.set(key, value);
              await delay(batchDelay);
            }
            if (writeTo === 'target' || writeTo === 'both') {
              const tKey = targetKeyPrefix ? targetKeyPrefix + key : key;
              await target.set(tKey, value);
              await delay(batchDelay);
            }
          }
          if (writeTo === 'source' || writeTo === 'both') writtenSourceHash.set(key, h);
          if (writeTo === 'target' || writeTo === 'both') writtenTargetHash.set(key, h);
          result.updated++;
          result.keys.updated.push(key);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ key, error: msg });
      result.keys.errors.push(key);
    }
  }

  // 9. Build and save new baseline
  if (syncId && !explicitBaseline) {
    const newBaseline: SyncBaseline = {
      syncId,
      syncedAt: new Date().toISOString(),
      entries: {},
    };

    // Snapshot current state by re-reading values that were written during sync.
    // This ensures baseline hashes match what adapters return on future reads
    // (important because adapters like Notion add extra fields on get()).
    const allKeys = new Set([...sourceHashes.keys(), ...targetHashes.keys()]);
    const writtenKeys = new Set([
      ...diff.toPush, ...diff.toPull, ...diff.conflicts,
    ]);
    for (const key of allKeys) {
      // Skip deleted keys
      if (diff.deleteFromSource.includes(key) || diff.deleteFromTarget.includes(key)) continue;

      let sHash: string;
      let tHash: string;

      if (writtenKeys.has(key) && !dryRun) {
        // Re-read from adapters to get canonical values after writes
        const sVal = await source.get(key);
        sHash = sVal != null ? compactHash(sVal) : '';

        const tKey = targetKeyPrefix ? targetKeyPrefix + key : key;
        const tVal = await target.get(tKey);
        tHash = tVal != null ? compactHash(tVal) : '';
      } else {
        // Unchanged — use pre-computed hashes
        sHash = sourceHashes.get(key) ?? '';
        tHash = targetHashes.get(key) ?? '';
      }

      if (sHash || tHash) {
        newBaseline.entries[key] = { sourceHash: sHash, targetHash: tHash };
      }
    }

    if (!dryRun) {
      try {
        const adapter = baselineAdapter ?? source;
        await saveBaseline(adapter, newBaseline);
      } catch (baselineErr) {
        const failedKeys = Object.keys(newBaseline.entries);
        console.warn(`[Sync] Failed to save baseline for ${failedKeys.length} keys: ${baselineErr}. These keys will be re-synced next time.`);
        // Don't throw — sync itself succeeded, just baseline persistence didn't
      }
    }

    result.baseline = newBaseline;
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Sync data between two StorageAdapter instances.
 *
 * @param source - Source adapter to read from
 * @param target - Target adapter to write to
 * @param options - Sync options (mode, transform, etc.)
 * @returns Summary of what was synced
 */
export async function syncAdapters(
  source: StorageAdapter,
  target: StorageAdapter,
  options: SyncAdapterOptions = {},
): Promise<SyncResult> {
  const {
    mode = 'push',
    prefix,
    targetPrefix,
    transform,
    overwrite = true,
    skipUnchanged = false,
    dryRun = false,
    onProgress,
    batchDelay = 0,
  } = options;

  const copyOpts = {
    prefix,
    targetPrefix,
    transform,
    overwrite,
    skipUnchanged,
    dryRun,
    onProgress,
    batchDelay,
  };

  if (mode === 'push') {
    return copyKeys(source, target, { ...copyOpts, phase: 'push' });
  }

  if (mode === 'pull') {
    // Pull = target → source, swap roles
    // When pulling, targetPrefix works in reverse: strip it from target keys
    const pullTransform = targetPrefix
      ? (key: string, value: any) => {
          const mapped = key.startsWith(targetPrefix) ? key.slice(targetPrefix.length) : key;
          if (transform) return transform(mapped, value);
          return { key: mapped, value };
        }
      : transform;

    return copyKeys(target, source, {
      ...copyOpts,
      prefix: targetPrefix ? targetPrefix + (prefix ?? '') : prefix,
      targetPrefix: undefined,
      transform: pullTransform,
      phase: 'pull',
    });
  }

  // mode === 'sync': bidirectional
  // If syncId is provided, use 3-way merge with baseline
  if (options.syncId || options.baseline) {
    return syncBidirectional(source, target, options);
  }

  // Legacy sync: set-difference only (no baseline, shared keys skipped)
  const sourceKeys = new Set(await source.keys(prefix));
  const targetKeyPrefix = targetPrefix ?? '';
  const targetKeys = new Set(await target.keys(targetKeyPrefix + (prefix ?? '')));

  // Map target keys back to source-space for comparison
  const targetKeysInSourceSpace = new Set<string>();
  for (const tk of targetKeys) {
    const sk = targetKeyPrefix ? tk.slice(targetKeyPrefix.length) : tk;
    targetKeysInSourceSpace.add(sk);
  }

  // Source-only → push to target
  const sourceOnly = new Set<string>();
  for (const sk of sourceKeys) {
    if (!targetKeysInSourceSpace.has(sk)) sourceOnly.add(sk);
  }

  // Target-only → pull to source
  const targetOnly = new Set<string>();
  for (const tk of targetKeysInSourceSpace) {
    if (!sourceKeys.has(tk)) targetOnly.add(targetKeyPrefix + tk);
  }

  const pushResult = await copyKeys(source, target, {
    ...copyOpts,
    phase: 'push',
    filterKeys: sourceOnly,
  });

  // For pull side, read from target using target-space keys
  const pullTransform = targetPrefix
    ? (key: string, value: any) => {
        const mapped = key.startsWith(targetPrefix) ? key.slice(targetPrefix.length) : key;
        if (transform) return transform(mapped, value);
        return { key: mapped, value };
      }
    : transform;

  const pullResult = await copyKeys(target, source, {
    ...copyOpts,
    prefix: undefined,
    targetPrefix: undefined,
    transform: pullTransform,
    phase: 'pull',
    filterKeys: targetOnly,
  });

  return mergeResults(pushResult, pullResult);
}
