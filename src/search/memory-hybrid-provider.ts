/**
 * In-Memory Hybrid Search Provider
 *
 * Combines BM25 full-text search with vector similarity search using
 * Reciprocal Rank Fusion (RRF). Both sub-providers must be supplied.
 *
 * hybridAlpha controls the blend:
 *   0.0 = pure vector
 *   0.5 = equal weight (default)
 *   1.0 = pure BM25
 *
 * Also supports plain 'bm25' and 'vector' search types by delegating
 * to the appropriate sub-provider, so you can use a single hybrid
 * provider for all three search modes.
 */

import type { SearchProvider, SearchProviderOptions, SearchProviderResult } from '../types.ts';
import type { MemoryBm25SearchProvider } from './memory-bm25-provider.ts';
import type { MemoryVectorSearchProvider } from './memory-vector-provider.ts';

export interface MemoryHybridConfig {
  bm25: MemoryBm25SearchProvider;
  vector: MemoryVectorSearchProvider;
  /** Default alpha for hybrid search (0=pure vector, 1=pure bm25). Default: 0.5 */
  defaultAlpha?: number;
  /** RRF constant k (higher = less emphasis on top ranks). Default: 60 */
  rrfK?: number;
}

export class MemoryHybridSearchProvider implements SearchProvider {
  readonly name = 'memory-hybrid';
  readonly supportedTypes = ['bm25', 'vector', 'hybrid'] as const;

  private bm25: MemoryBm25SearchProvider;
  private vector: MemoryVectorSearchProvider;
  private defaultAlpha: number;
  private rrfK: number;

  constructor(config: MemoryHybridConfig) {
    this.bm25 = config.bm25;
    this.vector = config.vector;
    this.defaultAlpha = config.defaultAlpha ?? 0.5;
    this.rrfK = config.rrfK ?? 60;
  }

  /** Index into both sub-providers */
  async index(key: string, value: any): Promise<void> {
    // BM25 is sync, vector is async
    this.bm25.index(key, value);
    await this.vector.index(key, value);
  }

  /** Remove from both sub-providers */
  async remove(key: string): Promise<void> {
    this.bm25.remove(key);
    this.vector.remove(key);
  }

  /** Rebuild both sub-providers */
  async rebuild(prefix?: string): Promise<{ indexed: number; skipped: number }> {
    const bm25Result = this.bm25.rebuild(prefix);
    const vectorResult = this.vector.rebuild(prefix);
    return {
      indexed: Math.max(bm25Result.indexed, vectorResult.indexed),
      skipped: Math.max(bm25Result.skipped, vectorResult.skipped),
    };
  }

  /** Search using the requested type, defaulting to hybrid */
  async search(query: string, options?: SearchProviderOptions): Promise<SearchProviderResult[]> {
    const type = options?.type ?? 'hybrid';

    switch (type) {
      case 'bm25':
        return this.bm25.search(query, options);
      case 'vector':
        return this.vector.search(query, options);
      case 'hybrid':
        return this.hybridSearch(query, options);
      default:
        return this.hybridSearch(query, options);
    }
  }

  /** Clear both sub-providers */
  clear(): void {
    this.bm25.clear();
    this.vector.clear();
  }

  // --- Hybrid search with Reciprocal Rank Fusion ---

  private async hybridSearch(query: string, options?: SearchProviderOptions): Promise<SearchProviderResult[]> {
    const limit = options?.limit ?? 10;
    const alpha = options?.hybridAlpha ?? this.defaultAlpha;

    // Fetch more candidates from each to ensure good fusion
    const candidateLimit = Math.max(limit * 3, 20);
    const subOptions = { ...options, limit: candidateLimit };

    // Run both searches in parallel
    const [bm25Results, vectorResults] = await Promise.all([
      alpha > 0 ? this.bm25.search(query, subOptions) : Promise.resolve([]),
      alpha < 1 ? this.vector.search(query, subOptions) : Promise.resolve([]),
    ]);

    // Reciprocal Rank Fusion
    const fused = new Map<string, { score: number; snippet: string; distance?: number }>();
    const k = this.rrfK;

    // BM25 contribution (weighted by alpha)
    for (let i = 0; i < bm25Results.length; i++) {
      const r = bm25Results[i];
      const rrfScore = alpha * (1 / (k + i + 1));
      const existing = fused.get(r.key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        fused.set(r.key, { score: rrfScore, snippet: r.snippet });
      }
    }

    // Vector contribution (weighted by 1 - alpha)
    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const rrfScore = (1 - alpha) * (1 / (k + i + 1));
      const existing = fused.get(r.key);
      if (existing) {
        existing.score += rrfScore;
        if (r.distance !== undefined) existing.distance = r.distance;
      } else {
        fused.set(r.key, { score: rrfScore, snippet: r.snippet, distance: r.distance });
      }
    }

    // Sort by fused score
    const sorted = Array.from(fused.entries())
      .map(([key, val]) => ({ key, ...val }))
      .sort((a, b) => b.score - a.score);

    // Normalize scores to 0-1
    const maxScore = sorted.length > 0 ? sorted[0].score : 1;
    const results: SearchProviderResult[] = sorted.slice(0, limit).map(s => ({
      key: s.key,
      score: maxScore > 0 ? s.score / maxScore : 0,
      snippet: s.snippet,
      distance: s.distance,
    }));

    if (options?.threshold !== undefined) {
      return results.filter(r => r.score >= options.threshold!);
    }

    return results;
  }
}
