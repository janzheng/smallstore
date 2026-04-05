# Smallstore Roadmap

## Vision

Smallstore is an **agent-native data layer** — a universal storage abstraction that gives AI agents the same power over data that Claude Agent SDK gives over code. Just as Claude Code has Read, Write, Edit, Glob, and Grep primitives, smallstore provides:

| Agent SDK | Smallstore | Status |
|-----------|-----------|--------|
| Read | `store.get(key)` | Done |
| Write | `store.set(key, value)` | Done |
| Edit | `store.patch(key, partial)` | Done |
| Glob | `store.keys('research/*/2024')` | Done |
| Grep | `store.query(collection, filter)` | Done (native SQL) |
| Batch | `store.batchGet/Set/Delete(...)` | Done |

Every preset should support **all data modes** out of the box. An agent shouldn't need to know which adapter handles blobs vs objects — it just stores data and the router figures out the rest.

---

## Two Orthogonal Dimensions

### Presets (WHERE data lives)
- **memory** — ephemeral in-process storage
- **local** — JSON files on disk (human-inspectable)
- **local-sqlite** — SQLite database (queryable, persistent)
- **cloud** — Upstash Redis + R2 (serverless, persistent)
- **hybrid** — SQLite + Upstash (local speed + cloud sync)

### Data Modes (WHAT the data is)
- **kv** — primitives (string, number, boolean)
- **object** — JSON-serializable structures (objects, arrays)
- **blob** — binary data (images, PDFs, audio)
- **structured** — typed/queryable tables (future: Drizzle schemas)

---

## Preset x Data Mode Matrix

### Current State (Phases 1-3 Complete)

| Preset | kv | object | blob | query | typeRouting? |
|--------|-----|--------|------|-------|:---:|
| memory | memory | memory | memory | in-memory filter | Yes |
| local | local-json | local-json | local-file | No | Yes |
| local-sqlite | sqlite | sqlite | local-file | **Native SQL** | Yes |
| cloud | upstash/memory | upstash/memory | **R2**/memory | No | Yes |
| hybrid | sqlite | sqlite | local-file | **Native SQL** | Yes |

Cloud preset uses R2 for blobs when `SM_R2_*` env vars are set, falls back to memory otherwise.
Cloud preset uses Upstash for kv/object when `UPSTASH_*` env vars are set, falls back to memory.

### Future State

| Preset | kv | object | blob | structured | query |
|--------|-----|--------|------|-----------|-------|
| memory | memory | memory | memory | — | in-memory |
| local | local-json | local-json | local-file | Drizzle SQLite | SQL |
| local-sqlite | sqlite | sqlite | local-file | Drizzle SQLite | SQL |
| cloud | upstash | upstash | R2/S3 | D1/Turso | SQL |
| hybrid | sqlite | sqlite | local-file + R2 | Drizzle | SQL |

---

## Phase 1: Fill the Matrix — DONE

### 1.1 typeRouting in all presets — Done
Added `typeRouting: { blob, object, kv }` to each preset. Router automatically routes data to the correct adapter by detected type.

### 1.2 Native SQL query in SQLite adapter — Done
SQLite adapter implements `query()` with MongoDB-style filters translated to `json_extract()` WHERE clauses. Router delegates to native query when available, sets `metadata.nativeQuery = true`.

### 1.3 Glob-pattern key matching — Done
`utils/glob.ts` with pattern matching (`*`, `**`, `?`, `{a,b}`). Router `keys()` supports glob patterns.

### 1.4 patch() method — Done
`patch(key, partial)` on Smallstore interface — shallow merge for partial updates.

---

## Phase 2: Agent-Native API — DONE (batch ops)

### 2.1 MCP tool interface — Deferred
Expose smallstore operations as MCP tools. (Deferred to separate integration.)

### 2.2 Batch operations — Done
`batchGet(paths)`, `batchSet(entries)`, `batchDelete(paths)` — parallel execution across adapters.

### 2.3 Collection-level operations — Done (pre-existing)
`listCollections`, `getSchema`, `copy`, `move`, `copyNamespace`, `listNamespaces`, `deleteNamespace`, `stat`, `tree`, `getNamespace` all already implemented.

