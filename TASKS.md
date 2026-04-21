# Smallstore

## Done This Session (2026-04-04)

- [x] [done: SM_WORKERS_URL primary, backward compat fallback, CF adapter comments, deleted coverflow test+example, updated user-guide docs] Remove coverflow-specific imports and paths #extraction #cleanup
- [x] [done: deno.json, jsr.json, package.json already correct] Update config files for standalone repo #extraction
- [x] [done: 40+ items → TASKS.done.md, TASKS-RACES → .done.md, TASKS-AUDIT → .done.md, TASKS-VISION → TASKS-DESIGN] Archive completed tasks and spring clean TASKS family #cleanup
- [x] [done: app-examples/ merged into examples/, all deno.json tasks + doc refs updated] Consolidate app-examples into examples #cleanup
- [x] [done: upsert-example.ts import, tiny-auth .env paths, self-interview dead ModelProvider code] Fix broken imports and remove dead code #cleanup
- [x] [done: packages/ removed, research/tigerfs removed, 15 stale docs deleted, 3 updated, all monorepo path refs fixed] Deep docs and repo cleanup #cleanup
- [x] [done: .DS_Store, dist/, node_modules/ added to .gitignore] Final tidying #cleanup
- [x] [fixed: 31 type errors → 0. Smallstore interface, query-engine, VFS grep/retrieve, R2Direct, middleware, retrieval pipeline] Fix all `deno check` type errors #bug-fix
- [x] [fixed: MemoryAdapter.query() now handles MongoDB-style filter objects via matchesFilter()] Fix query-examples.ts runtime crash #bug-fix

## Pre-Publish Validation #validation

### Offline Tests (no credentials needed)

- [x] `deno check mod.ts` — 0 errors (was 31)
- [x] `deno test --no-check --allow-all tests/*.test.ts` — 595 passed, 0 failed
- [x] `deno publish --dry-run --no-check --allow-slow-types` — pass
- [x] `deno task build:npm` — build complete, ESM + types in dist/

### Apps

- [x] `deno task api` — starts, serves on :8787
- [x] `deno task cli` — shows help, commands work
- [ ] `deno task interview:serve` — needs GROQ_API_KEY or OPENAI_API_KEY

### Examples — Local (no credentials)

- [x] `deno task clipper` — 45/45 checks passed
- [x] `deno task crm` — 51/51 checks passed
- [x] `deno task gallery` — simulated mode pass
- [x] `deno run --allow-all examples/upsert-example.ts` — pass
- [x] `deno run --allow-all examples/query-examples.ts` — pass
- [x] `deno run --allow-all examples/file-explorer-example.ts` — pass

### Examples — Need Credentials

- [*] `deno task paste` — doesn't load .env (pre-existing, not restructure issue)
- [x] `deno task auth` — pass (register, login, sessions working)
- [ ] `deno task auth:airtable` — needs Airtable env vars

### Live Adapter Tests (need .env credentials)

- [x] `deno test --no-check --allow-all tests/live-adapters.test.ts` — 12 passed, 1 failed (DO binding inactive)
- [x] Upstash — pass
- [x] Airtable — pass
- [x] Notion — pass
- [x] Sheetlog — pass
- [x] R2 Direct — pass
- [x] Unstorage (Upstash driver) — pass
- [x] Cloudflare KV — pass
- [x] Cloudflare D1 — pass
- [*] Cloudflare DO — skipped (DO binding not active on deployed worker)

## Now

- [x] [done: published @yawnxyz/smallstore@0.1.0] Publish to JSR (`deno publish`) #jsr-publish
- [x] [done: github.com/janzheng/smallstore] Make repo public on GitHub #github-public

## Soon

- [x] [done: deno.json import map → jsr:@yawnxyz/smallstore@^0.1.4, 40 files updated] Add back to coverflow as a dependency #coverflow-dep
- [x] [done: deno check passes, only pre-existing coverflow errors remain] Verify coverflow still works with smallstore as external dep #coverflow-verify

