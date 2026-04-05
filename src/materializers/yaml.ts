/**
 * YAML Materializer
 * 
 * Phase 3.2: Content negotiation - materialize collections as YAML
 * 
 * Returns collections as YAML format for config files and structured data.
 */

import type { Smallstore } from '../types.ts';
import { parsePath } from '../utils/path.ts';
import { formatSize } from '../detector.ts';

// ============================================================================
// YAML Materialization
// ============================================================================

/**
 * Materialize collection as YAML
 * 
 * Converts collection items to YAML format.
 * 
 * Use cases:
 * - Configuration files
 * - Structured data export
 * - Human-readable formats
 * - DevOps/infrastructure configs
 * 
 * @param storage - Smallstore instance
 * @param collectionPath - Collection to materialize
 * @returns YAML string
 * 
 * @example
 * const yaml = await materializeYaml(storage, "config/app");
 * // → collection: config/app
 * //   items: 3
 * //   data:
 * //     database:
 * //       host: localhost
 * //       port: 5432
 * //     cache:
 * //       enabled: true
 * //     logging:
 * //       level: info
 */
export async function materializeYaml(
  storage: Smallstore,
  collectionPath: string
): Promise<string> {
  const parsed = parsePath(collectionPath);
  
  // Get all keys in collection
  const keys = await storage.keys(collectionPath);
  
  if (keys.length === 0) {
    return `collection: ${collectionPath}\nitems: 0\ndata: {}\n`;
  }
  
  // Track stats
  let totalSizeBytes = 0;
  const data: Record<string, any> = {};
  
  // Load all items
  for (const key of keys) {
    try {
      const response = await storage.get(`${collectionPath}/${key}`);
      if (!response) continue;
      
      const itemData = response.content;
      const size = response.reference.size;
      
      totalSizeBytes += size;
      
      // Add to data object
      if (response.dataType === 'object') {
        data[key] = itemData;
      } else if (response.dataType === 'blob') {
        data[key] = `[Binary: ${formatSize(size)}]`;
      } else {
        data[key] = itemData;
      }
    } catch (err) {
      console.warn(`[materializeYaml] Failed to load key "${key}":`, err);
      data[key] = '[Error loading]';
    }
  }
  
  // Build YAML
  const lines: string[] = [];
  lines.push(`collection: ${collectionPath}`);
  lines.push(`items: ${keys.length}`);
  lines.push(`totalSize: ${formatSize(totalSizeBytes)}`);
  lines.push('data:');
  
  // Convert data to YAML (simple implementation)
  for (const [key, value] of Object.entries(data)) {
    lines.push(`  ${key}:`);
    const yamlValue = toYamlValue(value, 2);
    lines.push(yamlValue);
  }
  
  return lines.join('\n');
}

/**
 * Materialize single item as YAML
 * 
 * For single items (not collections), returns the item as YAML.
 * 
 * @param storage - Smallstore instance
 * @param itemPath - Path to single item
 * @returns YAML string
 * 
 * @example
 * const yaml = await materializeYamlItem(storage, "config/database");
 * // → host: localhost
 * //   port: 5432
 * //   database: myapp
 */
export async function materializeYamlItem(
  storage: Smallstore,
  itemPath: string
): Promise<string> {
  const response = await storage.get(itemPath);
  if (!response) {
    return `# Item not found: ${itemPath}\n`;
  }
  
  if (response.dataType === 'object') {
    return toYamlValue(response.content, 0);
  } else if (response.dataType === 'blob') {
    return `# Binary data: ${formatSize(response.reference.size)}\n`;
  } else {
    return `${response.content}\n`;
  }
}

/**
 * Convert value to YAML string (simple implementation)
 * 
 * This is a basic YAML serializer for common cases.
 * For production use, consider a full YAML library.
 * 
 * @param value - Value to convert
 * @param indent - Current indentation level
 * @returns YAML string
 */
function toYamlValue(value: any, indent: number): string {
  const indentStr = ' '.repeat(indent);
  
  if (value === null || value === undefined) {
    return `${indentStr}null`;
  }
  
  if (typeof value === 'string') {
    // Check if string needs quoting
    if (/[:\-\[\]\{\}#&*!|>'\"%@`]/.test(value) || /^\s|\s$/.test(value)) {
      return `${indentStr}"${value.replace(/"/g, '\\"')}"`;
    }
    return `${indentStr}${value}`;
  }
  
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${indentStr}${value}`;
  }
  
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indentStr}[]`;
    }
    
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        lines.push(`${indentStr}- `);
        const itemYaml = toYamlValue(item, indent + 2);
        lines.push(itemYaml.trimStart());
      } else {
        lines.push(`${indentStr}- ${toYamlValue(item, 0).trim()}`);
      }
    }
    return lines.join('\n');
  }
  
  if (typeof value === 'object') {
    const lines: string[] = [];
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        lines.push(`${indentStr}${key}:`);
        lines.push(toYamlValue(val, indent + 2));
      } else if (Array.isArray(val)) {
        lines.push(`${indentStr}${key}:`);
        lines.push(toYamlValue(val, indent + 2));
      } else {
        lines.push(`${indentStr}${key}: ${toYamlValue(val, 0).trim()}`);
      }
    }
    return lines.join('\n');
  }
  
  return `${indentStr}${String(value)}`;
}

