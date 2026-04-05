/**
 * Namespace Operations
 * 
 * Bulk operations on namespaces (copy, move, getNamespace).
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { NamespaceOptions, CopyOptions } from '../types.ts';
import { parsePath, buildKey, getPathFromKey, isMetadataKey } from '../utils/path.ts';

/**
 * Get all data under a namespace
 * 
 * @param adapter - Storage adapter
 * @param path - Namespace path
 * @param options - Namespace options
 * @returns Object with all data under namespace
 */
export async function getNamespace(
  adapter: StorageAdapter,
  path: string,
  options?: NamespaceOptions
): Promise<any> {
  const recursive = options?.recursive ?? true;
  
  // Get all keys under this namespace
  const prefix = `smallstore:${path}`;
  const allKeys = await adapter.keys(prefix);
  
  // Filter out metadata keys
  const dataKeys = allKeys.filter(k => !isMetadataKey(k));
  
  // Build result object
  const result: any = {};
  
  for (const key of dataKeys) {
    const keyPath = getPathFromKey(key);
    if (!keyPath) {
      continue;
    }
    
    // Get relative path within namespace
    const relativePath = keyPath.startsWith(path + '/')
      ? keyPath.slice(path.length + 1)
      : keyPath;
    
    // Skip if not recursive and path has multiple segments
    if (!recursive && relativePath.includes('/')) {
      continue;
    }
    
    // Load data
    const data = await adapter.get(key);
    
    // Store in result using relative path
    setNestedValue(result, relativePath, data);
  }
  
  return result;
}

/**
 * Copy data from one path to another
 * 
 * @param adapter - Storage adapter
 * @param source - Source path
 * @param dest - Destination path
 */
export async function copy(
  adapter: StorageAdapter,
  source: string,
  dest: string
): Promise<void> {
  // Parse paths
  const sourceParsed = parsePath(source);
  const destParsed = parsePath(dest);
  
  // Build keys
  const sourceKey = buildKey(sourceParsed);
  const destKey = buildKey(destParsed);
  
  // Get source data
  const data = await adapter.get(sourceKey);
  
  if (!data) {
    throw new Error(`Source path not found: ${source}`);
  }
  
  // Copy to destination
  await adapter.set(destKey, data);
}

/**
 * Move data (copy + delete)
 * 
 * @param adapter - Storage adapter
 * @param source - Source path
 * @param dest - Destination path
 */
export async function move(
  adapter: StorageAdapter,
  source: string,
  dest: string
): Promise<void> {
  // Copy first
  await copy(adapter, source, dest);

  // Then delete source
  const sourceParsed = parsePath(source);
  const sourceKey = buildKey(sourceParsed);
  try {
    await adapter.delete(sourceKey);
  } catch (deleteError) {
    const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
    throw new Error(
      `move: copy from '${source}' to '${dest}' succeeded, but deleting source failed: ${msg}. ` +
      `Data now exists in BOTH locations. Manually delete the source or destination to resolve.`
    );
  }
}

/**
 * Copy entire namespace
 * 
 * @param adapter - Storage adapter
 * @param source - Source namespace
 * @param dest - Destination namespace
 * @param options - Copy options
 */
export async function copyNamespace(
  adapter: StorageAdapter,
  source: string,
  dest: string,
  options?: CopyOptions
): Promise<void> {
  const overwrite = options?.overwrite ?? false;
  
  // Get all keys under source namespace
  const sourcePrefix = `smallstore:${source}`;
  const allKeys = await adapter.keys(sourcePrefix);
  
  // Filter out metadata keys
  const dataKeys = allKeys.filter(k => !isMetadataKey(k));
  
  // Copy each key, tracking progress for rollback on failure
  const copiedDestKeys: string[] = [];
  try {
    for (const key of dataKeys) {
      const sourcePath = getPathFromKey(key);
      if (!sourcePath) {
        continue;
      }

      // Calculate destination path
      const relativePath = sourcePath.startsWith(source + '/')
        ? sourcePath.slice(source.length + 1)
        : sourcePath.slice(source.length);

      const destPath = dest + (relativePath ? `/${relativePath}` : '');

      // Check if destination exists
      const destParsed = parsePath(destPath);
      const destKey = buildKey(destParsed);

      if (!overwrite && await adapter.has(destKey)) {
        throw new Error(`Destination already exists: ${destPath}`);
      }

      // Copy data
      const data = await adapter.get(key);
      await adapter.set(destKey, data);
      copiedDestKeys.push(destKey);
    }
  } catch (error) {
    // Rollback: delete successfully copied keys (best effort)
    for (const copiedKey of copiedDestKeys) {
      try { await adapter.delete(copiedKey); } catch { /* best effort cleanup */ }
    }
    throw new Error(
      `copyNamespace failed after ${copiedDestKeys.length}/${dataKeys.length} keys. ` +
      `Rolled back copied keys. Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Set nested value in object using path
 * 
 * @param obj - Target object
 * @param path - Path (e.g., "folder/subfolder/item")
 * @param value - Value to set
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const segments = path.split('/');
  let current = obj;
  
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!(segment in current)) {
      current[segment] = {};
    }
    current = current[segment];
  }
  
  const lastSegment = segments[segments.length - 1];
  current[lastSegment] = value;
}

