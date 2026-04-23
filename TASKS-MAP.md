# Smallstore — Map

## Phase 1: Core Storage [shipped]

### Adapter Interface

- [x] StorageAdapter interface (get/set/delete/has/keys/clear + optional query/searchProvider) #adapter-interface
- [x] AdapterCapabilities (supported types, cost, performance, features) #adapter-interface
- [x] Error types — AdapterError, UnsupportedOperationError, RateLimitError + 5 more #adapter-errors

### Adapters — Local (5)

- [x] Memory — in-memory hashmap, TTL (manual), search (BM25) #adapter-memory
  - Tests: used throughout all test suites
- [x] LocalJSON — JSON files on disk, debounced writes, cache #adapter-local-json
  - Tests: via presets tests | Search: BM25 (auto-indexes on set/delete)
- [x] LocalFile — binary blob storage on disk #adapter-local-file
  - Tests: `local-file.test.ts` | No search/query
- [x] DenoFsAdapter — real directory as store, text/binary detection, exclude patterns #adapter-deno-fs
  - Tests: `deno-fs-adapter.test.ts` (13 tests) | Search: BM25
- [x] SQLite — WAL mode, json_extract queries, FTS5 search #adapter-sqlite
  - Tests: `sqlite.test.ts`, `sqlite-query.test.ts` | Search: SqliteFtsSearchProvider | Query: yes

### Adapters — Structured Data (3)

- [x] StructuredSQLite — typed columns, real indexes, schema-driven tables #adapter-structured-sqlite
  - Tests: `structured-sqlite.test.ts` | Query: yes | Search: FTS5 (SqliteFtsSearchProvider)
- [x] Notion — page body blocks, auto field creation, unmapped field strategies, 1783 lines #adapter-notion
  - Tests: various | Query: yes (Notion DB queries) | Search: BM25
- [x] Airtable — bases/tables/records, auto field creation, linked records, 1744 lines #adapter-airtable
  - Tests: `airtable-field-creation.test.ts` | Query: yes | Search: BM25

### Adapters — Cloud KV (3)

- [x] Upstash Redis — REST API, native TTL, namespace support #adapter-upstash
  - Tests: via live-adapters | TTL: native | Known issue: double-stringify defensive parsing
- [x] Sheetlog — Google Sheets via Apps Script, hybrid array/row pattern #adapter-sheetlog
  - Tests: via live-adapters | No search/query
- [x] Unstorage — wrapper around unstorage drivers #adapter-unstorage
  - Tests: NONE | Known issue: async init bug in constructor

### Adapters — Cloudflare (4, all dual-mode HTTP + native binding)

- [x] Cloudflare KV — Workers KV, namespace support, TTL #adapter-cf-kv
  - Tests: implied only (no dedicated tests) | TTL: native
- [x] Cloudflare D1 — Workers D1 (SQLite), auto table creation #adapter-cf-d1
  - Tests: implied only
- [x] Cloudflare DO — Durable Objects, namespace + instance ID #adapter-cf-do
  - Tests: implied only
- [x] Cloudflare R2 — Object storage, auto MIME/JSON/CSV parsing #adapter-cf-r2
  - Tests: implied only

### Adapters — S3/R2 Direct (2)

- [x] R2-Direct — S3-compatible API, signed upload/download URLs #adapter-r2-direct
  - Tests: implied | Note: signed URL methods not in StorageAdapter interface
- [x] F2-R2 — R2 via Fuzzyfile proxy, deterministic keys #adapter-f2-r2
  - Tests: implied

### Adapters — Special (2)

- [x] Obsidian — vault adapter via VaultGraph, markdown↔JSON codec #adapter-obsidian
  - Tests: `obsidian-adapter.test.ts`, `obsidian-codec.test.ts` | Search: via VaultGraph FTS5 | Query: yes
- [x] OverlayAdapter — COW read-through, tombstones, snapshots, diff/commit #adapter-overlay
  - Tests: `overlay-adapter.test.ts` (55 tests) | No search provider

