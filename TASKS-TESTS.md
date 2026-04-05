# Smallstore — Test Coverage

**Total: 771 offline tests passing, 13 live-adapter tests, 13 specialized live tests passing**

Last verified: 2026-03-19

Run all live tests from the project root (where `.env` lives):
```bash
deno test --no-check --allow-all tests/live-adapters.test.ts
```

## Offline Tests — All Passing

### Adapters

- [x] [pass: 18/18, `deno test tests/sqlite.test.ts`] SQLite adapter CRUD, TTL, prefix, clear #test #adapter
- [x] [pass: 22/22, `deno test tests/sqlite-query.test.ts`] SQLite native query, filters, sort, pagination #test #adapter
- [x] [pass: 19/19, `deno test tests/structured-sqlite.test.ts`] Structured SQLite — typed columns, indexes, FTS #test #adapter
- [x] [pass: 5/5, `deno test tests/preset-structured.test.ts`] Structured SQLite via preset config #test #adapter
- [x] [pass: 12/12, `deno test tests/local-file.test.ts`] Local file adapter — binary blobs on disk #test #adapter
- [x] [pass: 13/13, `deno test tests/deno-fs-adapter.test.ts`] Deno FS adapter — real directory as store #test #adapter
- [x] [pass: 46/46, `deno test tests/overlay-adapter.test.ts`] Overlay adapter — COW read-through, snapshots, diff, commit #test #adapter
- [x] [pass: 3/3, `deno test tests/airtable-field-creation.test.ts`] Airtable dynamic field creation (mocked) #test #adapter
- [x] [pass: 24/24, `deno test tests/cloudflare-adapters.test.ts`] Cloudflare KV(5), D1(3), DO(4), R2(5) + Unstorage(7) — mocked fetch #test #adapter
  - [*] KV: constructor validation, capabilities, full CRUD, namespace prefixing, TTL passthrough
  - [*] D1: constructor validation, capabilities, full CRUD
  - [*] DO: constructor validation, capabilities, full CRUD + clear, custom namespace/instanceId
  - [*] R2: constructor validation, capabilities, full CRUD, scope prefixing, auth headers
  - [*] Unstorage: unknown driver rejection, credential validation (upstash, cf-kv, cf-r2), capabilities by driver, full CRUD + prefix clear, factory function
- [x] [pass: 9/9, `deno test tests/adapter-mocks.test.ts`] Upstash(5) + F2-R2(4) — mocked fetch, full CRUD, namespace, TTL #test #adapter
  - [*] Upstash: constructor validation, capabilities, full CRUD, namespace prefixing, TTL uses setex
  - [*] F2-R2: capabilities, set+get+has via cmd:data, delete with authKey, keys listing via cmd:list
- [x] [pass: 11/11, `deno test tests/adapter-search.test.ts`] Notion/Airtable BM25 search provider wiring #test #adapter #search
  - [*] BM25 provider exists and exposes correct name/supportedTypes
  - [*] Index + search cycle (simulates set → search)
  - [*] Empty index returns no results (pre-hydration)
  - [*] Remove after delete, collection scoping, update re-indexes
  - [*] Various value types, limit, empty/special queries, relevance ordering
  - [*] Hydration pattern: bulk index then multi-field search
  - [*] Note: extractSearchableText only indexes DEFAULT_FIELDS (content, text, body, description, title, name, summary) — custom fields need JSON.stringify fallback
  - [*] Note: BM25 uses exact token matching (no stemming) — "engineer" ≠ "engineering"

### Live adapter search test

- [x] [pass: `deno run tests/live/adapter-search/test.ts`] Airtable + Notion BM25 search with real data #test #live #search
  - [*] Airtable: 3 records created, "machine learning" → 2 results (correct), hydrated 20 existing records, cleanup
  - [*] Notion: 3 records created, "engineer" → 2 results (correct), hydrated 57 existing records, cleanup
  - [*] Verified: set() auto-indexes, search works immediately after writes, hydration pattern works for existing data

