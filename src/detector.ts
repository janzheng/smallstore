/**
 * Data Type Detector
 * 
 * Ultra-simple data type detection for "messy desk" / data mesh pattern:
 * - object: ANY JSON-serializable data (single object, array, nested)
 * - blob: Binary data (images, audio, PDFs)
 * - kv: Simple primitives (string, number, boolean, null)
 * 
 * No thresholds, no size checks - just detect what it fundamentally IS.
 */

import type { DataType, DataAnalysis } from './types.ts';

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Analyze data and determine its type, size, and characteristics
 * 
 * @param data - Data to analyze
 * @returns DataAnalysis with type, size, and recommendations
 * 
 * @example
 * analyzeData({ name: "test" });
 * // → { type: "object", sizeBytes: 15, size: "15 B" }
 * 
 * analyzeData([1, 2, 3, ...5000 items]);
 * // → { type: "object", sizeBytes: 50000, size: "48.8 KB", itemCount: 5000 }
 * 
 * analyzeData("Just a string");
 * // → { type: "kv", sizeBytes: 13, size: "13 B" }
 * 
 * analyzeData(imageBlob);
 * // → { type: "blob", sizeBytes: 1024000, size: "1 MB" }
 */
export function analyzeData(data: any): DataAnalysis {
  // Calculate size
  const sizeBytes = calculateSize(data);
  const size = formatSize(sizeBytes);
  
  // Detect type (ultra-simple!)
  const type = detectDataType(data);
  
  // Build analysis object
  const analysis: DataAnalysis = {
    type,
    sizeBytes,
    size,
  };
  
  // Add item count for arrays (helpful for metadata)
  if (Array.isArray(data)) {
    analysis.itemCount = data.length;
  }
  
  // Add recommendations based on analysis
  analysis.recommendedAdapter = recommendAdapter(analysis);
  
  return analysis;
}

// ============================================================================
// Data Type Detection (ULTRA-SIMPLE!)
// ============================================================================

/**
 * Detect data type - just 3 types, no complexity!
 * 
 * @param data - Data to detect
 * @returns DataType
 */
export function detectDataType(data: any): DataType {
  // Binary data → blob
  if (data instanceof Uint8Array || data instanceof ArrayBuffer || data instanceof Blob) {
    return 'blob';
  }
  
  // Primitives → kv (string, number, boolean, null)
  if (typeof data !== 'object' || data === null) {
    return 'kv';
  }
  
  // Everything else → object (single object, array, nested - doesn't matter!)
  return 'object';
}

// ============================================================================
// Size Calculation
// ============================================================================

/**
 * Calculate approximate size of data in bytes
 * 
 * Uses JSON serialization for simplicity
 * 
 * @param data - Data to measure
 * @returns Size in bytes
 */
export function calculateSize(data: any): number {
  try {
    // Null/undefined
    if (data === null || data === undefined) {
      return 0;
    }
    
    // String
    if (typeof data === 'string') {
      // UTF-8 encoding: most ASCII chars are 1 byte, some are 2-4
      // Rough approximation: 1.2 bytes per char average
      return data.length * 1.2;
    }
    
    // Number/boolean
    if (typeof data === 'number' || typeof data === 'boolean') {
      return 8; // Approximate
    }
    
    // Binary data
    if (data instanceof Uint8Array) {
      return data.byteLength;
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    if (data instanceof Blob) {
      return data.size;
    }
    
    // Complex data (objects, arrays) → JSON serialization
    const json = JSON.stringify(data);
    return json.length * 1.2; // UTF-8 approximation
  } catch (error) {
    // Fallback: estimate 1KB if serialization fails
    console.warn('[Detector] Size calculation failed, falling back to 1KB:', error);
    return 1024;
  }
}

/**
 * Format size in human-readable format
 * 
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "2.5 MB", "128 KB", "45 B")
 * 
 * @example
 * formatSize(1024);           // "1 KB"
 * formatSize(1536);           // "1.5 KB"
 * formatSize(1024 * 1024);    // "1 MB"
 * formatSize(2.5 * 1024 * 1024); // "2.5 MB"
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= k && unitIndex < units.length - 1) {
    size /= k;
    unitIndex++;
  }
  
  // Format with 1 decimal place if not bytes
  const formatted = unitIndex === 0
    ? size.toString()
    : size.toFixed(1);
  
  return `${formatted} ${units[unitIndex]}`;
}

// ============================================================================
// Adapter Recommendation
// ============================================================================

/**
 * Recommend optimal adapter based on data analysis
 * 
 * Simple heuristics for Phase 1:
 * - object → Memory (Phase 1) / Postgres (future)
 * - blob → Memory (Phase 1) / R2 (future)
 * - kv → Upstash (if available) / Memory
 * 
 * @param analysis - Data analysis result
 * @returns Recommended adapter name
 */
function recommendAdapter(analysis: DataAnalysis): string {
  const { type, sizeBytes } = analysis;
  
  // Objects (structured data) → Memory for now (future: Postgres/D1)
  if (type === 'object') {
    return 'memory'; // Phase 1: Use memory, will add Postgres later
  }
  
  // Blobs (binary data) → Memory for now (future: R2/S3)
  if (type === 'blob') {
    return 'memory';
  }
  
  // KV (small values) → Upstash if available (fast, cheap)
  if (type === 'kv') {
    // Small values (<1MB) can go to Upstash
    if (sizeBytes < 1 * 1024 * 1024) {
      return 'upstash';
    }
    return 'memory';
  }
  
  // Default: Memory (safest fallback)
  return 'memory';
}
