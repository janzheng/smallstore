# Smallstore

Universal storage abstraction layer for JavaScript and TypeScript. One API, 20 backends. In-memory stores, SQL and object storage, and cloud services (Upstash, Airtable, Notion, Google Sheets, Cloudflare KV/D1/DO/R2).

**Published:** [`@yawnxyz/smallstore` on JSR](https://jsr.io/@yawnxyz/smallstore) · [`smallstore` on npm](https://www.npmjs.com/package/smallstore) · current version: **0.1.4** (JSR) / **0.1.0** (npm). JSR is the primary distribution; see `PUBLISHING.md` for the publish pipeline.

## Headline features

- **Unified interface** — `get`, `set`, `delete`, `keys`, `query`, `list`, `has` work across every adapter that implements them.
- **Path-based routing** — `mounts` config maps key prefixes to adapters (`uploads/* → r2`, `cache/* → memory`).
- **Search providers** — BM25, vector (cosine), hybrid (RRF fusion), HNSW (Zvec), and SQLite FTS5.
- **Graph store** — nodes + edges with BFS/DFS/shortest-path traversal.
- **Episodic memory** — time-aware storage with importance decay and recall strategies.
- **Progressive disclosure** — multi-level summaries (overview → detail → raw).
- **Views & materializers** — JSON, CSV, Markdown, YAML, text output.
- **Blob middleware** — transparent binary-field handling (R2Direct backend, Airtable Attachments, Notion Files).
- **Adapter sync** — bidirectional replication with 3-way merge.
- **Messaging plugin family** — `Inbox` + `Channel` primitives. Channels: `cf-email` (Cloudflare Email Routing), `rss` (Atom + RSS 2.0/1.0), `webhook` (generic HTTP receiver with HMAC verify + JSON-path field mapping). Mailroom-style curation: rules engine, auto-confirm allowlist, classifier, sender index, quarantine, attachments. **Newsletter profiles** auto-group forwards by sender, expose chronological reading lists + aggregate per-publisher notes (`/inbox/:name/newsletters[/:slug[/items|notes]]`). **After-the-fact annotation** (`POST /inbox/:name/items/:id/note`, replace/append modes) for forwards that landed without a note. **Cross-newsletter notes** (`GET /inbox/:name/notes`) aggregates every annotation across publishers with `?text=` substring search inside notes only. **Todo extraction** (`GET /inbox/:name/todos`) surfaces action-shaped lines from those notes via a small regex set — checkboxes, `TODO:`, "remind me to", "sub me to", etc. **Markdown rendering** — append `?format=markdown` to any newsletter / notes route to get Obsidian/tigerflare-friendly output (profile + chronological issues + notes inlined as blockquotes). **Cron-driven mirror** — peers registered with `metadata.mirror_config` get per-newsletter markdown PUT to their destination every 30 minutes; manual flush via `POST /admin/inboxes/:name/mirror[/:peer]`. **Generic hook replay** (`POST /admin/inboxes/:name/replay`) backfills new fields onto historical items in one call. See [`docs/user-guide/mailroom-quickstart.md`](docs/user-guide/mailroom-quickstart.md).
- **Peer registry** — register external data sources (other smallstores, tigerflare, sheetlogs, RSS feeds, webhooks, generic HTTP) as peers; `GET/POST /peers/:name/{health,fetch,query}` proxies through with env-resolved auth.
- **HTTP API** — Hono integration exposes full CRUD + search + query + views + presigned URLs + namespace tree ops (route list below).
- **MCP server** — `src/mcp-server.ts` exposes 9 tools (`sm_read`, `sm_write`, `sm_delete`, `sm_list`, `sm_query`, `sm_adapters`, `sm_sync`, `sm_sync_jobs`, `sm_sync_status`) for Claude Code / agent integration. Forwards to a running HTTP server.
- **VFS** — bash-like CLI shell over any adapter (~20 commands: `ls`, `cat`, `cd`, `cp`, `mv`, `rm`, `pwd`, `find`, `grep`, `tree`, `stat`, `wc`, `du`, `export`, `retrieve`, `snapshot`, `write` + overlay commands).

## Installation

```bash
deno add jsr:@yawnxyz/smallstore
# or
npm install smallstore
```

```typescript
import { createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";
```

JSR subpath exports are supported for tree-shaking (see `jsr.json` for the full list):

```typescript
import { createR2DirectAdapter } from "jsr:@yawnxyz/smallstore/adapters/r2-direct";
```

## Basic usage

```typescript
import { createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

await store.set("users/alice", { name: "Alice", role: "admin" });
const alice = await store.get("users/alice");
const keys = await store.keys("users/");
await store.delete("users/alice");
```

## Presets

```typescript
createSmallstore({ preset: "memory" });        // in-memory, testing
createSmallstore({ preset: "local" });         // local JSON files
createSmallstore({ preset: "local-sqlite" });  // SQLite + FTS5
createSmallstore({ preset: "cloud" });         // Upstash + R2 via env vars
createSmallstore({ preset: "hybrid" });        // local primary + cloud backup
```

## Adapter matrix

Every adapter below exists, is tested, and is exported from `mod.ts`. Capabilities column reflects what's **actually implemented in code**, not the interface contract. `file:line` citations included where a capability is unique.

### Core ops legend

- `GSD` — `get` / `set` / `delete` / `has` / `keys`
- `L` — `list` (cursor-paginated keys)
- `Q` — `query` (MongoDB-style filter)
- `FTS` — full-text search (provider attached)
- `PU` — presigned URLs
- `BM` — binary middleware compatible

### Local adapters (6)

| Adapter | Backend | Core | L | Q | Search | Size limit |
|---------|---------|:---:|:---:|:---:|:---:|---|
| **memory** | In-memory Map | GSD | ✓ | ✓ | BM25 / Vector / Hybrid / HNSW | Unlimited |
| **sqlite** | `@db/sqlite` file | GSD | — | ✓ | FTS5 native | 1 GB |
| **structured-sqlite** | Typed SQL tables | GSD | — | ✓ | FTS5 native | 1 GB |
| **local-json** | JSON files on disk | GSD | ✓ | ✓ | Client BM25 | File size |
| **local-file** | Raw blobs on disk | GSD | — | — | — | Disk space |
| **deno-fs** | Directory tree | GSD | ✓ | ✓ | Client BM25 | Disk space |

### Cloud adapters (13)

| Adapter | Backend | Core | L | Q | Search | Presigned | Size limit |
|---------|---------|:---:|:---:|:---:|:---:|:---:|---|
| **upstash** | Redis REST | GSD | ✓ | ✓ | — | — | 1 MB |
| **airtable** | Airtable REST | GSD | ✓ | ✓ | Client BM25 | — | 100 KB / cell |
| **notion** | Notion API | GSD | ✓ | ✓ | Client BM25 | — | 2 KB / prop |
| **sheetlog** | Sheetlog proxy | GSD | ✓ | — | — | — | Sheetlog limit |
| **google-sheets-csv** | Public CSV (RO) | GET only | ✓ | — | — | — | Row count |
| **cloudflare-kv** | Worker KV binding | GSD | ✓ | ✓ | — | — | 1 MB |
| **cloudflare-d1** | Worker D1 binding | GSD | — | ✓ | — | — | Unlimited |
| **cloudflare-do** | Durable Object | GSD | ✓ | — | — | — | Per-DO |
| **cloudflare-r2** | Worker R2 binding | GSD | — | — | — | — | 5 TB / obj |
| **r2-direct** | AWS S3 SDK → R2 | GSD | — | — | — | **✓** `getSignedUploadUrl` / `getSignedDownloadUrl` (`r2-direct.ts:290, 319`) | 5 TB / obj |
| **f2-r2** | F2 R2 proxy | GSD | — | — | — | — | F2-dependent |
| **unstorage** | Unstorage drivers | GSD | ✓ | — | — | — | Driver |
| **obsidian** | Obsidian vault (RO) | GET only | ✓ | — | — | — | File size |

### Composite adapters (1)

| Adapter | Backend | Notes |
|---------|---------|-------|
| **overlay** | Copy-on-write cache | Stacks over another adapter; changes stay local until committed |

### Surprising asymmetries (read before picking)

- **Presigned URLs live only in `r2-direct`.** `cloudflare-r2` uses the Workers native binding, which has no presigned-URL API — so if you need presigned URLs inside a Worker, use `r2-direct` (S3 creds) even though the native binding is zero-config.
- **`cloudflare-r2` has no `list`/`query`.** Native binding doesn't expose those. Plan for key discovery outside the adapter (or use `r2-direct` with `listObjectsV2`).
- **Search providers auto-attach on some adapters but not all.** Memory, LocalJSON, DenoFS, SQLite auto-index on `set`/`delete`. Upstash, R2 variants, CF KV have no search API at all — front them with an `overlay` + search if you need it.
- **`r2-direct.get()` buffers the whole object** (`r2-direct.ts:189` uses `transformToString()`). Fine for JSON/CSV datasets; will OOM a Worker on multi-hundred-MB blobs. Use the native `cloudflare-r2` binding for streaming reads.

## Path-based routing

```typescript
const store = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    sqlite: createSQLiteAdapter({ path: "./data/main.db" }),
    r2: createR2DirectAdapter({ /* S3 creds */ }),
  },
  defaultAdapter: "memory",
  mounts: {
    "users/*": "sqlite",
    "uploads/*": "r2",
    "cache/*": "memory",
  },
});
```

## Search

Pluggable providers — attach one to a store and it indexes on every `set`:

| Provider | Algorithm | Notes |
|----------|-----------|-------|
| `MemoryBm25SearchProvider` | BM25 TF-IDF | Portable, zero deps, works with all adapters |
| `MemoryVectorSearchProvider` | Cosine similarity | User-supplied `embed` function (HF free tier or OpenAI) |
| `MemoryHybridSearchProvider` | Reciprocal Rank Fusion | Combines BM25 + vector |
| `ZvecSearchProvider` | HNSW graph (via zvec) | O(log n) for 10k–10M items |
| `SqliteFtsSearchProvider` | SQLite FTS5 | Native, only for SQLite / structured-sqlite |

## Graph store

```typescript
import { createGraphStore } from "@yawnxyz/smallstore";

const graph = createGraphStore(store);
await graph.addNode({ id: "alice", type: "person", data: { name: "Alice" } });
await graph.addEdge({ source: "alice", target: "bob", type: "knows" });
const friends = await graph.query({ from: "alice", edge: "knows" });
```

Implementation: `src/graph/{store,traversal,query}.ts`. Supports BFS, DFS, shortest-path.

## Episodic memory

```typescript
const episodes = createEpisodicStore(store);
await episodes.record({ type: "conversation", data: { topic: "..." }, importance: 0.8 });
const recalled = await episodes.recall({ tags: ["work"], minImportance: 0.5 });
```

Recall strategies: `byRelevance`, `Recent`, `Important`, `Frequent`. Importance decays exponentially with recency weighting (`src/episodic/decay.ts`).

## Progressive disclosure

Multi-level summarization — `overview → detail → raw`. Used when surfacing results to agents that can't afford the whole payload. See `src/disclosure/mod.ts`; exported from `mod.ts:505–516`.

## Views & materializers

- **Views** (`src/views/`) — materialized result sets, refreshable via HTTP (`POST /:collection/views/:name/refresh`).
- **Materializers** (`src/materializers/`) — output formatters: `materializeJson`, `materializeCsv`, `materializeMarkdown`, `materializeYaml`, `materializeText`.

## Blob middleware

`withBlobs()` wraps an adapter to route binary fields through a blob backend (R2Direct by default) while metadata stays in the primary store. Works with Airtable Attachments and Notion Files. See `src/blob-middleware/`.

## Adapter sync

Bidirectional replication between any two adapters (push / pull / merge) with 3-way merge and conflict resolution (source-wins / target-wins / skip). Dry-run mode, prefix mapping, background execution with job logs. See `src/sync.ts`.

## HTTP API

`createHonoRoutes()` wraps a store and exposes the route surface below. Framework-agnostic handlers live in `src/http/handlers.ts`; Hono registration in `src/http/integrations/hono.ts`.

```typescript
import { Hono } from "hono";
import { createHonoRoutes } from "@yawnxyz/smallstore";

const app = new Hono();
app.route("/api", createHonoRoutes(store));
Deno.serve(app.fetch);
```

### Routes

All paths are prefix-relative to wherever you mount the router (e.g. `/api` above). Route set verified against `src/http/integrations/hono.ts` (2026-04-19).

**Collection CRUD:**
| Method | Path | Purpose |
|--------|------|---------|
| GET/POST/PUT/PATCH/DELETE | `/:collection` | Collection-level ops |
| GET/POST/PUT/PATCH/DELETE | `/:collection/*` | Key-level CRUD at any path |
| GET/PUT | `/:collection/metadata` | Collection metadata |
| GET | `/:collection/schema` | Inferred schema |
| GET | `/:collection/keys` | Cursor-paginated keys |

**Search & query:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/:collection/search` | FTS (if provider attached) |
| POST | `/:collection/query` | MongoDB-style filter |
| POST | `/:collection/pipeline` | Retrieval pipeline (search + disclosure) |

**Bulk ops:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/:collection/slice` | Extract subset by field range |
| POST | `/:collection/split` | Split by field value |
| POST | `/:collection/deduplicate` | Remove duplicates |
| POST | `/merge` | Cross-collection merge |

**Namespace tree (top-level, not collection-scoped):**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/collections` | List adapters + mounted collections |
| GET | `/namespaces` | Root namespace listing |
| GET | `/namespaces/:path/children` | Children of a namespace |
| GET | `/namespaces/:path/stat` | Stat at a namespace path |
| DELETE | `/namespaces/:path` | Delete a namespace |
| GET | `/tree` | Full recursive tree |
| GET | `/tree/:path` | Tree under a path |

**Views:**
| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/views` | List / create views |
| POST | `/views/refresh` | Refresh all views |
| GET/PUT/DELETE | `/views/:name` | View CRUD |
| GET | `/views/:name/metadata` | View metadata |
| POST | `/views/:name/refresh` | Refresh a single view |

**Presigned URLs (adapter must support — currently `r2-direct`):**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/:collection/signed-upload` | Get a presigned upload URL |
| POST | `/:collection/signed-download` | Get a presigned download URL |

**Server-level routes (added by `serve.ts`, not part of `createHonoRoutes`):**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Server info (adapters, mounts, endpoint map) |
| GET | `/health` | Health check (unauthenticated) |
| GET | `/_adapters` | List adapters + capabilities (auth gated) |
| POST | `/_sync` | Trigger an adapter sync (auth gated) |
| GET | `/_sync/jobs` | List recent sync jobs (auth gated) |
| GET | `/_sync/jobs/:id` | Read a sync job's status (auth gated) |

**Auth:** `SMALLSTORE_TOKEN` env var gates `/_adapters` and `/_sync*` (bearer token). Set it in the serve environment to require auth on those endpoints.

### Request body envelope

Writes (POST / PUT / PATCH at `/:collection/*`) expect a JSON envelope:

```json
{ "data": <the-actual-value> }
```

Naked bodies return `{ "error": "BadRequest", "message": "Request body must contain \"data\" field" }`. This applies across all write routes.

### Running the server

```bash
deno task serve   # starts on the port in .smallstore.json (default 9999; this repo ships 9998)
```

Server mounts `createHonoRoutes` under `/api` by default (see `serve.ts`). So the collection-CRUD routes above are actually reachable at `/api/:collection`, the presigned routes at `/api/:collection/signed-upload`, etc. The server-level routes (`/health`, `/_adapters`, `/_sync*`) sit at the root.

Config file supports `mounts:` pattern → adapter routing.

## MCP server

For Claude Code / agent integration:

```bash
deno task mcp
```

Exposes 9 MCP tools that forward to a running Smallstore HTTP server (default `http://localhost:9998`, override via `SMALLSTORE_URL`):

| Tool | Purpose |
|------|---------|
| `sm_read` | GET a key |
| `sm_write` | PUT a key |
| `sm_delete` | DELETE a key |
| `sm_list` | List keys (with cursor) |
| `sm_query` | MongoDB-style filter query |
| `sm_adapters` | List configured adapters + capabilities |
| `sm_sync` | Trigger an adapter sync job |
| `sm_sync_status` | Read sync job status |
| `sm_sync_jobs` | List recent sync jobs |

Source: `src/mcp-server.ts`. Response bodies are capped at `SMALLSTORE_MAX_RESPONSE_BYTES` (default 10 MB) so large `sm_list`/`sm_read` on Notion/Airtable don't OOM the MCP subprocess.

## VFS (Virtual Filesystem)

Bash-like shell over any adapter. Command files live under `apps/cli/commands/vfs/`. Current set (2026-04-19):

- **File ops:** `cat`, `write`, `rm`, `cp`, `mv`, `stat`, `du`, `wc`
- **Navigation:** `cd`, `pwd`, `ls`, `tree`, `find`, `grep`
- **Import/export:** `export`, `retrieve`, `snapshot`
- **Overlay layer:** `overlay-status`, `overlay-diff`, `overlay-commit`, `overlay-discard`

Useful for agent scripting and debugging.

```typescript
import { vfs } from "@yawnxyz/smallstore";
const state = vfs.init(store);
await vfs.exec(state, "mkdir users");
await vfs.exec(state, "echo '{\"name\":\"Alice\"}' > users/alice");
```

Or interactive:

```bash
deno task sh    # VFS subshell
deno task cli   # Full REPL
```

## Commands

| Command | What it runs |
|---------|--------------|
| `deno task serve` | Hono HTTP server (port 9999) |
| `deno task mcp` | MCP server (stdio, for Claude Code) |
| `deno task cli` | Interactive REPL + VFS shell |
| `deno task sh` | VFS subshell only |
| `deno task clipper` | Example: data clipper with validation |
| `deno task crm` | Example: mini CRM |
| `deno task gallery` | Example: media gallery |
| `deno task paste` | Example: markdown paste bin (needs R2 creds) |
| `deno task auth` | Example: session auth |
| `deno test --no-check --allow-all tests/` | Full offline test suite |

## Known gaps and warts

Pulled from `TASKS-AUDIT.md`. These are real, open, and documented — not surprises:

| ID | Severity | What | Where |
|----|----------|------|-------|
| **A103** | ⚠️ **semantics** | `merge` default `append` mode can double data when re-run without explicit mode | `src/router.ts:1503–1568` |
| A022 | at-scale only | CacheManager LRU disjoint-key race can overflow cap under concurrent writes to different keys | `src/utils/cache-manager.ts:127–147` |
| A025 | at-scale only | Cache stats per-process vs adapter-wide divergence (monitoring noise) | — |
| A201 | at-scale only | Job-log files never rotated; full file reads for history queries | `src/sync.ts` |
| A203 | at-scale only | Job-ID collision probability ~1e-6 at 1k/sec burst | — |
| A204 | at-scale only | `GET /_sync/jobs` reads job files with concurrency cap 50 | — |
| A220 | UX | Cursor + offset interaction under-documented (Airtable / Upstash prefer cursor silently) | — |

**Won't-fix / deprecated:**
- `SearchOptions.path` — unused, scheduled for removal in the next major.

## Capability quick-reference

Stuck on "which adapter for X?" — consult this table first.

| You want | Pick |
|----------|------|
| Presigned upload / download URLs | `r2-direct` |
| Streaming binary reads in a Worker | `cloudflare-r2` (native binding) |
| SQL-level queries with typed columns | `structured-sqlite` |
| BM25 search, no network | `memory` + `sqlite` + `local-json` + `deno-fs` |
| Notion / Airtable as a KV | `notion` / `airtable` |
| Redis KV over HTTP | `upstash` |
| Graph relationships | any adapter + `createGraphStore()` |
| Time-decayed memory | any adapter + `createEpisodicStore()` |
| Bash-style agent scripting | any adapter + `vfs` |
| Read-only public sheet | `google-sheets-csv` |
| Local Obsidian vault | `obsidian` (read-only) |

## Testing

```bash
# Offline (no creds)
deno test --no-check --allow-all tests/*.test.ts

# Live (needs .env)
deno test --no-check --allow-all tests/live-adapters.test.ts

# Type check
deno check mod.ts
```

See `.env.example` for required environment variables.

## Publishing

```bash
deno publish --no-check --allow-slow-types   # JSR
deno task build:npm                           # generate dist/
```

Pre-publish blockers documented in `PUBLISHING.md` (slow-types, version pins on `npm:unstorage` / `npm:@notionhq/client`, Deno-only adapters excluded from npm build).

## License

[MIT](./LICENSE)
