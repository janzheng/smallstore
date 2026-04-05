/**
 * Sync engine — pull, push, and bidirectional sync between two VaultGraph APIs.
 *
 * Uses existing CRUD endpoints on the remote:
 *   Pull: GET /api/vault/notes/:path/raw
 *   Push: POST /api/vault/notes (create) or PUT /api/vault/notes/:path (update)
 *
 * Baseline persistence: .vault-graph/sync-baseline.json
 */

import type { NoteStorage } from "../storage-types.ts";
import { isBinaryPath } from "../storage-types.ts";
import type {
  SyncConfig,
  SyncDiff,
  SyncResult,
  SyncStatus,
  SyncManifest,
  DiffEntry,
  ConflictStrategy,
} from "./types.ts";
import { buildManifest } from "./manifest.ts";
import { computeDiff } from "./diff.ts";

// ── Sync State ───────────────────────────────────────────────────

let syncStatus: SyncStatus = {
  state: "idle",
  lastSyncAt: null,
};

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

// ── Remote API Client ────────────────────────────────────────────

function authHeaders(config: SyncConfig): Record<string, string> {
  return config.authToken
    ? { Authorization: `Bearer ${config.authToken}` }
    : {};
}

/** Fetch manifest from a remote VaultGraph API. */
export async function fetchRemoteManifest(config: SyncConfig): Promise<SyncManifest> {
  const res = await fetch(`${config.remoteUrl}/api/vault/sync/manifest`, {
    headers: authHeaders(config),
  });
  if (!res.ok) throw new Error(`Remote manifest fetch failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`Remote manifest error: ${body.error?.message}`);
  return body.data;
}

/** Delete a note on the remote API. */
async function deleteRemoteNote(config: SyncConfig, path: string): Promise<void> {
  const encoded = encodeURIComponent(path);
  const res = await fetch(
    `${config.remoteUrl}/api/vault/notes/${encoded}`,
    { method: "DELETE", headers: authHeaders(config) },
  );
  if (!res.ok) {
    const body = await res.json().catch((err: unknown) => { console.warn('[VaultSync] Response parse failed:', err); return null; });
    throw new Error(`Remote delete failed: ${path} (${res.status}) ${body?.error?.message ?? ""}`);
  }
}

/** Fetch a note's raw content from the remote API. */
async function fetchRemoteNote(config: SyncConfig, path: string): Promise<string> {
  const encoded = encodeURIComponent(path);
  const res = await fetch(
    `${config.remoteUrl}/api/vault/notes/${encoded}/raw`,
    { headers: authHeaders(config) },
  );
  if (!res.ok) throw new Error(`Remote note fetch failed: ${path} (${res.status})`);
  return await res.text();
}

/** Fetch binary content from the remote API. */
async function fetchRemoteBinary(config: SyncConfig, path: string): Promise<Uint8Array> {
  const encoded = encodeURIComponent(path);
  const res = await fetch(
    `${config.remoteUrl}/api/vault/attachments/${encoded}`,
    { headers: authHeaders(config) },
  );
  if (!res.ok) throw new Error(`Remote binary fetch failed: ${path} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Push binary content to the remote API. */
async function pushRemoteBinary(config: SyncConfig, path: string, data: Uint8Array): Promise<void> {
  const form = new FormData();
  form.append("path", path);
  form.append("file", new Blob([data]), path.split("/").pop() ?? "file");

  const res = await fetch(`${config.remoteUrl}/api/vault/attachments`, {
    method: "POST",
    headers: authHeaders(config),
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch((err: unknown) => { console.warn('[VaultSync] Response parse failed:', err); return null; });
    throw new Error(`Remote binary push failed: ${path} (${res.status}) ${body?.error?.message ?? ""}`);
  }
}

/** Push a note's raw content to the remote API. */
async function pushRemoteNote(
  config: SyncConfig,
  path: string,
  content: string,
  isNew: boolean,
): Promise<void> {
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(config),
  };

  if (isNew) {
    const res = await fetch(`${config.remoteUrl}/api/vault/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path, raw: content }),
    });
    if (!res.ok) {
      const body = await res.json().catch((err: unknown) => { console.warn('[VaultSync] Response parse failed:', err); return null; });
      throw new Error(`Remote create failed: ${path} (${res.status}) ${body?.error?.message ?? ""}`);
    }
  } else {
    const encoded = encodeURIComponent(path);
    const res = await fetch(
      `${config.remoteUrl}/api/vault/notes/${encoded}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ raw: content }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch((err: unknown) => { console.warn('[VaultSync] Response parse failed:', err); return null; });
      throw new Error(`Remote update failed: ${path} (${res.status}) ${body?.error?.message ?? ""}`);
    }
  }
}

// ── Pull ─────────────────────────────────────────────────────────

/** Pull specific notes from a remote API into local storage. */
export async function pullNotes(
  config: SyncConfig,
  storage: NoteStorage,
  entries: DiffEntry[],
): Promise<{ pulled: number; errors: string[] }> {
  let pulled = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    try {
      if (isBinaryPath(entry.path)) {
        const data = await fetchRemoteBinary(config, entry.path);
        await storage.writeBinary(entry.path, data);
      } else {
        const content = await fetchRemoteNote(config, entry.path);
        await storage.write(entry.path, content);
      }
      pulled++;
    } catch (e) {
      errors.push(`pull ${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { pulled, errors };
}

// ── Push ─────────────────────────────────────────────────────────

/** Push specific local notes to a remote API. */
export async function pushNotes(
  config: SyncConfig,
  storage: NoteStorage,
  entries: DiffEntry[],
): Promise<{ pushed: number; errors: string[] }> {
  let pushed = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    try {
      if (isBinaryPath(entry.path)) {
        const data = await storage.readBinary(entry.path);
        if (data === null) {
          errors.push(`push ${entry.path}: binary file not found locally`);
          continue;
        }
        await pushRemoteBinary(config, entry.path, data);
      } else {
        const content = await storage.read(entry.path);
        if (content === null) {
          errors.push(`push ${entry.path}: file not found locally`);
          continue;
        }
        const isNew = entry.remote === null;
        await pushRemoteNote(config, entry.path, content, isNew);
      }
      pushed++;
    } catch (e) {
      errors.push(`push ${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { pushed, errors };
}

// ── Delete ───────────────────────────────────────────────────────

/** Propagate deletions based on diff results. */
export async function deleteNotes(
  config: SyncConfig,
  storage: NoteStorage,
  entries: DiffEntry[],
): Promise<{ deleted: number; errors: string[] }> {
  let deleted = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    try {
      if (entry.local && !entry.remote) {
        // Remote deleted → delete locally
        await storage.delete(entry.path);
        deleted++;
      } else if (!entry.local && entry.remote) {
        // Local deleted → delete on remote
        await deleteRemoteNote(config, entry.path);
        deleted++;
      }
    } catch (e) {
      errors.push(`delete ${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { deleted, errors };
}

// ── Conflict Resolution ──────────────────────────────────────────

async function resolveConflicts(
  config: SyncConfig,
  storage: NoteStorage,
  conflicts: DiffEntry[],
  strategy: ConflictStrategy,
): Promise<{ resolved: number; conflictPaths: string[]; errors: string[] }> {
  let resolved = 0;
  const conflictPaths: string[] = [];
  const errors: string[] = [];

  for (const entry of conflicts) {
    try {
      switch (strategy) {
        case "last-write-wins": {
          const localNewer = (entry.local?.modifiedAt ?? "") >= (entry.remote?.modifiedAt ?? "");
          if (localNewer) {
            const content = await storage.read(entry.path);
            if (content) await pushRemoteNote(config, entry.path, content, false);
          } else {
            const content = await fetchRemoteNote(config, entry.path);
            await storage.write(entry.path, content);
          }
          resolved++;
          break;
        }
        case "local-wins": {
          const content = await storage.read(entry.path);
          if (content) await pushRemoteNote(config, entry.path, content, false);
          resolved++;
          break;
        }
        case "remote-wins": {
          const content = await fetchRemoteNote(config, entry.path);
          await storage.write(entry.path, content);
          resolved++;
          break;
        }
        case "create-conflict-file": {
          const remoteContent = await fetchRemoteNote(config, entry.path);
          const conflictPath = entry.path.replace(/\.md$/, ".conflict.md");
          await storage.write(conflictPath, remoteContent);
          conflictPaths.push(conflictPath);
          resolved++;
          break;
        }
      }
    } catch (e) {
      errors.push(`conflict ${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { resolved, conflictPaths, errors };
}

// ── Baseline Persistence ─────────────────────────────────────────

const BASELINE_PATH = ".vault-graph/sync-baseline.json";

async function loadBaseline(storage: NoteStorage): Promise<SyncManifest | null> {
  const content = await storage.read(BASELINE_PATH);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveBaseline(storage: NoteStorage, manifest: SyncManifest): Promise<void> {
  await storage.write(BASELINE_PATH, JSON.stringify(manifest, null, 2));
}

// ── Full Sync ────────────────────────────────────────────────────

/**
 * Run a full sync operation.
 *
 * 1. Build local manifest
 * 2. Fetch remote manifest
 * 3. Load baseline (from previous sync) for three-way merge
 * 4. Compute diff
 * 5. Pull/push based on mode
 * 6. Resolve conflicts
 * 7. Save new baseline
 */
export async function sync(
  config: SyncConfig,
  storage: NoteStorage,
): Promise<SyncResult> {
  const start = performance.now();
  syncStatus = { ...syncStatus, state: "syncing" };

  try {
    const localManifest = await buildManifest(storage, { exclude: config.exclude });
    const remoteManifest = await fetchRemoteManifest(config);
    const baseline = await loadBaseline(storage);

    const diff = computeDiff(localManifest, remoteManifest, baseline ?? undefined);

    let pulled = 0, pushed = 0, totalDeleted = 0;
    const allErrors: string[] = [];
    let allConflictPaths: string[] = [];

    // Pull
    if (config.mode === "pull-only" || config.mode === "bidirectional") {
      const result = await pullNotes(config, storage, diff.toPull);
      pulled = result.pulled;
      allErrors.push(...result.errors);
    }

    // Push
    if (config.mode === "push-only" || config.mode === "bidirectional") {
      const result = await pushNotes(config, storage, diff.toPush);
      pushed = result.pushed;
      allErrors.push(...result.errors);
    }

    // Deletions
    if (diff.toDelete.length > 0) {
      const result = await deleteNotes(config, storage, diff.toDelete);
      totalDeleted = result.deleted;
      allErrors.push(...result.errors);
    }

    // Conflicts (bidirectional only)
    const conflictCount = diff.conflicts.length;
    if (config.mode === "bidirectional" && diff.conflicts.length > 0) {
      const result = await resolveConflicts(
        config, storage, diff.conflicts, config.conflictStrategy,
      );
      allErrors.push(...result.errors);
      allConflictPaths = result.conflictPaths;
    }

    // Save baseline for next sync
    const newBaseline = await buildManifest(storage, { exclude: config.exclude });
    await saveBaseline(storage, newBaseline);

    const syncResult: SyncResult = {
      pulled,
      pushed,
      deleted: totalDeleted,
      conflicts: conflictCount,
      conflictPaths: allConflictPaths,
      errors: allErrors,
      durationMs: Math.round(performance.now() - start),
    };

    syncStatus = {
      state: "idle",
      lastSyncAt: new Date().toISOString(),
      lastResult: syncResult,
    };

    return syncResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    syncStatus = { ...syncStatus, state: "error", error: msg };
    throw e;
  }
}
