/**
 * Storage abstraction — uniform interface for vault file access.
 *
 * Implementations:
 * - FileSystemStorage: reads/writes a vault directory on disk
 */

/** File metadata for sync and caching. */
export interface FileStat {
  /** File size in bytes */
  size: number;
  /** Last modified time (unix ms) */
  mtime: number;
  /** Content hash (if available) */
  hash?: string;
}

/** Uniform note storage interface. */
export interface NoteStorage {
  /** List all file paths, optionally filtered by folder or extension. */
  list(opts?: { folder?: string; ext?: string }): Promise<string[]>;

  /** Read a file's raw text content. Returns null if not found. */
  read(path: string): Promise<string | null>;

  /** Write raw text content to a file. Creates parent directories as needed. */
  write(path: string, content: string): Promise<void>;

  /** Read a file's binary content. Returns null if not found. */
  readBinary(path: string): Promise<Uint8Array | null>;

  /** Write binary content to a file. Creates parent directories as needed. */
  writeBinary(path: string, content: Uint8Array): Promise<void>;

  /** Delete a file. */
  delete(path: string): Promise<void>;

  /** Check if a file exists. */
  exists(path: string): Promise<boolean>;

  /** Get file metadata (size, mtime). Returns null if not found. */
  stat(path: string): Promise<FileStat | null>;

  /** Move/rename a file. */
  move(oldPath: string, newPath: string): Promise<void>;

  /** List subdirectories under a parent path. */
  listFolders(parent?: string): Promise<string[]>;
}

/** Known binary file extensions in Obsidian vaults. */
export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp",
  ".mp3", ".webm", ".wav", ".m4a", ".ogg", ".3gp", ".flac",
  ".mp4", ".ogv", ".mov", ".mkv",
  ".pdf",
  ".canvas",
]);

/** Check if a path is a binary file based on extension. */
export function isBinaryPath(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}
