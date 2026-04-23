# Changelog

## 0.2.0 — Messaging plugin family (2026-04-23)

### Added

- **Messaging plugin family** — `Channel`, `Inbox`, and sketched `Outbox` primitives under `src/messaging/`. Channels translate external events (email, webhook, RSS) into normalized `InboxItem`s; Inbox composes a Channel + `StorageAdapter` + content-addressed dedup + opaque cursor + filter eval.
- **`CloudflareEmailChannel`** — `postal-mime` parser, field mapping (from/to/cc/subject/message_id/thread/references/SPF/DKIM/DMARC), body-size policy (text inline <64KB else blob ref), HTML always to blobs, attachment extraction + path-traversal sanitization, bounce/OOO label detection, content-addressed id for idempotent re-delivery.
- **`createEmailHandler`** — Cloudflare Workers `email(msg, env, ctx)` orchestrator that reads the raw .eml stream, parses through the registered channel, ingests into every inbox configured for that channel (supports fan-out), and calls `setReject()` if no inbox is configured.
- **HTTP routes** — `/inbox/:name/{items,query,cursor,items/:id}` + `/admin/inboxes` runtime CRUD + `/admin/channels` debug. All behind injectable `requireAuth`. Wired via `registerMessagingRoutes(app, ...)` — caller owns the auth middleware.
- **`InboxRegistry`** — in-memory inbox registry; boot-time inboxes from config, runtime inboxes via admin API, TTL prune for runtime entries.
- **`InboxFilter` + filter-spec parser** — declarative predicate DSL plus a markdown/YAML frontmatter parser (`parseFilterSpec`) matching mailroom's existing filters/*.md format.
- **`factory-slim` subpath export** — `createSmallstore` without the full adapter barrel; required for Cloudflare Workers bundles (root `mod.ts` pulls SQLite which breaks in Workers).
- **Cloudflare Workers deploy scaffold** — `deploy/` subproject (wrangler.toml + Worker entry + README) that bundles smallstore via `file:../dist` and deploys to `smallstore.labspace.ai`.
- **87 new tests** — cursor (5), filter (14), filter-spec (9), inbox reference impl (11), HTTP integration (17), cf-email channel (18), email handler end-to-end (6). Live-deploy verified against real D1 + R2.

### Fixed

- **`CloudflareD1Adapter.ensureTable` was broken in native (binding) mode.** The multi-line `CREATE TABLE` template was passed to D1's `binding.exec()`, which splits on newlines and requires each line to be a complete statement. Every first-write through a native D1 adapter tripped `Error in line 1: CREATE TABLE ... incomplete input: SQLITE_ERROR`. Switched to `binding.prepare(sql).run()` with single-line SQL. Caught during the first deploy of smallstore-as-Worker (2026-04-23).
- **`src/adapters/helpers/cloudflare-config.ts`** no longer `import "jsr:@std/dotenv/load"` at module init. That load forced a `Deno` reference in the built npm bundle, which breaks in Cloudflare Workers. Apps that want dotenv should load it themselves before calling these helpers.
- **`scripts/build-npm.ts`** — disabled `shims: { deno: true }`. The dnt deno shim references `__dirname` which is undefined in Workers ESM bundles. Consumers who need Deno-shim behavior in Node can add `@deno/shim-deno-test` explicitly. Net effect: Worker bundle dropped from 2MB to 533KB.

### Build

- **`build-npm.ts`** — added subpath exports for `./factory-slim`, `./messaging`, `./messaging/types`, `./adapters/{memory,cloudflare-{d1,r2,kv,do}}`. Moved npm package name to scoped `@yawnxyz/smallstore` to match JSR.
- **Version bumped 0.1.4/0.1.11/0.1.0 (drifted) → 0.2.0 unified** across jsr.json, deno.json, package.json.

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