## Done This Session (2026-04-05)

- [x] [fixed: added ttl? param to set() for interface compliance] DO adapter signature mismatch #bug-fix
- [x] [fixed: PIPELINE_DO → COVERFLOW_DO in types.ts, do-handler.ts, index.ts] DO binding name mismatch in coverflow-workers #bug-fix
- [x] [done: all 7 DO checks pass — SET, GET, HAS, KEYS, DELETE, CLEAR, CAPABILITIES] Cloudflare DO adapter live and tested #validation

## Notion SDK v5 Migration (2026-04-06 → 2026-04-21)

- [x] [done: f3d3581] Bump @notionhq/client from ^2.3.0 to ^5.16.0
  - [x] Replace hardcoded npm:@notionhq/client@^2.0.0 with bare specifiers
  - [x] Fix type import path: api-endpoints.d.ts → build/src/api-endpoints.d.ts
  - [x] Migrate archived → in_trash in all request bodies
  - [x] Update API version from 2022-06-28 to 2025-09-03
  - [x] Update build-npm.ts dependency and mapping versions
- [x] [done: @yawnxyz/smallstore@0.1.5 published 2026-04-17] Publish updated smallstore to JSR #jsr-publish
- [x] [done: live:notion green after fix] Re-run Notion live adapter tests after JSR publish #validation
- [x] [done: resolveDataSourceId() in notionModern.ts resolves database_id → data_source_id, cached per client] queryDatabase → queryDataSource migration for multi-source DBs #bug-fix
- [x] [done: 2026-04-21 — added `position` param to appendBlockChildren alongside `after`; supports `{type: "after_block"} | {type: "start"} | {type: "end"}` shape; positioning only applies to first batch when chunking. Mirrors coverflow change on the same day. 810/810 tests green] `after` → `position` forward-compat for SDK v5 deprecation #forward-compat

## Done This Session (2026-04-17 → 2026-04-18)

Published two JSR releases — **0.1.8** (paging + JSONL job logs + audit fixes) and **0.1.9** (audit closeout). Coverflow-v3 bumped 0.1.7 → 0.1.9 locally (commit `ccffe89a`, unpushed, tracked as a chore in coverflow TASKS.md).

### Adapter paging via optional `listKeys()` #paging

- [x] [done: commits 73868fc + 0e93b13] Standardize paging via opt-in `listKeys({prefix?, limit?, offset?, cursor?}) → {keys, hasMore, cursor?, total?}` #router
  - [x] `KeysPageOptions` + `KeysPage` added to `src/types.ts`
  - [x] Optional `listKeys?()` added to `StorageAdapter` interface
  - [x] Router fallback to `keys()` + slice when adapter lacks native impl — zero regression for non-paged adapters
  - [x] HTTP handler `handleListKeys` accepts `?limit=N&offset=N&cursor=X` with validation
  - [x] MemoryAdapter — slice native impl
  - [x] SQLiteAdapter — LIMIT/OFFSET + COUNT(*), returns cursor as stringified offset
  - [x] NotionAdapter — start_cursor pagination
  - [x] AirtableAdapter — opaque offset cursor
  - [x] UpstashAdapter — SCAN cursor
  - [x] CloudflareKVAdapter — list({limit, cursor}) with `list_complete` handling
  - [*] Sheetlog intentionally skipped — log-style adapter with no stable keys
- [x] [done: `tests/adapter-paging.test.ts` (mocked Upstash + CF KV), 3 new SQLite listKeys tests] Paging test coverage

### JSONL job logs for long `/_sync` runs #sync #jobs

User-requested alternative to an in-memory job registry. Deno server appends progress events line-by-line to `<dataDir>/jobs/<jobId>.jsonl` so clients can `tail -f` for live progress and `grep` for post-mortem. Crash-safe (no daemon state to reconcile), inspectable with standard tools, no long-polling HTTP.

