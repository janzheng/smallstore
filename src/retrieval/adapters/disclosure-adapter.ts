/**
 * DisclosureWrapper — wraps ProgressiveStore as a RetrievalProvider
 */

import type { ProgressiveStore } from '../../disclosure/store.ts';
import type {
  RetrievalProvider,
  RetrievalInput,
  RetrievalOutput,
} from '../types.ts';

export class DisclosureWrapper implements RetrievalProvider {
  readonly name = 'disclosure';
  readonly type = 'disclosure' as const;

  constructor(private progressiveStore: ProgressiveStore) {}

  async retrieve(
    input: RetrievalInput,
    options?: Record<string, any>,
  ): Promise<RetrievalOutput> {
    const start = performance.now();

    // If a specific path is in the data (from a prior search step), disclose it
    if (options?.path) {
      const disclosed = await this.progressiveStore.disclose(options.path, {
        query: input.query,
        depth: options?.depth ?? 'overview',
        ...options,
      });
      return {
        data: disclosed,
        metadata: {
          provider: this.name,
          type: 'disclosure',
          itemsReturned: 1,
          level: disclosed.level,
          executionTimeMs: performance.now() - start,
        },
      };
    }

    // Otherwise, discover relevant items
    const result = await this.progressiveStore.discoverRelevant({
      query: input.query,
      focus: options?.focus,
      depth: options?.depth ?? 'overview',
      maxItems: options?.maxItems ?? options?.limit ?? 10,
      activeSkills: options?.activeSkills,
      relevanceThreshold: options?.relevanceThreshold,
      includeRelatedSkills: options?.includeRelatedSkills,
    });

    return {
      data: result.items,
      metadata: {
        provider: this.name,
        type: 'disclosure',
        itemsReturned: result.items.length,
        itemsTotal: result.totalMatches,
        activeSkills: result.activeSkills,
        executionTimeMs: performance.now() - start,
      },
    };
  }
}
