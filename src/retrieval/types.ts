/**
 * Unified Retrieval Layer — Types
 *
 * One interface for search, transform, filter, metadata, and disclosure.
 * Existing SearchProvider and RetrievalAdapter keep working; this layer
 * wraps them into a composable pipeline.
 */

/** What kind of retrieval this provider does */
export type RetrievalProviderType =
  | 'search'      // Indexes + queries (BM25, vector, hybrid, FTS5)
  | 'transform'   // Reshapes data (text, structured, flatten)
  | 'filter'      // Reduces data (filter, slice)
  | 'metadata'    // Returns metadata about data
  | 'disclosure' // Progressive disclosure (skills + summarization)
  | 'empty';      // Empty/no-op result

/**
 * Unified retrieval provider interface.
 *
 * Wraps SearchProvider, RetrievalAdapter, and ProgressiveStore behind
 * one composable interface that can be chained in a pipeline.
 */
export interface RetrievalProvider {
  readonly name: string;
  readonly type: RetrievalProviderType;

  /** Run this provider */
  retrieve(
    input: RetrievalInput,
    options?: Record<string, any>,
  ): Promise<RetrievalOutput>;

  /** Index a key/value (search providers only) */
  index?(key: string, value: any): Promise<void>;
  /** Remove from index (search providers only) */
  remove?(key: string): Promise<void>;
  /** Rebuild index (search providers only) */
  rebuild?(
    prefix?: string,
  ): Promise<{ indexed: number; skipped: number }>;
}

/**
 * Input to a retrieval provider or pipeline step.
 *
 * Search providers use `query`/`vector`. Transform/filter providers use `data`.
 * The pipeline carries all fields forward so downstream steps can access both.
 */
export interface RetrievalInput {
  /** Pre-fetched data (for transform/filter providers) */
  data?: any;

  /** Text query (for search providers) */
  query?: string;

  /** Query embedding (for vector/hybrid search) */
  vector?: number[];

  /** Collection scope */
  collection?: string;

  /** Accumulated metadata from prior pipeline steps */
  pipelineMetadata?: Record<string, any>;
}

/** Output from a retrieval provider */
export interface RetrievalOutput {
  /** Result data — search results array, transformed data, or metadata */
  data: any;

  /** Metadata about this retrieval step */
  metadata: RetrievalOutputMeta;
}

/** Metadata attached to every retrieval output */
export interface RetrievalOutputMeta {
  /** Which provider produced this */
  provider: string;

  /** Provider type */
  type: RetrievalProviderType;

  /** Items returned */
  itemsReturned: number;

  /** Items available before filtering/limiting */
  itemsTotal?: number;

  /** How long this step took (ms) */
  executionTimeMs?: number;

  /** Provider-specific extras */
  [key: string]: any;
}

/**
 * One step in a retrieval pipeline.
 * Provider can be a name (resolved from registry) or an inline instance.
 */
export interface PipelineStep {
  /** Provider name (looked up in registry) or inline instance */
  provider: string | RetrievalProvider;

  /** Options passed to `provider.retrieve()` */
  options?: Record<string, any>;
}
