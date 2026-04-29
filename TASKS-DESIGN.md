# Smallstore — Design

## Mission

A portable storage abstraction where **data is the product** and any app is just a surface that can access and manipulate it.

## Goals

- [x] One API to talk to 17+ backends (Memory, SQLite, Redis, Notion, Airtable, Cloudflare, S3, Google Sheets, Obsidian, filesystem)
- [x] "Messy desk" — throw data in, organize later (append-by-default, views, materialized queries)
- [x] Full-text search across any adapter via SearchProvider plugin system
- [x] VFS shell for agents — bash-like interface to storage
- [x] Vector + hybrid search (5 providers: BM25, MemoryVector, Zvec HNSW, Hybrid RRF, SQLite FTS5)
- [@] JSR/npm publishing — standalone package, own repo
- [ ] Become the default "where does my data go" answer for small apps, agents, and pipelines
- [?] Multi-user / auth layer — needed for shared data scenarios?

## Non-Goals

- [*] Not a database replacement — no transactions, no complex joins, no ACID guarantees
- [*] Not for big data — smallstore is for small pockets of data (bookmarks, notes, configs, research)
- [*] Not a query engine — basic filtering yes, but SQL-level queries belong in SQLite/Postgres
- [*] Parquet ingestion — duckdb-wasm is too heavy; CSV/JSON covers the same use cases

## Success Metrics

- [*] A new app can be wired to existing data in <5 lines (preset + get/set)
- [*] Switching backends requires zero code changes beyond config
- [*] An LLM agent can use VFS to read/write data without knowing the backend

## Decisions

- [x] [decided: 3-type system] Data types — object, blob, kv. Ultra-simple, not 15 types.
- [x] [decided: SearchProvider interface] FTS architecture — plugin system, not per-adapter duck-typing
- [x] [decided: overwrite] Router.set() default mode — was 'append', caused array double-wrap bug
- [x] [decided: zvec] Vector search backend — Alibaba's zvec (HNSW, in-process, npm package). Brute-force MemoryVectorSearchProvider as zero-dep fallback.
- [x] [decided: embed callback] Embedding strategy — user provides `embed: (text) => number[]`, smallstore is agnostic about which AI provider
- [x] [decided: keep in-tree for now] Episodic memory + progressive disclosure + graph store — useful for agentic/research use cases, not core path
- [x] [decided: Hono] HTTP framework — Express stub intentionally not implemented
- [x] [decided: JSR primary + npm via dnt] Package distribution — JSR is primary, npm build via @deno/dnt
- [x] [decided: fail-closed] Empty `SMALLSTORE_TOKEN` rejects all protected requests — pre-2026-04-28, an empty/whitespace token silently disabled auth (`if (!token) return next()`). Now: `undefined` keeps routes open (dev-mode), but a *set-but-empty* value fails closed with 401 + a server log line. The set-but-empty case is almost always a CI/secret-rotation mistake; failing closed is the safe default. See `deploy/src/index.ts` `requireAuth`. Reference: security audit B001.
- [x] [decided: static safe-prefix regex + hard denylist, no override] Peer auth env-var allowlist — peer/webhook auth resolvers can only resolve env-vars matching `/^(TF_|NOTION_|SHEET_|GH_|AIRTABLE_|UPSTASH_|...)[A-Z0-9_]+$/`. `SMALLSTORE_*`, `CLOUDFLARE_*`, `CF_*`, `AWS_*`, `SECRET_*`, `PRIVATE_*` are hard-denied. **No env-var-controlled override** — that would just relocate the bug. Module: `src/peers/env-allowlist.ts`; gating happens at both `validateAuthShape` (HTTP) and `resolvePeerAuth` (request-time) for defense-in-depth. Reference: security audit B002/B003.

## Risks

- [x] [resolved: cleaned up in docs cleanup pass] 68 docs in docs/ — phase-completion records from build process
- [x] [resolved: fixed, added defensive comment] Unstorage adapter async initialization bug
- [*] zvec Node.js bindings are young (v0.2.x) — API surface changed between versions, `params` object format undocumented
- [x] [resolved: extracted to own repo 2026-04-04, SM_WORKERS_URL replaces COVERFLOW_WORKERS_URL] Moving to own repo means import paths change for coverflow