### Client Libraries (3)

- [x] Notion client — notionModern (699 lines), notionBlocks (596 lines, markdown↔blocks), notionTransformers (663 lines) #client-notion #needs:adapter-notion
- [x] Airtable client — bases (420 lines), tables, fields (617 lines, auto-creation), records (712 lines, batch ops) #client-airtable #needs:adapter-airtable
- [x] Sheetlog client — Google Sheets API wrapper (434 lines) #client-sheetlog #needs:adapter-sheetlog

### Vault-Graph Subsystem (Obsidian, independent)

- [x] Vault engine — file discovery, indexing (965 lines) #vault-graph
- [x] Markdown parser — frontmatter, wikilinks, backlinks (868 lines) #vault-parser #needs:vault-graph
- [x] SQLite persistence — vault store with caching (534 lines) #vault-store #needs:vault-graph
- [x] Bidirectional codec — markdown↔JSON (272 lines) #vault-codec #needs:vault-parser
- [x] Wikilink resolver — link resolution, backlinks (218 lines) #vault-resolver #needs:vault-parser
- [x] File watcher — filesystem change detection (170 lines) #vault-watcher #needs:vault-graph
- [x] Sync engine — 3-way merge, change detection, manifests (733 lines) #vault-sync #needs:vault-graph

---

## Phase 2: Router & HTTP [shipped]

### SmartRouter (3317 lines, 50+ public methods)

- [x] Core CRUD — get, set, patch, delete, has, keys, clear #router-crud #needs:adapter-interface
- [x] Smart routing — type detection → adapter scoring → best-fit selection #router-routing #needs:adapter-interface
- [x] Pattern-based mounts — path → adapter mapping #router-mounts #needs:adapter-interface
- [x] Metadata management — collection metadata, schema introspection #router-metadata #needs:adapter-interface
- [x] Namespace operations — tree, copy, move, getNamespace #router-namespace
- [x] Batch operations — batchGet, batchSet, batchDelete #router-batch #needs:router-crud
- [x] External sources — register/update/unregister external data feeds #router-external
  - Tests: no dedicated tests

### Router Internals

- [x] Cache manager — LRU eviction, TTL, hit/miss tracking, auto-invalidation (284 lines) #cache-manager #needs:router-crud
- [x] Query engine — MongoDB-style filters via json_extract (557 lines) #query-engine #needs:router-crud
- [x] External fetcher — HTTP fetch with retry + exponential backoff (238 + 215 lines) #external-fetcher
- [x] Cache key generator — stable hashing from objects (132 lines) #cache-key #needs:cache-manager

### Key Index

- [x] Key index tracking — which adapter stores each key (212 lines) #keyindex #needs:adapter-interface
  - Tests: no dedicated tests (exercised indirectly)

### HTTP Layer

- [x] Framework-agnostic handlers — 24 REST endpoints (1082 lines) #http-handlers #needs:router-crud
- [x] Hono integration — route registration, body parsing, error handling #http-hono #needs:http-handlers
- [x] Express integration — intentional stub (throws with "use Hono" message) #http-express
  - Note: exported from mod.ts despite being a stub — confusing
- [x] Types — SmallstoreRequest/Response/Instance/Route (231 lines) #http-types
  - Tests: `http.test.ts` (22 tests)

### Blob Middleware

- [x] Blob detection — format detection, MIME handling (1197 lines total) #blob-middleware #needs:adapter-interface
- [x] Resolver — stream handling, multi-backend upload (F2, R2) #blob-resolver #needs:blob-middleware
- [x] Platform formats — Airtable attachment, Notion file, URL-only #blob-formats
  - Tests: `blob-middleware.test.ts`

---

## Phase 3: Search [shipped]

### SearchProvider Interface

