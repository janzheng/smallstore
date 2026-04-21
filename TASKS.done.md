# Smallstore — Completed Tasks

Archive of shipped work, newest at top. See `git log` for full diffs and individual commits.

---

## 2026-04-21 — Notion SDK v5 forward-compat

- [x] [done: commit `59c5369`] Added `position` param to `notionModern.appendBlockChildren()` alongside `after` for SDK v5 forward compat. Position wins if both supplied; positioning only applies to first batch when chunking. Mirrored the same change in coverflow-v3 (commit `36546951`) on the same day. 810/810 tests green

## 2026-04-17 → 2026-04-18 — Paging + JSONL jobs + audit closeout

Two JSR releases — **0.1.8** (paging + JSONL job logs + audit batches 1-8) and **0.1.9** (audit closeout). Coverflow-v3 bumped 0.1.7 → 0.1.9.

- [x] [done: commits `73868fc` + `0e93b13`] Adapter paging via opt-in `listKeys({prefix, limit, offset, cursor}) → {keys, hasMore, cursor?, total?}` — added to interface, router fallback for non-paged adapters, native impls in MemoryAdapter (slice), SQLiteAdapter (LIMIT/OFFSET + COUNT), NotionAdapter (start_cursor), AirtableAdapter (opaque offset), UpstashAdapter (SCAN cursor), CloudflareKVAdapter (list with `list_complete`). Sheetlog skipped — log-style, no stable keys. HTTP `handleListKeys` accepts `?limit=N&offset=N&cursor=X` with validation. Tests in `tests/adapter-paging.test.ts` + 3 SQLite listKeys tests #paging
- [x] [done: commit `747518e`] JSONL job logs for `/_sync` — `src/utils/job-log.ts` (`createJobLog`/`tailJobLog`/`listJobs`/`summarizeJob`/`generateJobId`), `/_sync` defaults to background (202 + jobId + logPath, `?wait=true` for sync), `GET /_sync/jobs` + `GET /_sync/jobs/:id` for inspection (path-traversal guard via `/^[A-Za-z0-9._-]+$/`), optional `SMALLSTORE_TOKEN` bearer auth, per-pair `syncLocks: Map`. MCP gained `background?` flag + `sm_sync_status`/`sm_sync_jobs` tools. Tests: `tests/job-log.test.ts` (8) + `tests/sync-jobs-http.test.ts` (4 spawning real serve.ts) #sync #jobs #mcp
- [x] [done: TASKS-AUDIT.md, 8 batches landed across `dfc9751`, `f825014`, `291617d`, `1bd4464`, `454cac0`, `50040eb`, `1f640d5`, `5db0dab`, `1573f36`] Pre-0.1.8 audit Waves 1-2 — 47 findings landed. P1 regressions A001-A008 (LocalJson wrapper, SqliteFts metadata leak, MemoryAdapter clear race, deleteFromArray unwrap, deno-fs reopen, CSV BOM, CSV keyColumn, internal-key index guard); MCP/HTTP security A010-A013 (bearer auth, SYNC_OPTION_WHITELIST, self-sync guard, concurrent sync lock); MCP input hardening A070-A081 (collection validation, JSON.stringify guard, token CRLF check, MAX_RESPONSE_BYTES 10MB cap, SMALLSTORE_URL validation, SIGTERM/SIGINT, MethodNotFound RPC error, sm_list limit, source_adapter rename, empty-filter rejection, sm_read cost warning); CSV adapter polish A053-A059 (duplicate header detection, duplicate key warning, clock-skew guard, URL validation, @internal marker, auth-stripping error messages, readOnly capability); CacheManager A020-A024/A030 (TTL drop, torn-state rollback, oversized warn, TextEncoder UTF-8 sizing, typed CacheValidError); LocalJson A100-A102 (hydrate-promise reset, cached identity wrapper, cloned value to provider.index); Search providers A040-A044 (isInternalKey helper, zvec topk fix, filter forwarding, strict prefix match) #audit
- [x] [done: 11 verified findings after dropping false positives] Audit Wave 3 — paging + JSONL sweep
  - **A200** (commit `95b5f73`): `/_sync` lock TOCTOU race — moved createJobLog inside the IIFE so no awaits between `has()` and `set()` #race-condition
  - **A224** (`95b5f73`): SQLite listKeys silently dropped cursor — now accepts stringified offset, rejects non-numeric, emits `cursor: String(nextOffset)` when hasMore (2 new tests)
  - **A031** (`47f3f01`): external-fetcher 304 path now throws typed CacheValidError (was bare `Error('CACHE_VALID')`)
  - **A222** (`47f3f01`): `handleListKeys` uses `Number() + Number.isInteger()` — rejects "999x" instead of silently parsing as 999
  - **A228** (`47f3f01`): `?limit=0` now rejected as BadRequest (was returning empty-keys + hasMore:true)
  - **A244** (`47f3f01`): Extracted `DEFAULT_TAIL_EVENTS` + `SUMMARY_SCAN_EVENTS` constants with JSDoc in job-log.ts
