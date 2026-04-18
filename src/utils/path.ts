/**
 * Path Utilities
 * 
 * Folder-like path handling for Smallstore:
 * - "collection" → { collection: "collection", path: [] }
 * - "collection/folder/item" → { collection: "collection", path: ["folder", "item"] }
 * - Build storage keys from paths
 * - Join paths safely
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed collection path
 */
export interface ParsedPath {
  /** Collection name (first segment) */
  collection: string;
  
  /** Sub-path segments (everything after collection) */
  path: string[];
  
  /** Full path (collection + path joined) */
  fullPath: string;
}

// ============================================================================
// Path Parsing
// ============================================================================

/**
 * Parse a collection path into collection name and sub-paths
 * 
 * @param collectionPath - Path like "collection/folder/item"
 * @returns Parsed path with collection and sub-paths
 * 
 * @example
 * parsePath("api-cache");
 * // → { collection: "api-cache", path: [], fullPath: "api-cache" }
 * 
 * parsePath("research/papers/2024");
 * // → { collection: "research", path: ["papers", "2024"], fullPath: "research/papers/2024" }
 * 
 * parsePath("podcast-research-2024/episodes/ep1");
 * // → { collection: "podcast-research-2024", path: ["episodes", "ep1"], fullPath: "..." }
 */
export function parsePath(collectionPath: string): ParsedPath {
  // Handle empty/invalid paths
  if (!collectionPath || typeof collectionPath !== 'string') {
    throw new Error(`Invalid collection path: ${collectionPath}`);
  }
  
  // Normalize: trim, remove leading/trailing slashes
  const normalized = collectionPath.trim().replace(/^\/+|\/+$/g, '');
  
  if (!normalized) {
    throw new Error('Collection path cannot be empty');
  }
  
  // Split by slash
  const segments = normalized.split('/').filter((s) => s.length > 0);
  
  if (segments.length === 0) {
    throw new Error('Collection path must have at least one segment');
  }
  
  // First segment is collection, rest is path
  const [collection, ...path] = segments;
  
  return {
    collection,
    path,
    fullPath: normalized,
  };
}

// ============================================================================
// Key Building
// ============================================================================

/**
 * Build storage key from parsed path
 * 
 * Format: "smallstore:<collection>:<path1>:<path2>:..."
 * 
 * This ensures:
 * - Namespacing (all smallstore keys prefixed)
 * - Collision prevention (collection is always first)
 * - Hierarchical structure (colon-separated for backend adapters)
 * 
 * @param parsed - Parsed path
 * @param prefix - Optional additional prefix (default: "smallstore")
 * @returns Storage key
 * 
 * @example
 * buildKey({ collection: "api-cache", path: [], fullPath: "api-cache" });
 * // → "smallstore:api-cache"
 * 
 * buildKey({ collection: "research", path: ["papers", "2024"], fullPath: "..." });
 * // → "smallstore:research:papers:2024"
 * 
 * buildKey({ collection: "favorites", path: ["bookmarks"], fullPath: "..." }, "meta");
 * // → "meta:favorites:bookmarks"
 */
export function buildKey(parsed: ParsedPath, prefix = 'smallstore'): string {
  const segments = [prefix, parsed.collection, ...parsed.path];
  return segments.join(':');
}

// ============================================================================
// Path Joining
// ============================================================================

/**
 * Join path segments safely
 * 
 * Handles:
 * - Empty segments (ignored)
 * - Leading/trailing slashes (normalized)
 * - Multiple slashes (collapsed)
 * 
 * @param segments - Path segments to join
 * @returns Joined path
 * 
 * @example
 * joinPath("collection", "folder", "item");
 * // → "collection/folder/item"
 * 
 * joinPath("collection/", "/folder", "item");
 * // → "collection/folder/item"
 * 
 * joinPath("collection", "", "item");
 * // → "collection/item"
 */
export function joinPath(...segments: string[]): string {
  return segments
    .filter((s) => s && s.length > 0)
    .map((s) => s.replace(/^\/+|\/+$/g, '')) // Remove leading/trailing slashes
    .filter((s) => s.length > 0)
    .join('/');
}

// ============================================================================
// Metadata Key Building
// ============================================================================

/**
 * Build metadata key for collection schema tracking
 * 
 * Smallstore tracks metadata (schema, size, count) separately from data.
 * Metadata keys use "smallstore:meta:" prefix.
 * 
 * @param collection - Collection name
 * @returns Metadata key
 * 
 * @example
 * buildMetadataKey("api-cache");
 * // → "smallstore:meta:api-cache"
 */
export function buildMetadataKey(collection: string): string {
  return `smallstore:meta:${collection}`;
}

/**
 * Check if a key is a metadata key
 *
 * @param key - Storage key to check
 * @returns true if metadata key
 */
export function isMetadataKey(key: string): boolean {
  return key.startsWith('smallstore:meta:');
}

/**
 * Check if a key is a smallstore-internal key (metadata, key-index, views,
 * view data, or cache). Search providers should skip these at both index
 * and search time to avoid leaking internals into user-facing results.
 */