- [x] SearchProvider plugin interface (search, index, remove, rebuild) #search-interface #needs:adapter-interface
- [x] SearchProviderOptions (type, limit, threshold, vector, topK, metric, hybridAlpha) #search-types #needs:search-interface
- [x] Router search() delegates to adapter.searchProvider #search-router #needs:search-interface #needs:router-crud

### Search Providers (5)

- [x] SqliteFtsSearchProvider — FTS5, porter stemmer, BM25 scoring (139 lines) #sqlite-fts #needs:search-interface
- [x] MemoryBm25SearchProvider — pure JS inverted index, tf-idf (201 lines) #bm25 #needs:search-interface
- [x] MemoryVectorSearchProvider — brute-force cosine/euclidean/dot, embed callback (194 lines) #vector-memory #needs:search-interface
- [x] ZvecSearchProvider — HNSW via zvec, persistent storage, O(log n) (241 lines) #zvec #needs:search-interface
- [x] MemoryHybridSearchProvider — Reciprocal Rank Fusion, adjustable alpha (156 lines) #hybrid #needs:bm25 #needs:vector-memory

### Shared Utilities

- [x] Text extractor — extractSearchableText() from objects (30 lines) #text-extractor

### Search Coverage by Adapter

| Adapter | Search | Provider |
|---------|--------|----------|
| Memory | BM25 | MemoryBm25SearchProvider |
| DenoFS | BM25 | MemoryBm25SearchProvider |
| SQLite | FTS5 | SqliteFtsSearchProvider |
| Obsidian | FTS5 | via VaultGraph |
| StructuredSQLite | FTS5 | SqliteFtsSearchProvider |
| Notion | BM25 | MemoryBm25SearchProvider |
| Airtable | BM25 | MemoryBm25SearchProvider |
| Upstash | NONE | gap — could wire BM25 |
| LocalJSON | BM25 | MemoryBm25SearchProvider |
| Cloudflare * | NONE | gap |
| Overlay | NONE | complex (COW layering) |

Tests: `vector-search.test.ts` (25 tests), `tests/search.test.ts`

---

## Phase 4: Data Operations [shipped]

### Collection Operations

- [x] Slice — extract subset, optional save to new collection #slice #needs:router-crud
- [x] Split — partition by field value into multiple collections #split #needs:router-crud
- [x] Deduplicate — by ID field, content hash, or field comparison #deduplicate #needs:router-crud
- [x] Merge — combine multiple collections with optional dedup #merge #needs:router-crud
- [x] HTTP endpoints — POST slice/split/deduplicate/merge (4 endpoints) #data-ops-http #needs:http-handlers
  - Tests: no dedicated tests for HTTP endpoints

### Materialized Views

- [x] View manager — CRUD, registry (205 lines) #view-manager #needs:router-crud
- [x] Materialized engine — cached execution, refresh strategies (526 lines) #view-materialized #needs:view-manager
  - Refresh modes: lazy, on-write, manual, external
- [x] View storage — metadata persistence (146 lines) #view-storage #needs:view-manager
- [x] HTTP endpoints — 8 REST routes (list/create/get/metadata/update/delete/refresh/refresh-all) #view-http #needs:http-handlers
  - Tests: `materialized-views.test.ts` (13 tests)

### Input Processing

- [x] Input validation pipeline — type coercion, field mapping (457 lines) #validation #needs:router-crud
  - Tests: no dedicated tests

### Retriever Pipeline

- [x] MetadataRetriever — retrieve metadata only (108 lines) #retriever-metadata #needs:router-crud
- [x] SliceRetriever — array pagination, head/tail/random (108 lines) #retriever-slice #needs:router-crud
- [x] FilterRetriever — MongoDB-style filtering (123 lines) #retriever-filter #needs:query-engine
- [x] StructuredRetriever — structured data extraction (84 lines) #retriever-structured #needs:router-crud
- [x] TextRetriever — text field extraction (102 lines) #retriever-text #needs:router-crud
- [x] FlattenRetriever — flatten nested structures (108 lines) #retriever-flatten #needs:router-crud
  - Tests: no dedicated retriever tests