- [x] [fixed: commit `9f70646`] package.json `@notionhq/client` bumped `^2.3.0` → `^5.16.0` to match deno.json — prior mismatch had Deno materializing BOTH versions in node_modules and the subpath type import resolved to v2's incompatible types, surfacing as 7 TS errors on `deno publish` with full type checking
- [x] [done: commit `747518e` + tag] **JSR 0.1.8** — paging + JSONL jobs + audit batches 1-8
- [x] [done: commit `47f3f01` + tag] **JSR 0.1.9** — audit closeout (A031, A222, A228, A244) + A200 + A224
- [*] **Session stats**: 836 tests passing (up from 819), 58/58 + 11 Wave 3 findings (57 fixed, 1 won't-fix A042-path is `@deprecated`, 9 deferrable at-scale-only polish), 2 JSR releases, 1 coverflow bump

## 2026-04-17 — Phase 7 testing sweep bug fixes

Bugs surfaced by the Phase 7 testing sweep — each had a test asserting current (broken) behavior, flipped when fixed.

- [x] [fixed: added `{raw:true}` to `src/router.ts:1515/1584/1623/1680`] `router.get()` unwrapping in data-ops (slice/split/deduplicate/merge) #router
- [x] [fixed] `router.search()` now forwards `hybridAlpha` + `metric` to provider #router-search
- [x] [fixed] `LocalJsonAdapter.searchProvider` getter wraps provider with lazy hydration from disk on first `search()` — fixes BM25 index rebuild on reopen #local-json
- [x] [fixed] `fetchExternal` 304 Not Modified handling — `retryFetch` now passes 304 through; CACHE_VALID branch is reachable #external-fetcher
- [x] [fixed] `CacheManager` LRU eviction enforced — tracks per-entry size + monotonic access tick, `parseSizeString`, `evictUntilFits` with LRU policy; ttl-only skips eviction #cache-manager
- [x] [fixed] Search providers (bm25/vector/zvec) skip `smallstore:meta:*` and `smallstore:index:*` keys — no more leaked metadata/index keys #router-indexing
- [x] [fixed] `MemoryAdapter` accepts `{searchProvider}` in config; set/delete/clear read through the getter so runtime overrides also work #memory-adapter

## 2026-04-06 → 2026-04-21 — Notion SDK v5 migration

- [x] [done: `f3d3581`] Bump @notionhq/client `^2.3.0` → `^5.16.0` — replaced hardcoded `npm:@notionhq/client@^2.0.0` with bare specifiers, fixed type import path (`api-endpoints.d.ts` → `build/src/api-endpoints.d.ts`), migrated `archived` → `in_trash` in all request bodies, updated API version `2022-06-28` → `2025-09-03`, updated build-npm.ts dependency mappings
- [x] [done: `@yawnxyz/smallstore@0.1.5` published 2026-04-17] **JSR 0.1.5** with Notion v5
- [x] [done: live:notion green after fix] Re-run Notion live adapter tests after JSR publish
- [x] [done: `resolveDataSourceId()` in `notionModern.ts` resolves `database_id` → `data_source_id`, cached per client] queryDatabase → queryDataSource migration for multi-source DBs

## 2026-04-05 — DO adapter live + binding fix

- [x] [fixed: added `ttl?` param to `set()` for interface compliance] DO adapter signature mismatch
- [x] [fixed: `PIPELINE_DO` → `COVERFLOW_DO` in types.ts, do-handler.ts, index.ts] DO binding name mismatch in coverflow-workers
- [x] [done: 7/7 DO checks pass — SET, GET, HAS, KEYS, DELETE, CLEAR, CAPABILITIES] Cloudflare DO adapter live and tested

## 2026-04-04 — Standalone extraction + 0.1.0 publish

- [x] [done: SM_WORKERS_URL primary, backward compat fallback, CF adapter comments, deleted coverflow test+example, updated user-guide docs] Remove coverflow-specific imports and paths #extraction
- [x] [done: deno.json, jsr.json, package.json already correct] Update config files for standalone repo #extraction
- [x] [done: 40+ items → TASKS.done.md, TASKS-RACES → .done.md, TASKS-AUDIT → .done.md, TASKS-VISION → TASKS-DESIGN] Archive completed tasks and spring clean TASKS family
- [x] [done: app-examples/ merged into examples/, all deno.json tasks + doc refs updated] Consolidate app-examples into examples
- [x] [done: upsert-example.ts import, tiny-auth .env paths, self-interview dead ModelProvider code] Fix broken imports and remove dead code
- [x] [done: packages/ removed, research/tigerfs removed, 15 stale docs deleted, 3 updated, all monorepo path refs fixed] Deep docs and repo cleanup
- [x] [done: .DS_Store, dist/, node_modules/ added to .gitignore] Final tidying
- [x] [fixed: 31 type errors → 0 — Smallstore interface, query-engine, VFS grep/retrieve, R2Direct, middleware, retrieval pipeline] Fix all `deno check` type errors
- [x] [fixed: `MemoryAdapter.query()` now handles MongoDB-style filter objects via `matchesFilter()`] Fix query-examples.ts runtime crash
- [x] [done: published `@yawnxyz/smallstore@0.1.0`] **JSR 0.1.0** initial publish
- [x] [done: github.com/janzheng/smallstore] Make repo public on GitHub
- [x] [done: deno.json import map → `jsr:@yawnxyz/smallstore@^0.1.4`, 40 files updated] Add back to coverflow as a dependency
- [x] [done: deno check passes, only pre-existing coverflow errors remain] Verify coverflow still works with smallstore as external dep

### 2026-04-04 Pre-publish validation

- 595 offline tests passing, 0 failed
- `deno check mod.ts` 0 errors (was 31)
- `deno publish --dry-run` pass
- `deno task build:npm` ESM + types in dist/
- Apps: `api` (serves :8787), `cli` (help works)
- Local examples: `clipper` 45/45, `crm` 51/51, `gallery` simulated, upsert/query/file-explorer all pass
- `auth` register/login/sessions working
- Live adapters: 12/13 pass (Upstash, Airtable, Notion, Sheetlog, R2 Direct, Unstorage/Upstash, CF KV, CF D1) — DO skipped (binding inactive)

## 2026-03 — MCP Server + Hub Skill + Google Sheets CSV adapter

### MCP Server + Skill #mcp-server

Give Claude Code direct access to any Smallstore adapter without going through TigerFlare. Smallstore becomes a first-class MCP tool peer to TigerFlare: TF for agent filesystem/memory, Smallstore for external service I/O.

- [x] [done: `src/mcp-server.ts`, 7 tools wired, tools/list smoke passes] stdio MCP server using `@modelcontextprotocol/sdk`
- [x] [done: `deno task mcp`] deno task entry
- [x] [done: serve.ts adds `GET /_adapters` + `POST /_sync`] HTTP endpoints for sm_adapters / sm_sync
- [x] [done: jq patch to `~/.claude.json`, all 4 mcpServers now: brigade, deno-hub, smallstore, tigerflare] Register in `~/.claude.json` under `mcpServers.smallstore`
- [x] [done: `skills/smallstore/SKILL.md`, 155 lines, frontmatter + preflight + 7 tool sections + troubleshooting] Skill doc
- [x] [done: copied to `mcp-hub/skills/smallstore`, hub:sync added it to Claude Code + Cursor + Codex + Agents] Sync skill to `~/.claude/skills/`
- [x] [done: `examples/.smallstore.json.example` + `.sheetlog-docs.md`; verified `serve.ts` loads `.smallstore.json` via `config.ts loadConfig()`] Zero-extra-code sheetlog path
- [x] [done: `tests/mcp-server.test.ts`, 13 tests passing, incl. end-to-end roundtrip against real serve.ts] MCP server test suite

### Google Sheets CSV adapter (read-only) #google-sheets-csv

Read-only adapter for public/shared Google Sheets without OAuth or Apps Script. Fetches the published CSV export URL, parses into key/value records. Writes throw immediately. Use case: TigerFlare routes `/sheets/*` → this adapter via the bridge.

- [x] [done: 21 tests passing, uses `@std/csv`, read-only with `UnsupportedOperationError`] GoogleSheetsCsvAdapter + tests + README + mod.ts export

---

## Search & Vectors

- [x] [done: auto-indexes on set/delete, search:true in capabilities] Wire BM25 into LocalJSON adapter #search-expansion
- [x] [done: updated to use createEmbed, supports HF+OpenAI auto-detect] Coverflow vectorSearch module #coverflow-vector
- [x] [done: docs/user-guide/search.md — providers, embedding config, custom providers, HTTP API, adapter table] Document SearchProvider system #search-docs
- [x] [done: 50 movies, HF bge-small, all 3 providers + hybrid verified] Real embedding vector search tests #vector-real-test

## Docs & Cleanup

- [x] [done: deleted docs/archive/ 44 files, removed TODO.md + docs/TASKS.md] Docs & task cleanup #docs-cleanup #task-cleanup
- [x] [done: 30+ types exported from mod.ts] Export missing types #type-exports
- [x] [done: not a bug, added defensive comment] Unstorage async init audit #unstorage-fix

## Publishing Prep

- [x] [done: zero coverflow imports found] Audit mod.ts for coverflow leaks #decouple
- [x] [done: jsr.json + deno.json updated, LICENSE added, 8 bare npm: specifiers versioned, dry-run passes] JSR publishing setup #jsr-setup
- [x] [done: CHANGELOG.md written — core, search, HTTP, agent, modules sections] Write CHANGELOG.md #changelog

## Test Fixes (2026-03-19)

- [x] [done: added `@std/path` to deno.json import map, unblocked 68 tests (35 sync + 26 obsidian-adapter + 7 obsidian-sync)] Obsidian `@std/path` import error #test-fix
- [x] [done: uploadF2R2 now uses `cmd: presign` + presigned URL PUT instead of non-existent `/upload` endpoint; deleteF2R2 uses `cmd: delete` command protocol; added `authKey` to F2R2BackendConfig type] F2 blob middleware upload/delete using wrong API protocol #bug-fix

## Loose Ends Found in Audit

- [x] [done: async init fixed] Unstorage adapter init bug #unstorage-fix
- [x] [done: 24 tests — KV(5), D1(3), DO(4), R2(5), Unstorage(7), all mocked offline] Unstorage + Cloudflare adapter tests #unstorage-tests #cf-tests
- [x] [done: not a bug — defensive double-parse is correct, handles external/legacy double-stringified data] Upstash double-stringify investigation #upstash-cleanup
- [x] [done: SqliteFtsSearchProvider wired, auto-indexes on set/delete] StructuredSQLite search provider #search-expansion
- [x] [done: removed exports from http/mod.ts, file kept but not public] Express HTTP stub cleanup #express-stub
- [~] [deferred: COW layering makes this complex, not worth it now] Overlay search provider #search-expansion
- [x] [done: added to Smallstore interface + router + HTTP handlers (POST signed-upload/signed-download), SignedUrlOptions type exported] R2Direct adapter — signed URL methods not exposed via StorageAdapter interface #r2-signed-urls
- [~] [kept: historical reference, not blocking anything] docs/design/VISION.md + ROADMAP.md
- [~] [kept: audit history, useful for understanding past fixes] docs/audits/

## Later (completed)

- [x] [done: covered by cloudflare-adapters.test.ts — 24 offline mock tests] Cloudflare adapter integration tests #cf-tests
- [x] [done: dnt build script fixed (@deno/dnt, importMap, ESM-only), dist/ produces ESM + types, 12 subpath exports] npm package build #npm-target
- [x] [done: both adapters get MemoryBm25SearchProvider, auto-index on set(), remove on delete(), search:true in capabilities] Add search to Notion/Airtable adapters (client-side BM25) #search-expansion
- [x] [done: updated to v0.2.1 (latest). New API: ZVecCreateAndOpen + ZVecCollectionSchema. Scores now return real values (not zeros). 29 tests passing] Upgrade zvec to latest (0.2.1) #zvec-upgrade
- [x] [done: removed efSearch config, zvec defaults work fine. Their JS bindings don't support params yet — not our problem] zvec ef tuning param #zvec-params
- [x] [done: RetrievalProvider interface + RetrievalPipeline + 3 wrapper adapters (SearchProviderWrapper, RetrieverWrapper, DisclosureWrapper) + router integration + 22 tests] Unified retrieval layer #retrieval-unification #architecture
- [x] [done: handleRetrievalPipeline handler + Hono route (POST /:collection/pipeline), dynamic provider registry (filter/slice/text/structured/flatten/metadata)] HTTP endpoint for retrieval pipelines #retrieval-http
- [x] [done: `retrieve` VFS command — filter/slice/text/structured/flatten/metadata with dotted flag parsing, pipes between steps via JSON] Wire VFS pipes to use RetrievalPipeline internally #retrieval-vfs
- [x] [done: 9 tests — Upstash(5): CRUD+namespace+TTL, F2-R2(4): CRUD+keys+delete. Notion/Sheetlog/R2Direct skipped (SDK mocking too complex, covered by live tests)] Offline mocked tests for Upstash/F2-R2 adapters #adapter-mock-tests
- [x] [done: 4 tests added to http.test.ts — upload URL, download URL, default expiry, unsupported adapter] Signed URL HTTP handler test #http-test

## Caching & Bot Protection (2026-03-20) #http-caching

Multi-layer HTTP caching to handle bot traffic and reduce costs. All 4 phases complete.

### Phase 1: Cache-Control Headers + ETag/304
- [x] [done] Export `simpleHash` from `src/utils/cache-key.ts` #cache-headers
- [x] [done: Cache-Control, ETag, If-None-Match → 304, route-specific TTLs, private/public, SWR directive] Create `src/http/middleware/cache-headers.ts` #cache-headers
- [x] [done: `HonoRoutesOptions.cacheHeaders`] Wire cache-headers middleware into Hono adapter #cache-headers
- [x] [done: 16 tests — ETag, 304, Cache-Control, route TTLs, private mode, disabled] Tests for cache-headers middleware #cache-headers #tests

### Phase 2: Server-Side Response Cache with SWR
- [x] [done: ResponseCacheStore class, SWR background refresh, write-through invalidation, cacheSeed, maxEntries eviction, cleanup, stats] Create `src/http/middleware/response-cache.ts` #response-cache
- [x] [done: `HonoRoutesOptions.responseCache`] Wire response-cache middleware into Hono adapter #response-cache
- [x] [done: 20 tests — HIT/MISS/STALE/SWR, invalidation, cacheSeed, neverCache, no-cache header, error responses, stats] Tests for response-cache middleware #response-cache #tests

### Phase 3: Rate Limiting
- [x] [done: RateLimiterStore class, per-IP sliding window, separate read/write limits, 429 + headers, cleanup, stats] Create `src/http/middleware/rate-limiter.ts` #rate-limit
- [x] [done: `HonoRoutesOptions.rateLimit`] Wire rate-limiter middleware into Hono adapter #rate-limit
- [x] [done: 12 tests — read/write limits, IP isolation, cleanup, stats, Hono integration, disabled mode] Tests for rate-limiter middleware #rate-limit #tests

### Phase 4: Distributed KV Cache + Unified Config
- [x] [done: DistributedCacheStore class, L1 memory + L2 adapter cascade, promotion on L2 hit, invalidation, stats] Create `src/http/middleware/distributed-cache.ts` #distributed-cache
- [x] [done: createSmallstoreMiddleware() factory, configFromEnv(), admin stats/clear endpoints, deepMerge config, SM_MIDDLEWARE_DISABLED env] Create `src/http/middleware/mod.ts` #middleware-config
- [x] [done: `HonoRoutesOptions.distributedCache`] Wire distributed-cache into Hono adapter #distributed-cache
- [x] [done: distributedCache, DistributedCacheStore, createSmallstoreMiddleware, configFromEnv exported] Export middleware from `src/http/mod.ts` #middleware-config
- [x] [done: 17 distributed-cache tests + 13 factory tests — 30 total, all pass] Tests for distributed-cache and unified config #distributed-cache #tests

## Extraction (2026-04-04)

- [x] Create new repo, move contents to root
- [x] Remove coverflow-specific imports or paths (renamed COVERFLOW_WORKERS_URL → SM_WORKERS_URL primary, kept backward compat fallback; cleaned CF adapter comments; removed coverflow-specific test + example files; updated user-guide docs)
- [x] Update deno.json, jsr.json, package.json (already had correct repo URL + names)
