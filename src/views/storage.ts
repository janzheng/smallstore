/**
 * View Storage
 * 
 * Persistence layer for view definitions.
 * Views are stored in metadata adapter with special prefix.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { ViewDefinition } from '../types.ts';

// ============================================================================
// View Key Building
// ============================================================================

/**
 * Build storage key for a view
 * 
 * Format: "smallstore:view:<name>" for global views
 * Format: "smallstore:view:<namespace>:<name>" for namespace-scoped views
 * 
 * @param name - View name (may include namespace, e.g., "favorites/hn-bookmarks.view")
 * @returns Storage key
 */
export function buildViewKey(name: string): string {
  // Normalize: remove .view suffix if present (we'll check it elsewhere)
  const normalized = name.endsWith('.view') ? name : `${name}.view`;
  return `smallstore:view:${normalized}`;
}

/**
 * Check if a key is a view key
 * 
 * @param key - Storage key
 * @returns true if view key
 */
export function isViewKey(key: string): boolean {
  return key.startsWith('smallstore:view:');
}

/**
 * Extract view name from view key
 * 
 * @param key - View storage key
 * @returns View name, or null if invalid
 */
export function getViewNameFromKey(key: string): string | null {
  if (!isViewKey(key)) {
    return null;
  }
  
  // "smallstore:view:<name>" → <name>
  const parts = key.split(':');
  return parts.slice(2).join(':'); // Handle names with colons
}

// ============================================================================
// View Persistence
// ============================================================================

/**
 * Save view definition to storage
 * 
 * @param adapter - Storage adapter (usually metadata adapter)
 * @param viewDef - View definition
 */
export async function saveView(
  adapter: StorageAdapter,
  viewDef: ViewDefinition
): Promise<void> {
  const key = buildViewKey(viewDef.name);
  
  // Add timestamps
  const now = new Date().toISOString();
  const definition: ViewDefinition = {
    ...viewDef,
    updated: now,
    created: viewDef.created || now,
  };
  
  await adapter.set(key, definition);
}

/**
 * Load view definition from storage
 * 
 * @param adapter - Storage adapter
 * @param name - View name
 * @returns View definition, or null if not found
 */
export async function loadView(
  adapter: StorageAdapter,
  name: string
): Promise<ViewDefinition | null> {
  const key = buildViewKey(name);
  const definition = await adapter.get(key);
  
  if (!definition) {
    return null;
  }
  
  return definition as ViewDefinition;
}

/**
 * Delete view from storage
 * 
 * @param adapter - Storage adapter
 * @param name - View name
 */
export async function deleteView(
  adapter: StorageAdapter,
  name: string
): Promise<void> {
  const key = buildViewKey(name);
  await adapter.delete(key);
}

/**
 * List all views (optionally filtered by namespace)
 * 
 * @param adapter - Storage adapter
 * @param namespace - Optional namespace filter
 * @returns Array of view names
 */
export async function listViews(
  adapter: StorageAdapter,
  namespace?: string
): Promise<string[]> {
  // Get all keys with view prefix
  const keys = await adapter.keys('smallstore:view:');
  
  // Extract view names
  const viewNames = keys
    .filter(key => isViewKey(key))
    .map(key => getViewNameFromKey(key))
    .filter((name): name is string => name !== null);
  
  // Filter by namespace if specified
  if (namespace) {
    const normalizedNs = namespace.endsWith('/') ? namespace : `${namespace}/`;
    return viewNames.filter(name => name.startsWith(normalizedNs));
  }
  
  return viewNames;
}