### Adapter Sync

- [x] syncAdapters — bidirectional with 3-way merge, conflict resolution (101 lines) #sync #needs:adapter-interface
  - Modes: push, pull, sync | Conflict: source-wins, target-wins, custom
  - Tests: `obsidian-sync.test.ts` (for Obsidian↔Notion case)

### Materializers (5 formats)

- [x] JSON materializer (336 lines) #mat-json
- [x] CSV materializer (321 lines) #mat-csv
- [x] Markdown materializer (249 lines) #mat-markdown
- [x] YAML materializer (202 lines) #mat-yaml
- [x] Text materializer (137 lines) #mat-text
  - Tests: no dedicated materializer tests (exercised via VFS export)

---

## Phase 5: Agent Interface [shipped]

### VFS Engine

- [x] VFS core — path resolution, tokenizer, command chaining (vfs.ts) #vfs #needs:router-crud
- [x] `&&` chaining + `|` pipes + `--format=` output formatting #vfs-features #needs:vfs

### VFS Commands (15 + 8 aliases)

- [x] Navigation: pwd, cd, ls, tree #vfs-nav #needs:vfs
- [x] File ops: cat, write, rm, cp, mv, stat, find, grep, du, wc, export #vfs-fileops #needs:vfs
- [x] Overlay ops: overlay-status, overlay-diff, overlay-commit, overlay-discard, snapshot #vfs-overlay #needs:vfs #needs:adapter-overlay
- [x] Aliases: dir=ls, read=cat, echo=write, delete=rm, remove=rm, copy=cp, move=mv, search=grep #vfs-aliases
  - Tests: `vfs.test.ts` (51 tests)

### CLI

- [x] Interactive REPL with state persistence #vfs-repl #needs:vfs
- [x] One-shot mode: `deno task sh "ls"` #vfs-oneshot #needs:vfs
- [x] Standard commands: collections, keys, get, set, delete, query, search, tree #cli-commands #needs:router-crud

---

## Phase 6: Advanced Features [shipped]

### Graph Store (2556 lines)

- [x] Node/edge CRUD, relationships (store.ts, 956 lines) #graph-store #needs:router-crud
- [x] BFS/DFS traversal, shortest path (traversal.ts, 618 lines) #graph-traversal #needs:graph-store
- [x] Query builder for complex graph queries (query.ts, 471 lines) #graph-query #needs:graph-store
  - Tests: `graph.test.ts` (15+ tests) — in tests/

### Episodic Memory (2623 lines)

- [x] Episode CRUD, recall (store.ts, 622 lines) #episodic-store #needs:router-crud
- [x] Timeline operations, temporal filtering (timeline.ts, 383 lines) #episodic-timeline #needs:episodic-store
- [x] Relevance scoring, recall algorithms (recall.ts, 351 lines) #episodic-recall #needs:episodic-store
- [x] Forgetting curve, importance decay (decay.ts, 237 lines) #episodic-decay #needs:episodic-store
  - Tests: `episodic.test.ts` — in tests/

### Progressive Disclosure (2297 lines)

- [x] Disclosure engine (store.ts, 534 lines) #disclosure-store #needs:router-crud
- [x] Multi-level summarization (summarizer.ts, 439 lines) #disclosure-summarizer #needs:disclosure-store
- [x] Skill registry, matching (skills.ts, 382 lines) #disclosure-skills #needs:disclosure-store
- [x] Relevance scoring, fuzzy match (relevance.ts, 352 lines) #disclosure-relevance #needs:disclosure-store
  - Tests: `disclosure.test.ts` — in tests/

### Presets