- [x] [pass: 26/26, `deno test tests/obsidian-codec.test.ts tests/obsidian-adapter.test.ts`] Obsidian adapter — codec, CRUD, query, vault graph #test #adapter
- [x] [pass: 35/35, `deno test tests/sync-adapters.test.ts`] Sync adapters — push, pull, bidirectional, conflict resolution, baseline #test #adapter
- [x] [pass: 7/7, `deno test tests/obsidian-sync.test.ts`] Obsidian sync — export, import, bidirectional, sqlite roundtrip, manifest diff #test #adapter

### Core / Router

- [x] [pass: 28/28, `deno test tests/presets.test.ts`] Presets — local, local-sqlite, memory, resolution #test #core
- [x] [pass: 21/21, `deno test tests/matrix.test.ts`] Router matrix — multi-adapter routing, type routing, mounts #test #core
- [x] [pass: 8/8, `deno test tests/batch.test.ts`] Batch operations — batchGet, batchSet, batchDelete #test #core
- [x] [pass: 8/8, `deno test tests/patch.test.ts`] Patch/merge — deep merge, array append, overwrite modes #test #core
- [x] [pass: 21/21, `deno test tests/glob.test.ts`] Glob utilities — pattern matching, regex conversion, prefix extraction #test #util
- [x] [pass: 5/5, `deno test tests/list-collections.test.ts`] Collection listing across adapters #test #core
- [x] [pass: 27/27, `deno test tests/detector.test.ts`] Data detector — type detection, size calculation, analysis #test #util

### Search

- [x] [pass: 11/11, `deno test tests/search.test.ts`] BM25 full-text search — indexing, query, relevance #test #search
- [x] [pass: 25/25, `deno test tests/vector-search.test.ts`] MemoryVector, MemoryHybrid, Zvec — mock embeddings #test #search
  - [*] MemoryVector: index+search, score ordering, pre-computed vectors, remove
  - [*] MemoryHybrid: BM25+vector fusion via RRF
  - [*] Zvec: HNSW index+search, score ordering, pre-computed vectors, remove, name+supportedTypes

### Modules

- [x] [pass: 29/29, `deno test tests/graph.test.ts`] Graph store — nodes, edges, traversal, BFS, DFS, shortest path #test #module
- [x] [pass: 23/23, `deno test tests/episodic.test.ts`] Episodic memory — episodes, sequences, recall, decay #test #module
- [x] [pass: 26/26, `deno test tests/disclosure.test.ts`] Progressive disclosure — levels, relevance scoring, skills #test #module
- [x] [pass: 24/24, `deno test tests/blob-middleware.test.ts`] Blob middleware — detection, resolution, platform formats #test #module
- [x] [pass: 5/5, `deno test tests/view.test.ts`] Views — save, load, delete, list, key building #test #module
- [x] [pass: 13/13, `deno test tests/materialized-views.test.ts`] Materialized views — create, refresh, update, delete #test #module
- [x] [pass: 7/7, `deno test tests/file-explorer.test.ts`] File explorer — tree, metadata, navigation #test #module
- [x] [pass: 21/21, `deno test tests/materializers.test.ts`] Materializers — JSON, CSV, Markdown, Text, YAML (collection + item) #test #module
- [x] [pass: 45/45, `deno test tests/validation.test.ts`] Input validation — strict/sieve modes, JSON Schema, Zod, transforms (pick/omit/where/$operators), processInput #test #module
- [x] [pass: 18/18, `deno test tests/keyindex.test.ts`] Key index — createEmpty, add/remove, getLocation, save/load/delete with MemoryAdapter #test #module
- [x] [pass: 13/13, `deno test tests/namespace.test.ts`] Namespace operations — prefix listing, copy, move, delete namespace, deep nesting, has() #test #module
- [x] [pass: 47/47, `deno test tests/retrievers.test.ts`] Retrievers — all 6 types (Metadata, Slice, Filter, Structured, Text, Flatten) + createMetadata helper #test #module

### HTTP / API

- [x] [pass: 25/25, `deno test tests/http.test.ts`] HTTP handlers — GET, SET, DELETE, metadata, schema, keys, signed URLs, exports #test #http
- [x] [pass: 24/24, `deno test tests/api.test.ts`] API integration — full CRUD + search + query cycle via Hono #test #http
- [x] [pass: 9/9, `deno test tests/retrieval-pipeline.test.ts`] Retrieval pipeline — HTTP handler (filter, slice, multi-step, errors) + VFS retrieve (filter, slice, chained pipes, usage) #test #http #vfs

