# Unified Retrieval Layer

*Deep dive — design and implementation of a single plugin interface for all retrieval in smallstore.*

## The problem

Smallstore has **three parallel retrieval systems** that don't compose:

| System | Interface | Location | What it does |
|--------|-----------|----------|--------------|
| **Retrievers** (6) | `RetrievalAdapter` | `src/retrievers/` | Transform/filter data on read (metadata, slice, filter, structured, text, flatten) |
| **Search** (5) | `SearchProvider` | `src/search/` | Find data by keyword/vector/hybrid |
| **Disclosure** | `ProgressiveStore` | `src/disclosure/` | Context-aware depth control (summary -> full) |

You can't search -> then disclose at summary level -> then slice. Adding a new retrieval strategy (RAG, re-ranking) means picking which system to extend.

## What we built

**Status: Implemented and tested (22 tests passing)**

### Core interface

```typescript
interface RetrievalProvider {
  readonly name: string;
  readonly type: 'search' | 'transform' | 'filter' | 'metadata' | 'disclosure';
  retrieve(input: RetrievalInput, options?: Record<string, any>): Promise<RetrievalOutput>;
  index?(key: string, value: any): Promise<void>;    // search providers only
  remove?(key: string): Promise<void>;                // search providers only
  rebuild?(prefix?: string): Promise<{ indexed: number; skipped: number }>;
}
```

### Wrapper adapters

| Wrapper | Wraps | Maps to type |
|---------|-------|-------------|
| `SearchProviderWrapper` | Any `SearchProvider` (BM25, Vector, etc.) | `'search'` |
| `RetrieverWrapper` | Any `RetrievalAdapter` (Filter, Slice, etc.) | `'transform'` / `'filter'` / `'metadata'` |
| `DisclosureWrapper` | `ProgressiveStore` | `'disclosure'` |

### Pipeline composition

```typescript
const pipeline = store.createRetrievalPipeline()
  .add('search:memory', { type: 'bm25', limit: 50 })
  .add('filter', { where: { status: 'published' } })
  .add('slice', { mode: 'head', take: 10 });

const result = await pipeline.execute({ query: 'machine learning' });
// result.data = top 10 published items matching "machine learning"
// result.metadata.steps = per-step metadata (timing, counts)
```

### Router integration

```typescript
// Pipeline in get() options
const data = await store.get('articles', {
  pipeline: [
    { provider: 'filter', options: { where: { category: 'ai' } } },
    { provider: 'slice', options: { mode: 'head', take: 5 } },
  ],
});

// retrievePipeline() returns RetrievalOutput with full metadata
const result = await store.retrievePipeline('articles', [
  { provider: 'filter', options: { where: { category: 'ai' } } },
]);

// Custom providers
store.registerRetrievalProvider({
  name: 'dedupe',
  type: 'transform',
  async retrieve(input, options) {
    const field = options?.field ?? 'id';
    const seen = new Set();
    const unique = input.data.filter((item: any) => {
      const key = item[field];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      data: unique,
      metadata: { provider: 'dedupe', type: 'transform', itemsReturned: unique.length },
    };
  },
});
```

## Files

| File | Purpose |
|------|---------|
| `src/retrieval/types.ts` | `RetrievalProvider`, `RetrievalInput`, `RetrievalOutput`, `PipelineStep` |
| `src/retrieval/pipeline.ts` | `RetrievalPipeline` — step chaining, registry resolution |
| `src/retrieval/adapters/search-adapter.ts` | `SearchProviderWrapper` |
| `src/retrieval/adapters/retriever-adapter.ts` | `RetrieverWrapper` |
| `src/retrieval/adapters/disclosure-adapter.ts` | `DisclosureWrapper` |
| `src/retrieval/mod.ts` | Barrel exports |
| `tests/smallstore/retrieval-pipeline.test.ts` | 22 tests |

### Router changes (additive, non-breaking)

- Added `retrievalProviders: Map<string, RetrievalProvider>` alongside existing `retrievers` map
- Auto-wraps all existing retrievers + adapter search providers on init
- New methods: `registerRetrievalProvider()`, `getRetrievalProvider()`, `listRetrievalProviders()`, `createRetrievalPipeline()`, `retrievePipeline()`
- `get()` supports `options.pipeline` (unified) alongside existing `options.retrievers` (legacy)

## What this enables next

| Capability | Before | With unified layer |
|-----------|--------|-------------------|
| Search then slice | Two separate calls | One pipeline |
| Search then disclose | Not possible | `['bm25', 'disclosure:summary']` |
| Re-ranking | Not possible | Drop in a `ReRankProvider` |
| RAG retrieval | Manual glue | `['vector', 'rerank', 'disclosure:detailed']` |
| Context windowing | Not possible | `ContextWindowProvider` (fit to token budget) |
| Custom retrieval | Extend 1 of 3 systems | One interface |

## Open questions

- Should the HTTP layer expose a `POST /:collection/pipeline` endpoint?
- Should `ViewDefinition.retrievers` (which uses `RetrievalStep[]`) migrate to `PipelineStep[]`?
- How does caching interact with pipelines? Cache final result? Per-step? Search index only?
- Should providers declare input/output types for pipeline validation at construction time?

## Discussion

### 2026-03-19 — Implemented

Shipped with 22 tests. The key design choice: wrapper adapters (non-breaking) over interface replacement (breaking). Both old and new APIs coexist.

The pipeline pattern maps directly to VFS piping — `cat notes | filter --where status=active | slice --take 5` could become `pipeline: [filter, slice]`. This could make the VFS pipe implementation more principled.

The biggest design win is that new retrieval strategies (re-ranking, RAG, context windowing) now have a clear extension point. You implement `RetrievalProvider`, register it, and it works in any pipeline.
