/**
 * In-Memory BM25 Search Provider
 *
 * Pure JS BM25 full-text search that works with any adapter.
 * Maintains an in-memory inverted index — good for small-medium collections
 * (up to ~10k docs). No external dependencies.
 *
 * BM25 parameters: k1=1.2 (term frequency saturation), b=0.75 (length normalization)
 */

import type { SearchProvider, SearchProviderOptions, SearchProviderResult } from '../types.ts';
import { extractSearchableText } from './text-extractor.ts';

/** Tokenize text: lowercase, split on non-alphanumeric, filter short tokens */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
}

interface DocEntry {
  key: string;
  text: string;
  tokens: string[];
  termFreqs: Map<string, number>;
}

export class MemoryBm25SearchProvider implements SearchProvider {
  readonly name = 'memory-bm25';
  readonly supportedTypes = ['bm25'] as const;

  // BM25 parameters
  private k1 = 1.2;
  private b = 0.75;

  // Index state
  private docs = new Map<string, DocEntry>();
  private docFreqs = new Map<string, number>(); // term → number of docs containing it
  private avgDocLength = 0;

  /** Index a single key/value */
  index(key: string, value: any): void {
    const text = extractSearchableText(value);
    if (!text) return;

    const tokens = tokenize(text);
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
    }

    const newEntry: DocEntry = { key, text, tokens, termFreqs };

    // Build new docFreqs in local variables before mutating state
    // Clone current docFreqs
    const newDocFreqs = new Map(this.docFreqs);

    // Remove old entry's contribution from docFreqs
    const existing = this.docs.get(key);
    if (existing) {
      for (const term of existing.termFreqs.keys()) {
        const count = newDocFreqs.get(term) || 0;
        if (count <= 1) {
          newDocFreqs.delete(term);
        } else {
          newDocFreqs.set(term, count - 1);
        }
      }
    }

    // Add new entry's contribution to docFreqs
    for (const term of termFreqs.keys()) {
      newDocFreqs.set(term, (newDocFreqs.get(term) || 0) + 1);
    }

    // Calculate new avgDocLength
    let totalTokens = 0;
    const newDocsSize = existing ? this.docs.size : this.docs.size + 1;
    for (const [docKey, doc] of this.docs) {
      if (docKey === key) continue; // skip old entry
      totalTokens += doc.tokens.length;
    }
    totalTokens += tokens.length; // add new entry
    const newAvgDocLength = newDocsSize > 0 ? totalTokens / newDocsSize : 0;

    // Apply all mutations synchronously (no awaits, cannot be interrupted)
    this.docs.set(key, newEntry);
    this.docFreqs = newDocFreqs;
    this.avgDocLength = newAvgDocLength;
  }

  /** Remove a key from the index */
  remove(key: string): void {
    this.removeFromIndex(key);
    this.updateAvgDocLength();
  }

  /** Search indexed content using BM25 scoring */
  search(query: string, options?: SearchProviderOptions): SearchProviderResult[] {
    const limit = options?.limit ?? 20;
    if (!query || query.trim().length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const N = this.docs.size;
    if (N === 0) return [];

    const scores: Array<{ key: string; score: number; text: string }> = [];

    for (const [key, doc] of this.docs) {
      // Skip internal metadata/index keys
      if (key.startsWith('smallstore:meta:') || key.startsWith('smallstore:index:')) continue;
      // Collection scoping
      if (options?.collection && !key.includes(options.collection)) continue;

      let score = 0;
      const docLen = doc.tokens.length;

      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) || 0;
        if (tf === 0) continue;

        const df = this.docFreqs.get(term) || 0;
        // IDF with smoothing (avoid log(0) and negative IDF)
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        // BM25 TF component
        const tfNorm = (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * docLen / this.avgDocLength));

        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ key, score, text: doc.text });
      }
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Normalize scores to 0-1 via sigmoid (same as SQLite provider)
    const maxScore = scores.length > 0 ? scores[0].score : 1;
    const results = scores.slice(0, limit).map(s => ({
      key: s.key,
      score: 1 / (1 + Math.exp(-(s.score / Math.max(maxScore, 1) * 10 - 5) / 3)),
      snippet: this.generateSnippet(s.text, queryTokens),
    }));

    // Apply threshold
    if (options?.threshold !== undefined) {
      return results.filter(r => r.score >= options.threshold!);
    }

    return results;
  }

  /** Rebuild index from a data source (requires external iteration) */
  rebuild(_prefix?: string): { indexed: number; skipped: number } {
    // For in-memory provider, rebuild is a no-op since data lives in memory.
    // The caller (adapter set() calls) keeps the index up to date.
    // If a full rebuild is needed, clear and re-index externally.
    return { indexed: this.docs.size, skipped: 0 };
  }

  /** Clear all indexed data (useful for rebuild) */
  clear(): void {
    this.docs.clear();
    this.docFreqs.clear();
    this.avgDocLength = 0;
  }

  // --- Private helpers ---

  private removeFromIndex(key: string): void {
    const existing = this.docs.get(key);
    if (!existing) return;

    // Decrement document frequencies
    for (const term of existing.termFreqs.keys()) {
      const count = this.docFreqs.get(term) || 0;
      if (count <= 1) {
        this.docFreqs.delete(term);
      } else {
        this.docFreqs.set(term, count - 1);
      }
    }

    this.docs.delete(key);
  }

  private updateAvgDocLength(): void {
    if (this.docs.size === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const doc of this.docs.values()) {
      total += doc.tokens.length;
    }
    this.avgDocLength = total / this.docs.size;
  }

  private generateSnippet(text: string, queryTokens: string[]): string {
    const lower = text.toLowerCase();
    let bestPos = 0;
    let bestScore = -1;

    // Find the position with the most query term matches nearby
    for (const token of queryTokens) {
      const idx = lower.indexOf(token);
      if (idx >= 0 && idx > bestScore) {
        bestPos = idx;
        bestScore = idx;
      }
    }

    // Extract snippet around best position
    const snippetLen = 120;
    const start = Math.max(0, bestPos - 30);
    const end = Math.min(text.length, start + snippetLen);
    let snippet = text.slice(start, end).trim();

    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';

    return snippet;
  }
}
