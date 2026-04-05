/**
 * Base types and helpers for retrieval adapters
 * 
 * Phase 2: Retrieval system foundation
 */

import type { 
  DataType,
  RetrievalAdapter, 
  RetrievalCapabilities, 
  RetrievalOptions, 
  RetrievalResult,
  RetrievalMetadata,
} from '../types.ts';

// Re-export types for convenience
export type { 
  RetrievalAdapter, 
  RetrievalCapabilities, 
  RetrievalOptions, 
  RetrievalResult,
  RetrievalMetadata,
};

/**
 * Helper to create retrieval metadata
 * 
 * Standardizes metadata format across all retrievers
 * 
 * @param retrieverName - Name of retriever that produced this result
 * @param data - Transformed/filtered data
 * @param originalData - Original data before transformation
 * @param extra - Additional retriever-specific metadata
 * @returns Standardized metadata object
 */
export function createMetadata(
  retrieverName: string,
  data: any,
  originalData: any,
  extra?: Record<string, any>
): RetrievalMetadata {
  return {
    retriever: retrieverName,
    itemsReturned: Array.isArray(data) ? data.length : 1,
    itemsTotal: Array.isArray(originalData) ? originalData.length : 1,
    ...extra
  };
}