- [x] [done: commit 747518e] `src/utils/job-log.ts` — append-only JSONL logger with `createJobLog`, `tailJobLog`, `listJobs`, `summarizeJob`, `generateJobId` #job-log
- [x] [done: serve.ts /_sync default-background (202 + jobId + logPath)] Redesigned `/_sync` endpoint with `?wait=true` for sync behavior #serve
- [x] [done: GET /_sync/jobs (list recent) + GET /_sync/jobs/:id (tail events), path-traversal guard via `/^[A-Za-z0-9._-]+$/`] Job inspection endpoints
- [x] [done: auth via optional SMALLSTORE_TOKEN bearer, per-pair lock in `syncLocks: Map`, option whitelist] Security + concurrency guards on /_sync
- [x] [done: sm_sync gains `background?: boolean` flag, new `sm_sync_status` + `sm_sync_jobs` MCP tools] MCP tools for job lifecycle #mcp
- [x] [done: `tests/job-log.test.ts` (8 unit tests) + `tests/sync-jobs-http.test.ts` (4 integration tests spawning real serve.ts)] JSONL + background-sync test coverage
- [x] [done: skills/smallstore/SKILL.md updated with source_adapter/target_adapter rename + paging cursor docs + background sync pattern] Skill doc refresh

### Pre-0.1.8 audit (Waves 1-2) #audit

- [x] [done: TASKS-AUDIT.md, 47 findings + Wave 3 (11 more) = 58 total] Parallel-agent correctness sweep
- [x] [done: commits dfc9751, f825014, 291617d, 1bd4464, 454cac0, 50040eb, 1f640d5, 5db0dab, 1573f36 — 8 batches] Audit fixes landed
  - [x] P1 regressions: A001-A008 (LocalJson wrapper, SqliteFts metadata leak, MemoryAdapter clear race, deleteFromArray unwrap, deno-fs reopen, CSV BOM, CSV keyColumn, internal-key index guard)
  - [x] MCP/HTTP security (A010-A013): optional SMALLSTORE_TOKEN bearer auth, SYNC_OPTION_WHITELIST, self-sync guard, concurrent sync lock
  - [x] MCP input hardening (A070-A081): validateCollection (empty/..,sub-route collisions), JSON.stringify guard, token CRLF check, MAX_RESPONSE_BYTES cap (10MB default), SMALLSTORE_URL validation, SIGTERM/SIGINT, MethodNotFound RPC error, sm_list limit in URL, source_adapter rename, empty-filter rejection, sm_read cost warning
  - [x] CSV adapter polish (A053-A059): duplicate header detection, duplicate key warning, clock-skew guard, URL validation, @internal marker, auth-stripping error messages, readOnly capability
  - [x] CacheManager (A020-A024, A030): TTL-expired drop, torn-state rollback, oversized-entry warn, TextEncoder UTF-8 sizing, typed CacheValidError
  - [x] LocalJson (A100-A102): hydrate-promise reset on failure, cached wrapper for identity, cloned value to provider.index()
  - [x] Search providers (A040-A044): isInternalKey helper, zvec topk inflation fix, filter forwarded (matchesFilter post-search), keyMatchesCollection strict prefix match

### Audit Wave 3 — paging + JSONL sweep #audit

- [x] [done: 20 candidate findings → 11 verified after dropping false positives (Notion hasMore, CF KV list_complete, JSONL atomicity via PIPE_BUF misread, `.catch(()=>{})` is-the-handler, intentional append() swallowing)] Wave 3 audit
- [x] [fixed: commit 95b5f73] **A200** /_sync lock TOCTOU race — moved createJobLog INSIDE the IIFE so no awaits between has() and set() #race-condition
- [x] [fixed: commit 95b5f73 — cursor accepted as stringified offset, non-numeric rejected, emits `cursor: String(nextOffset)` when hasMore, 2 new tests] **A224** SQLite listKeys silently dropped cursor
- [x] [fixed: commit 47f3f01] **A031** external-fetcher 304 path now throws typed CacheValidError (was bare `Error('CACHE_VALID')`)
- [x] [fixed: commit 47f3f01] **A222** `handleListKeys` uses `Number() + Number.isInteger()` — rejects "999x" instead of silently parsing as 999
- [x] [fixed: commit 47f3f01] **A228** `?limit=0` now rejected as BadRequest (was returning empty-keys + hasMore:true)
- [x] [fixed: commit 47f3f01] **A244** Extracted `DEFAULT_TAIL_EVENTS` + `SUMMARY_SCAN_EVENTS` constants with JSDoc in job-log.ts

