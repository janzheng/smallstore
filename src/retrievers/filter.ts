/**
 * Filter Retriever
 * 
 * Simple field matching with basic operators.
 * Like SQL WHERE clause but simpler and in-memory.
 */

import type { DataType } from '../types.ts';
import type { RetrievalAdapter, RetrievalResult } from './base.ts';
import { createMetadata } from './base.ts';

/**
 * Filter retriever options
 */
export interface FilterRetrieverOptions {
  /** Single filter predicate */
  where?: Record<string, any>;
  
  /** Multiple conditions (all must match - AND) */
  and?: Record<string, any>[];
  
  /** Multiple conditions (any can match - OR) */
  or?: Record<string, any>[];
}

/**
 * Filter Retriever
 * 
 * Filter array items by field values.
 * Supports exact match and basic operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $contains
 */
export class FilterRetriever implements RetrievalAdapter {
  readonly name = 'filter';
  readonly capabilities = {
    name: 'filter',
    type: 'filter' as const,
    supportedTypes: ['object'] as DataType[],
  };

  async retrieve(data: any, options?: FilterRetrieverOptions): Promise<RetrievalResult> {
    const array = Array.isArray(data) ? data : [data];
    
    const filtered = array.filter((item) => {
      // AND conditions
      if (options?.and) {
        return options.and.every(pred => this.matchesPredicate(item, pred));
      }
      
      // OR conditions
      if (options?.or) {
        return options.or.some(pred => this.matchesPredicate(item, pred));
      }
      
      // Single predicate
      if (options?.where) {
        return this.matchesPredicate(item, options.where);
      }
      
      return true;
    });
    
    return {
      data: filtered,
      metadata: createMetadata('filter', filtered, array, {
        filterRate: array.length > 0 ? filtered.length / array.length : 0
      })
    };
  }

  /**
   * Check if item matches predicate
   */
  private matchesPredicate(item: any, predicate: Record<string, any>): boolean {
    for (const [key, condition] of Object.entries(predicate)) {
      const value = this.getNestedValue(item, key);
      
      if (!this.matchesCondition(value, condition)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if value matches condition
   * 
   * Supports:
   * - Simple value: { field: "value" } - exact match
   * - Operators: { field: { $eq: "value" } }
   */
  private matchesCondition(value: any, condition: any): boolean {
    // Simple value (exact match)
    if (typeof condition !== 'object' || condition === null) {
      return value === condition;
    }
    
    // Operators
    if ('$eq' in condition) return value === condition.$eq;
    if ('$ne' in condition) return value !== condition.$ne;
    if ('$gt' in condition) return value > condition.$gt;
    if ('$gte' in condition) return value >= condition.$gte;
    if ('$lt' in condition) return value < condition.$lt;
    if ('$lte' in condition) return value <= condition.$lte;
    if ('$in' in condition) return condition.$in.includes(value);
    if ('$contains' in condition) {
      if (Array.isArray(value)) return value.includes(condition.$contains);
      if (typeof value === 'string') return value.includes(condition.$contains);
      return false;
    }
    
    // Default: equality
    return value === condition;
  }

  /**
   * Get nested value from object using dot notation
   * Example: "user.address.city" → obj.user?.address?.city
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((curr, key) => curr?.[key], obj);
  }
}

