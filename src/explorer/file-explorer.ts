/**
 * File Explorer
 * 
 * Phase 3.2: Browse and inspect Smallstore like a filesystem
 * 
 * Provides file-oriented views of storage:
 * - Browse collections as folder listings
 * - Visualize as tree structures
 * - Get file metadata
 * - Generate direct URLs
 */

import type { Smallstore, DataType } from '../types.ts';
import { parsePath, buildKey } from '../utils/path.ts';
import { loadIndex, getKeyLocation } from '../keyindex/mod.ts';
import { parseExtension, getMimeType } from '../utils/extensions.ts';
import { formatSize } from '../detector.ts';

// ============================================================================
// File Metadata Interface
// ============================================================================

/**
 * File metadata
 * 
 * Rich metadata about stored items, treating them like files in a filesystem.
 */
export interface FileMetadata {
  /** Full key (e.g., "documents/photos/vacation.jpg") */
  key: string;
  
  /** Filename (last path segment) */
  filename: string;
  
  /** Collection name */
  collection: string;
  
  /** Data type */
  type: DataType;
  
  /** MIME type (based on extension or data type) */
  mimeType?: string;
  
  /** Size in bytes */
  size: number;
  
  /** Human-readable size */
  sizeFormatted: string;
  
  /** Adapter storing this file */
  adapter: string;
  
  /** Direct URL (if adapter supports it) */
  url?: string;
  
  /** When file was created */
  created: string;
  
  /** When file was last updated */
  updated: string;
  
  /** Additional metadata */
  metadata?: Record<string, any>;
}

// ============================================================================
// Tree Options
// ============================================================================

/**
 * Options for tree visualization in FileExplorer
 */
export interface TreeOptions {
  /** Maximum depth to traverse */
  maxDepth?: number;
  
  /** Include file metadata in tree? */
  includeMetadata?: boolean;
}

// ============================================================================
// File Explorer Class
// ============================================================================

/**
 * File Explorer - Browse Smallstore like a filesystem
 * 
 * Phase 3.2: Separate utility class for file-oriented operations
 * 
 * Keeps main Smallstore interface clean while providing
 * powerful browsing and inspection capabilities.
 * 
 * @example
 * const storage = createSmallstore({...});
 * const explorer = new FileExplorer(storage);
 * 
 * // Browse a namespace
 * const files = await explorer.browse("documents");
 * for (const file of files) {
 *   console.log(`${file.filename} (${file.sizeFormatted}) - ${file.adapter}`);
 * }
 * 
 * // Get tree structure
 * const tree = await explorer.tree("my-workspace");
 * console.log(JSON.stringify(tree, null, 2));
 * 
 * // Get file metadata
 * const meta = await explorer.metadata("documents/report.pdf");
 * console.log(`${meta.filename}: ${meta.mimeType}, ${meta.sizeFormatted}`);
 * 
 * // Get direct URL
 * const url = await explorer.getFileUrl("images/photo.jpg");
 * console.log(`Direct link: ${url}`);
 */
export class FileExplorer {
  constructor(private storage: Smallstore) {}
  
  /**
   * Browse namespace and list files with metadata
   * 
   * Like `ls -la` for Smallstore - shows all files with full metadata.
   * 
   * @param namespace - Namespace to browse
   * @returns Array of file metadata
   * 
   * @example
   * const files = await explorer.browse("documents/photos");
   * // → [
   * //     { filename: "vacation.jpg", type: "blob", size: 2048000, ... },
   * //     { filename: "metadata.json", type: "object", size: 256, ... }
   * //   ]
   */
  async browse(namespace: string): Promise<FileMetadata[]> {
    const parsed = parsePath(namespace);
    
    // Get all keys in namespace
    const keys = await this.storage.keys(namespace);
    
    if (keys.length === 0) {
      return [];
    }
    
    // Load key index for metadata
    const metadataAdapter = this.storage.getMetadataAdapter();
    const index = await loadIndex(metadataAdapter, parsed.collection);
    
    // Build file metadata for each key
    const files: FileMetadata[] = [];
    
    for (const key of keys) {
      try {
        const fullKey = buildKey({ ...parsed, path: [...parsed.path, key], fullPath: `${namespace}/${key}` });
        
        if (index) {
          const location = getKeyLocation(index, fullKey);
          if (location) {
            const ext = parseExtension(key);
            
            files.push({
              key: fullKey,
              filename: key,
              collection: parsed.collection,
              type: location.dataType,
              mimeType: ext.hasExtension ? getMimeType(ext.extension) : undefined,
              size: location.sizeBytes,
              sizeFormatted: formatSize(location.sizeBytes),
              adapter: location.adapter,
              created: location.created,
              updated: location.updated,
            });
          }
        }
      } catch (err) {
        console.warn(`[FileExplorer] Failed to get metadata for "${key}":`, err);
        // Continue with other files
      }
    }
    
    return files;
  }
  