- [x] memory — memory only #preset-memory
- [x] local — memory + local-json + local-file #preset-local
- [x] local-sqlite — memory + sqlite + local-file #preset-local-sqlite
- [x] deno-fs — memory + deno-fs #preset-deno-fs
- [x] cloud — memory + upstash + optional R2 #preset-cloud
- [x] hybrid — memory + sqlite + optional upstash #preset-hybrid
- [x] structured — memory + structured-sqlite + local-file #preset-structured

### Utilities (3390 lines)

- [x] Path utils — parse/build collection paths, key management (362 lines) #util-path
- [x] Size utils — calculate data sizes, format bytes (148 lines) #util-size
- [x] Glob utils — pattern matching, regex conversion (93 lines) #util-glob
- [x] Extension utils — file extensions, MIME types (342 lines) #util-extensions
- [x] Response utils — format query results (325 lines) #util-response
- [x] Env utils — environment variable resolution (53 lines) #util-env
- [x] Debug utils — debug logging (41 lines) #util-debug

### File Explorer

- [x] FileExplorer — browse file structure, metadata (389 lines) #file-explorer #needs:router-crud
  - Tests: `file-explorer.test.ts`

---

## Applications & Examples [shipped]

### Apps

- [x] API server — standalone HTTP server for running smallstore as a service (apps/api/) #app-api #needs:http-hono #needs:router-crud
- [x] Self-interview — full end-to-end demo app: AI interview engine + web UI + Google Sheets backend (apps/self-interview/, 15 files) #app-self-interview #needs:adapter-sheetlog
  - Demonstrates: Sheetlog adapter, real-time AI, web UI, .env config
  - Has own deno.json, static assets, live tests

### App Examples (5 mini apps)

- [x] data-clipper — bookmarklet-style data capture #example-data-clipper
- [x] md-paste — markdown paste bin #example-md-paste
- [x] media-gallery — media file gallery #example-media-gallery
- [x] mini-crm — tiny CRM #example-mini-crm
- [x] tiny-auth — minimal auth example #example-tiny-auth

### Runnable Examples (9 scripts)

- [x] Adapter demos — airtable-adapter-example.ts, notion-adapter-example.ts #example-adapters
- [x] Query demos — query-examples.ts, query-caching.examples.ts #example-queries
- [x] Feature demos — external-sources, file-explorer, upsert, read-api-cache #example-features
- [x] Migration — cleanup-migration-test.ts #example-migration

### Entry Points & Config

- [x] mod.ts — main package entry, all public exports #entry-mod
- [x] presets.ts — 7 preset configurations #entry-presets
- [x] config.ts — adapter config types, env resolvers, factory (467 lines) #entry-config
- [x] factory-slim.ts — lightweight factory for minimal instances #entry-factory-slim
- [x] serve.ts — server bootstrapping #entry-serve
- [x] jsr.json — JSR package config (already exists) #publishing-jsr
- [x] package.json — npm metadata #publishing-npm
- [x] scripts/build-npm.ts — npm build script #publishing-build

---

## Phase 7: Publishing & Polish [shipped]

### Lane A: Cleanup (no dependencies)

- [x] [done: archive/ deleted in git, stale redirects removed] Docs cleanup — archive 40+ phase-completion records #docs-cleanup
- [x] [done: 30+ types now exported from mod.ts] Export missing types (CachedResult, CachingConfig, QueryCacheOptions, etc.) #type-exports
- [x] [done: not a bug — async init is correct, added defensive comment] Unstorage adapter async init #unstorage-fix #needs:adapter-interface
- [x] [done: removed TODO.md and docs/TASKS.md] Remove old task files (replaced by TASKS family) #task-cleanup
- [x] [done: removed exports from http/mod.ts, file kept but not public] Remove or un-export Express stub (currently exported but throws) #express-cleanup #needs:http-handlers

### Lane B: Search Polish (depends on search)

