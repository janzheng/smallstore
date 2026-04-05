/**
 * Markdown Materializer
 * 
 * Phase 3.2: Content negotiation - materialize collections as markdown
 * 
 * Returns collections as human-readable markdown with code blocks.
 * Great for documentation, exports, and viewing data in markdown tools.
 */

import type { Smallstore } from '../types.ts';
import { parsePath } from '../utils/path.ts';
import { loadIndex } from '../keyindex/mod.ts';
import { formatSize } from '../detector.ts';

// ============================================================================
// Markdown Materialization
// ============================================================================

/**
 * Materialize collection as markdown
 * 
 * Converts collection items to markdown format with:
 * - Header with collection info
 * - Metadata summary
 * - Items as headings with code blocks
 * 
 * Use cases:
 * - Documentation generation
 * - Data export for markdown tools
 * - Human-readable collection views
 * - README generation
 * 
 * @param storage - Smallstore instance
 * @param collectionPath - Collection to materialize
 * @returns Markdown string
 * 
 * @example
 * const md = await materializeMarkdown(storage, "bookmarks/tech");
 * // → # bookmarks/tech
 * //
 * //   **Collection:** bookmarks/tech
 * //   **Items:** 42
 * //   **Total Size:** 2.5 KB
 * //   **Last Updated:** 2025-11-18T...
 * //
 * //   ## article1 (object)
 * //
 * //   **Adapter:** upstash
 * //   **Size:** 256 bytes
 * //
 * //   ```json
 * //   {
 * //     "title": "Cool Post",
 * //     "url": "https://..."
 * //   }
 * //   ```
 */
export async function materializeMarkdown(
  storage: Smallstore,
  collectionPath: string
): Promise<string> {
  const parsed = parsePath(collectionPath);
  
  // Get all keys in collection
  const keys = await storage.keys(collectionPath);
  
  // Load key index for metadata
  const metadataAdapter = storage.getMetadataAdapter();
  const index = await loadIndex(metadataAdapter, parsed.collection);
  
  // Track stats
  const adapterCounts: Record<string, number> = {};
  let totalSizeBytes = 0;
  let newestUpdated: string | undefined;
  
  // Start markdown
  const lines: string[] = [];
  
  // Header
  lines.push(`# ${collectionPath}`);
  lines.push('');
  
  // Collection metadata (will update after loading items)
  const metadataLineIndex = lines.length;
  lines.push(''); // Placeholder for metadata
  
  // Load all items
  const itemBlocks: string[] = [];
  
  for (const key of keys) {
    try {
      // Get data (unwrap StorageFileResponse)
      const response = await storage.get(`${collectionPath}/${key}`);
      if (!response) continue;
      
      const data = response.content;
      const adapter = response.adapter;
      const dataType = response.dataType;
      const size = response.reference.size;
      
      // Update stats
      adapterCounts[adapter] = (adapterCounts[adapter] || 0) + 1;
      totalSizeBytes += size;
      
      // Track timestamps from index
      if (index) {
        const fullKey = `smallstore:${parsed.collection}:${key}`;
        const location = index.keys[fullKey];
        if (location) {
          if (!newestUpdated || location.updated > newestUpdated) {
            newestUpdated = location.updated;
          }
        }
      }
      
      // Format item as markdown block
      const itemBlock: string[] = [];
      itemBlock.push(`## ${key} (${dataType})`);
      itemBlock.push('');
      itemBlock.push(`**Adapter:** ${adapter}`);
      itemBlock.push(`**Size:** ${formatSize(size)}`);
      itemBlock.push('');
      
      // Add data as code block
      if (dataType === 'object') {
        itemBlock.push('```json');
        itemBlock.push(JSON.stringify(data, null, 2));
        itemBlock.push('```');
      } else if (dataType === 'blob') {
        itemBlock.push('```');
        itemBlock.push(`[Binary data: ${formatSize(size)}]`);
        itemBlock.push('```');
      } else {
        // kv (primitives)
        itemBlock.push('```');
        itemBlock.push(String(data));
        itemBlock.push('```');
      }
      
      itemBlocks.push(itemBlock.join('\n'));
    } catch (err) {
      console.warn(`[materializeMarkdown] Failed to load key "${key}":`, err);
      // Continue with other keys
    }
  }
  
  // Update metadata section
  const adapterSummary = Object.entries(adapterCounts)
    .map(([adapter, count]) => `${adapter}: ${count}`)
    .join(', ');
  
  const metadata: string[] = [];
  metadata.push(`**Collection:** ${collectionPath}`);
  metadata.push(`**Items:** ${itemBlocks.length}`);
  metadata.push(`**Total Size:** ${formatSize(totalSizeBytes)}`);
  if (adapterSummary) {
    metadata.push(`**Adapters:** ${adapterSummary}`);
  }
  if (newestUpdated) {
    metadata.push(`**Last Updated:** ${newestUpdated}`);
  }
  metadata.push('');
  
  lines[metadataLineIndex] = metadata.join('\n');
  
  // Add all items
  if (itemBlocks.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(...itemBlocks.map(block => block + '\n'));
  } else {
    lines.push('*No items in collection*');
  }
  
  return lines.join('\n');
}

/**
 * Materialize single item as markdown
 * 
 * For single items (not collections), returns the item formatted as markdown.
 * 
 * @param storage - Smallstore instance
 * @param itemPath - Path to single item
 * @returns Markdown string
 * 
 * @example
 * const md = await materializeMarkdownItem(storage, "users/alice");
 * // → # alice
 * //
 * //   **Type:** object
 * //   **Adapter:** upstash
 * //   **Size:** 256 bytes
 * //
 * //   ```json
 * //   {
 * //     "name": "Alice",
 * //     "email": "alice@example.com"
 * //   }
 * //   ```
 */
export async function materializeMarkdownItem(
  storage: Smallstore,
  itemPath: string
): Promise<string> {
  const response = await storage.get(itemPath);
  if (!response) {
    return `# ${itemPath}\n\n*Item not found*`;
  }
  
  const parsed = parsePath(itemPath);
  const filename = parsed.path.length > 0
    ? parsed.path[parsed.path.length - 1]
    : parsed.collection;
  
  const lines: string[] = [];
  
  // Header
  lines.push(`# ${filename}`);
  lines.push('');
  
  // Metadata
  lines.push(`**Type:** ${response.dataType}`);
  lines.push(`**Adapter:** ${response.adapter}`);
  lines.push(`**Size:** ${formatSize(response.reference.size)}`);
  if (response.reference.createdAt) {
    lines.push(`**Created:** ${new Date(response.reference.createdAt).toISOString()}`);
  }
  lines.push('');
  
  // Data
  if (response.dataType === 'object') {
    lines.push('```json');
    lines.push(JSON.stringify(response.content, null, 2));
    lines.push('```');
  } else if (response.dataType === 'blob') {
    lines.push('```');
    lines.push(`[Binary data: ${formatSize(response.reference.size)}]`);
    lines.push('```');
  } else {
    // kv (primitives)
    lines.push('```');
    lines.push(String(response.content));
    lines.push('```');
  }
  
  return lines.join('\n');
}

