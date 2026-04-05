/**
 * JSON Materializer
 * 
 * Phase 3.2: Content negotiation - materialize collections as structured JSON
 * 
 * Returns collections with full metadata about items, adapters, and storage.
 * Inspired by Discourse API's .json endpoints.
 */

import type { Smallstore, GetOptions } from '../types.ts';
import { parsePath } from '../utils/path.ts';
import { loadIndex } from '../keyindex/mod.ts';
import { formatSize } from '../detector.ts';

// ============================================================================
// JSON Materialization
// ============================================================================

/**
 * Materialized JSON response
 * 
 * Structured representation of collection with full metadata.
 */
export interface MaterializedJson {
  /** Collection path */
  collection: string;
  
  /** Number of items */
  count: number;
  
  /** Array of items with metadata */
  items: Array<{
    /** Item key (relative to collection) */
    key: string;
    
    /** Data type */
    type: 'object' | 'blob' | 'kv';
    
    /** Item data */
    data: any;
    
    /** Size in bytes */
    size?: number;
    
    /** Adapter storing this item */
    adapter?: string;
  }>;
  
  /** Collection-level metadata */
  metadata: {
    /** Adapter usage breakdown */
    adapters: Record<string, number>;
    
    /** Total size (human-readable) */
    totalSize: string;
    
    /** Total size in bytes */
    totalSizeBytes: number;
    
    /** When collection was created */
    created?: string;
    
    /** When collection was last updated */
    updated?: string;
  };
}

/**
 * Materialize collection as structured JSON
 * 
 * Loads all items in collection and wraps with rich metadata.
 * Supports filtering by type, adapter, schema, and key search.
 * 
 * Use cases:
 * - API endpoints returning collection data
 * - Debugging/introspection
 * - Data export with metadata
 * 
 * @param storage - Smallstore instance
 * @param collectionPath - Collection to materialize
 * @param options - Optional filtering, sorting, pagination options
 * @returns Structured JSON with items and metadata
 * 
 * @example
 * const json = await materializeJson(storage, "bookmarks/tech");
 * // → {
 * //     collection: "bookmarks/tech",
 * //     count: 42,
 * //     items: [
 * //       { key: "article1", type: "object", data: {...}, adapter: "upstash" },
 * //       { key: "article2", type: "object", data: {...}, adapter: "upstash" }
 * //     ],
 * //     metadata: {
 * //       adapters: { upstash: 42 },
 * //       totalSize: "2.5 KB",
 * //       totalSizeBytes: 2560,
 * //       updated: "2025-11-18T..."
 * //     }
 * //   }
 * 
 * @example
 * // Filter by type and schema
 * const json = await materializeJson(storage, "collection", {
 *   filterType: "object",
 *   filterSchema: {
 *     required: ["name", "role"]
 *   }
 * });
 */
export async function materializeJson(
  storage: Smallstore,
  collectionPath: string,
  options?: GetOptions
): Promise<MaterializedJson> {
  const parsed = parsePath(collectionPath);
  
  // Get all keys in collection
  const keys = await storage.keys(collectionPath);
  
  // Load key index for metadata
  const metadataAdapter = storage.getMetadataAdapter();
  const index = await loadIndex(metadataAdapter, parsed.collection);
  
  // Track stats
  const adapterCounts: Record<string, number> = {};
  let totalSizeBytes = 0;
  let oldestCreated: string | undefined;
  let newestUpdated: string | undefined;
  
  // Load all items
  const items: MaterializedJson['items'] = [];
  
  for (const key of keys) {
    try {
      // Get data (unwrap StorageFileResponse)
      const response = await storage.get(`${collectionPath}/${key}`);
      if (!response) continue;
      
      const data = response.content;
      const adapter = response.adapter;
      const dataType = response.dataType;
      const size = response.reference.size;
      
      // ============================================================================
      // Phase 3.4: Apply filters
      // ============================================================================
      
      // Filter by data type
      if (options?.filterType && options.filterType !== 'all') {
        if (dataType !== options.filterType) continue;
      }
      
      // Filter by adapter
      if (options?.filterAdapter) {
        if (adapter !== options.filterAdapter) continue;
      }
      
      // Search in keys
      if (options?.searchKeys) {
        const searchLower = options.searchKeys.toLowerCase();
        if (!key.toLowerCase().includes(searchLower)) continue;
      }
      
      // Filter by JSON schema (only for objects)
      if (options?.filterSchema) {
        if (dataType !== 'object') continue;
        if (!matchesSchema(data, options.filterSchema)) continue;
      }
      
      // ============================================================================
      // Item passed all filters - add it
      // ============================================================================
      
      items.push({
        key,
        type: dataType,
        data,
        size,
        adapter,
      });
      
      // Update stats
      adapterCounts[adapter] = (adapterCounts[adapter] || 0) + 1;
      totalSizeBytes += size;
      
      // Track timestamps from index
      if (index) {
        const fullKey = `smallstore:${parsed.collection}:${key}`;
        const location = index.keys[fullKey];
        if (location) {
          if (!oldestCreated || location.created < oldestCreated) {
            oldestCreated = location.created;
          }
          if (!newestUpdated || location.updated > newestUpdated) {
            newestUpdated = location.updated;
          }
        }
      }
    } catch (err) {
      console.warn(`[materializeJson] Failed to load key "${key}":`, err);
      // Continue with other keys
    }
  }
  
  return {
    collection: collectionPath,
    count: items.length,
    items,
    metadata: {
      adapters: adapterCounts,
      totalSize: formatSize(totalSizeBytes),
      totalSizeBytes,
      created: oldestCreated,
      updated: newestUpdated,
    },
  };
}

