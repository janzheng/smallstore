/**
 * In-Memory Vector Search Provider
 *
 * Brute-force cosine similarity search with an async embed callback.
 * Good for small collections (<10k items). Zero external dependencies —
 * the caller provides their own embedding function.
 *
 * Vectors are stored in-memory alongside the key. For persistence,
 * the adapter (or a wrapper) should store vectors in smallstore and
 * reload them via rebuild().
 */

import type { SearchProvider, SearchProviderOptions, SearchProviderResult } from '../types.ts';
import { extractSearchableText } from './text-extractor.ts';
import { isInternalKey, keyMatchesCollection } from '../utils/path.ts';

/** Configuration for MemoryVectorSearchProvider */
export interface MemoryVectorConfig {
  /** Async function that turns text into a vector. You wire this to your embedding API. */
  embed: (text: string) => number[] | Promise<number[]>;
  /** Vector dimensions (e.g., 1536 for OpenAI text-embedding-3-small). Used for validation. */
  dimensions?: number;
  /** Distance metric (default: cosine) */
  metric?: 'cosine' | 'euclidean' | 'dot';
}

interface VectorEntry {
  key: string;
  text: string;
  vector: number[];
}

export class MemoryVectorSearchProvider implements SearchProvider {
  readonly name = 'memory-vector';
  readonly supportedTypes = ['vector'] as const;

  private embedFn: (text: string) => number[] | Promise<number[]>;
  private dimensions?: number;
  private metric: 'cosine' | 'euclidean' | 'dot';
  private entries = new Map<string, VectorEntry>();

  constructor(config: MemoryVectorConfig) {
    this.embedFn = config.embed;
    this.dimensions = config.dimensions;
    this.metric = config.metric ?? 'cosine';
  }

  /** Index a key/value — extracts text and computes embedding */
  async index(key: string, value: any): Promise<void> {
    if (isInternalKey(key)) return;
    const text = extractSearchableText(value);
    if (!text) return;

    const vector = await this.embedFn(text);

    if (this.dimensions && vector.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }

    this.entries.set(key, { key, text, vector });
  }

  /** Remove a key from the index */
  remove(key: string): void {
    this.entries.delete(key);
  }

  /** Search by vector similarity */
  async search(query: string, options?: SearchProviderOptions): Promise<SearchProviderResult[]> {
    const limit = options?.limit ?? 10;

    // If a pre-computed query vector is provided, use it; otherwise embed the query text
    let queryVector: number[];
    if (options?.vector && options.vector.length > 0) {
      queryVector = options.vector;
    } else if (query && query.trim().length > 0) {
      queryVector = await this.embedFn(query);
    } else {
      return [];
    }

    if (this.entries.size === 0) return [];

    const scored: Array<{ key: string; score: number; text: string }> = [];

    for (const [key, entry] of this.entries) {
      // Defense in depth: index() already filters internal keys.
      if (isInternalKey(key)) continue;
      // Collection scoping — strict prefix match so "docs" doesn't leak into "old-docs".
      if (options?.collection && !keyMatchesCollection(key, options.collection)) continue;

      const distance = this.computeDistance(queryVector, entry.vector);
      // Convert distance to similarity score (0-1, higher = more similar)
      const score = this.distanceToScore(distance);

      scored.push({ key, score, text: entry.text });
    }

    scored.sort((a, b) => b.score - a.score);

    const results: SearchProviderResult[] = scored.slice(0, limit).map(s => ({
      key: s.key,
      score: s.score,
      snippet: s.text.length > 120 ? s.text.slice(0, 120) + '...' : s.text,
      distance: this.scoreToDistance(s.score),
    }));

    if (options?.threshold !== undefined) {
      return results.filter(r => r.score >= options.threshold!);
    }

    return results;
  }

  /** Rebuild is a no-op for in-memory — caller must re-index */
  rebuild(_prefix?: string): { indexed: number; skipped: number } {
    return { indexed: this.entries.size, skipped: 0 };
  }

  /** Clear all vectors */
  clear(): void {
    this.entries.clear();
  }

  /** Get the stored vector for a key (useful for persistence/debugging) */
  getVector(key: string): number[] | undefined {
    return this.entries.get(key)?.vector;
  }

  /** Bulk-load pre-computed vectors (e.g., from persistence) */
  loadVectors(entries: Array<{ key: string; text: string; vector: number[] }>): void {
    for (const entry of entries) {
      this.entries.set(entry.key, entry);
    }
  }

  /** Get count of indexed vectors */
  get size(): number {
    return this.entries.size;
  }

  // --- Distance computations ---

  private computeDistance(a: number[], b: number[]): number {
    switch (this.metric) {
      case 'cosine': return this.cosineDistance(a, b);
      case 'euclidean': return this.euclideanDistance(a, b);
      case 'dot': return -this.dotProduct(a, b); // negate so lower = more similar
    }
  }

  private distanceToScore(distance: number): number {
    switch (this.metric) {
      case 'cosine': return 1 - distance; // cosine distance is 0-2, similarity is 1-distance
      case 'euclidean': return 1 / (1 + distance); // sigmoid-like mapping
      case 'dot': return 1 / (1 + Math.exp(distance)); // negate was already applied
    }
  }

  private scoreToDistance(score: number): number {
    switch (this.metric) {
      case 'cosine': return 1 - score;
      case 'euclidean': return (1 / score) - 1;
      case 'dot': return -Math.log(1 / score - 1);
    }
  }

  private cosineDistance(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0) return 1; // no similarity
    return 1 - (dot / denom);
  }

  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  private dotProduct(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }
}