  /**
   * Get tree structure of namespace
   * 
   * Like `tree` command - visualizes folder hierarchy.
   * 
   * @param namespace - Namespace to visualize
   * @param options - Tree options
   * @returns Tree structure
   * 
   * @example
   * const tree = await explorer.tree("my-workspace");
   * // → {
   * //     "my-workspace": {
   * //       "documents": {
   * //         "_files": ["report.pdf", "notes.txt"]
   * //       },
   * //       "photos": {
   * //         "_files": ["vacation.jpg"]
   * //       }
   * //     }
   * //   }
   */
  async tree(namespace: string, options?: TreeOptions): Promise<Record<string, any>> {
    const maxDepth = options?.maxDepth || 10;
    const parsed = parsePath(namespace);
    
    // Get all keys in namespace (recursively)
    const keys = await this.getAllKeysRecursive(namespace, maxDepth);
    
    // Build tree structure
    const tree: Record<string, any> = {};
    
    for (const key of keys) {
      // Split into path segments
      const relativePath = key.replace(`${namespace}/`, '');
      const segments = relativePath.split('/');
      
      // Navigate/create tree structure
      let current = tree;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        
        if (i === segments.length - 1) {
          // Leaf node (file)
          if (!current._files) {
            current._files = [];
          }
          current._files.push(segment);
        } else {
          // Directory node
          if (!current[segment]) {
            current[segment] = {};
          }
          current = current[segment];
        }
      }
    }
    
    return { [namespace]: tree };
  }
  
  /**
   * Get metadata for a single file
   * 
   * Like `stat` command - shows detailed file information.
   * 
   * @param key - File key
   * @returns File metadata
   * 
   * @example
   * const meta = await explorer.metadata("documents/report.pdf");
   * // → {
   * //     filename: "report.pdf",
   * //     type: "blob",
   * //     mimeType: "application/pdf",
   * //     size: 1024000,
   * //     sizeFormatted: "1.0 MB",
   * //     adapter: "r2",
   * //     ...
   * //   }
   */
  async metadata(key: string): Promise<FileMetadata | null> {
    const parsed = parsePath(key);
    const storageKey = buildKey(parsed);
    
    // Load key index
    const metadataAdapter = this.storage.getMetadataAdapter();
    const index = await loadIndex(metadataAdapter, parsed.collection);
    
    if (!index) {
      return null;
    }
    
    const location = getKeyLocation(index, storageKey);
    if (!location) {
      return null;
    }
    
    const filename = parsed.path.length > 0
      ? parsed.path[parsed.path.length - 1]
      : parsed.collection;
    
    const ext = parseExtension(filename);
    
    return {
      key: storageKey,
      filename,
      collection: parsed.collection,
      type: location.dataType,
      mimeType: ext.hasExtension ? getMimeType(ext.extension) : undefined,
      size: location.sizeBytes,
      sizeFormatted: formatSize(location.sizeBytes),
      adapter: location.adapter,
      created: location.created,
      updated: location.updated,
    };
  }
  
  /**
   * Get direct URL to file (if adapter supports it)
   * 
   * Like `readlink` - resolves to direct URL for serving/downloading.
   * 
   * Note: URL generation depends on adapter capabilities.
   * Not all adapters can provide direct URLs.
   * 
   * @param key - File key
   * @returns Direct URL or null
   * 
   * @example
   * const url = await explorer.getFileUrl("images/photo.jpg");
   * if (url) {
   *   console.log(`<img src="${url}" />`);
   * }
   */
  async getFileUrl(key: string): Promise<string | null> {
    const parsed = parsePath(key);
    const storageKey = buildKey(parsed);
    
    // Load key index to find adapter
    const metadataAdapter = this.storage.getMetadataAdapter();
    const index = await loadIndex(metadataAdapter, parsed.collection);
    
    if (!index) {
      return null;
    }
    
    const location = getKeyLocation(index, storageKey);
    if (!location) {
      return null;
    }
    
    const adapter = this.storage.getAdapter(location.adapter);
    if (!adapter) {
      return null;
    }
    
    // Check if adapter has URL generation capability
    // This is adapter-specific and would need to be implemented per adapter
    
    // For R2 adapter (example)
    if (location.adapter === 'r2' || location.adapter === 'cloudflare-r2') {
      // R2 URLs follow pattern: https://{bucket}.{account}.r2.cloudflarestorage.com/{key}
      // This would need actual adapter configuration
      return null; // Placeholder - would need actual R2 config
    }
    
    // For other adapters, might not support direct URLs
    return null;
  }
  
  /**
   * Helper: Recursively get all keys under namespace
   * 
   * @param namespace - Namespace to scan
   * @param maxDepth - Maximum depth to recurse
   * @param currentDepth - Current recursion depth
   * @returns Array of all keys
   */
  private async getAllKeysRecursive(
    namespace: string,
    maxDepth: number,
    currentDepth = 0
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) {
      return [];
    }
    
    const keys = await this.storage.keys(namespace);
    const allKeys: string[] = [];
    
    for (const key of keys) {
      const fullKey = `${namespace}/${key}`;
      allKeys.push(fullKey);
      
      // Try to recurse into this key as a namespace
      try {
        const subKeys = await this.getAllKeysRecursive(fullKey, maxDepth, currentDepth + 1);
        allKeys.push(...subKeys);
      } catch {
        // Not a namespace, just a leaf key
      }
    }
    
    return allKeys;
  }
}

