/**
 * File system watcher for VaultGraph — monitors vault directory
 * for changes and triggers incremental index updates.
 *
 * Features:
 * - 50ms debounce to collapse rapid events
 * - Rename detection from remove+create pairs
 * - Ordered processing: deletes → renames → creates → modifies
 */

import { relative } from "@std/path";

// ── Event handler interface ────────────────────────────────────────

export interface EventHandler {
  onModify(path: string): Promise<void>;
  onCreate(path: string): Promise<void>;
  onDelete(path: string): Promise<void>;
  onRename(oldPath: string, newPath: string): Promise<void>;
}

// ── Watcher ────────────────────────────────────────────────────────

export class VaultWatcher {
  private watcher: Deno.FsWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents = new Map<string, Deno.FsEvent["kind"]>();
  private _paused = false;
  private _closed = false;

  constructor(
    private vaultDir: string,
    private handler: EventHandler,
    private getHash?: (path: string) => string | null,
  ) {}

  /** Start watching for file changes */
  async start(): Promise<void> {
    if (this._closed) return;
    // Resolve symlinks (macOS /var → /private/var) to ensure
    // relative() produces correct paths from watcher events
    this.vaultDir = await Deno.realPath(this.vaultDir);
    this.watcher = Deno.watchFs(this.vaultDir, { recursive: true });
    this.listen();
  }

  private async listen(): Promise<void> {
    if (!this.watcher) return;
    try {
      for await (const event of this.watcher) {
        if (this._closed) break;
        if (this._paused) continue;

        for (const absPath of event.paths) {
          const relPath = relative(this.vaultDir, absPath);

          // Skip hidden directories, .obsidian, and our own cache
          if (relPath.startsWith(".")) continue;
          if (relPath.includes("/.")) continue;

          // Only index markdown, canvas, and common asset files
          if (!this.isIndexable(relPath)) continue;

          this.pendingEvents.set(relPath, event.kind);
        }
        this.scheduleFlush();
      }
    } catch {
      // Watcher closed
    }
  }

  private isIndexable(path: string): boolean {
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    return [".md", ".canvas", ".png", ".jpg", ".jpeg", ".gif", ".svg",
      ".pdf", ".mp3", ".mp4", ".webm", ".wav", ".ogg", ".base"].includes(ext);
  }

  private scheduleFlush(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flush().catch(err => console.warn('[VaultWatcher] Flush failed:', err));
    }, 50);
  }

  private async flush(): Promise<void> {
    const events = new Map(this.pendingEvents);
    this.pendingEvents.clear();

    const removed = new Set<string>();
    const created = new Set<string>();
    const modified = new Set<string>();

    for (const [path, kind] of events) {
      switch (kind) {
        case "remove": removed.add(path); break;
        case "create": created.add(path); break;
        case "modify": modified.add(path); break;
      }
    }

    // Detect renames: remove + create with same content hash
    const renames: [string, string][] = [];
    if (this.getHash) {
      for (const oldPath of removed) {
        const oldHash = this.getHash(oldPath);
        if (!oldHash) continue;
        for (const newPath of created) {
          try {
            const content = await Deno.readTextFile(
              `${this.vaultDir}/${newPath}`,
            );
            const data = new TextEncoder().encode(content);
            const hashBuffer = await crypto.subtle.digest("SHA-256", data);
            const newHash = Array.from(new Uint8Array(hashBuffer))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            if (oldHash === newHash) {
              renames.push([oldPath, newPath]);
              removed.delete(oldPath);
              created.delete(newPath);
              break;
            }
          } catch {
            // File might not exist
          }
        }
      }
    }

    // Process in order: deletes → renames → creates → modifies
    for (const path of removed) {
      await this.handler.onDelete(path);
    }
    for (const [oldPath, newPath] of renames) {
      await this.handler.onRename(oldPath, newPath);
    }
    for (const path of created) {
      await this.handler.onCreate(path);
    }
    for (const path of modified) {
      if (!removed.has(path) && !created.has(path)) {
        await this.handler.onModify(path);
      }
    }
  }

  /** Pause watching (for bulk operations) */
  pause(): void {
    this._paused = true;
  }

  /** Resume watching — triggers warm-start catch-up */
  resume(): void {
    this._paused = false;
  }

  get isPaused(): boolean {
    return this._paused;
  }

  /** Stop watching and clean up */
  close(): void {
    this._closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    try {
      this.watcher?.close();
    } catch {
      // Already closed
    }
  }
}
