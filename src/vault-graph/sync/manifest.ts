/**
 * Manifest generation — enumerate vault files with content hashes.
 *
 * A SyncManifest is a snapshot of every file's path, hash, mtime, and size.
 * Two manifests can be compared via computeDiff() to determine what changed.
 */

import type { NoteStorage } from "../storage-types.ts";
import { isBinaryPath } from "../storage-types.ts";
import type { SyncManifest, ManifestEntry } from "./types.ts";
import { sha256, sha256Binary } from "../codec.ts";

/** Simple glob pattern matching (supports * and **). */
function matchGlob(path: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(path);
}

/**
 * Build a manifest of all markdown files in storage.
 *
 * Walks storage.list(), reads content for hashing, reads stat for mtime/size.
 */
export async function buildManifest(
  storage: NoteStorage,
  opts?: { vaultId?: string; exclude?: string[]; extensions?: string[] },
): Promise<SyncManifest> {
  const exts = opts?.extensions ?? [".md"];
  const entries: ManifestEntry[] = [];

  for (const ext of exts) {
    const paths = await storage.list({ ext });

    for (const path of paths) {
      if (opts?.exclude?.some((pattern) => matchGlob(path, pattern))) continue;

      const stat = await storage.stat(path);
      let hash: string;
      let size: number;

      if (isBinaryPath(path)) {
        const data = await storage.readBinary(path);
        if (data === null) continue;
        hash = await sha256Binary(data);
        size = stat?.size ?? data.byteLength;
      } else {
        const content = await storage.read(path);
        if (content === null) continue;
        hash = await sha256(content);
        size = stat?.size ?? new TextEncoder().encode(content).length;
      }

      entries.push({
        path,
        hash,
        modifiedAt: stat?.mtime
          ? new Date(stat.mtime).toISOString()
          : new Date().toISOString(),
        size,
      });
    }
  }

  return {
    vaultId: opts?.vaultId ?? "local",
    generatedAt: new Date().toISOString(),
    entries,
    count: entries.length,
  };
}
