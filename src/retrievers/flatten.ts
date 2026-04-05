/**
 * Flatten Retriever
 * 
 * Flatten nested objects to flat key-value pairs.
 * Like Python's pandas.json_normalize() or lodash.flattenDeep()
 */

import type { DataType } from '../types.ts';
import type { RetrievalAdapter, RetrievalResult } from './base.ts';
import { createMetadata } from './base.ts';

/**
 * Flatten retriever options
 */
export interface FlattenRetrieverOptions {
  /** Maximum depth to flatten */
  maxDepth?: number;
  
  /** Separator for nested keys (e.g., "." for "user.address.city") */
  separator?: string;
  
  /** How to handle arrays: 'keep' (leave as-is) or 'flatten' (create indexed keys) */
  arrays?: 'keep' | 'flatten';
}

/**
 * Flatten Retriever
 * 
 * Flatten nested objects to flat structure.
 * { user: { name: "Alice", address: { city: "NYC" } } }
 * → { "user.name": "Alice", "user.address.city": "NYC" }
 */
export class FlattenRetriever implements RetrievalAdapter {
  readonly name = 'flatten';
  readonly capabilities = {
    name: 'flatten',
    type: 'transform' as const,
    supportedTypes: ['object'] as DataType[],
  };

  async retrieve(data: any, options?: FlattenRetrieverOptions): Promise<RetrievalResult> {
    const separator = options?.separator || '.';
    const maxDepth = options?.maxDepth ?? Infinity;
    const arrays = options?.arrays || 'keep';
    
    const flattened = Array.isArray(data)
      ? data.map(item => this.flatten(item, '', separator, maxDepth, arrays, 0))
      : this.flatten(data, '', separator, maxDepth, arrays, 0);
    
    return {
      data: flattened,
      metadata: createMetadata('flatten', flattened, data)
    };
  }

  /**
   * Flatten object recursively
   */
  private flatten(
    obj: any,
    prefix: string,
    separator: string,
    maxDepth: number,
    arrays: string,
    currentDepth: number
  ): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (currentDepth >= maxDepth) {
      return obj;
    }
    
    const result: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}${separator}${key}` : key;
      
      // Handle arrays
      if (Array.isArray(value)) {
        if (arrays === 'flatten') {
          value.forEach((item, i) => {
            const arrayKey = `${newKey}${separator}${i}`;
            if (typeof item === 'object' && item !== null) {
              Object.assign(result, this.flatten(item, arrayKey, separator, maxDepth, arrays, currentDepth + 1));
            } else {
              result[arrayKey] = item;
            }
          });
        } else {
          result[newKey] = value;
        }
      }
      // Handle nested objects
      else if (typeof value === 'object' && value !== null) {
        Object.assign(result, this.flatten(value, newKey, separator, maxDepth, arrays, currentDepth + 1));
      }
      // Handle primitives
      else {
        result[newKey] = value;
      }
    }
    
    return result;
  }
}

