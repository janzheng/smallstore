/**
 * Query Engine - Universal query system for Smallstore (Phase 3.6f-a)
 * 
 * Supports:
 * - MongoDB-style filters
 * - Function filters
 * - Projection (select/omit)
 * - Sorting
 * - Pagination (page & cursor-based)
 * - Range requests
 */

import type {
  FilterObject,
  FilterOperators,
  QueryOptions,
  QueryResult,
  PaginationMetadata,
  RangeMetadata,
  QueryMetadata,
  Cursor,
} from '../types.ts';
import { createHash } from "node:crypto";

// ============================================================================
// Filter Engine
// ============================================================================

/**
 * Test if a value matches a filter operator
 */
export function matchesOperator(value: any, operator: FilterOperators): boolean {
  // Comparison
  if (operator.$eq !== undefined) {
    return value === operator.$eq;
  }
  if (operator.$ne !== undefined) {
    return value !== operator.$ne;
  }
  if (operator.$gt !== undefined) {
    return value > operator.$gt;
  }
  if (operator.$gte !== undefined) {
    return value >= operator.$gte;
  }
  if (operator.$lt !== undefined) {
    return value < operator.$lt;
  }
  if (operator.$lte !== undefined) {
    return value <= operator.$lte;
  }
  if (operator.$in !== undefined) {
    return operator.$in.includes(value);
  }
  if (operator.$nin !== undefined) {
    return !operator.$nin.includes(value);
  }
  
  // String operations
  if (operator.$contains !== undefined) {
    return typeof value === 'string' && value.includes(operator.$contains);
  }
  if (operator.$startsWith !== undefined) {
    return typeof value === 'string' && value.startsWith(operator.$startsWith);
  }
  if (operator.$endsWith !== undefined) {
    return typeof value === 'string' && value.endsWith(operator.$endsWith);
  }
  if (operator.$regex !== undefined) {
    const regex = new RegExp(operator.$regex);
    return typeof value === 'string' && regex.test(value);
  }
  
  // Array operations
  if (operator.$size !== undefined) {
    return Array.isArray(value) && value.length === operator.$size;
  }
  if (operator.$all !== undefined) {
    return Array.isArray(value) && operator.$all.every((item: any) => value.includes(item));
  }
  if (operator.$elemMatch !== undefined) {
    return Array.isArray(value) && value.some((item: any) => matchesFilter(item, operator.$elemMatch!));
  }
  
  // Existence
  if (operator.$exists !== undefined) {
    const exists = value !== undefined && value !== null;
    return operator.$exists ? exists : !exists;
  }
  if (operator.$type !== undefined) {
    return typeof value === operator.$type;
  }
  
  // Logical (handled separately)
  if (operator.$and !== undefined || operator.$or !== undefined || operator.$not !== undefined) {
    throw new Error('Logical operators must be handled at the object level');
  }
  
  return false;
}

/**
 * Test if an item matches a filter object
 */
export function matchesFilter(item: any, filter: FilterObject): boolean {
  // Handle logical operators
  if (filter.$and) {
    return filter.$and.every((f: FilterObject) => matchesFilter(item, f));
  }
  if (filter.$or) {
    return filter.$or.some((f: FilterObject) => matchesFilter(item, f));
  }
  if (filter.$not) {
    return !matchesFilter(item, filter.$not);
  }
  
  // Handle field filters
  for (const [field, condition] of Object.entries(filter)) {
    // Skip logical operators (already handled)
    if (field.startsWith('$')) continue;
    
    const value = getNestedValue(item, field);
    
    // Simple equality check
    if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
      if (value !== condition) return false;
      continue;
    }
    
    // Operator check
    if (!matchesOperator(value, condition as FilterOperators)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Get nested value from object using dot notation
 * 
 * @example
 * getNestedValue({ user: { name: "Alice" } }, "user.name") // "Alice"
 */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  
  return current;
}

/**
 * Apply filter to array of items
 */
export function applyFilter(
  items: any[],
  options: QueryOptions
): any[] {
  let filtered = items;
  
  // Function filter (takes precedence)
  if (options.where) {
    filtered = filtered.filter(options.where);
  }
  // MongoDB-style filter
  else if (options.filter) {
    filtered = filtered.filter(item => matchesFilter(item, options.filter!));
  }
  
  return filtered;
}

// ============================================================================
// Projection Engine
// ============================================================================

/**
 * Apply projection (select/omit) to an item
 */
export function applyProjection(item: any, options: QueryOptions): any {
  if (!item || typeof item !== 'object') {
    return item;
  }
  
  // Apply transform first
  if (options.transform) {
    item = options.transform(item);
  }
  
  // Select specific fields
  if (options.select && options.select.length > 0) {
    const projected: any = {};
    for (const field of options.select) {
      const value = getNestedValue(item, field);
      setNestedValue(projected, field, value);
    }
    return projected;
  }
  
  // Omit specific fields
  if (options.omit && options.omit.length > 0) {
    const projected = { ...item };
    for (const field of options.omit) {
      deleteNestedValue(projected, field);
    }
    return projected;
  }
  
  return item;
}

/**
 * Set nested value in object using dot notation
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }
  
  current[parts[parts.length - 1]] = value;
}

/**
 * Delete nested value from object using dot notation
 */
function deleteNestedValue(obj: any, path: string): void {
  const parts = path.split('.');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      return;
    }
    current = current[part];
  }
  
  delete current[parts[parts.length - 1]];
}

