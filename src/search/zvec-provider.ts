/**
 * Zvec Search Provider
 *
 * HNSW-based vector search using Alibaba's zvec — "the SQLite of vector databases."
 * Drop-in replacement for MemoryVectorSearchProvider with O(log n) queries
 * instead of O(n) brute force. Good for 10k-10M items.
 *
 * Requires: npm:@zvec/zvec (native C++ binary, ~37MB)
 *
 * Usage:
 *   const provider = new ZvecSearchProvider({
 *     embed: async (text) => await openai.embeddings.create(...).data[0].embedding,
 *     dimensions: 1536,
 *   });
 */

import type { SearchProvider, SearchProviderOptions, SearchProviderResult } from '../types.ts';
import { extractSearchableText } from './text-extractor.ts';

/** Configuration for ZvecSearchProvider */
export interface ZvecConfig {
  /** Async function that turns text into a vector */
  embed: (text: string) => number[] | Promise<number[]>;
  /** Vector dimensions (required — zvec needs this upfront) */
  dimensions: number;
  /** Distance metric (default: cosine) */
  metric?: 'cosine' | 'euclidean' | 'dot';
  /** Path for persistent storage. If omitted, uses a temp directory (ephemeral). */
  storagePath?: string;
  // Note: ef (HNSW recall tuning) is not yet supported in zvec JS bindings (params object rejected).
  // Queries use zvec's built-in default which works well for most use cases.
}

// Lazy-loaded zvec module — singleton pattern is intentional.
// Zvec should only be initialized once per process; multiple ZvecSearchProvider
// instances share the same underlying module and init state.
let _zvec: any = null;
let _zvecInitialized = false;

async function getZvec() {
  if (!_zvec) {
    _zvec = (await import('@zvec/zvec')).default;
  }
  if (!_zvecInitialized) {
    _zvec.ZVecInitialize({});
    _zvecInitialized = true;
  }
  return _zvec;
}

/** Map our metric names to zvec's MetricType enum */
function resolveMetric(zvec: any, metric: string) {
  switch (metric) {
    case 'cosine': return zvec.ZVecMetricType.COSINE;
    case 'euclidean': return zvec.ZVecMetricType.L2;
    case 'dot': return zvec.ZVecMetricType.IP;
    default: return zvec.ZVecMetricType.COSINE;
  }
}

export class ZvecSearchProvider implements SearchProvider {
  readonly name = 'zvec';
  readonly supportedTypes = ['vector'] as const;

  private embedFn: (text: string) => number[] | Promise<number[]>;
  private dimensions: number;
  private metric: 'cosine' | 'euclidean' | 'dot';
  private storagePath?: string;
  // zvec state (lazy-initialized)
  private collection: any = null;
  private dbPath: string | null = null;
  private tmpDir: string | null = null;

  // Track indexed keys and their text (for snippets)
  private textCache = new Map<string, string>();

  constructor(config: ZvecConfig) {
    this.embedFn = config.embed;
    this.dimensions = config.dimensions;
    this.metric = config.metric ?? 'cosine';
    this.storagePath = config.storagePath;
  }

  /** Lazy-init the zvec collection */
  private async ensureCollection(): Promise<any> {
    if (this.collection) return this.collection;

    const zvec = await getZvec();

    // Determine storage path
    if (this.storagePath) {
      this.dbPath = this.storagePath;
    } else {
      this.tmpDir = await Deno.makeTempDir({ prefix: 'smallstore-zvec-' });
      this.dbPath = `${this.tmpDir}/index.zvec`;
    }

    const schema = new zvec.ZVecCollectionSchema({
      name: 'smallstore_vectors',
      fields: [
        { name: 'text', dataType: zvec.ZVecDataType.STRING },
      ],
      vectors: [
        {
          name: 'emb',
          dimension: this.dimensions,
          dataType: zvec.ZVecDataType.VECTOR_FP32,
          metricType: resolveMetric(zvec, this.metric),
          indexType: zvec.ZVecIndexType.HNSW,
        },
      ],
    });

    this.collection = zvec.ZVecCreateAndOpen(this.dbPath, schema);
    return this.collection;
  }

  /** Index a key/value — extracts text and computes embedding */
  async index(key: string, value: any): Promise<void> {
    const text = extractSearchableText(value);
    if (!text) return;

    const vector = await this.embedFn(text);
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }

    const col = await this.ensureCollection();

    // Upsert — handles both insert and update
    col.upsertSync({
      id: key,
      fields: { text: text.slice(0, 2000) }, // zvec field storage limit
      vectors: { emb: vector },
    });

    this.textCache.set(key, text);
  }

  /** Remove a key from the index */
  async remove(key: string): Promise<void> {
    if (!this.collection) return;
    try {
      this.collection.deleteSync(key);
    } catch {
      // Key may not exist — that's fine
    }
    this.textCache.delete(key);
  }

  /** Search by vector similarity */
  async search(query: string, options?: SearchProviderOptions): Promise<SearchProviderResult[]> {
    if (!this.collection) return [];

    const limit = options?.limit ?? options?.topK ?? 10;

    // Get query vector — either pre-computed or embed the text
    let queryVector: number[];
    if (options?.vector && options.vector.length > 0) {
      queryVector = options.vector;
    } else if (query && query.trim().length > 0) {
      queryVector = await this.embedFn(query);
    } else {
      return [];
    }

    // Build and optimize for accurate results
    this.collection.optimizeSync();

    const results = this.collection.querySync({
      fieldName: 'emb',
      vector: queryVector,
      topk: limit,
    });

    const mapped: SearchProviderResult[] = results.map((r: any) => {
      const text = r.fields?.text || this.textCache.get(r.id) || '';
      const score = r.score; // zvec cosine returns similarity 0-1
      return {
        key: r.id,
        score,
        snippet: text.length > 120 ? text.slice(0, 120) + '...' : text,
        distance: this.metric === 'cosine' ? 1 - score : undefined,
      };
    });

    // Collection scoping
    const filtered = options?.collection
      ? mapped.filter(r => r.key.includes(options.collection!))
      : mapped;

    if (options?.threshold !== undefined) {
      return filtered.filter(r => r.score >= options.threshold!);
    }

    return filtered;
  }

  /** Rebuild is a no-op — zvec maintains its own index */
  rebuild(_prefix?: string): { indexed: number; skipped: number } {
    return { indexed: this.textCache.size, skipped: 0 };
  }

  /** Clear all indexed data */
  async clear(): Promise<void> {
    if (this.collection) {
      this.collection.closeSync();
      this.collection = null;
    }
    // Remove storage and re-create on next use
    if (this.dbPath) {
      try {
        await Deno.remove(this.dbPath, { recursive: true });
      } catch { /* may not exist */ }
    }
    if (this.tmpDir) {
      try {
        await Deno.remove(this.tmpDir, { recursive: true });
      } catch { /* may not exist */ }
      this.tmpDir = null;
    }
    this.dbPath = null;
    this.textCache.clear();
  }

  /** Close the zvec collection (call when done) */
  async close(): Promise<void> {
    if (this.collection) {
      this.collection.closeSync();
      this.collection = null;
    }
  }

  /** Get count of indexed items */
  get size(): number {
    return this.textCache.size;
  }
}