### Agent Interface

- [x] [pass: 51/51, `deno test tests/vfs.test.ts`] VFS — 15 commands, aliases, chaining, pipes, format options #test #vfs

## Live-API Tests — All Passing

### Core live-adapters.test.ts (13/13 passing)

- [x] [pass: 13/13, `deno test --no-check --allow-all tests/live-adapters.test.ts`] All adapters CRUD against real services #test #live
  - [*] LocalJSON: CRUD + keys + has
  - [*] Memory: CRUD + delete
  - [*] Upstash: CRUD via SM_UPSTASH_URL/SM_UPSTASH_TOKEN
  - [*] Airtable: CRUD via SM_AIRTABLE_* (3 records, update, list keys, has)
  - [*] Notion: CRUD via SM_NOTION_* (3 records, update, list keys, has)
  - [*] Sheetlog: CRUD via SM_SHEET_URL/SM_SHEET_NAME
  - [*] R2 Direct: CRUD via SM_R2_* (JSON + binary blob + signed URL)
  - [*] Unstorage (Upstash driver): CRUD via SM_UPSTASH_*
  - [*] Cloudflare KV: CRUD via SM_WORKERS_URL (HTTP mode)
  - [*] Cloudflare D1: CRUD via SM_WORKERS_URL (HTTP mode)
  - [*] Cloudflare DO: CRUD via SM_WORKERS_URL (HTTP mode)
  - [*] Multi-adapter: LocalJSON + Memory in parallel
  - [*] Summary: all 11 adapter backends available and passing

### Specialized live tests (scripts, not deno test)

- [x] [pass: `deno run tests/live/airtable/test.ts`] Airtable — CRUD, update, list keys, has #test #live
- [x] [pass: `deno run tests/live/r2/test.ts`] R2 Direct — JSON, binary blob, signed download URL, list keys #test #live
- [x] [pass: `deno run tests/live/sheetlog/test.ts`] Sheetlog — create rows, read all, find by column, upsert #test #live
- [x] [pass: `deno run tests/live/notion/test.ts`] Notion — CRUD, update, list keys (40 total), has #test #live
- [x] [pass: `deno run tests/live/airtable-blobs/test.ts`] Airtable + R2 blob middleware — 3 bunnies with images #test #live
- [x] [pass: `deno run tests/live/notion-blobs/test.ts`] Notion + R2 blob middleware — 3 bunnies with images #test #live
- [x] [pass: `deno run tests/live/sheetlog-views/test.ts`] Sheetlog views — CSV, Markdown, JSON materialization (10 tasks) #test #live
- [x] [pass: `deno run tests/live/sheetlog-disclosure/test.ts`] Sheetlog disclosure — progressive depth, skills, cross-topic discovery #test #live
- [x] [pass: `deno run tests/live/notion-graph-crm/test.ts`] Notion graph CRM — 7 nodes, 8 edges, path finding, BFS/DFS #test #live
- [x] [pass: `deno run tests/live/notion-episodic/test.ts`] Notion episodic — 6 episodes, recall by tag, timeline, decay #test #live
- [x] [pass: `deno run tests/live/notion-wiki/test.ts`] Notion wiki — 8 pages, namespaces, retrievers (Metadata, Text, Filter) #test #live
- [x] [pass: `deno run tests/live/multi-adapter-network/test.ts`] Multi-adapter network — Notion people + Sheetlog meetings + graph traversal #test #live

### Real embedding tests

- [x] [pass: 4/4, `deno test tests/vector-search-real.test.ts`] HuggingFace bge-small-en-v1.5 #test #search #live
  - [*] 50 movies, MemoryVector semantic, Zvec HNSW, Hybrid BM25+vector, self-similarity clustering
  - [*] ~2s runtime, 7 HF API calls

### Previously failing — Now Fixed

- [x] [pass: after F2 protocol fix] Blob middleware standalone test (`tests/live/blobs/test.ts`) #test #live #fixed
  - [*] Was: `uploadF2R2` posted to non-existent `/upload` endpoint
  - [*] Fix: uses `cmd: presign` + presigned URL PUT, matching F2R2Adapter protocol
  - [*] Also fixed `deleteF2R2` to use `cmd: delete` command protocol

