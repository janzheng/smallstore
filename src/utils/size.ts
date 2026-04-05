/**
 * Size Utilities
 * 
 * Helper functions for size comparison and validation:
 * - Parse human-readable sizes ("1MB", "500KB")
 * - Compare sizes
 * - Validate size limits
 */

// ============================================================================
// Size Parsing
// ============================================================================

/**
 * Parse human-readable size string to bytes
 * 
 * @param sizeStr - Size string like "1MB", "500KB", "1.5GB"
 * @returns Size in bytes
 * 
 * @example
 * parseSize("1KB");     // → 1024
 * parseSize("1.5MB");   // → 1572864
 * parseSize("500 KB");  // → 512000
 * parseSize("1GB");     // → 1073741824
 */
export function parseSize(sizeStr: string): number {
  const normalized = sizeStr.trim().toUpperCase().replace(/\s+/g, '');
  
  // Extract number and unit
  const match = normalized.match(/^([\d.]+)([KMGT]?B?)$/);
  if (!match) {
    throw new Error(`Invalid size format: ${sizeStr}`);
  }
  
  const [, numStr, unit] = match;
  const num = parseFloat(numStr);
  
  if (isNaN(num)) {
    throw new Error(`Invalid size number: ${numStr}`);
  }
  
  // Convert to bytes based on unit
  const multipliers: Record<string, number> = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024,
    
    // Handle case where unit is just 'K', 'M', 'G', 'T'
    'K': 1024,
    'M': 1024 * 1024,
    'G': 1024 * 1024 * 1024,
    'T': 1024 * 1024 * 1024 * 1024,
  };
  
  const multiplier = multipliers[unit] || 1;
  return Math.floor(num * multiplier);
}

// ============================================================================
// Size Comparison
// ============================================================================

/**
 * Check if a size (in bytes) is within a limit
 * 
 * @param sizeBytes - Size to check (in bytes)
 * @param limitBytes - Limit (in bytes, or undefined for no limit)
 * @returns true if within limit
 * 
 * @example
 * isWithinLimit(1024, 2048);        // true
 * isWithinLimit(3000, 2048);        // false
 * isWithinLimit(1024, undefined);   // true (no limit)
 */
export function isWithinLimit(sizeBytes: number, limitBytes: number | undefined): boolean {
  if (limitBytes === undefined) {
    return true; // No limit
  }
  
  return sizeBytes <= limitBytes;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate size against limit, throw if exceeds
 * 
 * @param sizeBytes - Size to validate
 * @param limitBytes - Limit (undefined = no limit)
 * @param context - Context for error message (e.g., "Upstash adapter")
 * @throws Error if exceeds limit
 * 
 * @example
 * validateSize(1024, 2048, "Memory adapter");  // OK
 * validateSize(3000, 2048, "Upstash adapter"); // Throws
 */
export function validateSize(
  sizeBytes: number,
  limitBytes: number | undefined,
  context: string
): void {
  if (!isWithinLimit(sizeBytes, limitBytes)) {
    const limitStr = formatSizeBytes(limitBytes!);
    const actualStr = formatSizeBytes(sizeBytes);
    throw new Error(
      `${context}: Data size ${actualStr} exceeds limit of ${limitStr}`
    );
  }
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format size in bytes to human-readable string
 * 
 * Note: This is a duplicate of detector.ts formatSize()
 * We include it here for standalone use of size utilities
 * 
 * @param bytes - Size in bytes
 * @returns Formatted string
 */
export function formatSizeBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= k && unitIndex < units.length - 1) {
    size /= k;
    unitIndex++;
  }
  
  const formatted = unitIndex === 0
    ? size.toString()
    : size.toFixed(1);
  
  return `${formatted} ${units[unitIndex]}`;
}