### Pre-publish type fix

- [x] [fixed: commit 9f70646] package.json `@notionhq/client` bumped `^2.3.0` → `^5.16.0` to match deno.json — prior mismatch had Deno materializing BOTH versions in node_modules and the subpath type import resolved to v2's incompatible types, surfacing as 7 TS errors on `deno publish` with full type checking

### JSR publishes

- [x] [done: commit 747518e + tag] `@yawnxyz/smallstore@0.1.8` — paging + JSONL jobs + audit batches 1-8
- [x] [done: commit 47f3f01 + tag] `@yawnxyz/smallstore@0.1.9` — audit closeout (A031, A222, A228, A244) + A200 + A224

### Session stats

- **836 tests passing, 0 failed** (up from 819 at session start)
- **58/58 + 11 Wave 3 findings** — 57 fixed, 1 won't-fix (A042-path is @deprecated), 9 deferrable (all #at-scale-only polish)
- **2 JSR releases** (0.1.8, 0.1.9) + 1 coverflow bump (commit `ccffe89a`, unpushed)

## Discovered Bugs (2026-04-17)

Surfaced by the Phase 7 testing sweep. Each has a test asserting current (broken) behavior — flip when fixed.

- [x] [fixed: added {raw:true} to src/router.ts:1515/1584/1623/1680] `router.get()` unwrapping in data-ops (slice/split/deduplicate/merge) #bug-fix
- [x] [fixed: router.search() now forwards hybridAlpha + metric to provider] `router.search()` drops `hybridAlpha` #bug-fix #router-search
- [x] [fixed: LocalJsonAdapter.searchProvider getter wraps provider with lazy hydration from disk on first search()] `LocalJsonAdapter` rebuilds BM25 index on reopen #bug-fix #local-json
- [x] [fixed: retryFetch now passes 304 through; external-fetcher's CACHE_VALID branch is reachable] `fetchExternal` 304 Not Modified handling #bug-fix #external-fetcher
- [x] [fixed: CacheManager tracks per-entry size + monotonic access tick, parseSizeString, evictUntilFits with LRU policy; ttl-only skips eviction] `CacheManager` LRU eviction enforced #bug-fix #cache-manager
- [x] [fixed: bm25/vector/zvec providers skip smallstore:meta:* and smallstore:index:* keys] Search providers no longer leak metadata/index keys #bug-fix #router-indexing
- [x] [fixed: MemoryAdapter accepts {searchProvider} in config; set/delete/clear read through the getter so runtime overrides also work] Custom SearchProvider plug-in for MemoryAdapter #bug-fix #memory-adapter

## Dependency Notes

- [*] **Zod 4 migration shipped in coverflow on 2026-04-20** (`coverflow-v3` commits `2b9f8c04` + `c37d9722` + `36546951`). Smallstore is unaffected — grep confirms zero zod imports in `src/`. The "smallstore Zod schemas need updating too" note from the original v3-vs-v4 standoff turned out to be moot.
- [*] **Notion v5 cleanup learnings from coverflow** (cross-reference `/Users/janzheng/Desktop/Projects/_deno/coverflow/coverflow-v3` Archive section in TASKS.md):
  - The SDK v5 `after` param on `blocks.children.append` is `@deprecated` in types but still accepts at runtime. Coverflow added `position` support alongside `after` — same change applied here on 2026-04-21
  - Coverflow had a dead `shared/notion/api/` wrapper directory (13 files, zero imports) that hard-coded a v4-only `databases.query` call. Worth a periodic grep here for similar abandoned wrappers — they'd silently break a future bump
  - Coverflow's `notionModern.queryDatabase()` uses dataSources.query exclusively. Smallstore's version is more sophisticated — has SDK v4 fallback + raw HTTP fallback for older API versions. Keep the smallstore approach
- [*] @notionhq/client v5 and @modelcontextprotocol/sdk v1.29 both accept zod ^3.25 || ^4.0 — no forced upgrade if smallstore ever does add zod schemas

## Future

### MCP Server + Skill #mcp-server

Give Claude Code direct access to any Smallstore adapter — read, write, list, query, and sync — without going through TigerFlare. Smallstore becomes a first-class MCP tool peer to TigerFlare: TF for agent filesystem/memory, Smallstore for external service I/O.

Architecture: `src/mcp-server.ts` calls the running Smallstore HTTP server (started via `deno task serve`). Config via `.smallstore.json` mounts determines which adapter each collection hits. A hub skill (`smallstore`) gives agents a documented entry point.

#### Phase 1: MCP Server

- [x] [done: src/mcp-server.ts, 7 tools wired, tools/list smoke passes] stdio MCP server using `@modelcontextprotocol/sdk` #mcp-core
- [x] [done: deno task mcp] deno task entry #task
- [x] [done: serve.ts adds GET /_adapters + POST /_sync] HTTP endpoints for sm_adapters / sm_sync
- [x] [done: jq patch to ~/.claude.json, all 4 mcpServers now: brigade, deno-hub, smallstore, tigerflare] Register in `~/.claude.json` under `mcpServers.smallstore` #registration
  ```json
  {
    "command": "deno",
    "args": ["run", "--allow-net", "--allow-read", "--allow-env",
             "/path/to/smallstore/src/mcp-server.ts"],
    "env": { "SMALLSTORE_URL": "http://localhost:9998" }
  }
  ```

#### Phase 2: Hub Skill

- [x] [done: skills/smallstore/SKILL.md, 155 lines, frontmatter + preflight + 7 tool sections + troubleshooting] Skill doc #skill
- [x] [done: copied to mcp-hub/skills/smallstore, hub:sync added it to Claude Code + Cursor + Codex + Agents] Sync skill to `~/.claude/skills/` via `hub:sync` #sync

#### Phase 3: Sheetlog convenience

- [x] [done: examples/.smallstore.json.example + .sheetlog-docs.md; verified serve.ts loads .smallstore.json via config.ts loadConfig()] Zero-extra-code sheetlog path #docs

#### Phase 1: Testing

- [x] [done: tests/mcp-server.test.ts, 13 tests passing, incl. end-to-end roundtrip against real serve.ts] MCP server test suite #tests

### Google Sheets CSV adapter (read-only) #google-sheets-csv

Read-only adapter for public/shared Google Sheets without OAuth or Apps Script. Fetches the published CSV export URL (`https://docs.google.com/spreadsheets/d/.../export?format=csv`), parses it into key/value records, and exposes the standard IAdapter interface. Writes throw immediately.

Use case: TigerFlare routes `/sheets/*` → this adapter via the bridge, so agents can `tf_read` shared spreadsheet data without credentials. Distinct from the sheetlog adapter (which requires Apps Script and supports writes).

- [x] [done: 21 tests passing, uses @std/csv, read-only with UnsupportedOperationError] GoogleSheetsCsvAdapter + tests + README + mod.ts export #adapter

- [ ] Publish to npm (`deno task build:npm && cd dist && npm publish`) #npm-publish
- [ ] Test and validate npm build works in Node.js projects #npm-validate
- [ ] Migrate coverflow-workers into smallstore-owned worker `-> foxfire .brief/smallstore-workers-takeover.md` #infra
- [*] LLM/agent features → see [TASKS-MAP.md Phase 8](./TASKS-MAP.md) (rerank, context window, RAG pipeline, semantic recall, working memory, etc.)
