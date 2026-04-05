/**
 * Markdown parser for VaultGraph — extracts frontmatter, wikilinks, embeds,
 * headings, tags, and block IDs from Obsidian Flavored Markdown.
 *
 * Correctly handles suppression zones: code blocks, inline code, math blocks,
 * and frontmatter values. Comments (%% blocks) are NOT suppressed per Obsidian behavior.
 */

import { parse as parseYaml } from "@std/yaml";
import type {
  BlockRef,
  ExternalLinkRef,
  FileMetadata,
  FootnoteRef,
  HeadingRef,
  LinkRef,
  ListItemRef,
  Loc,
  ParsedLink,
  Position,
  SectionRef,
  SectionType,
  TagRef,
} from "./types.ts";

// ── Regex patterns ─────────────────────────────────────────────────

const WIKILINK_RE = /(!)?\[\[([^\]]+)\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const TAG_RE = /(?<=\s|^)#([a-zA-Z][\w/-]*)/g;
const BLOCK_ID_RE = /\s\^([\w-]+)\s*$/gm;
const EXTERNAL_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const BARE_URL_RE = /(?<!\()(?<!\]\()https?:\/\/[^\s)>\]]+/g;
const FOOTNOTE_DEF_RE = /^\[\^(\w+)\]:/gm;

// ── Suppression zones ──────────────────────────────────────────────

interface SuppressionZone {
  start: number;
  end: number;
}

/**
 * Find all byte ranges that should suppress wikilink/tag/heading extraction.
 * Zones: fenced code blocks, inline code, math blocks, and escaped brackets.
 * Note: Obsidian does NOT suppress links/tags inside %% comment %% blocks —
 * they are indexed in metadataCache even though they render as invisible.
 */
