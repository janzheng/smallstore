/**
 * VaultGraph module — headless Obsidian vault indexer for smallstore.
 *
 * Provides markdown parsing, wikilink resolution, SQLite persistence,
 * full-text search, and bidirectional markdown <-> JSON conversion.
 */

// Core vault engine
export { VaultGraph } from './vault.ts';

// SQLite persistence
export { SqliteStore } from './store.ts';

// Markdown parser
export { parseFile, extractFrontmatter, extractSections, parseLinkSyntax } from './parser.ts';

// Wikilink resolver
export { buildLookups, resolveLink, resolveAllLinks, basenameNoExt } from './resolver.ts';

// Bidirectional codec (markdown <-> JSON)
export {
  decodeMarkdown,
  encodeMarkdown,
  buildMarkdown,
  patchMarkdown,
  sha256,
  sha256Binary,
  pathToTitle,
  pathToId,
} from './codec.ts';

// File system storage
export { FileSystemStorage } from './fs-storage.ts';

// File watcher
export { VaultWatcher } from './watcher.ts';

// Types
export type * from './types.ts';
export type * from './note-types.ts';
export type * from './storage-types.ts';

// NoteStorage interface (re-export as value for runtime use)
export { isBinaryPath, BINARY_EXTENSIONS } from './storage-types.ts';

// Sync protocol
export * from './sync/mod.ts';
