/**
 * Sync protocol types for VaultGraph-to-VaultGraph synchronization.
 */

// ── Manifest ─────────────────────────────────────────────────────

/** A single file entry in a sync manifest. */
export interface ManifestEntry {
  /** Vault-relative path: "folder/My Note.md" */
  path: string;
  /** SHA-256 hex of raw content */
  hash: string;
  /** Last modified ISO 8601 timestamp */
  modifiedAt: string;
  /** File size in bytes */
  size: number;
}

/** Snapshot of all files in a vault at a point in time. */
export interface SyncManifest {
  /** Identifier for this vault instance */
  vaultId: string;
  /** ISO 8601 timestamp when manifest was generated */
  generatedAt: string;
  /** All files in the vault */
  entries: ManifestEntry[];
  /** Total file count */
  count: number;
}

// ── Diff ─────────────────────────────────────────────────────────

/** Classification of a file difference between two manifests. */
export type DiffAction = "added" | "modified" | "deleted" | "conflict";

/** A single file that differs between local and remote. */
export interface DiffEntry {
  path: string;
  action: DiffAction;
  /** Local manifest entry (null if file only exists remotely) */
  local: ManifestEntry | null;
  /** Remote manifest entry (null if file only exists locally) */
  remote: ManifestEntry | null;
}

/** Result of comparing two manifests. */
export interface SyncDiff {
  /** Files to pull from remote (remote-only or remote-newer) */
  toPull: DiffEntry[];
  /** Files to push to remote (local-only or local-newer) */
  toPush: DiffEntry[];
  /** Files deleted on one side since last sync (requires baseline) */
  toDelete: DiffEntry[];
  /** Files modified on both sides since last sync */
  conflicts: DiffEntry[];
  /** Count of files identical on both sides */
  unchanged: number;
}

// ── Config ───────────────────────────────────────────────────────

export type SyncMode = "bidirectional" | "pull-only" | "push-only";

export type ConflictStrategy =
  | "last-write-wins"
  | "local-wins"
  | "remote-wins"
  | "create-conflict-file";

/** Configuration for a sync operation. */
export interface SyncConfig {
  /** URL of the remote VaultGraph API: "http://remote:8020" */
  remoteUrl: string;
  /** Sync direction */
  mode: SyncMode;
  /** How to handle conflicts */
  conflictStrategy: ConflictStrategy;
  /** Paths to exclude from sync (glob patterns) */
  exclude?: string[];
  /** Optional auth token for remote API */
  authToken?: string;
}

// ── Status ───────────────────────────────────────────────────────

export type SyncState = "idle" | "syncing" | "error";

/** Current sync status. */
export interface SyncStatus {
  state: SyncState;
  /** Last successful sync timestamp, null if never synced */
  lastSyncAt: string | null;
  /** Error message if state is "error" */
  error?: string;
  /** Stats from last sync operation */
  lastResult?: SyncResult;
}

/** Result of a completed sync operation. */
export interface SyncResult {
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: number;
  conflictPaths: string[];
  errors: string[];
  durationMs: number;
}
