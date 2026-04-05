/**
 * Key Index Storage
 * 
 * Persistence layer for key indexes (Phase 3).
 * Key indexes track which adapter stores each key for multi-adapter setups.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { KeyIndex, KeyLocation } from '../types.ts';
import { buildIndexKey } from '../utils/path.ts';
import { debug } from '../utils/debug.ts';

// ============================================================================
// Key Index Persistence
// ============================================================================

/**
 * Save key index to storage
 * 
 * @param adapter - Storage adapter (usually metadata adapter)
 * @param index - Key index to save
 */
export async function saveIndex(
  adapter: StorageAdapter,
  index: KeyIndex
): Promise<void> {
  const key = buildIndexKey(index.collection);
  
  // Update timestamps
  const now = new Date().toISOString();
  const updatedIndex: KeyIndex = {
    ...index,
    metadata: {
      ...index.metadata,
      updated: now,
      created: index.metadata.created || now,
      keyCount: Object.keys(index.keys).length,
    },
  };
  
  await adapter.set(key, updatedIndex);
}

/**
 * Load key index from storage
 * 
 * @param adapter - Storage adapter
 * @param collection - Collection name
 * @returns Key index, or null if not found
 */
export async function loadIndex(
  adapter: StorageAdapter,
  collection: string
): Promise<KeyIndex | null> {
  const key = buildIndexKey(collection);
  debug(`[KeyIndex] loadIndex: loading index for collection "${collection}", key: "${key}"`);
  
  const index = await adapter.get(key);
  
  debug(`[KeyIndex] loadIndex: raw index loaded:`, index ? JSON.stringify(index).substring(0, 200) : 'null');
  
  if (!index) {
    debug(`[KeyIndex] loadIndex: no index found, returning null`);
    return null;
  }
  
  debug(`[KeyIndex] loadIndex: validating structure, index.keys type:`, typeof index.keys);
  debug(`[KeyIndex] loadIndex: index.keys value:`, index.keys);
  
  // Defensive: Ensure the index has the required structure
  // (handle corrupted/old indexes that might be missing properties)
  const validIndex: KeyIndex = {
    collection: index.collection || collection,
    keys: index.keys || {},
    metadata: index.metadata || {
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      keyCount: 0,
    },
  };
  
  debug(`[KeyIndex] loadIndex: returning validated index with ${Object.keys(validIndex.keys).length} keys`);
  
  return validIndex;
}

/**
 * Delete key index from storage
 * 
 * @param adapter - Storage adapter
 * @param collection - Collection name
 */
export async function deleteIndex(
  adapter: StorageAdapter,
  collection: string
): Promise<void> {
  const key = buildIndexKey(collection);
  await adapter.delete(key);
}

// ============================================================================
// Key Index Mutations
// ============================================================================

/**
 * Add or update a key in the index
 * 
 * @param index - Key index to mutate
 * @param location - Key location to add/update
 * @returns Updated index
 */
export function addKeyToIndex(
  index: KeyIndex,
  location: KeyLocation
): KeyIndex {
  const now = new Date().toISOString();
  
  // Defensive: Ensure keys object exists (handle corrupted/old indexes)
  const existingKeys = index.keys || {};
  
  return {
    ...index,
    keys: {
      ...existingKeys,
      [location.key]: {
        ...location,
        updated: now,
        created: existingKeys[location.key]?.created || now,
      },
    },
    metadata: {
      ...index.metadata,
      updated: now,
    },
  };
}

/**
 * Remove a key from the index
 * 
 * @param index - Key index to mutate
 * @param key - Storage key to remove
 * @returns Updated index
 */
export function removeKeyFromIndex(
  index: KeyIndex,
  key: string
): KeyIndex {
  // Defensive: Ensure keys object exists (handle corrupted/old indexes)
  const existingKeys = index.keys || {};
  const { [key]: removed, ...remainingKeys } = existingKeys;
  
  return {
    ...index,
    keys: remainingKeys,
    metadata: {
      ...index.metadata,
      updated: new Date().toISOString(),
      keyCount: Object.keys(remainingKeys).length,
    },
  };
}

/**
 * Get key location from index
 * 
 * @param index - Key index
 * @param key - Storage key
 * @returns Key location, or null if not found
 */
export function getKeyLocation(
  index: KeyIndex,
  key: string
): KeyLocation | null {
  // Defensive: Ensure keys object exists (handle corrupted/old indexes)
  return index.keys?.[key] || null;
}

/**
 * Create empty key index for a collection
 * 
 * @param collection - Collection name
 * @returns Empty key index
 */
export function createEmptyIndex(collection: string): KeyIndex {
  return {
    collection,
    keys: {},
    metadata: {
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      keyCount: 0,
    },
  };
}