export function isInternalKey(key: string): boolean {
  return (
    key.startsWith('smallstore:meta:') ||
    key.startsWith('smallstore:index:') ||
    key.startsWith('smallstore:view:') ||
    key.startsWith('smallstore:_views:') ||
    key.startsWith('smallstore:_viewdata:') ||
    key.startsWith('_cache/')
  );
}

/**
 * Extract collection name from metadata key
 * 
 * @param metadataKey - Metadata key
 * @returns Collection name, or null if invalid
 * 
 * @example
 * getCollectionFromMetadataKey("smallstore:meta:api-cache");
 * // → "api-cache"
 */
export function getCollectionFromMetadataKey(metadataKey: string): string | null {
  if (!isMetadataKey(metadataKey)) {
    return null;
  }
  
  const parts = metadataKey.split(':');
  return parts[2] || null; // "smallstore:meta:<collection>"
}

// ============================================================================
// Phase 3: Key Index Building
// ============================================================================

/**
 * Build key index storage key for a collection
 * 
 * Key indexes track which adapter stores each key for multi-adapter setups.
 * Index keys use "smallstore:index:" prefix.
 * 
 * @param collection - Collection name
 * @returns Key index storage key
 * 
 * @example
 * buildIndexKey("research");
 * // → "smallstore:index:research"
 */
export function buildIndexKey(collection: string): string {
  return `smallstore:index:${collection}`;
}

/**
 * Check if a key is an index key
 * 
 * @param key - Storage key to check
 * @returns true if index key
 */
export function isIndexKey(key: string): boolean {
  return key.startsWith('smallstore:index:');
}

/**
 * Extract collection name from index key
 * 
 * @param indexKey - Index key
 * @returns Collection name, or null if invalid
 * 
 * @example
 * getCollectionFromIndexKey("smallstore:index:research");
 * // → "research"
 */
export function getCollectionFromIndexKey(indexKey: string): string | null {
  if (!isIndexKey(indexKey)) {
    return null;
  }
  
  const parts = indexKey.split(':');
  return parts[2] || null; // "smallstore:index:<collection>"
}

// ============================================================================
// Phase 2.5: View & Namespace Utilities
// ============================================================================

/**
 * Check if a path is a view path (ends with .view)
 * 
 * @param path - Path to check
 * @returns true if view path
 * 
 * @example
 * isViewPath("hn-bookmarks.view"); // → true
 * isViewPath("favorites/recent.view"); // → true
 * isViewPath("favorites/bookmarks"); // → false
 */
export function isViewPath(path: string): boolean {
  return path.endsWith('.view');
}

/**
 * Strip .view suffix from path
 * 
 * @param path - Path with .view suffix
 * @returns Path without .view suffix
 * 
 * @example
 * stripViewSuffix("hn-bookmarks.view"); // → "hn-bookmarks"
 * stripViewSuffix("favorites/recent.view"); // → "favorites/recent"
 */
export function stripViewSuffix(path: string): string {
  return path.endsWith('.view') ? path.slice(0, -5) : path;
}

/**
 * Extract namespace from path
 * 
 * For paths with slashes, return everything except the last segment.
 * For single-segment paths, return empty string (global namespace).
 * 
 * @param path - Path to extract namespace from
 * @returns Namespace, or empty string if global
 * 
 * @example
 * getNamespace("favorites/bookmarks"); // → "favorites"
 * getNamespace("work/projects/2024"); // → "work/projects"
 * getNamespace("global-collection"); // → ""
 */
export function getNamespace(path: string): string {
  const segments = path.split('/');
  if (segments.length <= 1) {
    return '';
  }
  return segments.slice(0, -1).join('/');
}

/**
 * Get all paths under a namespace
 * 
 * Filters a list of keys to only include those under the given namespace.
 * 
 * @param keys - Array of storage keys
 * @param namespace - Namespace to filter by
 * @returns Filtered keys
 * 
 * @example
 * getAllPathsUnder(
 *   ["smallstore:favorites:bookmarks", "smallstore:work:notes"],
 *   "favorites"
 * );
 * // → ["smallstore:favorites:bookmarks"]
 */
export function getAllPathsUnder(keys: string[], namespace: string): string[] {
  const prefix = `smallstore:${namespace}`;
  return keys.filter(key => key.startsWith(prefix) && !isMetadataKey(key));
}

/**
 * Extract path from storage key
 * 
 * Converts storage key back to collection path.
 * 
 * @param key - Storage key
 * @returns Collection path, or null if not a valid key
 * 
 * @example
 * getPathFromKey("smallstore:favorites:bookmarks");
 * // → "favorites/bookmarks"
 * 
 * getPathFromKey("smallstore:api-cache");
 * // → "api-cache"
 */
export function getPathFromKey(key: string): string | null {
  if (!key.startsWith('smallstore:')) {
    return null;
  }
  
  const parts = key.split(':');
  // Skip "smallstore" prefix
  const pathParts = parts.slice(1);
  return pathParts.join('/');
}

/**
 * Check if a key belongs to a namespace
 * 
 * @param key - Storage key
 * @param namespace - Namespace to check
 * @returns true if key is under namespace
 */
export function isUnderNamespace(key: string, namespace: string): boolean {
  const path = getPathFromKey(key);
  if (!path) {
    return false;
  }
  
  return path.startsWith(namespace);
}

