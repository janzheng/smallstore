/**
 * Diff computation — compare two sync manifests to determine what changed.
 *
 * Supports optional three-way merge with a baseline manifest:
 * - With baseline: detect deletions and only flag conflicts when BOTH sides changed
 * - Without baseline: use modifiedAt timestamps as a heuristic
 */

import type { SyncManifest, SyncDiff, DiffEntry, ManifestEntry } from "./types.ts";

function indexByPath(entries: ManifestEntry[]): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    map.set(entry.path, entry);
  }
  return map;
}

/**
 * Compare local and remote manifests to produce a sync diff.
 *
 * @param local - Local vault manifest
 * @param remote - Remote vault manifest
 * @param baseline - Optional baseline from previous sync (enables three-way merge)
 */
export function computeDiff(
  local: SyncManifest,
  remote: SyncManifest,
  baseline?: SyncManifest,
): SyncDiff {
  const localMap = indexByPath(local.entries);
  const remoteMap = indexByPath(remote.entries);
  const baselineMap = baseline ? indexByPath(baseline.entries) : null;

  // Include baseline paths so we can detect files deleted from both sides
  const allPaths = new Set([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...(baselineMap ? baselineMap.keys() : []),
  ]);

  const toPull: DiffEntry[] = [];
  const toPush: DiffEntry[] = [];
  const toDelete: DiffEntry[] = [];
  const conflicts: DiffEntry[] = [];
  let unchanged = 0;

  for (const path of allPaths) {
    const localEntry = localMap.get(path) ?? null;
    const remoteEntry = remoteMap.get(path) ?? null;
    const baseEntry = baselineMap?.get(path) ?? null;

    // Both exist with same hash — unchanged
    if (localEntry && remoteEntry && localEntry.hash === remoteEntry.hash) {
      unchanged++;
      continue;
    }

    // Neither side has it (only possible if baseline had it) — both deleted, skip
    if (!localEntry && !remoteEntry) {
      continue;
    }

    // Remote only (local doesn't have it)
    if (!localEntry && remoteEntry) {
      if (baseEntry) {
        // Was in baseline → local deleted it
        if (remoteEntry.hash === baseEntry.hash) {
          // Remote unchanged since baseline → propagate local deletion
          toDelete.push({ path, action: "deleted", local: null, remote: remoteEntry });
        } else {
          // Remote edited AND local deleted → conflict (edit vs delete)
          conflicts.push({ path, action: "conflict", local: null, remote: remoteEntry });
        }
      } else {
        // Not in baseline → genuinely new on remote → pull
        toPull.push({ path, action: "added", local: null, remote: remoteEntry });
      }
      continue;
    }

    // Local only (remote doesn't have it)
    if (localEntry && !remoteEntry) {
      if (baseEntry) {
        // Was in baseline → remote deleted it
        if (localEntry.hash === baseEntry.hash) {
          // Local unchanged since baseline → propagate remote deletion
          toDelete.push({ path, action: "deleted", local: localEntry, remote: null });
        } else {
          // Local edited AND remote deleted → conflict (edit vs delete)
          conflicts.push({ path, action: "conflict", local: localEntry, remote: null });
        }
      } else {
        // Not in baseline → genuinely new on local → push
        toPush.push({ path, action: "added", local: localEntry, remote: null });
      }
      continue;
    }

    // Both exist, different hashes
    if (localEntry && remoteEntry) {
      if (baselineMap) {
        // Three-way: check which side(s) changed since baseline
        const localChanged = !baseEntry || baseEntry.hash !== localEntry.hash;
        const remoteChanged = !baseEntry || baseEntry.hash !== remoteEntry.hash;

        if (localChanged && remoteChanged) {
          conflicts.push({ path, action: "conflict", local: localEntry, remote: remoteEntry });
        } else if (localChanged) {
          toPush.push({ path, action: "modified", local: localEntry, remote: remoteEntry });
        } else if (remoteChanged) {
          toPull.push({ path, action: "modified", local: localEntry, remote: remoteEntry });
        }
        // Both unchanged shouldn't reach here (hashes differ), but skip if it does
      } else {
        // No baseline: use modifiedAt as heuristic
        if (localEntry.modifiedAt > remoteEntry.modifiedAt) {
          toPush.push({ path, action: "modified", local: localEntry, remote: remoteEntry });
        } else if (remoteEntry.modifiedAt > localEntry.modifiedAt) {
          toPull.push({ path, action: "modified", local: localEntry, remote: remoteEntry });
        } else {
          // Same mtime but different hash — conflict
          conflicts.push({ path, action: "conflict", local: localEntry, remote: remoteEntry });
        }
      }
    }
  }

  return { toPull, toPush, toDelete, conflicts, unchanged };
}