### 2.4 Schema discovery — Done (pre-existing)
`getSchema(collection)` returns paths, types, adapters, and metadata for any collection.

---

## Phase 3: Cloud Blob Storage — DONE

### 3.1 R2 adapter integration — Done
`R2DirectAdapter` wired into cloud preset. When `SM_R2_*` env vars are present, blob data routes to R2 via `typeRouting.blob → 'r2'`.

### 3.2 S3-compatible adapter — Deferred
Generic S3 adapter for AWS, Backblaze B2, MinIO. Deferred until needed.

### 3.3 Cloud preset typeRouting — Done
Cloud preset dynamically configures `typeRouting.blob` based on R2 env var availability.

---

## Phase 4: Structured Schema Mode — DONE

### 4.1 Structured SQLite adapter — Done
`StructuredSQLiteAdapter` creates real SQL tables with typed columns from schema definitions. Collections map to actual database tables (not JSON blobs). Implemented without `npm:drizzle-orm` dependency for Deno compatibility — uses `jsr:@db/sqlite` directly with a Drizzle-inspired schema API.

### 4.2 Auto-migration — Done
Tables auto-created on first access via `CREATE TABLE IF NOT EXISTS`. Indexes auto-created from schema definitions. No CLI migration tool needed.

### 4.3 Native SQL queries — Done
Queries on real columns (no `json_extract` needed). MongoDB-style filter operators translated to native SQL. Supports `$eq`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`, `$startsWith`, sort, limit, skip.

### 4.4 Batch insert — Done
`insertMany(table, rows)` executes in a SQLite transaction for high throughput.

---

## Phase 5: FTS5 Full-Text Search — DONE

See [SEARCH-ARCHITECTURE.md](./SEARCH-ARCHITECTURE.md) for full design.

### 5.1 FTS5 in SQLite adapter — Done
FTS5 virtual table in SQLite adapter. Auto-indexes text on `set()`, auto-removes on `delete()`. BM25 scoring with sigmoid normalization to 0-1 range. Extracts text from common fields (content, text, body, description, title, name, summary).

### 5.2 Router search() for BM25 — Done
`search()` method for `type: 'bm25'`. Delegates to SQLite adapter's `ftsSearch()`. Supports limit, threshold, collection scoping. Vector/hybrid types throw descriptive errors.

### 5.3 Structured preset — Done
`StructuredSQLiteAdapter` wired into `'structured'` preset in `presets.ts`. User provides schema override.

### 5.4 listCollections(pattern?) — Done
Glob pattern filtering (`user*`, `{users,posts}`) and prefix matching via existing `glob.ts` utilities.

### 5.5 view() delegation — Done
`view()` wired to ViewManager for named views (via `getView()`), direct retriever pipeline for inline definitions. Both paths use `{ raw: true }` to avoid StorageFileResponse wrapping.

---

## Future Phases

### Phase 6: Vector Search
- VectorSearchAdapter using sqlite-vec or external embeddings
- Token-aware chunking with overlap
- Content-addressable storage for dedup
- Lazy model initialization

### Phase 7: Hybrid Search
- HybridSearchAdapter orchestrating FTS5 + vector
- Reciprocal Rank Fusion (RRF)
- LLM reranking (optional)
- qmd-style context hierarchy

### Phase 8: Blob Indexing
- FeatureExtractor plugin interface
- PDF, image, audio extractors
- GGUF model support for local-only extraction

---

## Deferred / Future

- **MCP tool interface** — expose as MCP tools for agent CRUD
- **S3-compatible adapter** — generic S3 for AWS, B2, MinIO
- **Cross-adapter query federation** — query across multiple adapters simultaneously
- **Streaming/chunked blob I/O** — for very large files
- **Transactions across adapters** — multi-adapter atomic operations
- **SQLite native json_patch()** — optimize `patch()` to update in-place
- **Unstorage driver expansion** — fs, redis, mongodb, vercel-kv, netlify-blobs