- [x] [done: LocalJSON wired; Upstash/CF KV deferred] Wire BM25 search to more adapters (LocalJSON, Upstash, Cloudflare KV) #search-expansion #needs:bm25
- [x] [done: SqliteFtsSearchProvider wired, auto-indexes on set/delete] Wire SqliteFtsSearchProvider to StructuredSQLite adapter #search-structured-sqlite #needs:sqlite-fts
- [x] [done: 50 movies, HF bge-small-en-v1.5, all 4 tests pass] Test vector search with real embeddings #vector-real-test #needs:zvec
- [x] [done: docs/user-guide/search.md] Document search provider usage in user-guide #search-docs #needs:search-interface

### Lane C: Publishing (depends on cleanup)

- [x] [done: jsr.json + deno.json updated, LICENSE added, dry-run passes] JSR package setup (deno.json, mod.ts exports audit) #jsr-setup #needs:docs-cleanup #needs:type-exports
- [x] [done: SM_WORKERS_URL primary, coverflow refs cleaned] Decouple from coverflow imports (if any remain) #decouple #needs:jsr-setup
- [x] [done: dnt build script, dist/ produces ESM + types, 12 subpath exports] npm build target (TBD — conversion complexity) #npm-target #needs:jsr-setup

### Lane D: Testing Gaps (independent)

- [x] [done: 24 mocked tests] Cloudflare adapter integration tests (KV, D1, DO, R2 — currently no dedicated tests) #cf-tests #needs:adapter-interface
- [x] [done: 7 tests in cloudflare-adapters.test.ts] Unstorage adapter tests #unstorage-tests #needs:unstorage-fix
- [x] [done: 13 tests in search-integration.test.ts; flagged 4 issues — hybridAlpha drop, LocalJson reopen, metadata leak, MemoryAdapter swap] Search provider tests with real adapters #search-integration-tests #needs:search-interface
- [x] [done: 88 tests across cache-manager/query-engine/external-fetcher.test.ts; flagged 2 bugs — 304 dead code, CacheManager LRU unenforced] Router internals tests #router-tests #needs:router-crud
- [x] [done: 47 tests per TASKS-TESTS.md] Retriever pipeline tests (6 retrievers, no dedicated tests) #retriever-tests #needs:router-crud
- [x] [done: 31 tests in data-ops-http.test.ts; exposed + fixed router.ts get() missing {raw:true} on slice/split/deduplicate/merge] Data ops HTTP endpoint tests #data-ops-tests #needs:data-ops-http
- [x] [done: 21 tests] Materializer tests (currently only exercised via VFS export) #materializer-tests #needs:router-crud
- [x] [done: 45 tests] Input validation tests #validation-tests #needs:validation

---

## Phase 8: LLM / Agent Intelligence [future]

Features that extend smallstore for AI/agent workflows. All build on the existing retrieval pipeline (`RetrievalProvider` interface) and disclosure/episodic modules. These are optional — smallstore works fine without them.

### Retrieval Pipeline Extensions

- [ ] Re-rank provider (Cohere/Jina) — cross-encoder re-scoring after initial search #rerank-provider #needs:search-interface
- [ ] Context window provider — token-budget-aware slicing, fit retrieval results to a target token count #context-window-provider #needs:search-interface
- [ ] RAG pipeline preset — composable search → rerank → context-window → disclose pipeline #rag-preset #needs:rerank-provider #needs:context-window-provider
- [ ] Pipeline HTTP endpoint — `POST /:collection/pipeline` for ad-hoc retrieval chains #pipeline-http #needs:http-handlers

### Episodic / Memory Enhancements

- [ ] Semantic recall — vector-based episode retrieval (currently keyword/tag only) #episodic-semantic #needs:episodic-store #needs:vector-memory
- [ ] Working memory — short-term scratch space with auto-eviction, for agent conversation state #working-memory #needs:episodic-store
- [?] Memory consolidation — merge related episodes over time (sleep-like compaction) #memory-consolidation #needs:episodic-store

### Disclosure / Context Control

