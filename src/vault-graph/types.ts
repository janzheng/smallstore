/**
 * VaultGraph type definitions — Obsidian-compatible vault indexer types.
 */

// ── Position tracking ──────────────────────────────────────────────

export interface Loc {
  line: number;
  col: number;
  offset: number;
}

export interface Position {
  start: Loc;
  end: Loc;
}

// ── Link and embed references ──────────────────────────────────────

export interface LinkRef {
  /** Target file name: "Agent Loop" */
  link: string;
  /** Raw syntax: "[[Agent Loop|display]]" */
  original: string;
  /** Rendered display text */
  displayText: string;
  /** "#heading" or "#^block-id" */
  subpath: string | null;
  position: Position;
}

// ── Document structure ─────────────────────────────────────────────

export interface HeadingRef {
  heading: string;
  level: number;
  position: Position;
}

export type SectionType =
  | "yaml"
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "blockquote"
  | "callout"
  | "thematicBreak"
  | "table"
  | "html"
  | "comment"
  | "math";

export interface SectionRef {
  type: SectionType;
  position: Position;
}

export interface TagRef {
  /** Full tag including #: "#patterns/memory" */
  tag: string;
  position: Position;
}

export interface BlockRef {
  /** Block ID without ^: "important-block" */
  id: string;
  position: Position;
}

export interface ListItemRef {
  position: Position;
  /** Offset of parent list item (-1 for root) */
  parent: number;
  /** null if not a task, " " for unchecked, "x" for done */
  task: string | null;
}

// ── External links ────────────────────────────────────────────────

export interface ExternalLinkRef {
  url: string;
  displayText: string;
  position: Position;
}

// ── Footnotes ─────────────────────────────────────────────────────

export interface FootnoteRef {
  id: string;
  position: Position;
}

// ── Per-file metadata ──────────────────────────────────────────────

export interface FileMetadata {
  path: string;

  // Frontmatter
  frontmatter: Record<string, unknown> | null;
  frontmatterPosition: Position | null;

  // Links and embeds
  links: LinkRef[];
  embeds: LinkRef[];

  // External links (markdown links + bare URLs — no graph edges)
  externalLinks: ExternalLinkRef[];

  // Document structure
  headings: HeadingRef[];
  sections: SectionRef[];

  // Tags
  tags: TagRef[];

  // Block references
  blockIds: BlockRef[];

  // Lists
  listItems: ListItemRef[];

  // Footnotes
  footnotes: FootnoteRef[];
}

// ── File cache entry ───────────────────────────────────────────────

export interface FileCacheEntry {
  mtime: number;
  size: number;
  hash: string;
}

// ── Parsed link ────────────────────────────────────────────────────

export interface ParsedLink {
  isEmbed: boolean;
  target: string;
  subpath: string | null;
  displayText: string;
  original: string;
}

// ── Lookups ────────────────────────────────────────────────────────

export interface Lookups {
  /** Lowercase basename → path (unique names only) */
  uniqueFileLookup: Map<string, string>;
  /** Lowercase alias → path */
  aliasLookup: Map<string, string>;
  /** Lowercase basename → paths[] (ambiguous names) */
  ambiguousFiles: Map<string, string[]>;
  /** All file paths in the vault */
  allFiles: Set<string>;
}

// ── Vault options ──────────────────────────────────────────────────

export interface VaultOptions {
  /** Watch for file changes (default: false) */
  watch?: boolean;
  /** Auto-update wikilinks on rename (default: false) */
  autoUpdateLinks?: boolean;
  /** SQLite cache directory (default: ".vault-graph" inside vault) */
  cacheDir?: string;
  /** Paths to exclude from indexing (glob patterns) */
  exclude?: string[];
}

// ── Search types ───────────────────────────────────────────────────

export interface SearchOptions {
  limit?: number;
  paths?: string[];
}

export interface ContextSearchOptions extends SearchOptions {
  contextWords?: number;
}

export interface SearchResult {
  path: string;
  rank: number;
}

export interface ContextSearchResult extends SearchResult {
  context: string;
  line: number;
}

// ── Health & stats ─────────────────────────────────────────────────

export interface VaultHealth {
  nodeCount: number;
  edgeCount: number;
  density: number;
  orphans: string[];
  deadends: string[];
  unresolvedCount: number;
  hubNodes: { path: string; inLinks: number }[];
}

export interface VaultStats {
  fileCount: number;
  markdownFileCount: number;
  linkCount: number;
  unresolvedLinkCount: number;
  tagCount: number;
  aliasCount: number;
}

// ── Property types ─────────────────────────────────────────────────

export type PropertyType =
  | "text"
  | "multitext"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "tags"
  | "aliases";

export interface PropertyInfo {
  name: string;
  type: PropertyType;
  count: number;
}
