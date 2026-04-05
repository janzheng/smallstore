# Smallstore Search & Retrieval Architecture

**Status:** Design
**Inspiration:** [qmd](https://github.com/tobi/qmd) — on-device hybrid search engine
**Related:** [ROADMAP.md](./ROADMAP.md)

---

## Vision

Smallstore's search layer follows the same philosophy as the storage layer: **modular, preset-aware, and pluggable**. Just as StorageAdapter lets you swap where data lives, SearchAdapter lets you swap how data is found.

The goal is a layered search pipeline that works locally with zero dependencies (FTS5), but can scale up to vector search, LLM reranking, and hybrid fusion when models are available.

---

## Search Pipeline Layers

```
Layer 1: Full-Text (BM25 via FTS5)     ← zero deps, built into SQLite
Layer 2: Vector (embedding similarity)  ← requires embedding model adapter
Layer 3: Reranking (LLM rescoring)      ← requires LLM adapter
Layer 4: Fusion (Reciprocal Rank Fusion)← combines signals from layers 1-3
```

Each layer is independent. You can use layer 1 alone (most use cases), add layer 2 for semantic search, or go full hybrid with all four. Layers are composed, not coupled.

---

## SearchAdapter Interface

The plugin contract for search backends. Parallel to `StorageAdapter` for storage.

```typescript
interface SearchAdapter {
  readonly name: string;
  readonly capabilities: SearchCapabilities;

  // Indexing
  index(key: string, content: string | Uint8Array, metadata?: Record<string, any>): Promise<void>;
  removeIndex(key: string): Promise<void>;
  reindex?(keys?: string[]): Promise<{ indexed: number; errors: number }>;

  // Searching
  search(query: string, options?: SearchAdapterOptions): Promise<ScoredResult[]>;
}

interface SearchCapabilities {
  type: 'fulltext' | 'vector' | 'reranker' | 'hybrid';
  requiresModel?: boolean;        // true for vector/reranker
  supportsBlobIndex?: boolean;     // true if can extract features from blobs
  supportsStreaming?: boolean;
}

interface SearchAdapterOptions {
  limit?: number;
  threshold?: number;             // Minimum score (0-1)
  collection?: string;            // Scope to collection
  filter?: Record<string, any>;   // Pre-filter before search
}

interface ScoredResult {
  key: string;
  score: number;                  // Always 0-1 normalized
  snippet?: string;               // Context around match
  metadata?: Record<string, any>;
}
```

---

## Built-in Adapters

| Adapter | Layer | Backend | Dependencies | Status |
|---------|-------|---------|-------------|--------|
| `FTS5SearchAdapter` | fulltext | SQLite FTS5 + BM25 | jsr:@db/sqlite (already used) | Phase 5 |
| `MemorySearchAdapter` | fulltext | In-memory LIKE scan | none | Future |
| `VectorSearchAdapter` | vector | sqlite-vec or external | embedding model | Future |
| `LLMRerankerAdapter` | reranker | Any LLM provider | LLM adapter | Future |
| `HybridSearchAdapter` | hybrid | Orchestrates others + RRF | composition | Future |

---

## Score Normalization Contract

All search adapters MUST return scores normalized to **0-1 range**. This enables fair fusion across heterogeneous backends.

**BM25 (FTS5):** Sigmoid normalization
```
score = 1 / (1 + exp(-(abs(raw_score) - 5) / 3))
```
Maps typical FTS5 BM25 range (~-15 to ~-2) into 0-1 via sigmoid.

**Vector (cosine distance):**
```
score = 1 / (1 + distance)
```

**Reranker (LLM confidence 0-10):**
```
score = raw_score / 10
```

**Reciprocal Rank Fusion (combining backends):**
```
rrf_score = sum(weight / (k + rank + 1))   // k=60 default
```
With position bonuses: rank 0 gets +0.05, ranks 1-2 get +0.02.

---

## Auto-Indexing

When a StorageAdapter that supports FTS5 is used (SQLite, structured), the router auto-indexes on `set()` and auto-removes on `delete()`.

**Text extraction from values:**
1. If value is a string → index directly
2. If value is an object → extract from common fields: `content`, `text`, `body`, `description`, `title`, `name`
3. Fallback → JSON.stringify for basic keyword matching

**FTS5 table schema:**
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS kv_fts USING fts5(
  key, content,
  tokenize='porter unicode61'
);
```

Uses Porter stemmer + Unicode tokenizer for good multilingual keyword matching.

---

## Blob Feature Extraction

SearchAdapter can declare `supportsBlobIndex: true` to handle binary data.

**Pipeline:**
```
Blob (PDF, image, audio)
  → FeatureExtractor plugin
    → Text representation
      → SearchAdapter.index(key, text)
```

**Extractor plugins** (future, not built-in):
| Type | Extractor | Notes |
|------|-----------|-------|
| PDF | pdf-to-text | Text extraction from PDF pages |
| Image | image-caption | VLM caption generation |
| Audio | whisper-transcript | Speech-to-text transcription |
| HTML | html-to-text | Strip tags, extract content |
| Markdown | passthrough | Already text, index directly |

Extractors follow a simple interface:
```typescript
interface FeatureExtractor {
  readonly supportedTypes: string[];  // MIME types
  extract(data: Uint8Array, metadata?: Record<string, any>): Promise<string>;
}
```

Could shell out to external tools (pandoc, ffmpeg+whisper). Could also use qmd-style GGUF models for local extraction.

---

## Preset Integration

How search plugs into each storage preset:

| Preset | Search Backend | Auto-Index on set()? | Notes |
|--------|---------------|---------------------|-------|
| memory | MemorySearchAdapter (LIKE scan) | No | Simple substring matching |
| local | None (use query filter) | No | JSON files, no FTS |
| local-sqlite | FTS5SearchAdapter | Yes | Full BM25 search |
| structured | FTS5SearchAdapter (text columns) | Yes | Index text-type columns |
| cloud | Deferred | No | Could use Upstash search API |
| hybrid | FTS5SearchAdapter (local SQLite) | Yes | Local FTS + cloud storage |

---

## Chunking Strategy (Future — Vector Search)

For embedding models with token limits (~512-1024 tokens), documents need chunking:

```typescript
interface ChunkOptions {
  maxTokens?: number;       // Default: 900
  overlapRatio?: number;    // Default: 0.15 (15%)
  preservePosition?: boolean; // Track byte offsets for snippets
}

interface Chunk {
  text: string;
  seq: number;              // Chunk sequence number
  pos: number;              // Byte position in original
}
```

**Key design decisions (from qmd):**
- Token-aware splitting (not character-based)
- 15% overlap prevents context loss at boundaries
- Byte position preservation enables snippet extraction from original
- Chunk-level embeddings + document-level metadata

---

## Content-Addressable Storage (Future)

For deduplication and efficient change detection:

```sql
-- Content table (immutable, deduplicated)
CREATE TABLE search_content (
  hash TEXT PRIMARY KEY,     -- SHA-256 of content
  content TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

-- Document registry (mutable, tracks active state)
CREATE TABLE search_documents (
  key TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  hash TEXT NOT NULL,         -- FK to search_content
  active INTEGER DEFAULT 1,
  FOREIGN KEY (hash) REFERENCES search_content(hash)
);
```

**Benefits:**
- Same content stored once regardless of how many keys reference it
- Change detection via hash comparison (skip re-indexing unchanged content)
- Soft delete via `active` flag + periodic cleanup

---

## Virtual Path System (Future)

Logical addressing independent of storage backend:

```
smallstore://collection/path/to/item
```

**Benefits:**
- Decouples logical structure from adapter layout
- Consistent addressing for MCP tool operations
- Enables cross-collection queries
- Compatible with qmd-style `qmd://` URIs

---

## MCP Search Tools (Future)

When exposed as MCP tools, search follows qmd's dual-payload pattern:

```typescript
// Human-readable summary + machine-readable structured data
{
  content: [{ type: "text", text: "Found 5 results for 'authentication'..." }],
  structuredContent: {
    results: ScoredResult[]
  }
}
```

**Planned tools:**
| Tool | Description |
|------|-------------|
| `smallstore_search` | BM25 keyword search |
| `smallstore_vsearch` | Vector semantic search (future) |
| `smallstore_query` | Hybrid search with reranking (future) |
| `smallstore_index` | Manually trigger re-indexing |

---

## Implementation Phases

### Phase 5: FTS5 Full-Text Search (Current)
- FTS5SearchAdapter built into SQLite adapter
- Auto-index on set(), auto-remove on delete()
- Router search() for type: 'bm25'
- Score normalization (sigmoid)

### Phase 6: Vector Search (Future)
- VectorSearchAdapter using sqlite-vec or external embeddings
- Chunking pipeline with overlap
- Content-addressable storage for dedup
- Lazy initialization (models loaded on first search)

### Phase 7: Hybrid Search (Future)
- HybridSearchAdapter orchestrating FTS5 + vector
- Reciprocal Rank Fusion
- Optional LLM reranking
- Session-based model lifecycle for heavy models
- qmd-style context hierarchy

### Phase 8: Blob Indexing (Future)
- FeatureExtractor plugin interface
- PDF, image, audio extractors
- Integration with external extraction tools
- GGUF model support for local-only extraction
