/**
 * VaultGraph Content API types — web-friendly projections of vault data.
 *
 * Note is the canonical JSON representation of an Obsidian-compatible note,
 * designed for web clients and API consumers. It strips positional data from
 * the internal FileMetadata type and adds timestamps + content hash for sync.
 */

// ── Note types ──────────────────────────────────────────────────────

/** A single note in the vault, serializable to/from Obsidian markdown. */
export interface Note {
  /** Stable identifier (path-derived slug or UUID) */
  id: string;
  /** Vault-relative path: "folder/My Note.md" */
  path: string;
  /** Title derived from filename (basename without extension) */
  title: string;

  /** Frontmatter properties */
  properties: Record<string, unknown> | null;
  /** Structured body content blocks */
  body: NoteBlock[];
  /** Raw markdown source (authoritative for pass-through editing) */
  raw: string;

  /** Outgoing wikilinks (position-free) */
  links: NoteLinkRef[];
  /** Embedded content references */
  embeds: NoteLinkRef[];
  /** External links (http, mailto, etc.) */
  externalLinks: NoteExternalLink[];

  /** Document headings */
  headings: NoteHeading[];
  /** Flattened inline tags: ["#memory", "#patterns/composition"] */
  tags: string[];
  /** Block IDs without ^: ["important-block"] */
  blockIds: string[];

  /** ISO 8601 timestamps */
  createdAt: string;
  modifiedAt: string;
  /** SHA-256 hex of raw content, for sync diffing */
  hash: string;
}

/** Structured content block — stores raw markdown, not a parsed AST. */
export interface NoteBlock {
  type:
    | "heading"
    | "paragraph"
    | "list"
    | "code"
    | "blockquote"
    | "callout"
    | "table"
    | "math"
    | "thematicBreak"
    | "html"
    | "comment";
  /** Raw markdown content of this block */
  content: string;
  /** Heading level (1-6), only for type="heading" */
  level?: number;
  /** Code block language, only for type="code" */
  language?: string;
  /** Callout type (note, warning, etc.), only for type="callout" */
  calloutType?: string;
  /** Block ID if present (^block-id) */
  blockId?: string;
}

/** Position-free link reference for API consumers. */
export interface NoteLinkRef {
  /** Link target (resolved path or raw link text) */
  target: string;
  /** Display text */
  display: string;
  /** Whether this link resolves to a known vault file */
  resolved: boolean;
}

export interface NoteExternalLink {
  url: string;
  display: string;
}

export interface NoteHeading {
  text: string;
  level: number;
}

// ── Note summary (for list endpoints) ───────────────────────────────

/** Lightweight note representation for list/search results. */
export interface NoteSummary {
  id: string;
  path: string;
  title: string;
  properties: Record<string, unknown> | null;
  tags: string[];
  modifiedAt: string;
  hash: string;
}

// ── Write payloads ──────────────────────────────────────────────────

/** Request body for creating a new note. */
export interface CreateNotePayload {
  /** Vault-relative path (required) */
  path: string;
  /** Frontmatter properties */
  properties?: Record<string, unknown>;
  /** Structured body blocks (alternative to raw) */
  body?: NoteBlock[];
  /** Raw markdown (takes precedence over properties+body if both provided) */
  raw?: string;
}

/** Request body for updating an existing note. */
export interface UpdateNotePayload {
  /** Frontmatter properties (replaces existing) */
  properties?: Record<string, unknown>;
  /** Structured body blocks (replaces existing) */
  body?: NoteBlock[];
  /** Raw markdown (replaces everything) */
  raw?: string;
}

/** Request body for patching a note (partial update). */
export interface PatchNotePayload {
  /** Merge into existing frontmatter properties */
  properties?: Record<string, unknown>;
  /** Append raw markdown to end of note */
  append?: string;
  /** Prepend raw markdown after frontmatter */
  prepend?: string;
}

/** Request body for moving/renaming a note. */
export interface MoveNotePayload {
  newPath: string;
}
