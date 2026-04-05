# Search

Smallstore has a pluggable search system. Any adapter can support search via a **SearchProvider** — a small interface that handles indexing and querying. You pick the provider, attach it to an adapter, and search works.

## Quick Start

```typescript
import { createSmallstore } from '@smallstore/core';

// Memory and SQLite presets come with BM25 search built in
const store = createSmallstore({ preset: 'local-sqlite' });

// Store some data
await store.set('articles/intro', { title: 'Intro to AI', content: 'Machine learning is...' });
await store.set('articles/ethics', { title: 'AI Ethics', content: 'Ethical considerations...' });

// Search — auto-indexed on set()
const results = await store.search('articles', { query: 'machine learning', type: 'bm25' });
// [{ key: 'articles/intro', score: 0.85, snippet: '...Machine learning is...' }]
```

## Search Types

| Type | Provider | What it does | Best for |
|------|----------|-------------|----------|
| `bm25` | MemoryBm25, SqliteFts | Keyword matching with TF-IDF scoring | Exact term lookup, filtering |
| `vector` | MemoryVector, Zvec | Cosine similarity on embeddings | Semantic "meaning" search |
| `hybrid` | MemoryHybrid | RRF fusion of BM25 + vector | Best of both worlds |

## Providers

### MemoryBm25SearchProvider

Pure JS BM25 full-text search. Zero dependencies. Auto-indexed on `set()`/`delete()`.

**Built into:** Memory adapter, LocalJSON adapter, DenoFS adapter

```typescript
import { MemoryBm25SearchProvider } from '@smallstore/core';

const bm25 = new MemoryBm25SearchProvider();
bm25.index('doc1', { title: 'Hello', content: 'World' });
const results = bm25.search('hello'); // [{ key: 'doc1', score: 0.8, snippet: '...' }]
```

### SqliteFtsSearchProvider

SQLite FTS5 with porter tokenizer. Extracted from the SQLite adapter.

**Built into:** SQLite adapter (automatically)

```typescript
import { SqliteFtsSearchProvider } from '@smallstore/core';
// Usually you don't create this directly — SQLite adapter does it for you
```

### MemoryVectorSearchProvider

Brute-force cosine similarity. Good for <10k items. Requires an `embed` callback.

```typescript
import { MemoryVectorSearchProvider, createEmbed } from '@smallstore/core';

const embed = createEmbed(); // auto-detects HuggingFace or OpenAI from env
const provider = new MemoryVectorSearchProvider({ embed, dimensions: 384 });

await provider.index('doc1', { content: 'Machine learning basics' });
const results = await provider.search('AI fundamentals');
// [{ key: 'doc1', score: 0.78, snippet: 'Machine learning basics' }]
```

### ZvecSearchProvider

