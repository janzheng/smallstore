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

## Notion SDK v5 Migration (2026-04-06)

- [x] [done: f3d3581] Bump @notionhq/client from ^2.3.0 to ^5.16.0
  - [x] Replace hardcoded npm:@notionhq/client@^2.0.0 with bare specifiers
  - [x] Fix type import path: api-endpoints.d.ts → build/src/api-endpoints.d.ts
  - [x] Migrate archived → in_trash in all request bodies
  - [x] Update API version from 2022-06-28 to 2025-09-03
  - [x] Update build-npm.ts dependency and mapping versions
- [x] [done: @yawnxyz/smallstore@0.1.5 published 2026-04-17] Publish updated smallstore to JSR #jsr-publish
- [x] [done: live:notion green after fix] Re-run Notion live adapter tests after JSR publish #validation
- [x] [done: resolveDataSourceId() in notionModern.ts resolves database_id → data_source_id, cached per client] queryDatabase → queryDataSource migration for multi-source DBs #bug-fix

## Discovered Bugs (2026-04-17)

Surfaced by the Phase 7 testing sweep. Each has a test asserting current (broken) behavior — flip when fixed.

- [x] [fixed: added {raw:true} to src/router.ts:1515/1584/1623/1680 — slice/split/deduplicate/merge now work; 31/31 tests green] `router.get()` unwrapping: data-ops called `get(path)` without `{raw:true}`, got wrapped StorageFileResponse — all 4 endpoints were broken in production #bug-fix
- [ ] `router.search()` drops `hybridAlpha` in SearchProviderOptions (src/router.ts:1161-1169) — hybrid alpha always uses provider default #bug #router-search
- [ ] `LocalJsonAdapter` does not rebuild BM25 index on reopen (src/adapters/local-json.ts:46-79) — data persists, index doesn't #bug #local-json
- [ ] `fetchExternal` 304 Not Modified branch is dead code (src/utils/external-fetcher.ts:94-96) — retryFetch throws HttpError first, conditional-request caching silently fails #bug #external-fetcher
- [ ] `CacheManager` exposes `evictionPolicy`/`maxCacheSize` but never enforces them — no actual LRU eviction #bug #cache-manager
- [ ] Router auto-indexing leaks metadata keys (`smallstore:meta:*`, `smallstore:index:*`) into search results — collection filter uses overly-permissive `key.includes(collection)` #bug #router-indexing
- [ ] `MemoryAdapter._searchProvider` is baked-in — swapping via `Object.defineProperty` doesn't redirect auto-indexing #ergonomics #memory-adapter

## Dependency Notes

- [*] zod stays on v3 for now — zodex ^0.3.0 (used in coverflow shared/ai/) requires zod 3.x
  - [*] zodex 4.x requires zod ^4.0 as peer dep — they must upgrade together
  - [*] zod 4 has breaking API changes across 598+ files in coverflow
  - [*] @notionhq/client v5 and @modelcontextprotocol/sdk v1.29 both accept zod ^3.25 || ^4.0 — no forced upgrade
  - [*] When zod 4 migration happens, smallstore's Zod schemas will need updating too

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
