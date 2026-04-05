/**
 * Markdown codec — bidirectional conversion between Note JSON and Obsidian markdown.
 *
 * decodeMarkdown: parses markdown into a Note using VaultGraph's parser
 * encodeMarkdown: serializes a Note back to valid Obsidian markdown
 */

import { stringify as yamlStringify } from "@std/yaml";
import { parseFile, extractFrontmatter, extractSections } from "./parser.ts";
import type { SectionRef } from "./types.ts";
import type { Note, NoteBlock, NoteLinkRef, NoteExternalLink, NoteHeading } from "./note-types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute SHA-256 hex hash of a string. */
export async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compute SHA-256 hex hash of binary data. */
export async function sha256Binary(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract title from a vault-relative path. */
export function pathToTitle(path: string): string {
  const basename = path.split("/").pop() ?? path;
  return basename.replace(/\.\w+$/, "");
}

/** Generate a stable ID from a path. */
export function pathToId(path: string): string {
  return path
    .toLowerCase()
    .replace(/\.\w+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Build line offset table for a string. */
function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

// ── Decode: Markdown → Note ─────────────────────────────────────────

/**
 * Parse an Obsidian markdown string into a Note.
 *
 * Uses VaultGraph's parser for structural extraction, then projects
 * the result into the web-friendly Note format.
 */
export async function decodeMarkdown(
  content: string,
  path: string,
  opts?: { createdAt?: string; modifiedAt?: string },
): Promise<Note> {
  const metadata = parseFile(content, path);
  const { frontmatter, body, bodyOffset } = extractFrontmatter(content);

  // Build body blocks from sections
  const lineOffsets = buildLineOffsets(content);
  const sections = extractSections(body, bodyOffset, lineOffsets);
  const blocks = sectionsToBlocks(content, sections, body, bodyOffset);

  // Flatten links (strip Position objects)
  const links: NoteLinkRef[] = metadata.links.map((l) => ({
    target: l.link,
    display: l.displayText,
    resolved: false, // Resolution requires VaultGraph; set later by routes
  }));

  const embeds: NoteLinkRef[] = metadata.embeds.map((e) => ({
    target: e.link,
    display: e.displayText,
    resolved: false,
  }));

  const externalLinks: NoteExternalLink[] = metadata.externalLinks.map((e) => ({
    url: e.url,
    display: e.displayText,
  }));

  const headings: NoteHeading[] = metadata.headings.map((h) => ({
    text: h.heading,
    level: h.level,
  }));

  const tags = metadata.tags.map((t) => t.tag);
  const blockIds = metadata.blockIds.map((b) => b.id);

  const now = new Date().toISOString();
  const hash = await sha256(content);

  return {
    id: pathToId(path),
    path,
    title: pathToTitle(path),
    properties: frontmatter,
    body: blocks,
    raw: content,
    links,
    embeds,
    externalLinks,
    headings,
    tags,
    blockIds,
    createdAt: opts?.createdAt ?? now,
    modifiedAt: opts?.modifiedAt ?? now,
    hash,
  };
}

/**
 * Convert SectionRef[] to NoteBlock[] by slicing raw content.
 * Blocks store their raw markdown content, preserving wikilinks, tags, etc.
 */
function sectionsToBlocks(
  fullContent: string,
  sections: SectionRef[],
  body: string,
  _bodyOffset: number,
): NoteBlock[] {
  const blocks: NoteBlock[] = [];

  for (const section of sections) {
    // Skip yaml frontmatter sections — handled separately via properties
    if (section.type === "yaml") continue;

    const startOffset = section.position.start.offset;
    const endOffset = section.position.end.offset;
    const raw = fullContent.slice(startOffset, endOffset).trimEnd();

    const block: NoteBlock = {
      type: section.type,
      content: raw,
    };

    // Enrich with type-specific metadata
    if (section.type === "heading") {
      const match = raw.match(/^(#{1,6})\s+(.*)/);
      if (match) {
        block.level = match[1].length;
      }
    }

    if (section.type === "code") {
      const langMatch = raw.match(/^```(\w*)/);
      if (langMatch && langMatch[1]) {
        block.language = langMatch[1];
      }
    }

    if (section.type === "callout") {
      const typeMatch = raw.match(/^>\s*\[!(\w+)\]/);
      if (typeMatch) {
        block.calloutType = typeMatch[1];
      }
    }

    // Check for block ID on last line
    const lastLine = raw.split("\n").pop() ?? "";
    const blockIdMatch = lastLine.match(/\s\^([\w-]+)\s*$/);
    if (blockIdMatch) {
      block.blockId = blockIdMatch[1];
    }

    blocks.push(block);
  }

  return blocks;
}

// ── Encode: Note → Markdown ─────────────────────────────────────────

/**
 * Serialize a Note back to Obsidian-compatible markdown.
 *
 * Strategy:
 * - If note.raw is present and body is empty, return raw (passthrough)
 * - Otherwise, build from frontmatter + body blocks
 */
export function encodeMarkdown(note: Partial<Note> & { path: string }): string {
  // Passthrough: if raw is provided and no structured body, use raw directly
  if (note.raw && (!note.body || note.body.length === 0)) {
    return note.raw;
  }

  const parts: string[] = [];

  // Frontmatter
  if (note.properties && Object.keys(note.properties).length > 0) {
    const yaml = yamlStringify(note.properties, { lineWidth: -1 }).trimEnd();
    parts.push(`---\n${yaml}\n---`);
  }

  // Body blocks
  if (note.body && note.body.length > 0) {
    for (const block of note.body) {
      parts.push(block.content);
    }
  }

  return parts.join("\n\n") + "\n";
}

/**
 * Build raw markdown from a CreateNotePayload-like input.
 * Handles the case where only properties and/or raw text are provided.
 */
export function buildMarkdown(opts: {
  properties?: Record<string, unknown>;
  body?: NoteBlock[];
  raw?: string;
}): string {
  // Raw takes precedence
  if (opts.raw) return opts.raw;

  return encodeMarkdown({
    path: "",
    properties: opts.properties ?? null,
    body: opts.body,
  });
}

/**
 * Apply a patch to existing raw markdown.
 * Supports: property merge, append, prepend.
 */
export function patchMarkdown(
  existing: string,
  patch: { properties?: Record<string, unknown>; append?: string; prepend?: string },
): string {
  let result = existing;

  // Merge properties into frontmatter
  if (patch.properties) {
    const { frontmatter, body } = extractFrontmatter(result);
    const merged = { ...(frontmatter ?? {}), ...patch.properties };
    const yaml = yamlStringify(merged, { lineWidth: -1 }).trimEnd();
    result = `---\n${yaml}\n---\n\n${body}`;
  }

  // Append to end
  if (patch.append) {
    result = result.trimEnd() + "\n\n" + patch.append + "\n";
  }

  // Prepend after frontmatter
  if (patch.prepend) {
    const { frontmatter, body } = extractFrontmatter(result);
    if (frontmatter) {
      const yaml = yamlStringify(frontmatter, { lineWidth: -1 }).trimEnd();
      result = `---\n${yaml}\n---\n\n${patch.prepend}\n\n${body}`;
    } else {
      result = patch.prepend + "\n\n" + result;
    }
  }

  return result;
}
