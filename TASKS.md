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

- [ ] Publish to JSR (`deno publish`) #jsr-publish
- [ ] Publish to npm (`deno task build:npm && cd dist && npm publish`) #npm-publish
- [ ] Make repo public on GitHub #github-public

## Soon

- [ ] Add back to coverflow as a dependency (jsr:@smallstore/core or npm:smallstore) #coverflow-dep
- [ ] Verify coverflow still works with smallstore as external dep #coverflow-verify

## Future

- [ ] Re-rank provider (Cohere/Jina) #retrieval-rerank
- [ ] Context window provider (token-budget-aware slicing) #retrieval-context
