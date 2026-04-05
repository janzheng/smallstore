/**
 * Structured Retriever
 * 
 * Normalize everything to consistent object format.
 * Useful for APIs that expect uniform data structures.
 */

import type { DataType } from '../types.ts';
import type { RetrievalAdapter, RetrievalResult } from './base.ts';
import { createMetadata } from './base.ts';

/**
 * Structured retriever options
 */
export interface StructuredRetrieverOptions {
  /** Wrap primitive values in objects? */
  wrapPrimitives?: boolean;
  
  /** Key name for wrapped primitive values */
  valueKey?: string;
  
  /** Add _index field to each item? */
  addIndex?: boolean;
}

/**
 * Structured Retriever
 * 
 * Normalize heterogeneous data to consistent object format.
 * Perfect for mixed arrays like: ["text", { obj: 1 }, 42]
 */
export class StructuredRetriever implements RetrievalAdapter {
  readonly name = 'structured';
  readonly capabilities = {
    name: 'structured',
    type: 'transform' as const,
    supportedTypes: ['object', 'kv'] as DataType[],
  };

  async retrieve(data: any, options?: StructuredRetrieverOptions): Promise<RetrievalResult> {
    const wrapPrimitives = options?.wrapPrimitives ?? true;
    const valueKey = options?.valueKey || 'value';
    const addIndex = options?.addIndex ?? false;
    
    const structured = Array.isArray(data)
      ? data.map((item, i) => this.toStructured(item, i, { wrapPrimitives, valueKey, addIndex }))
      : this.toStructured(data, 0, { wrapPrimitives, valueKey, addIndex });
    
    return {
      data: structured,
      metadata: createMetadata('structured', structured, data)
    };
  }

  /**
   * Convert item to structured format
   */
  private toStructured(item: any, index: number, options: any): any {
    // Already an object? Return as-is or augment
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const obj = { ...item };
      if (options.addIndex) obj._index = index;
      return obj;
    }
    
    // Array? Recursively convert
    if (Array.isArray(item)) {
      return item.map((subItem, i) => this.toStructured(subItem, i, options));
    }
    
    // Primitive? Wrap if requested
    if (options.wrapPrimitives) {
      const obj: any = {
        [options.valueKey]: item,
        _type: typeof item
      };
      if (options.addIndex) obj._index = index;
      return obj;
    }
    
    return item;
  }
}

