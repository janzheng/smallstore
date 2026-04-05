/**
 * Link resolution — resolves wikilink text to file paths,
 * matching Obsidian's behavior.
 */

import type { FileMetadata, Lookups } from "./types.ts";

// ── Helpers ────────────────────────────────────────────────────────

/** Get basename without extension from a path */
export function basenameNoExt(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 ? name.slice(0, lastDot) : name;
}

/** Get directory portion of a path */
function dirname(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.slice(0, lastSlash) : "";
}

// ── Build lookup tables ────────────────────────────────────────────

export function buildLookups(
  files: string[],
  metadataMap: Map<string, FileMetadata>,
): Lookups {
  const uniqueFileLookup = new Map<string, string>();
  const ambiguousFiles = new Map<string, string[]>();
  const aliasLookup = new Map<string, string>();
  const allFiles = new Set(files);

  // Build unique file lookup from basenames
  for (const path of files) {
    const basename = basenameNoExt(path).toLowerCase();
    if (ambiguousFiles.has(basename)) {
      ambiguousFiles.get(basename)!.push(path);
    } else if (uniqueFileLookup.has(basename)) {
      // Move from unique to ambiguous
      ambiguousFiles.set(basename, [uniqueFileLookup.get(basename)!, path]);
      uniqueFileLookup.delete(basename);
    } else {
      uniqueFileLookup.set(basename, path);
    }
  }

  // Build alias lookup from frontmatter
  for (const [path, meta] of metadataMap) {
    const aliases = meta.frontmatter?.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.trim()) {
          aliasLookup.set(alias.toLowerCase().trim(), path);
        }
      }
    }
  }

  return { uniqueFileLookup, aliasLookup, ambiguousFiles, allFiles };
}

// ── Resolve a single link ──────────────────────────────────────────

export interface ResolvedLink {
  path: string;
  subpath: string | null;
}

/**
 * Resolve a wikilink target to a file path.
 *
 * Resolution strategies (in order):
 * 1. Exact basename match in uniqueFileLookup
 * 2. Extension-qualified match (strip .md and retry)
 * 3. Alias match
 * 4. Folder-qualified path match
 * 5. Ambiguous basename — shortest path wins (Obsidian behavior)
 * 6. Direct file path match (for non-.md files like images)
 */
export function resolveLink(
  target: string,
  subpath: string | null,
  sourcePath: string,
  lookups: Lookups,
): ResolvedLink | null {
  if (!target) {
    // Self-referential: [[#heading]] — resolve to source file
    if (subpath) {
      return { path: sourcePath, subpath };
    }
    return null;
  }

  const normalized = target.toLowerCase().trim();

  // Strategy a: Exact basename match (unique names only)
  let resolvedPath = lookups.uniqueFileLookup.get(normalized);

  // Strategy b: Extension-qualified match — [[File.md]]
  if (!resolvedPath) {
    const withoutExt = normalized.replace(/\.\w+$/, "");
    if (withoutExt !== normalized) {
      resolvedPath = lookups.uniqueFileLookup.get(withoutExt);
    }
  }

  // Strategy c: Alias match
  if (!resolvedPath) {
    resolvedPath = lookups.aliasLookup.get(normalized);
  }

  // Strategy d: Folder-qualified path match
  if (!resolvedPath && normalized.includes("/")) {
    for (const path of lookups.allFiles) {
      const pathLower = path.toLowerCase();
      const pathNoExt = pathLower.replace(/\.\w+$/, "");
      if (pathNoExt === normalized || pathLower === normalized) {
        resolvedPath = path;
        break;
      }
    }
  }

  // Strategy e: Ambiguous basename — shortest path wins
  if (!resolvedPath) {
    const ambKey = normalized.replace(/\.\w+$/, "") || normalized;
    if (lookups.ambiguousFiles.has(ambKey)) {
      const candidates = lookups.ambiguousFiles.get(ambKey)!;
      resolvedPath = resolveAmbiguous(candidates, sourcePath);
    }
  }

  // Strategy f: Direct file path match (for images, non-.md files)
  if (!resolvedPath) {
    if (lookups.allFiles.has(target)) {
      resolvedPath = target;
    }
    if (!resolvedPath) {
      for (const path of lookups.allFiles) {
        if (path.toLowerCase() === normalized || path.toLowerCase() === normalized + ".md") {
          resolvedPath = path;
          break;
        }
      }
    }
  }

  if (!resolvedPath) return null;

  return { path: resolvedPath, subpath };
}

/** Resolve ambiguous basename — shortest path wins (matches Obsidian behavior) */
function resolveAmbiguous(candidates: string[], _sourcePath: string): string {
  // Obsidian always resolves to the shortest path, then alphabetical.
  // No same-folder preference with newLinkFormat: "shortest".
  const sorted = [...candidates].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  return sorted[0];
}

// ── Resolve all links in a vault ───────────────────────────────────

export interface ResolvedLinksResult {
  /** source.md → { target.md: count } */
  resolved: Map<string, Map<string, number>>;
  /** source.md → { "target name": count } */
  unresolved: Map<string, Map<string, number>>;
}

/**
 * Resolve all links and embeds across all files, producing
 * the full resolved/unresolved link maps.
 */
export function resolveAllLinks(
  metadataMap: Map<string, FileMetadata>,
  lookups: Lookups,
): ResolvedLinksResult {
  const resolved = new Map<string, Map<string, number>>();
  const unresolved = new Map<string, Map<string, number>>();

  for (const [sourcePath, meta] of metadataMap) {
    const sourceResolved = new Map<string, number>();
    const sourceUnresolved = new Map<string, number>();

    // Process both links and embeds
    const allRefs = [...meta.links, ...meta.embeds];

    for (const ref of allRefs) {
      const result = resolveLink(ref.link, ref.subpath, sourcePath, lookups);

      if (result) {
        const count = sourceResolved.get(result.path) ?? 0;
        sourceResolved.set(result.path, count + 1);
      } else {
        // Obsidian strips .md extension from unresolved link keys
        let linkName = ref.link.toLowerCase().trim();
        if (linkName.endsWith(".md")) linkName = linkName.slice(0, -3);
        if (linkName) {
          const count = sourceUnresolved.get(linkName) ?? 0;
          sourceUnresolved.set(linkName, count + 1);
        }
      }
    }

    if (sourceResolved.size > 0) {
      resolved.set(sourcePath, sourceResolved);
    }
    if (sourceUnresolved.size > 0) {
      unresolved.set(sourcePath, sourceUnresolved);
    }
  }

  return { resolved, unresolved };
}
