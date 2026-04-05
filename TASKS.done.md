# Smallstore — Completed Tasks

Archived 2026-04-04. Moved from TASKS.md during standalone repo spring cleaning.

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