function findSuppressionZones(content: string): SuppressionZone[] {
  const zones: SuppressionZone[] = [];

  // Fenced code blocks: ```...```
  const fencedRe = /^(`{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm;
  for (const m of content.matchAll(fencedRe)) {
    zones.push({ start: m.index!, end: m.index! + m[0].length });
  }

  // Inline code: `...`  (non-greedy, single line)
  const inlineCodeRe = /`([^`\n]+)`/g;
  for (const m of content.matchAll(inlineCodeRe)) {
    zones.push({ start: m.index!, end: m.index! + m[0].length });
  }

  // Note: %% comment %% blocks are NOT suppression zones.
  // Obsidian indexes links/tags inside comments in metadataCache.

  // Block math: $$...$$
  const blockMathRe = /\$\$[\s\S]*?\$\$/g;
  for (const m of content.matchAll(blockMathRe)) {
    zones.push({ start: m.index!, end: m.index! + m[0].length });
  }

  // Inline math: $...$  (non-greedy, no newlines)
  const inlineMathRe = /(?<![\\$])\$(?!\$)([^$\n]+?)\$(?!\$)/g;
  for (const m of content.matchAll(inlineMathRe)) {
    zones.push({ start: m.index!, end: m.index! + m[0].length });
  }

  return zones;
}

/** Check if a byte offset falls inside any suppression zone */
function isSuppressed(offset: number, zones: SuppressionZone[]): boolean {
  for (const z of zones) {
    if (offset >= z.start && offset < z.end) return true;
  }
  return false;
}

// ── Line offset table ──────────────────────────────────────────────

function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function binarySearch(offsets: number[], target: number): number {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function offsetToLoc(lineOffsets: number[], offset: number): Loc {
  const line = binarySearch(lineOffsets, offset);
  return { line, col: offset - lineOffsets[line], offset };
}

function offsetToPosition(
  lineOffsets: number[],
  startOffset: number,
  endOffset: number,
): Position {
  return {
    start: offsetToLoc(lineOffsets, startOffset),
    end: offsetToLoc(lineOffsets, endOffset),
  };
}

// ── Frontmatter extraction ─────────────────────────────────────────

export interface FrontmatterResult {
  frontmatter: Record<string, unknown> | null;
  frontmatterPosition: Position | null;
  body: string;
  bodyOffset: number;
}

export function extractFrontmatter(content: string): FrontmatterResult {
  const match = content.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) {
    return { frontmatter: null, frontmatterPosition: null, body: content, bodyOffset: 0 };
  }

  const yamlStr = match[1];
  let frontmatter: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(yamlStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = normalizeFrontmatter(parsed as Record<string, unknown>);
    }
  } catch {
    frontmatter = null;
  }

  const endOffset = match[0].length;
  const lineOffsets = buildLineOffsets(content);
  const frontmatterPosition = offsetToPosition(lineOffsets, 0, endOffset);

  return {
    frontmatter,
    frontmatterPosition,
    body: content.slice(endOffset),
    bodyOffset: endOffset,
  };
}

/** Normalize YAML parsed values — convert Date objects to ISO strings */
function normalizeFrontmatter(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof Date) {
      // Keep as YYYY-MM-DD string
      const iso = value.toISOString();
      result[key] = iso.includes("T00:00:00") ? iso.split("T")[0] : iso;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Link syntax parsing ────────────────────────────────────────────

export function parseLinkSyntax(raw: string): ParsedLink {
  let s = raw;
  let isEmbed = false;

  if (s.startsWith("!")) {
    isEmbed = true;
    s = s.slice(1);
  }
  if (s.startsWith("[[") && s.endsWith("]]")) {
    s = s.slice(2, -2);
  }

  // Split on pipe for alias: "target|display"
  const pipeIdx = s.indexOf("|");
  let targetAndSubpath: string;
  let displayText: string;

  if (pipeIdx >= 0) {
    targetAndSubpath = s.slice(0, pipeIdx);
    displayText = s.slice(pipeIdx + 1);
  } else {
    targetAndSubpath = s;
    displayText = s;
  }

  // Split on # for subpath
  const hashIdx = targetAndSubpath.indexOf("#");
  let target: string;
  let subpath: string | null;

  if (hashIdx >= 0) {
    target = targetAndSubpath.slice(0, hashIdx);
    subpath = targetAndSubpath.slice(hashIdx);
  } else {
    target = targetAndSubpath;
    subpath = null;
  }

  return {
    isEmbed,
    target: target.trim(),
    subpath,
    displayText: displayText.trim(),
    original: raw,
  };
}

// ── Extract links and embeds ───────────────────────────────────────

export function extractLinks(
  body: string,
  bodyOffset: number,
  suppressionZones: SuppressionZone[],
  lineOffsets: number[],
): { links: LinkRef[]; embeds: LinkRef[] } {
  const links: LinkRef[] = [];
  const embeds: LinkRef[] = [];

  // Also check for escaped brackets
  const escapedPositions = new Set<number>();
  const escapedRe = /\\(\[\[)/g;
  for (const m of body.matchAll(escapedRe)) {
    escapedPositions.add(bodyOffset + m.index! + 1); // position of the [[
  }

  WIKILINK_RE.lastIndex = 0;
  for (const match of body.matchAll(WIKILINK_RE)) {
    const absOffset = bodyOffset + match.index!;

    // Skip if in suppression zone
    if (isSuppressed(absOffset, suppressionZones)) continue;

    // Skip escaped brackets
    const bracketOffset = match[1] ? absOffset + 1 : absOffset; // skip ! for embeds
    if (escapedPositions.has(bracketOffset)) continue;

    const raw = match[0];
    const parsed = parseLinkSyntax(raw);
    const position = offsetToPosition(lineOffsets, absOffset, absOffset + raw.length);

    // Obsidian preserves the link text verbatim (including .md extension if present).
    // Resolution handles extension matching separately.
    const ref: LinkRef = {
      link: parsed.target,
      original: raw,
      displayText: parsed.displayText,
      subpath: parsed.subpath,
      position,
    };

    if (parsed.isEmbed) {
      embeds.push(ref);
    } else {
      links.push(ref);
    }
  }

  return { links, embeds };
}

// ── Extract headings ───────────────────────────────────────────────

export function extractHeadings(
  body: string,
  bodyOffset: number,
  suppressionZones: SuppressionZone[],
  lineOffsets: number[],
): HeadingRef[] {
  const headings: HeadingRef[] = [];

  HEADING_RE.lastIndex = 0;
  for (const match of body.matchAll(HEADING_RE)) {
    const absOffset = bodyOffset + match.index!;
    if (isSuppressed(absOffset, suppressionZones)) continue;

    headings.push({
      heading: match[2].trim(),
      level: match[1].length,
      position: offsetToPosition(
        lineOffsets,
        absOffset,
        absOffset + match[0].length,
      ),
    });
  }

  return headings;
}

// ── Extract inline tags ────────────────────────────────────────────

export function extractTags(
  body: string,
  bodyOffset: number,
  suppressionZones: SuppressionZone[],
  lineOffsets: number[],
): TagRef[] {
  const tags: TagRef[] = [];

  TAG_RE.lastIndex = 0;
  for (const match of body.matchAll(TAG_RE)) {
    const absOffset = bodyOffset + match.index!;
    if (isSuppressed(absOffset, suppressionZones)) continue;

    tags.push({
      tag: `#${match[1]}`,
      position: offsetToPosition(
        lineOffsets,
        absOffset,
        absOffset + match[0].length,
      ),
    });
  }

  return tags;
}

// ── Extract block IDs ──────────────────────────────────────────────

export function extractBlockIds(
  body: string,
  bodyOffset: number,
  suppressionZones: SuppressionZone[],
  lineOffsets: number[],
): BlockRef[] {
  const blockIds: BlockRef[] = [];

  BLOCK_ID_RE.lastIndex = 0;
  for (const match of body.matchAll(BLOCK_ID_RE)) {
    const absOffset = bodyOffset + match.index!;
    if (isSuppressed(absOffset, suppressionZones)) continue;

    blockIds.push({
      id: match[1],
      position: offsetToPosition(
        lineOffsets,
        absOffset,
        absOffset + match[0].length,
      ),
    });
  }

  return blockIds;
}

// ── Extract sections ──────────────────────────────────────────────

export function extractSections(
  body: string,
  bodyOffset: number,
  lineOffsets: number[],
): SectionRef[] {
  const sections: SectionRef[] = [];
  const lines = body.split("\n");
  let i = 0;

  /** Convert body-local line index to absolute offset, then to Position */
  function lineRangeToPosition(startLine: number, endLine: number): Position {
    // Find the absolute offset for this body-local line
    let absStartOffset = bodyOffset;
    for (let l = 0; l < startLine; l++) {
      absStartOffset += lines[l].length + 1; // +1 for \n
    }
    let absEndOffset = bodyOffset;
    for (let l = 0; l <= endLine; l++) {
      absEndOffset += lines[l].length + 1;
    }
    // End offset should point to end of the line (not start of next)
    absEndOffset -= 1;
    return offsetToPosition(lineOffsets, absStartOffset, absEndOffset);
  }

  /** Find end of a contiguous block starting with `>` */
  function findBlockquoteEnd(start: number): number {
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].startsWith(">")) {
      end++;
    }
    return end;
  }

  /** Find end of a list block */
  function findListEnd(start: number): number {
    let end = start;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      // Continue if it's another list item or indented continuation
      if (
        next.match(/^\s*[-*+]\s/) ||
        next.match(/^\s*\d+\.\s/) ||
        (next.match(/^\s+\S/) && !next.match(/^#{1,6}\s/))
      ) {
        end++;
      } else if (next.trim() === "") {
        // Empty line might separate list items — peek ahead
        if (end + 2 < lines.length &&
          (lines[end + 2].match(/^\s*[-*+]\s/) || lines[end + 2].match(/^\s*\d+\.\s/))) {
          end += 2;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    return end;
  }

  /** Find end of a table block */
  function findTableEnd(start: number): number {
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].startsWith("|")) {
      end++;
    }
    return end;
  }

  /** Find end of a paragraph (non-empty lines until blank or structural) */
  function findParagraphEnd(start: number): number {
    let end = start;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (
        next.trim() === "" ||
        next.match(/^#{1,6}\s/) ||
        next.match(/^```/) ||
        next.match(/^>/) ||
        next.match(/^\s*[-*+]\s/) ||
        next.match(/^\s*\d+\.\s/) ||
        next.match(/^\|/) ||
        next.match(/^%%/) ||
        next.match(/^\$\$/) ||
        next.match(/^(---|\*\*\*|___)$/)
      ) {
        break;
      }
      end++;
    }
    return end;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    const codeFenceMatch = line.match(/^(`{3,})/);
    if (codeFenceMatch) {
      const fence = codeFenceMatch[1];
      const codeStart = i;
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        i++;
      }
      sections.push({ type: "code", position: lineRangeToPosition(codeStart, i) });
      i++;
      continue;
    }

    // Heading
    if (line.match(/^#{1,6}\s/)) {
      sections.push({ type: "heading", position: lineRangeToPosition(i, i) });
      i++;
      continue;
    }

    // Math block
    if (line.startsWith("$$")) {
      const mathStart = i;
      if (line.trim() === "$$") {
        // Multi-line math
        i++;
        while (i < lines.length && !lines[i].startsWith("$$")) {
          i++;
        }
      }
      sections.push({ type: "math", position: lineRangeToPosition(mathStart, i) });
      i++;
      continue;
    }

    // Comment block
    if (line.startsWith("%%")) {
      const commentStart = i;
      if (!line.endsWith("%%") || line === "%%") {
        i++;
        while (i < lines.length && !lines[i].endsWith("%%")) {
          i++;
        }
      }
      sections.push({ type: "comment", position: lineRangeToPosition(commentStart, i) });
      i++;
      continue;
    }

    // Callout (> [!type])
    if (line.match(/^>\s*\[!/)) {
      const end = findBlockquoteEnd(i);
      sections.push({ type: "callout", position: lineRangeToPosition(i, end) });
      i = end + 1;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const end = findBlockquoteEnd(i);
      sections.push({ type: "blockquote", position: lineRangeToPosition(i, end) });
      i = end + 1;
      continue;
    }

    // Table
    if (line.startsWith("|")) {
      const end = findTableEnd(i);
      sections.push({ type: "table", position: lineRangeToPosition(i, end) });
      i = end + 1;
      continue;
    }

    // Thematic break
    if (line.match(/^(---|\*\*\*|___)$/)) {
      sections.push({ type: "thematicBreak", position: lineRangeToPosition(i, i) });
      i++;
      continue;
    }

    // List
    if (line.match(/^\s*[-*+]\s/) || line.match(/^\s*\d+\.\s/)) {
      const end = findListEnd(i);
      sections.push({ type: "list", position: lineRangeToPosition(i, end) });
      i = end + 1;
      continue;
    }

    // Paragraph (default)
    const end = findParagraphEnd(i);
    sections.push({ type: "paragraph", position: lineRangeToPosition(i, end) });
    i = end + 1;
  }

  return sections;
}

// ── Extract list items ────────────────────────────────────────────

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s(\[(.)\]\s)?(.*)$/;

export function extractListItems(
  body: string,
  bodyOffset: number,
  lineOffsets: number[],
): ListItemRef[] {
  const items: ListItemRef[] = [];
  const lines = body.split("\n");

  // Stack of { indent, offset } for parent tracking
  const stack: { indent: number; offset: number }[] = [];

  let currentOffset = bodyOffset;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(LIST_ITEM_RE);

    if (match) {
      const indent = match[1].length;
      const taskChar = match[4] ?? null; // " ", "x", etc. or null

      const absOffset = currentOffset;
      const endOffset = currentOffset + line.length;

      // Pop stack entries with >= indent to find parent
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack.length > 0 ? stack[stack.length - 1].offset : -1;

      items.push({
        position: offsetToPosition(lineOffsets, absOffset, endOffset),
        parent,
        task: taskChar,
      });

      stack.push({ indent, offset: absOffset });
    }

    currentOffset += line.length + 1; // +1 for \n
  }

  return items;
}

// ── Canvas file parsing ────────────────────────────────────────────

interface CanvasNode {
  id: string;
  type: "file" | "text" | "link" | "group";
  file?: string;
  text?: string;
  url?: string;
}

interface CanvasFile {
  nodes: CanvasNode[];
  edges: unknown[];
}

/**
 * Parse a .canvas file and extract file references and text node wikilinks.
 * File nodes: strip .md extension to match Obsidian's unresolved link key format.
 * Text node wikilinks: ARE extracted — Obsidian indexes them in metadataCache.
 */
export function parseCanvasFile(content: string, path: string): FileMetadata {
  let canvas: CanvasFile;
  try {
    canvas = JSON.parse(content);
  } catch {
    return emptyMetadata(path);
  }

  const links: LinkRef[] = [];
  const dummyPos: Position = {
    start: { line: 0, col: 0, offset: 0 },
    end: { line: 0, col: 0, offset: 0 },
  };

  for (const node of canvas.nodes ?? []) {
    if (node.type === "file" && node.file) {
      // Obsidian strips .md extension from file node paths in unresolved links
      const linkText = node.file.endsWith(".md") ? node.file.slice(0, -3) : node.file;
      links.push({
        link: linkText,
        original: node.file,
        displayText: node.file,
        subpath: null,
        position: dummyPos,
      });
    }
    // Obsidian extracts wikilinks from canvas text node content
    if (node.type === "text" && node.text) {
      WIKILINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK_RE.exec(node.text)) !== null) {
        const parsed = parseLinkSyntax(m[0]);
        links.push({
          link: parsed.target,
          original: m[0],
          displayText: parsed.displayText,
          subpath: parsed.subpath,
          position: dummyPos,
        });
      }
    }
  }

  return {
    path,
    frontmatter: null,
    frontmatterPosition: null,
    links,
    embeds: [],
    externalLinks: [],
    headings: [],
    sections: [],
    tags: [],
    blockIds: [],
    listItems: [],
    footnotes: [],
  };
}

// ── External link extraction ────────────────────────────────────────

export function extractExternalLinks(
  body: string,
  bodyOffset: number,
  suppressionZones: { start: number; end: number }[],
  lineOffsets: number[],
): ExternalLinkRef[] {
  const results: ExternalLinkRef[] = [];

  // Markdown links [text](url)
  EXTERNAL_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXTERNAL_LINK_RE.exec(body)) !== null) {
    const absOffset = bodyOffset + match.index;
    if (isSuppressed(absOffset, suppressionZones)) continue;
    const url = match[2];
    const displayText = match[1];
    results.push({
      url,
      displayText,
      position: offsetToPosition(lineOffsets, absOffset, absOffset + match[0].length - 1),
    });
  }

  // Bare URLs (not already captured by markdown link syntax)
  BARE_URL_RE.lastIndex = 0;
  while ((match = BARE_URL_RE.exec(body)) !== null) {
    const absOffset = bodyOffset + match.index;
    if (isSuppressed(absOffset, suppressionZones)) continue;
    // Check this URL wasn't already captured as part of a markdown link
    const alreadyCaptured = results.some(
      (r) => absOffset >= r.position.start.offset && absOffset <= r.position.end.offset,
    );
    if (alreadyCaptured) continue;
    results.push({
      url: match[0],
      displayText: match[0],
      position: offsetToPosition(lineOffsets, absOffset, absOffset + match[0].length - 1),
    });
  }

  return results;
}

// ── Footnote extraction ─────────────────────────────────────────────

export function extractFootnotes(
  body: string,
  bodyOffset: number,
  suppressionZones: { start: number; end: number }[],
  lineOffsets: number[],
): FootnoteRef[] {
  const results: FootnoteRef[] = [];

  FOOTNOTE_DEF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FOOTNOTE_DEF_RE.exec(body)) !== null) {
    const absOffset = bodyOffset + match.index;
    if (isSuppressed(absOffset, suppressionZones)) continue;
    results.push({
      id: match[1],
      position: offsetToPosition(lineOffsets, absOffset, absOffset + match[0].length - 1),
    });
  }

  return results;
}

