/**
 * Retrievers Module
 * 
 * Export all retrieval adapters
 */

// Export all retrievers
export { MetadataRetriever } from './metadata.ts';
export { SliceRetriever } from './slice.ts';
export { FilterRetriever } from './filter.ts';
export { StructuredRetriever } from './structured.ts';
export { TextRetriever } from './text.ts';
export { FlattenRetriever } from './flatten.ts';

// Export base types
export type { 
  RetrievalAdapter, 
  RetrievalCapabilities, 
  RetrievalOptions, 
  RetrievalResult,
  RetrievalMetadata,
} from './base.ts';
export { createMetadata } from './base.ts';

// Export retriever-specific option types for convenience
export type { MetadataRetrieverOptions } from './metadata.ts';
export type { SliceRetrieverOptions } from './slice.ts';
export type { FilterRetrieverOptions } from './filter.ts';
export type { StructuredRetrieverOptions } from './structured.ts';
export type { TextRetrieverOptions } from './text.ts';
export type { FlattenRetrieverOptions } from './flatten.ts';

