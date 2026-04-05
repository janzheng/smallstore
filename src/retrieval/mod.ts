/**
 * Unified Retrieval Layer
 *
 * One plugin interface for search, transform, filter, metadata, and disclosure.
 * Compose providers into pipelines that chain data through multiple steps.
 *
 * @example
 * ```typescript
 * import { RetrievalPipeline, SearchProviderWrapper, RetrieverWrapper } from 'smallstore/retrieval';
 *
 * // Wrap existing providers
 * const search = new SearchProviderWrapper(adapter.searchProvider);
 * const filter = new RetrieverWrapper(new FilterRetriever());
 *
 * // Build pipeline: search → filter → slice
 * const pipeline = new RetrievalPipeline()
 *   .add(search, { type: 'bm25', limit: 50 })
 *   .add(filter, { where: { status: 'published' } })
 *   .add('slice', { mode: 'head', take: 10 });
 *
 * const result = await pipeline.execute({ query: 'machine learning' });
 * ```
 */

// Types
export type {
  RetrievalProvider,
  RetrievalProviderType,
  RetrievalInput,
  RetrievalOutput,
  RetrievalOutputMeta,
  PipelineStep,
} from './types.ts';

// Pipeline
export { RetrievalPipeline } from './pipeline.ts';

// Adapters (wrappers for existing systems)
export { SearchProviderWrapper } from './adapters/search-adapter.ts';
export { RetrieverWrapper } from './adapters/retriever-adapter.ts';
export { DisclosureWrapper } from './adapters/disclosure-adapter.ts';