// ============================================================================
// Sorting Engine
// ============================================================================

/**
 * Parse sort string (e.g., "date DESC", "name ASC")
 */
function parseSortString(sort: string): Record<string, 1 | -1> {
  const parts = sort.trim().split(/\s+/);
  const field = parts[0];
  const order = parts[1]?.toUpperCase() === 'DESC' ? -1 : 1;
  return { [field]: order };
}

/**
 * Apply sorting to array of items
 */
export function applySort(items: any[], options: QueryOptions): any[] {
  if (!options.sort) {
    return items;
  }
  
  const sortObj = typeof options.sort === 'string'
    ? parseSortString(options.sort)
    : options.sort;
  
  const sortedItems = [...items];
  
  sortedItems.sort((a, b) => {
    for (const [field, order] of Object.entries(sortObj)) {
      const aVal = getNestedValue(a, field);
      const bVal = getNestedValue(b, field);
      
      // Handle null/undefined
      if (aVal === null || aVal === undefined) return order;
      if (bVal === null || bVal === undefined) return -order;
      
      // Compare
      if (aVal < bVal) return -order;
      if (aVal > bVal) return order;
    }
    return 0;
  });
  
  return sortedItems;
}

// ============================================================================
// Pagination Engine
// ============================================================================

/**
 * Parse range string (e.g., "0-99", "bytes=0-1023")
 */
export function parseRange(range: string | { start: number; end: number }): { start: number; end: number } {
  if (typeof range === 'object') {
    return range;
  }
  
  // Remove "bytes=" prefix if present
  const rangeStr = range.replace(/^bytes=/, '');
  const [start, end] = rangeStr.split('-').map(s => parseInt(s, 10));
  
  return { start, end };
}

/**
 * Apply range to items
 */
export function applyRange(
  items: any[],
  options: QueryOptions
): { items: any[]; range: RangeMetadata } {
  if (!options.range) {
    throw new Error('Range option is required');
  }
  
  const { start, end } = parseRange(options.range);
  const actualEnd = Math.min(end + 1, items.length); // end is inclusive
  const sliced = items.slice(start, actualEnd);
  
  return {
    items: sliced,
    range: {
      start,
      end: actualEnd - 1,
      total: items.length,
      contentRange: `items ${start}-${actualEnd - 1}/${items.length}`
    }
  };
}

/**
 * Apply page-based pagination
 */
export function applyPagePagination(
  items: any[],
  options: QueryOptions
): { items: any[]; pagination: PaginationMetadata } {
  const page = options.page || 1;
  const pageSize = options.pageSize || 10;
  
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedItems = items.slice(start, end);
  
  const totalPages = Math.ceil(items.length / pageSize);
  
  // Generate cursor for next page
  const nextCursor = end < items.length
    ? encodeCursor({
        lastId: String(end),
        lastValue: end,
        direction: 'forward'
      })
    : undefined;
  
  const previousCursor = page > 1
    ? encodeCursor({
        lastId: String(start - pageSize),
        lastValue: start - pageSize,
        direction: 'backward'
      })
    : undefined;
  
  return {
    items: paginatedItems,
    pagination: {
      page,
      pageSize,
      totalItems: items.length,
      totalPages,
      hasNext: end < items.length,
      hasPrevious: page > 1,
      nextCursor,
      previousCursor
    }
  };
}