- [?] Multi-user disclosure — per-user access levels on progressive disclosure #disclosure-multi-user #needs:disclosure-store
- [?] Auto-summarization provider — LLM-generated summaries at disclosure levels (currently manual) #auto-summarize #needs:disclosure-summarizer

---

## Phase 9: Messaging — Inbox + Channel + Outbox -> 2026-Q2

New plugin family for **flows in** (Channel → Inbox) and later **flows out** (Outbox → Channel). Sibling to materializers/search/retrievers/views — composes existing adapters, doesn't replace them. Brief: `.brief/messaging-plugins.md`. Full backlog: [TASKS-MESSAGING.md](./TASKS-MESSAGING.md).

### Lane A: Foundation (sequential)

- [ ] Deploy `serve.ts` to Cloudflare Workers as the smallstore host #deploy-host
- [ ] `Channel` + `Inbox` interfaces + reference impl in `src/messaging/` #messaging-iface #needs:deploy-host
- [ ] Inbox HTTP routes + admin runtime-config API in `src/http/` #messaging-http #needs:messaging-iface
- [ ] CF Email channel (`cf-email`) + `email()` export on `serve.ts` #channel-cf-email #needs:messaging-http
- [ ] Wire mailroom — Email Routing → deployed Worker → mailroom collection consumer scripts #mailroom-wired #needs:channel-cf-email
- [ ] MCP tools — `sm_inbox_*` + admin tools #messaging-mcp #needs:messaging-http

### Lane B: More channels (parallel, ship as needed)

- [ ] `webhook` channel — generic HTTP receiver with optional HMAC #channel-webhook #needs:messaging-http
- [ ] `rss` pull channel + shared pull runner via Worker `scheduled()` cron #channel-rss #needs:messaging-http
- [ ] `voice` push channel for `@cloudflare/voice` transcript streams #channel-voice #needs:messaging-http

### Lane C: Outbox (deferred until first send use case)

- [?] Spike: D1-table-as-queue vs CF Queues + DO alarms #outbox-spike #needs:mailroom-wired
- [ ] `Outbox` plugin + `cf-email-out` channel (CF Email Sending public beta) #outbox-cf-email #needs:outbox-spike
- [ ] Outbox HTTP routes + MCP tools #outbox-http #needs:outbox-cf-email

### Lane D: Polish (after foundation)

- [ ] `docs/design/messaging-pattern.md` — public contract documentation #messaging-docs #needs:mailroom-wired
- [ ] `examples/cf-email-inbox/` — documentation-grade walkthrough #messaging-example #needs:mailroom-wired
- [ ] Federated query across inboxes #federated-query #needs:messaging-http
- [ ] Workflows V2 trigger from `inbox.watch` #workflows-trigger #needs:messaging-http

---

## Test Coverage Summary

Full details in [TASKS-TESTS.md](./TASKS-TESTS.md). **537 offline tests passing across 28 files.**

| Area | Tests | Status |
|------|------:|--------|
| Adapters (SQLite, StructuredSQLite, LocalFile, DenoFS, Overlay, Airtable, CF KV/D1/DO/R2, Unstorage) | 160 | All passing |
| Core / Router (presets, matrix, batch, patch, glob, collections, detector) | 118 | All passing |
| Search (BM25, MemoryVector, MemoryHybrid, Zvec) | 36 | All passing |
| Modules (graph, episodic, disclosure, blob-middleware, views, materialized views, file explorer) | 127 | All passing |
| HTTP / API (handlers + Hono integration) | 45 | All passing |
| VFS (15 commands, aliases, chaining, pipes) | 51 | All passing |
| Live API (HuggingFace embeddings, multi-adapter) | 4+ | Requires env vars |
| **Gaps** | | |
| F2-R2 adapter | 0 | No tests |
| Upstash/Notion/Sheetlog/R2Direct (offline) | 0 | Live-only |
| Materializers, Retrievers, Validation, Key Index | 0 | No dedicated tests |
| Obsidian adapter/sync | 3 files | Broken (`@std/path` import) |
