# Changelog

## 0.1.0 — Initial Release

### Core

- **Router** — Smart routing with collection-based addressing, type detection, and mount-based adapter selection
- **17 adapters** — Memory, LocalJSON, LocalFile, DenoFS, SQLite, StructuredSQLite, Upstash, Sheetlog, Notion, Airtable, Unstorage, Overlay, R2Direct, F2-R2, Cloudflare KV/D1/DO/R2
- **7 presets** — memory, local, local-sqlite, deno-fs, cloud, hybrid, structured
- **Data operations** — CRUD, slice, split, deduplicate, merge, copy, move, namespace management

### Search

- **SearchProvider plugin system** — Formal interface for attaching search to any adapter
- **MemoryBm25SearchProvider** — Pure JS BM25 full-text search, zero dependencies
- **SqliteFtsSearchProvider** — SQLite FTS5 with porter tokenizer
- **MemoryVectorSearchProvider** — Brute-force cosine similarity with async embed callback
- **ZvecSearchProvider** — HNSW via zvec, O(log n) queries for 10k-10M items
- **MemoryHybridSearchProvider** — Reciprocal Rank Fusion of BM25 + vector
- **Embedding helpers** — `createEmbed()` auto-detects HuggingFace (free) or OpenAI from env vars
- **Auto-indexing** — Memory, LocalJSON, DenoFS, SQLite, and StructuredSQLite adapters auto-index on set/delete

### HTTP Layer

- **Framework-agnostic handlers** — 20+ handlers for CRUD, search, query, views, data ops
- **Hono integration** — `createHonoRoutes()` mounts all endpoints
- **Materialized views** — Create, refresh, list, update, delete via REST

### Agent Interface

- **VFS** — 15 bash-like commands (ls, cat, write, find, grep, tree, etc.) + 8 aliases
- **REPL** — Interactive shell with state persistence
- **Overlay** — Copy-on-write adapter with snapshot management

### Modules

- **Graph store** — Node/edge CRUD, BFS/DFS traversal, shortest path, query builder
- **Episodic memory** — Episodes with importance decay, temporal filtering, recall algorithms
- **Progressive disclosure** — Multi-level summarization, skill registry, relevance scoring
- **Blob middleware** — Binary data handling with R2/F2 backends
- **Materializers** — JSON, CSV, Markdown, YAML, Text output formats
- **Adapter sync** — Bidirectional sync with 3-way merge and conflict resolution