/**
 * Apply cursor-based pagination
 */
export function applyCursorPagination(
  items: any[],
  options: QueryOptions
): { items: any[]; pagination: PaginationMetadata } {
  if (!options.cursor) {
    throw new Error('Cursor is required for cursor-based pagination');
  }
  
  const cursor = decodeCursor(options.cursor);
  if (!cursor) {
    // Invalid cursor — fall back to first page
    return applyPagePagination(items, { ...options, page: 1 });
  }
  const pageSize = options.pageSize || 10;

  // Find starting position based on cursor
  let start = parseInt(cursor.lastId, 10);
  if (cursor.direction === 'backward') {
    start = Math.max(0, start - pageSize);
  } else {
    start = start;
  }
  
  const end = start + pageSize;
  const paginatedItems = items.slice(start, end);
  
  const nextCursor = end < items.length
    ? encodeCursor({
        lastId: String(end),
        lastValue: end,
        direction: 'forward'
      })
    : undefined;
  
  const previousCursor = start > 0
    ? encodeCursor({
        lastId: String(start - pageSize),
        lastValue: start - pageSize,
        direction: 'backward'
      })
    : undefined;
  
  return {
    items: paginatedItems,
    pagination: {
      page: Math.floor(start / pageSize) + 1,
      pageSize,
      totalItems: items.length,
      totalPages: Math.ceil(items.length / pageSize),
      hasNext: end < items.length,
      hasPrevious: start > 0,
      nextCursor,
      previousCursor
    }
  };
}

/**
 * Encode cursor to base64
 */
export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  return btoa(json);
}

/**
 * Decode cursor from base64
 */
export function decodeCursor(encoded: string): Cursor | null {
  try {
    const json = atob(encoded);
    return JSON.parse(json);
  } catch {
    return null; // Invalid cursor — treat as no cursor
  }
}

// ============================================================================
// Query Execution
// ============================================================================

/**
 * Execute a complete query on items
 */
export function executeQuery(
  items: any[],
  options: QueryOptions = {}
): QueryResult {
  const startTime = Date.now();
  const itemsScanned = items.length;
  
  // 1. Filter
  let filtered = applyFilter(items, options);
  
  // 2. Sort
  if (options.sort) {
    filtered = applySort(filtered, options);
  }
  
  // 3. Projection (before pagination to reduce data size)
  const projected = filtered.map(item => applyProjection(item, options));
  
  // 4. Pagination or Range
  let result: QueryResult;
  
  if (options.range) {
    const { items: rangedItems, range } = applyRange(projected, options);
    result = {
      data: rangedItems,
      range,
      meta: {
        executionTime: Date.now() - startTime,
        itemsScanned,
        itemsReturned: rangedItems.length
      }
    };
  } else if (options.cursor) {
    const { items: paginatedItems, pagination } = applyCursorPagination(projected, options);
    result = {
      data: paginatedItems,
      pagination,
      meta: {
        executionTime: Date.now() - startTime,
        itemsScanned,
        itemsReturned: paginatedItems.length
      }
    };
  } else if (options.page || options.pageSize) {
    const { items: paginatedItems, pagination } = applyPagePagination(projected, options);
    result = {
      data: paginatedItems,
      pagination,
      meta: {
        executionTime: Date.now() - startTime,
        itemsScanned,
        itemsReturned: paginatedItems.length
      }
    };
  } else {
    // No pagination - apply limit/skip
    let finalItems = projected;
    
    if (options.skip) {
      finalItems = finalItems.slice(options.skip);
    }
    
    if (options.limit) {
      finalItems = finalItems.slice(0, options.limit);
    }
    
    result = {
      data: finalItems,
      meta: {
        executionTime: Date.now() - startTime,
        itemsScanned,
        itemsReturned: finalItems.length
      }
    };
  }
  
  // Include metadata if requested
  if (!options.includeMeta) {
    delete result.meta;
  }
  
  return result;
}

