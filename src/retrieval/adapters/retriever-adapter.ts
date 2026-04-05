/**
 * RetrieverWrapper — wraps an existing RetrievalAdapter as a RetrievalProvider
 */

import type { RetrievalAdapter } from '../../types.ts';
import type {
  RetrievalProvider,
  RetrievalProviderType,
  RetrievalInput,
  RetrievalOutput,
} from '../types.ts';

/** Map existing capability types to unified types */
function mapType(
  capType: 'transform' | 'filter' | 'metadata',
): RetrievalProviderType {
  return capType;
}

export class RetrieverWrapper implements RetrievalProvider {
  readonly name: string;
  readonly type: RetrievalProviderType;

  constructor(private retriever: RetrievalAdapter) {
    this.name = retriever.name;
    this.type = mapType(retriever.capabilities.type);
  }

  async retrieve(
    input: RetrievalInput,
    options?: Record<string, any>,
  ): Promise<RetrievalOutput> {
    const start = performance.now();

    const result = await this.retriever.retrieve(input.data, options);

    return {
      data: result.data,
      metadata: {
        provider: this.name,
        type: this.type,
        itemsReturned: result.metadata.itemsReturned,
        itemsTotal: result.metadata.itemsTotal,
        executionTimeMs: performance.now() - start,
      },
    };
  }
}
