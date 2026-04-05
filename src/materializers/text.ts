/**
 * Text Materializer
 * 
 * Phase 3.2: Content negotiation - materialize collections as plain text
 * 
 * Returns collections as simple key:value text format.
 * Good for quick viewing and grep-able output.
 */

import type { Smallstore } from '../types.ts';
import { parsePath } from '../utils/path.ts';
import { formatSize } from '../detector.ts';

// ============================================================================
// Text Materialization
// ============================================================================

/**
 * Materialize collection as plain text
 * 
 * Converts collection items to simple key:value format.
 * 
 * Use cases:
 * - Quick viewing in terminal
 * - Grep-able output
 * - Log-like representation
 * - Simple exports
 * 
 * @param storage - Smallstore instance
 * @param collectionPath - Collection to materialize
 * @returns Plain text string
 * 
 * @example
 * const text = await materializeText(storage, "settings");
 * // → settings
 * //   Items: 3
 * //   Total Size: 128 bytes
 * //
 * //   theme: "dark"
 * //   language: "en"
 * //   notifications: true
 */
export async function materializeText(
  storage: Smallstore,
  collectionPath: string
): Promise<string> {
  const parsed = parsePath(collectionPath);
  
  // Get all keys in collection
  const keys = await storage.keys(collectionPath);
  
  if (keys.length === 0) {
    return `${collectionPath}\nNo items`;
  }
  
  // Track stats
  let totalSizeBytes = 0;
  
  // Start text
  const lines: string[] = [];
  lines.push(collectionPath);
  
  // Load all items
  const itemLines: string[] = [];
  
  for (const key of keys) {
    try {
      const response = await storage.get(`${collectionPath}/${key}`);
      if (!response) continue;
      
      const data = response.content;
      const size = response.reference.size;
      
      totalSizeBytes += size;
      
      // Format item
      let valueStr: string;
      if (response.dataType === 'object') {
        valueStr = JSON.stringify(data);
      } else if (response.dataType === 'blob') {
        valueStr = `[Binary: ${formatSize(size)}]`;
      } else {
        valueStr = String(data);
      }
      
      itemLines.push(`  ${key}: ${valueStr}`);
    } catch (err) {
      console.warn(`[materializeText] Failed to load key "${key}":`, err);
      itemLines.push(`  ${key}: [Error loading]`);
    }
  }
  
  // Add metadata
  lines.push(`  Items: ${itemLines.length}`);
  lines.push(`  Total Size: ${formatSize(totalSizeBytes)}`);
  lines.push('');
  
  // Add items
  lines.push(...itemLines);
  
  return lines.join('\n');
}

/**
 * Materialize single item as plain text
 * 
 * For single items (not collections), returns the item as simple text.
 * 
 * @param storage - Smallstore instance
 * @param itemPath - Path to single item
 * @returns Plain text string
 * 
 * @example
 * const text = await materializeTextItem(storage, "settings/theme");
 * // → settings/theme: "dark"
 */
export async function materializeTextItem(
  storage: Smallstore,
  itemPath: string
): Promise<string> {
  const response = await storage.get(itemPath);
  if (!response) {
    return `${itemPath}: [Not found]`;
  }
  
  let valueStr: string;
  if (response.dataType === 'object') {
    valueStr = JSON.stringify(response.content, null, 2);
  } else if (response.dataType === 'blob') {
    valueStr = `[Binary: ${formatSize(response.reference.size)}]`;
  } else {
    valueStr = String(response.content);
  }
  
  return `${itemPath}: ${valueStr}`;
}