// ── Main parse function ────────────────────────────────────────────

function emptyMetadata(path: string): FileMetadata {
  return {
    path,
    frontmatter: null,
    frontmatterPosition: null,
    links: [],
    embeds: [],
    externalLinks: [],
    headings: [],
    sections: [],
    tags: [],
    blockIds: [],
    listItems: [],
    footnotes: [],
  };
}

/**
 * Parse a markdown file and extract all metadata.
 * Handles suppression zones to avoid extracting links/tags from
 * code blocks, comments, math blocks, etc.
 */
export function parseFile(content: string, path: string): FileMetadata {
  // Canvas files use JSON parsing
  if (path.endsWith(".canvas")) {
    return parseCanvasFile(content, path);
  }

  // Non-markdown files get empty metadata
  if (!path.endsWith(".md")) {
    return emptyMetadata(path);
  }

  const { frontmatter, frontmatterPosition, body, bodyOffset } =
    extractFrontmatter(content);

  // Build line offsets for the full content (for position tracking)
  const lineOffsets = buildLineOffsets(content);

  // Find suppression zones in the full content
  const suppressionZones = findSuppressionZones(content);

  // Also suppress the frontmatter zone itself
  if (frontmatterPosition) {
    suppressionZones.push({
      start: frontmatterPosition.start.offset,
      end: frontmatterPosition.end.offset,
    });
  }

  const { links, embeds } = extractLinks(body, bodyOffset, suppressionZones, lineOffsets);
  const headings = extractHeadings(body, bodyOffset, suppressionZones, lineOffsets);
  const tags = extractTags(body, bodyOffset, suppressionZones, lineOffsets);
  const blockIds = extractBlockIds(body, bodyOffset, suppressionZones, lineOffsets);
  const bodySections = extractSections(body, bodyOffset, lineOffsets);
  const listItems = extractListItems(body, bodyOffset, lineOffsets);
  const allExternalLinks = extractExternalLinks(body, bodyOffset, suppressionZones, lineOffsets);
  const footnotes = extractFootnotes(body, bodyOffset, suppressionZones, lineOffsets);

  // Obsidian puts relative markdown links [text](./file.md) in links[] alongside wikilinks.
  // Separate relative paths from true external links.
  const externalLinks: ExternalLinkRef[] = [];
  for (const ext of allExternalLinks) {
    if (!ext.url.startsWith("http") && !ext.url.startsWith("mailto:") && !ext.url.startsWith("#")) {
      links.push({
        link: ext.url,
        original: `[${ext.displayText}](${ext.url})`,
        displayText: ext.displayText,
        subpath: null,
        position: ext.position,
      });
    } else {
      externalLinks.push(ext);
    }
  }

  // Prepend yaml section for frontmatter (Obsidian includes this in sections)
  const sections: SectionRef[] = [];
  if (frontmatterPosition) {
    sections.push({ type: "yaml", position: frontmatterPosition });
  }
  sections.push(...bodySections);

  return {
    path,
    frontmatter,
    frontmatterPosition,
    links,
    embeds,
    externalLinks,
    headings,
    sections,
    tags,
    blockIds,
    listItems,
    footnotes,
  };
}
