/**
 * Slice Retriever
 * 
 * Pagination and sampling - like getting products per page.
 * Supports head, tail, random sampling, and range-based pagination.
 */

import type { DataType } from '../types.ts';
import type { RetrievalAdapter, RetrievalResult } from './base.ts';
import { createMetadata } from './base.ts';

/**
 * Slice retriever options
 */
export interface SliceRetrieverOptions {
  /** Slice mode: head (first N), tail (last N), random (random N), range (skip + take) */
  mode?: 'head' | 'tail' | 'random' | 'range';
  
  /** Number of items to take */
  take?: number;
  
  /** Number of items to skip (for range mode) */
  skip?: number;
  
  /** Random seed for reproducible random sampling */
  seed?: number;
}

/**
 * Slice Retriever
 * 
 * Get a subset of data - perfect for pagination and sampling.
 * Like Python's array[0:10] but with more modes.
 */
export class SliceRetriever implements RetrievalAdapter {
  readonly name = 'slice';
  readonly capabilities = {
    name: 'slice',
    type: 'filter' as const,
    supportedTypes: ['object'] as DataType[],
  };

  async retrieve(data: any, options?: SliceRetrieverOptions): Promise<RetrievalResult> {
    const array = Array.isArray(data) ? data : [data];
    const mode = options?.mode || 'head';
    const take = options?.take || 10;
    
    let result: any[];
    
    switch (mode) {
      case 'head':
        result = array.slice(0, take);
        break;
        
      case 'tail':
        result = array.slice(-take);
        break;
        
      case 'random':
        const shuffled = this.shuffle(array, options?.seed);
        result = shuffled.slice(0, take);
        break;
        
      case 'range':
        const skip = options?.skip || 0;
        result = array.slice(skip, skip + take);
        break;
        
      default:
        result = array.slice(0, take);
    }
    
    return {
      data: result,
      metadata: createMetadata('slice', result, array, { 
        mode, 
        take, 
        skip: options?.skip 
      })
    };
  }

  /**
   * Shuffle array using Fisher-Yates algorithm
   */
  private shuffle(array: any[], seed?: number): any[] {
    const arr = [...array];
    const random = seed !== undefined ? this.seededRandom(seed) : Math.random;
    
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    
    return arr;
  }

  /**
   * Create seeded random number generator
   */
  private seededRandom(seed: number) {
    return function() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }
}

