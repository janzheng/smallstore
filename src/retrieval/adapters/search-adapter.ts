/**
 * SearchProviderWrapper — wraps an existing SearchProvider as a RetrievalProvider
 */

import type { SearchProvider } from '../../types.ts';
import type {
  RetrievalProvider,
  RetrievalInput,
  RetrievalOutput,
} from '../types.ts';

export class SearchProviderWrapper implements RetrievalProvider {
  readonly type = 'search' as const;
  readonly name: string;

  constructor(
    private searchProvider: SearchProvider,
    name?: string,
  ) {
    this.name = name ?? `search:${searchProvider.name}`;
  }

  async retrieve(
    input: RetrievalInput,
    options?: Record<string, any>,
  ): Promise<RetrievalOutput> {
    const start = performance.now();

    const query = input.query ?? '';
    const searchType = options?.type ?? (input.vector ? 'vector' : 'bm25');

    if (!this.searchProvider.supportedTypes.includes(searchType)) {
      throw new Error(
        `Search provider "${this.searchProvider.name}" does not support type "${searchType}". ` +
        `Supported: ${this.searchProvider.supportedTypes.join(', ')}`,
      );
    }

    const rawResults = await this.searchProvider.search(query, {
      limit: options?.limit ?? options?.topK ?? 20,
      collection: input.collection,
      threshold: options?.threshold,
      type: searchType,
      vector: input.vector,
      topK: options?.topK,
      query,
      metric: options?.metric,
      hybridAlpha: options?.hybridAlpha,
    });

    const results = rawResults.map((r) => ({
      key: r.key,
      score: r.score,
      snippet: r.snippet,
      ...(r.distance !== undefined ? { distance: r.distance } : {}),
    }));

    return {
      data: results,
      metadata: {
        provider: this.name,
        type: 'search',
        itemsReturned: results.length,
        searchType,
        executionTimeMs: performance.now() - start,
      },
    };
  }

  async index(key: string, value: any): Promise<void> {
    await this.searchProvider.index(key, value);
  }

  async remove(key: string): Promise<void> {
    await this.searchProvider.remove(key);
  }

  async rebuild(
    prefix?: string,
  ): Promise<{ indexed: number; skipped: number }> {
    return await this.searchProvider.rebuild(prefix);
  }
}