## Previously Broken — Now Fixed

- [x] [pass: 35/35 after import map fix] Sync adapter tests (`tests/sync-adapters.test.ts`) #test #fixed
- [x] [pass: 26/26 after import map fix] Obsidian adapter + codec tests (`tests/obsidian-adapter.test.ts`, `tests/obsidian-codec.test.ts`) #test #fixed
- [x] [pass: 7/7 after import map fix] Obsidian sync tests (`tests/obsidian-sync.test.ts`) #test #fixed
  - [*] Fix: added `"@std/path": "jsr:@std/path@^1.0.0"` to deno.json imports

## Coverage Gaps — No Tests

### Adapters without offline (mocked) tests

- [ ] Upstash adapter — live tests pass, no mocked offline test #gap #adapter
  - [*] `src/adapters/upstash.ts` — HTTP REST API, could mock fetch like CF adapters
- [ ] Notion adapter — live tests pass, no mocked offline test #gap #adapter
  - [*] `src/adapters/notion.ts` — uses @notionhq/client, would need to mock Client
- [ ] Sheetlog adapter — live tests pass, no mocked offline test #gap #adapter
  - [*] `src/adapters/sheetlog.ts` — HTTP to Google Sheets proxy
- [ ] R2 Direct adapter — live tests pass, no mocked offline test #gap #adapter
  - [*] `src/adapters/r2-direct.ts` — uses @aws-sdk/client-s3, could mock S3Client
  - [*] Signed URL methods (getSignedUploadUrl, getSignedDownloadUrl) verified live via R2 test
- [ ] F2-R2 adapter — no dedicated offline test #gap #adapter
  - [*] `src/adapters/f2-r2.ts` — HTTP proxy to R2 via F2 service
  - [*] Exercised indirectly via blob middleware live test (upload + delete via F2 protocol)

### Infrastructure

- [ ] Obsidian import map fix — unblock 3 test files #gap #infra
  - [*] Fix: add `"@std/path": "jsr:@std/path@^1.0.0"` to deno.json imports

## Test Commands Quick Reference

```bash
# All offline tests (537 tests, ~25s)
deno test --no-check --allow-all tests/

# Core adapters + utilities (217 tests)
deno task test:core

# Graph + episodic + disclosure (78 tests)
deno task test:unit

# All live adapter tests (13 tests, ~23s)
deno test --no-check --allow-all tests/live-adapters.test.ts

# Individual live tests
deno run --no-check --allow-all tests/live/airtable/test.ts
deno run --no-check --allow-all tests/live/r2/test.ts
deno run --no-check --allow-all tests/live/sheetlog/test.ts
deno run --no-check --allow-all tests/live/notion/test.ts
deno run --no-check --allow-all tests/live/airtable-blobs/test.ts
deno run --no-check --allow-all tests/live/notion-blobs/test.ts
deno run --no-check --allow-all tests/live/sheetlog-views/test.ts
deno run --no-check --allow-all tests/live/sheetlog-disclosure/test.ts
deno run --no-check --allow-all tests/live/notion-graph-crm/test.ts
deno run --no-check --allow-all tests/live/notion-episodic/test.ts
deno run --no-check --allow-all tests/live/notion-wiki/test.ts
deno run --no-check --allow-all tests/live/multi-adapter-network/test.ts

# Real embedding tests (requires HUGGINGFACE_API_KEY)
deno test --no-check --allow-all tests/vector-search-real.test.ts
```

## Test Count Summary

| Area | Offline | Live | Status |
|------|--------:|-----:|--------|
| Adapters | 160 | 13 + 6 scripts | All passing |
| Core / Router | 118 | — | All passing |
| Search | 36 | 4 (embeddings) | All passing |
| Modules | 271 | 6 scripts (graph, episodic, disclosure, views, wiki, multi-adapter) | All passing |
| HTTP / API | 45 | — | All passing |
| VFS | 51 | — | All passing |
| Obsidian/Sync | 68 | — | Fixed (was broken) |
| F2 Blobs | — | 1 script | Fixed (was failing) |
| **Total** | **749** | **13 + 13 scripts + 4 embed** | |
