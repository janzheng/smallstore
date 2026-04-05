/**
 * Metadata Retriever
 * 
 * Get collection info WITHOUT loading all data.
 * Useful for checking collection size, types, and structure.
 */

import type { DataType } from '../types.ts';
import type { RetrievalAdapter, RetrievalResult } from './base.ts';
import { createMetadata } from './base.ts';

/**
 * Metadata retriever options
 */
export interface MetadataRetrieverOptions {
  /** Analyze types in array (sample items) */
  analyzeTypes?: boolean;
  
  /** Include size statistics for arrays */
  includeSizes?: boolean;
}

/**
 * Metadata Retriever
 * 
 * Returns metadata about a collection without returning the actual data.
 * Like running `ls -la` instead of reading the file.
 */
export class MetadataRetriever implements RetrievalAdapter {
  readonly name = 'metadata';
  readonly capabilities = {
    name: 'metadata',
    type: 'metadata' as const,
    supportedTypes: ['object', 'blob', 'kv'] as DataType[],
  };

  async retrieve(data: any, options?: MetadataRetrieverOptions): Promise<RetrievalResult> {
    const metadata: any = {
      itemCount: Array.isArray(data) ? data.length : 1,
      dataType: this.detectType(data),
      isEmpty: this.isEmpty(data),
    };

    // Optional: Analyze types in array
    if (options?.analyzeTypes && Array.isArray(data)) {
      metadata.types = this.analyzeTypes(data);
    }

    // Optional: Size statistics
    if (options?.includeSizes && Array.isArray(data)) {
      metadata.sizes = this.analyzeSizes(data);
    }
    
    // Special handling for blobs
    if (data instanceof Uint8Array) {
      metadata.sizeBytes = data.length;
      metadata.dataType = 'blob';
    }

    return {
      data: metadata,
      metadata: createMetadata('metadata', metadata, data)
    };
  }

  private detectType(data: any): string {
    if (Array.isArray(data)) return 'array';
    if (data instanceof Uint8Array) return 'blob';
    if (typeof data === 'object') return 'object';
    return typeof data;
  }

  private isEmpty(data: any): boolean {
    if (Array.isArray(data)) return data.length === 0;
    if (typeof data === 'object' && data !== null) return Object.keys(data).length === 0;
    return data === null || data === undefined;
  }

  private analyzeTypes(array: any[]): Record<string, number> {
    const types: Record<string, number> = {};
    for (const item of array) {
      const type = typeof item;
      types[type] = (types[type] || 0) + 1;
    }
    return types;
  }

  private analyzeSizes(array: any[]): { min: number; max: number; avg: number } {
    if (array.length === 0) {
      return { min: 0, max: 0, avg: 0 };
    }
    
    const sizes = array.map(item => {
      try {
        return JSON.stringify(item).length;
      } catch {
        return 0;
      }
    });
    
    return {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      avg: sizes.reduce((a, b) => a + b, 0) / sizes.length
    };
  }
}

