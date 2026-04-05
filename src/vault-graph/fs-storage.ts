/**
 * FileSystemStorage — reads and writes notes to a vault directory on disk.
 *
 * VaultGraph's watcher detects changes and re-indexes automatically,
 * so there's no need to manually trigger re-indexing after writes.
 */

import { join, dirname, relative } from "@std/path";
import { walk } from "@std/fs/walk";
import { ensureDir } from "@std/fs/ensure-dir";
import type { NoteStorage, FileStat } from "./storage-types.ts";

export class FileSystemStorage implements NoteStorage {
  constructor(private vaultDir: string) {}

  async list(opts?: { folder?: string; ext?: string }): Promise<string[]> {
    const baseDir = opts?.folder
      ? join(this.vaultDir, opts.folder)
      : this.vaultDir;

    const files: string[] = [];

    try {
      for await (const entry of walk(baseDir, {
        includeDirs: false,
        followSymlinks: false,
      })) {
        const relPath = relative(this.vaultDir, entry.path);

        // Skip hidden dirs and .obsidian config
        if (relPath.startsWith(".") || relPath.includes("/.")) continue;
        if (relPath.startsWith(".vault-graph")) continue;

        // Filter by extension
        if (opts?.ext && !relPath.endsWith(opts.ext)) continue;

        files.push(relPath);
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }

    return files.sort();
  }

  async read(path: string): Promise<string | null> {
    try {
      return await Deno.readTextFile(join(this.vaultDir, path));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const absPath = join(this.vaultDir, path);
    await ensureDir(dirname(absPath));
    await Deno.writeTextFile(absPath, content);
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(join(this.vaultDir, path));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    const absPath = join(this.vaultDir, path);
    await ensureDir(dirname(absPath));
    await Deno.writeFile(absPath, content);
  }

  async delete(path: string): Promise<void> {
    try {
      await Deno.remove(join(this.vaultDir, path));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(join(this.vaultDir, path));
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await Deno.stat(join(this.vaultDir, path));
      return {
        size: info.size,
        mtime: info.mtime?.getTime() ?? Date.now(),
      };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async move(oldPath: string, newPath: string): Promise<void> {
    const absOld = join(this.vaultDir, oldPath);
    const absNew = join(this.vaultDir, newPath);
    await ensureDir(dirname(absNew));
    await Deno.rename(absOld, absNew);
  }

  async listFolders(parent?: string): Promise<string[]> {
    const baseDir = parent
      ? join(this.vaultDir, parent)
      : this.vaultDir;

    const folders: string[] = [];
    try {
      for await (const entry of Deno.readDir(baseDir)) {
        if (entry.isDirectory && !entry.name.startsWith(".")) {
          const relPath = parent
            ? `${parent}/${entry.name}`
            : entry.name;
          folders.push(relPath);
        }
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }

    return folders.sort();
  }
}