HNSW index via [zvec](https://github.com/alibaba/zvec) — O(log n) queries, handles 10k-10M items. Same `embed` callback pattern.

```typescript
import { ZvecSearchProvider, createEmbed } from '@smallstore/core';

const embed = createEmbed();
const provider = new ZvecSearchProvider({
  embed,
  dimensions: embed.dimensions!, // 384 for bge-small
  storagePath: './my-index.zvec', // optional: persist to disk
});

await provider.index('doc1', { content: 'Quantum computing overview' });
const results = await provider.search('quantum');
```

### MemoryHybridSearchProvider

Combines BM25 + vector via Reciprocal Rank Fusion. Supports all three search types (`bm25`, `vector`, `hybrid`).

```typescript
import {
  MemoryBm25SearchProvider,
  MemoryVectorSearchProvider,
  MemoryHybridSearchProvider,
  createEmbed,
} from '@smallstore/core';

const embed = createEmbed();
const bm25 = new MemoryBm25SearchProvider();
const vector = new MemoryVectorSearchProvider({ embed });
const hybrid = new MemoryHybridSearchProvider({ bm25, vector });

await hybrid.index('doc1', { content: 'Neural network training' });

// All three modes work:
await hybrid.search('neural', { type: 'bm25' });   // keyword match
await hybrid.search('deep learning', { type: 'vector' }); // semantic
await hybrid.search('neural networks', { type: 'hybrid' }); // combined
```

The `hybridAlpha` parameter controls the blend (0 = pure vector, 1 = pure BM25, default 0.5):

```typescript
await hybrid.search('query', { type: 'hybrid', hybridAlpha: 0.7 }); // favor keywords
```

## Embedding Configuration

The `createEmbed()` helper auto-detects your embedding provider from environment variables:

| Env var | Provider | Default model | Dims | Cost |
|---------|----------|--------------|------|------|
| `HUGGINGFACE_API_KEY` | HuggingFace | BAAI/bge-small-en-v1.5 | 384 | Free |
| `OPENAI_API_KEY` | OpenAI | text-embedding-3-small | 1536 | Paid |

Override with:
- `EMBED_PROVIDER=huggingface` or `openai` — force a provider
- `EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B` — override model

Or configure in code:

```typescript
import { createHuggingFaceEmbed, createOpenAIEmbed } from '@smallstore/core';

// Explicit HuggingFace
const embed = createHuggingFaceEmbed({ model: 'BAAI/bge-large-en-v1.5' });

// Explicit OpenAI
const embed = createOpenAIEmbed({ model: 'text-embedding-3-large' });
```

The embed function also exposes `.batch()` for efficient bulk embedding and `.dimensions` for known models.

## Adding Search to Any Adapter

Any adapter can support search by setting the `searchProvider` property. Here's the pattern:

```typescript
import { createMemoryAdapter, MemoryBm25SearchProvider } from '@smallstore/core';

// Method 1: Adapters that have it built in (Memory, SQLite, LocalJSON, DenoFS)
const adapter = createMemoryAdapter();
adapter.searchProvider; // MemoryBm25SearchProvider (auto-created)

// Method 2: Attach to any adapter manually
import { createUpstashAdapter } from '@smallstore/core';

const upstash = createUpstashAdapter({ url: '...', token: '...' });
// Upstash doesn't have search by default, but you can add it:
(upstash as any).searchProvider = new MemoryBm25SearchProvider();
// Now search works — but you need to manually index data
```

### Building a Custom SearchProvider

Implement the `SearchProvider` interface:

```typescript
import type { SearchProvider, SearchProviderOptions, SearchProviderResult } from '@smallstore/core';

class MySearchProvider implements SearchProvider {
  readonly name = 'my-search';
  readonly supportedTypes = ['bm25'] as const; // or ['vector'], ['bm25', 'vector', 'hybrid']

  index(key: string, value: any): void {
    // Extract text from value, add to your index
  }

  remove(key: string): void {
    // Remove from index
  }

  search(query: string, options?: SearchProviderOptions): SearchProviderResult[] {
    // Return ranked results: { key, score (0-1), snippet }
    return [];
  }

  rebuild(prefix?: string): { indexed: number; skipped: number } {
    // Rebuild index from scratch (optional — return current stats)
    return { indexed: 0, skipped: 0 };
  }
}
```

## HTTP API

```
GET /:collection/search?q=query&limit=10&type=bm25&threshold=0.5
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | required | Search query text |
| `limit` | number | 10 | Max results |
| `type` | string | `bm25` | Search type: `bm25`, `vector`, `hybrid` |
| `threshold` | number | — | Minimum score (0-1) to include |

Response:
```json
{
  "results": [
    { "key": "articles/intro", "score": 0.85, "snippet": "...Machine learning is..." }
  ],
  "query": "machine learning",
  "total": 1,
  "limit": 10
}
```

## Which Adapters Support Search

| Adapter | Search Provider | Auto-indexed |
|---------|----------------|-------------|
| Memory | MemoryBm25 | Yes |
| LocalJSON | MemoryBm25 | Yes |
| DenoFS | MemoryBm25 | Yes |
| SQLite | SqliteFts (FTS5) | Yes |
| Overlay | Delegates to base | Yes |
| Upstash | None (add manually) | — |
| Notion | None | — |
| Airtable | None | — |
| Cloudflare KV/D1/DO/R2 | None | — |

For adapters without built-in search, attach a `MemoryBm25SearchProvider` or vector provider manually. Note that in-memory providers lose their index on restart — you'll need to rebuild by iterating stored data.