/**
 * Materialize single item as JSON
 * 
 * For single items (not collections), returns the item with metadata.
 * 
 * @param storage - Smallstore instance
 * @param itemPath - Path to single item
 * @returns Item data with metadata
 * 
 * @example
 * const json = await materializeJsonItem(storage, "users/alice");
 * // → {
 * //     key: "users/alice",
 * //     type: "object",
 * //     data: { name: "Alice", email: "..." },
 * //     adapter: "upstash",
 * //     size: 256
 * //   }
 */
export async function materializeJsonItem(
  storage: Smallstore,
  itemPath: string
): Promise<any> {
  const response = await storage.get(itemPath);
  if (!response) {
    return null;
  }
  
  return {
    key: itemPath,
    type: response.dataType,
    data: response.content,
    adapter: response.adapter,
    size: response.reference.size,
    created: response.reference.createdAt 
      ? new Date(response.reference.createdAt).toISOString()
      : undefined,
  };
}

// ============================================================================
// Phase 3.4: JSON Schema Validation Utilities
// ============================================================================

/**
 * Check if data matches a JSON schema
 * 
 * Simplified schema validation supporting:
 * - type checking (object, array, string, number, boolean)
 * - required fields
 * - property types
 * - enum values
 * - pattern matching (for strings)
 * 
 * @param data - Data to validate
 * @param schema - JSON Schema to validate against
 * @returns true if data matches schema
 * 
 * @example
 * matchesSchema(
 *   { name: "Alice", role: "Developer" },
 *   { required: ["name", "role"], properties: { name: { type: "string" } } }
 * ); // → true
 */
export function matchesSchema(data: any, schema: Record<string, any>): boolean {
  if (!data || typeof data !== 'object') return false;
  
  // Check type
  if (schema.type && schema.type !== typeof data) {
    if (schema.type === "object" && typeof data !== "object") return false;
    if (schema.type === "array" && !Array.isArray(data)) return false;
  }
  
  // Check required fields
  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in data) || data[field] === undefined || data[field] === null) {
        return false;
      }
    }
  }
  
  // Check properties (if specified)
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [prop, propSchema] of Object.entries(schema.properties)) {
      if (prop in data) {
        const propValue = data[prop];
        const propSchemaObj = propSchema as Record<string, any>;
        
        // Check property type
        if (propSchemaObj.type) {
          const actualType = Array.isArray(propValue) ? 'array' : typeof propValue;
          if (propSchemaObj.type !== actualType) {
            return false;
          }
        }
        
        // Check enum values
        if (propSchemaObj.enum && Array.isArray(propSchemaObj.enum)) {
          if (!propSchemaObj.enum.includes(propValue)) {
            return false;
          }
        }
        
        // Check pattern (for strings)
        if (propSchemaObj.pattern && typeof propValue === 'string') {
          const regex = new RegExp(propSchemaObj.pattern);
          if (!regex.test(propValue)) {
            return false;
          }
        }
      }
    }
  }
  
  return true;
}

