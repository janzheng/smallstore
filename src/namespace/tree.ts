/**
 * Tree Builder
 * 
 * Build folder structure visualization for namespaces.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { NamespaceTree, TreeOptions, DataType } from '../types.ts';
import { getPathFromKey, isMetadataKey } from '../utils/path.ts';
import { isViewKey, getViewNameFromKey, loadView } from '../views/storage.ts';

/**
 * Build namespace tree
 * 
 * @param adapter - Storage adapter
 * @param metadataAdapter - Metadata adapter (for views)
 * @param path - Namespace path
 * @param options - Tree options
 * @returns Tree structure
 */
export async function buildTree(
  adapter: StorageAdapter,
  metadataAdapter: StorageAdapter,
  path: string,
  options?: TreeOptions
): Promise<NamespaceTree> {
  const maxDepth = options?.maxDepth ?? Infinity;
  const includeViews = options?.includeViews ?? true;
  
  return await buildTreeNode(
    adapter,
    metadataAdapter,
    path,
    0,
    maxDepth,
    includeViews
  );
}

/**
 * Build a single tree node recursively
 */
async function buildTreeNode(
  adapter: StorageAdapter,
  metadataAdapter: StorageAdapter,
  path: string,
  depth: number,
  maxDepth: number,
  includeViews: boolean
): Promise<NamespaceTree> {
  // Get all keys under this path
  const prefix = `smallstore:${path}`;
  const allKeys = await adapter.keys(prefix);
  
  // Also get view keys if requested
  let viewKeys: string[] = [];
  if (includeViews) {
    const viewPrefix = `smallstore:view:${path}`;
    viewKeys = await metadataAdapter.keys(viewPrefix);
  }
  
  // Analyze keys to determine node type
  const dataKeys = allKeys.filter(k => !isMetadataKey(k));
  
  // If no keys, check if this path exists as a collection
  if (dataKeys.length === 0 && viewKeys.length === 0) {
    // Try to get data directly
    const data = await adapter.get(`smallstore:${path}`);
    if (data) {
      return {
        path,
        type: 'collection',
        itemCount: Array.isArray(data) ? data.length : 1,
        dataType: detectType(data),
      };
    }
    
    // Empty folder or non-existent
    return {
      path,
      type: 'folder',
      children: {},
    };
  }
  
  // If we have exactly one key that matches our path, it's a collection
  const exactMatch = dataKeys.find(k => getPathFromKey(k) === path);
  if (exactMatch && dataKeys.length === 1 && viewKeys.length === 0) {
    const data = await adapter.get(exactMatch);
    return {
      path,
      type: 'collection',
      itemCount: Array.isArray(data) ? data.length : 1,
      dataType: detectType(data),
    };
  }
  
  // It's a folder with children
  if (depth >= maxDepth) {
    return {
      path,
      type: 'folder',
      children: {}, // Don't expand further
    };
  }
  
  // Build children
  const children: Record<string, NamespaceTree> = {};
  
  // Group keys by immediate child
  const childPaths = new Set<string>();
  
  for (const key of dataKeys) {
    const keyPath = getPathFromKey(key);
    if (!keyPath || keyPath === path) {
      continue;
    }
    
    // Get next segment after current path
    const relative = keyPath.startsWith(path + '/') 
      ? keyPath.slice(path.length + 1)
      : keyPath.slice(path.length);
    
    const nextSegment = relative.split('/')[0];
    if (nextSegment) {
      const childPath = path ? `${path}/${nextSegment}` : nextSegment;
      childPaths.add(childPath);
    }
  }
  
  // Build child nodes
  for (const childPath of childPaths) {
    const childName = childPath.split('/').pop() || childPath;
    children[childName] = await buildTreeNode(
      adapter,
      metadataAdapter,
      childPath,
      depth + 1,
      maxDepth,
      includeViews
    );
  }
  
  // Add views as children
  if (includeViews) {
    for (const viewKey of viewKeys) {
      const viewName = getViewNameFromKey(viewKey);
      if (!viewName) {
        continue;
      }
      
      // Check if view is directly under this path
      const viewPath = viewName.replace('.view', '');
      const viewNamespace = viewPath.includes('/') 
        ? viewPath.substring(0, viewPath.lastIndexOf('/'))
        : '';
      
      if (viewNamespace === path || (!path && !viewNamespace)) {
        const viewDef = await loadView(metadataAdapter, viewName);
        if (viewDef) {
          const simpleName = viewPath.split('/').pop() || viewPath;
          children[simpleName + '.view'] = {
            path: viewName,
            type: 'view',
            source: viewDef.source,
            pipeline: viewDef.retrievers,
          };
        }
      }
    }
  }
  
  return {
    path,
    type: 'folder',
    children,
  };
}

/**
 * Detect data type from data
 */
function detectType(data: any): DataType {
  if (data instanceof Uint8Array) {
    return 'blob';
  }
  
  if (typeof data === 'object' && data !== null) {
    return 'object';
  }
  
  return 'kv';
}

