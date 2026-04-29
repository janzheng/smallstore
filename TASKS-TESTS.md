# Smallstore — Test Coverage

**Total: 2104 offline tests passing, 13 live-adapter tests, 13 specialized live tests passing**

Last verified: 2026-04-28 (full suite: `deno test --allow-all --no-check tests/`)

Test count grew 771 → 1841 across the 2026-04 audit + remediation + admin-tools cycle. See § "2026-04 audit + remediation — test deltas" below for what landed when.

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

## 2026-04 audit + remediation — test deltas

All landed in `main` between commits `7d7ffe6` (Phase A — security audit Sprint 0) and `916ea57` (admin MCP tools). Total + 1070 tests across 4 new files + 16 expanded files. Each entry below lists the canonical run command.

### New test files (shipped 2026-04-28)

- [x] [pass: 10/10, `deno test --no-check tests/peers-env-allowlist.test.ts`] **`tests/peers-env-allowlist.test.ts`** — env-var allowlist module unit tests. Covers default-allow (TF_/NOTION_/SHEET_/SHEETLOG_/GH_/GITHUB_/AIRTABLE_/UPSTASH_/API_/WEBHOOK_/BASIC_/BEARER_/HMAC_), hard-deny (SMALLSTORE_/CLOUDFLARE_/CF_/AWS_/SECRET_/PRIVATE_/DATABASE_/REDIS_), generic-shorthand rejection (TOKEN/KEY/USER/PASS), AllowlistViolationError shape, embedder override via `createEnvAllowlist({ safePrefix?, hardDeny? })`. Audit B002. #test #security #peers
- [x] [pass: 5/5, `deno test --no-check tests/timing-safe.test.ts`] **`tests/timing-safe.test.ts`** — constant-time string equality (`timingSafeEqualString`). Equal returns true, mismatched chars false, mismatched lengths false (without short-circuit), non-string inputs false, mismatch position doesn't short-circuit the loop. Audit B011. #test #security #http
- [x] [pass: 6/6, `deno test --no-check tests/messaging-dispatch.test.ts`] **`tests/messaging-dispatch.test.ts`** — dispatch-pipeline failure semantics. Classifier throw → drop with `drop_reason: "classifier-failed"` + `console.error`; postClassify + sinks + postStore not invoked on drop; throwing preIngest still flows through (existing behavior preserved). Audit B009. #test #messaging #pipeline
- [x] [pass: 9/9, `deno test --no-check tests/router-routing.test.ts`] **`tests/router-routing.test.ts`** — router glob + specificity + routing-fallback parity. Glob metachar escape (`cache.temp` literal), specificity sort overrides insertion order both directions, set+append parity for glob mounts. Audit B006/B017/B018. #test #router

### Expanded test files (audit B-series remediation)

- [x] [pass: 73/73, `deno test --no-check tests/peers-proxy.test.ts`] +15 cases: 4 B002 (env-allowlist gates `resolvePeerAuth`'s bearer/header/basic paths + proxyGet short-circuit) + 11 B033 (`isValidPath` unit, proxy CRLF/control-char rejection, HTTP route boundary at /peers/:name/fetch + /peers/:name/query). #test #security #peers
- [x] [pass: ~30+ messaging-auto-confirm cases, `deno test --no-check tests/messaging-auto-confirm.test.ts`] +6 cases: 5 B007 redirect-walk (302→safe-host completes, 302→unsubscribe aborts, 302→IP-literal aborts, MAX_REDIRECTS=3 limit, "302 counts as success" rewritten to "302→safe walk completes") + 1 B015 cache-invalidation-via-subscribeInvalidations. #test #messaging #auto-confirm
- [x] [pass: ~25+ confirm-detect cases, `deno test --no-check tests/messaging-confirm-detect.test.ts`] +8 cases: 3 B016 HTML-anchor extraction (picks <a href> matching anchor text not adjacent URL, falls back to plaintext when no anchor, skips unsubscribe href even with confirm anchor text) + 5 B027 transactional-mail rejection (Verify your email address → false, Verify your subscription → true, Verify your sign up → true, Verify your account → false, password-reset → false). #test #messaging #confirm-detect
- [x] [pass: 16+ senders-store cases, `deno test --no-check tests/messaging-auto-confirm-senders-store.test.ts`] +5 B015 subscribe semantics (fires on add+delete that actually changed state, idempotent add doesn't fire, unsubscribe stops notifications, listener exception doesn't poison mutation path). #test #messaging #auto-confirm
- [x] [pass: 29/29, `deno test --no-check tests/messaging-inbox.test.ts`] +7 cases: 4 B004 atomicity (pending key cleared after success, recoverOrphans re-indexes after simulated mid-write crash, reaps pending without item, cleans benign pending after late delete) + 2 B014 concurrency (20 distinct concurrent ingests land as 20, 10 same-id ingests collapse to 1) + 1 happy-path. #test #messaging #inbox
- [x] [pass: 30/30, `deno test --no-check tests/messaging-d1-fts.test.ts`] +4 cases: B005 throw CorruptValueError on JSON-parse fail, B034 50-key clear smoke, B035 concurrent ensureTable shares one migration, B036 SQL LIMIT/OFFSET correctness. #test #adapter #d1
- [x] [pass: 27/27 (rules) + 11/11 (rules-http), `deno test --no-check tests/messaging-rules.test.ts tests/messaging-rules-http.test.ts`] +4 cases: 2 B008 (malformed filter throws inside evaluateFilter — second well-formed rule still matches; throwing rulesStore.apply → hook returns 'accept' + logs) + 2 B024 cursor non-advance (fast-fail in <10 calls vs 10k cap on stuck cursor; healthy paginated query no false-positive). #test #messaging #rules
- [x] [pass: 25/25, `deno test --no-check tests/messaging-mirror.test.ts`] +4 cases: B019 concurrent runMirror short-circuits with `skipped: 'in-flight'`, B021 hydration concurrency cap of 10 (timestamp-gap analysis confirms 3 batches for 25 items), B022 item-cap (1000 → 200 rendered) + byte-cap (32 × 5KB → bytes ≤ cap with `_recent_caps` test override). #test #messaging #mirror
- [x] [pass: ~25+ forward-detect cases, `deno test --no-check tests/messaging-forward-detect.test.ts`] +4 B025 cases: bare-address regex now rejects `+` and percent-encoded chars in local-part (negative lookbehind anchors); legitimate `<user+inbox@example.com>` in angle brackets still extracts. #test #messaging #forward-detect
- [x] [pass: ~15+ unread-hook cases, `deno test --no-check tests/messaging-unread-hook.test.ts`] +5 B028 cases: `read_at` sentinel skips stamp on items that carry it; quarantine restore path (`_ingest({force: true})`) doesn't re-run hooks today but the sentinel is dormant defense-in-depth. #test #messaging #unread
- [x] [pass: ~20+ sender-aliases cases, `deno test --no-check tests/messaging-sender-aliases.test.ts`] +3 B029 cases: parse-time specificity sort (longest literal-prefix wins regardless of insertion order); 4 existing parse tests updated to reflect sorted output. #test #messaging #sender-aliases
- [x] [pass: 27/27, `deno test --no-check tests/messaging-channel-rss.test.ts`] +1 B030 case: 100-entry feed × 50 entities each parses fine (5000 expansions, well under 50_000 cap). #test #messaging #rss
- [x] [pass: 15/15, `deno test --no-check tests/messaging-pull-runner.test.ts`] +1 B031 case (shared-guid feed → 1 stored + 1 collided + 0 dropped) + 1 existing test updated (re-poll counted as `items_collided` not `items_stored`) + 2 fixture renames `FEED_TOKEN` → `API_FEED_TOKEN` + `MISSING_TOKEN` → `API_MISSING_TOKEN` for B002 allowlist compliance. #test #messaging #pull-runner
- [x] [pass: 42/42, `deno test --no-check tests/messaging-newsletter-markdown.test.ts`] +8 B032 cases: 4 `escapeMarkdownText` units (backticks, lines exactly `---`, leading `# `, normal text round-trips) + 4 per-renderer integration (renderNewsletterProfile, renderNewsletterNotes, renderAllNotes, renderRecentFeed). #test #messaging #markdown
- [x] [pass: ~30+ adapter-paging cases, `deno test --no-check tests/adapter-paging.test.ts`] +2 B037 cases: probabilistic eviction over 1000+200 sets with stubbed `Date.now`, on-demand `keys()` correctness regression. #test #adapter #memory
- [x] [pass: ~30+ cursor cases, `deno test --no-check tests/messaging-cursor.test.ts`] +8 B041 cases: malformed JSON, non-object payload, missing/wrong-typed `at`/`id`, non-ISO `at`, oversized id, accepted ISO with offsets, boundary 256-char id, empty-id sentinel preserved. #test #messaging #cursor

### Audit cleanup batch (5393ef9, ee174a2, 55c9f84)

- [x] [pass: 18/18, `deno test --no-check tests/sync-jobs-http.test.ts`] +1 A201 case: full `POST /_sync/jobs/prune` dryRun → real-prune cycle against running server with backdated mtime (`Deno.utime`). Plus a 10s → 30s deadline raise for the background-mode test (was flaking 1/3 under full-suite parallelism, now stable). #test #server #sync-jobs
- [x] [pass: 13/13, `deno test --no-check tests/job-log.test.ts`] +5 A201 cases: pruneJobs reaps files older than cutoff + retains fresher, dryRun returns plan without deleting, empty dir returns zeroed counters, olderThanMs ≤ 0 is no-op, default 30d cutoff retains fresh files. Helper `backdateFile` via `Deno.utime`. #test #util #job-log

### Admin MCP tools (916ea57)

- [x] [pass: 19/19, `deno test --no-check tests/mcp-server.test.ts`] +3 mock-roundtrip cases: sm_inbox_create forwards `POST /admin/inboxes` with body, sm_inbox_list_admin forwards `GET /admin/inboxes`, sm_inbox_delete_inbox forwards `DELETE /admin/inboxes/:name`. Plus tools/list assertion bumped 26 → 49 → 52 (the 2026-04-28 refresh + the +3 admin tools). #test #mcp #admin

### Adapter offline mock coverage (2026-04-28)

Closed all 5 entries in the "Adapters without offline (mocked) tests"
gap list. 122 new tests across 5 new files, all stubbing the adapter's
HTTP / SDK surface so no live credentials are needed.

- [x] [pass: 28/28, `deno test --no-check tests/adapter-sheetlog.test.ts`] **`tests/adapter-sheetlog.test.ts`** (commit fb20b23) — companion to adapter-sheetlog-guard.test.ts. Constructor + capabilities, get/has/keys (sheet-as-collection), upsert (single, array, explicit idField, keyGenerator with __generatedKey injection, non-object rejection, empty-array short-circuit, auto-detect failure on non-unique first key), insert (delegates to upsert), merge (3 dedup strategies: id / hash / fields), query/list pagination. Stubs the underlying `client` directly. #test #adapter #sheetlog
- [x] [pass: 26/26, `deno test --no-check tests/adapter-upstash.test.ts`] **`tests/adapter-upstash.test.ts`** (commit 2928ff9) — full REST surface. Constructor (rejects without url+token after env clear), get (200, double-stringification, 404, null result, plain text, 500 propagation), set (SET vs SETEX URL shape, content-type text/plain, body shape), delete (POST /del/<key>), has (result=1/0), keys (pattern building + namespace stripping), listKeys (SCAN cursor walking, A220 cursor+offset precedence), clear (lists then bulk-deletes), namespace prefixing. Stubs globalThis.fetch with URL-pattern responder. #test #adapter #upstash
- [x] [pass: 28/28, `deno test --no-check tests/adapter-f2-r2.test.ts`] **`tests/adapter-f2-r2.test.ts`** (commit 651e53d) — full F2 + R2 surface. parseKey (smallstore: prefix stripping, slash split, defaultScope fallback), get (JSON content-type → parsed, non-JSON → Uint8Array, 404/403 → null, bearer auth injection), set (cmd:data for objects/strings/numbers/booleans, cmd:presign + PUT to presigned URL for binary, presign-no-url throws), delete (cmd:delete with authKey, missing-authKey skips, 404 tolerated for idempotency, 500 propagated), has (HEAD → true/false, network error → false), keys (cmd:list maps to smallstore: prefixed keys), clear (cmd:delete with prefix). Stubs globalThis.fetch with URL+bodyJson responder. #test #adapter #f2-r2
- [x] [pass: 23/23, `deno test --no-check tests/adapter-r2-direct.test.ts`] **`tests/adapter-r2-direct.test.ts`** (commit ebcb522) — full S3-via-AWS-SDK surface. Constructor + capabilities, set (PutObjectCommand for JSON object/string/Uint8Array with right Body+ContentType), get (parsed JSON / raw bytes / null on NoSuchKey / null when Body missing / autoParse off), delete (DeleteObjectCommand), has (HeadObjectCommand → true / false on NotFound or NoSuchKey / rethrow other errors), keys (ListObjectsV2Command maps Contents[].Key, prefix passes through), clear (lists then deletes each), getSignedUploadUrl + getSignedDownloadUrl + filename variant (use real S3Client; presigner is pure-local URL building so synthetic credentials work offline). Stubs s3Client.send via private-property injection; per-command-name dispatch. #test #adapter #r2-direct
- [x] [pass: 17/17, `deno test --no-check tests/adapter-notion.test.ts`] **`tests/adapter-notion.test.ts`** (commit 10d2184) — CRUD + paginated key paths. Constructor (rejects without mappings/introspectSchema, accepts with mappings, cleans databaseId dashes), get (queryDatabase filter shape + transformFromNotion result + null on empty + null on error), delete (queries by key + updatePage(in_trash:true) + no-op when not found + idempotent on object_not_found), has (true/false/false-on-error), keys (paged via has_more + next_cursor + prefix filter + [] on error), listKeys (cursor walking + limit + prefix + A220 cursor+offset precedence). Stubs the entire NotionModernClient surface (queryDatabase / updatePage / createPage / getPage / listBlockChildren / appendBlockChildren / deleteBlock / getDatabase / getDataSource); per-method dispatch. Out of scope (live-only via tests/live/notion/test.ts): set + upsert (transformer pipeline + createPage vs updatePage), dynamic field creation, contentProperty body reads/writes, schema introspection. #test #adapter #notion

### Spam triage primitives — Sprint 1 of `.brief/spam-layers.md` (commit 0ec354f)

- [x] [pass: 19/19, `deno test --no-check tests/messaging-spam-triage.test.ts`] **`tests/messaging-spam-triage.test.ts`** — Sprint 1 of the spam-layers feature. Covers SenderRecord schema bump round-trip (3 cases — default 0 for new senders, setRecord round-trip, auto-ingest preserves), resolveSpamAttribution all branches (5 — trusted forwarder, untrusted forwarder, no forward, missing from_email edge, missing both edge), mark-spam endpoint (6 — happy path, idempotent decision #1, trusted-forwarder routing, consider_demote when trusted+5+marks+spam_rate>0.5, NO consider_demote when not trusted, 501 when senderIndexFor unwired), mark-not-spam endpoint (5 — happy path, idempotent, auto-confirm revocation decision #3, null when not auto-confirmed, undo round-trip preserving source). #test #messaging #spam-triage

### Spam layers Sprint 2 — header heuristics + sender reputation + content-hash

- [x] [pass: 28/28, `deno test --no-check tests/messaging-spam-headers.test.ts`] **`tests/messaging-spam-headers.test.ts`** — Layer 2 of the layered spam defense. Pure-helper coverage: `hasFromReplyToMismatch` (same-domain/different/missing/case-insensitive header keys/quoted from), `hasGenericDisplayName` (Team/Newsletter/noreply true; Jane Doe false; quoted-display-name unwrapping), `hasBulkWithoutListUnsubscribe` (anchor + word-proximity detection vs List-Unsubscribe header), `hasDmarcFail` (pass/fail/unknown/none). Hook coverage: emits `header:dmarc-fail` ONLY on explicit fail (not 'unknown' or 'none'); multi-label emission; clean-item accept; dedup against existing labels; **trusted-sender bypass** via stub senderIndex returning `tags: ['trusted']`; non-trusted senderIndex still runs heuristics; senderIndex.get throw → swallow + continue. #test #messaging #spam-headers
- [x] [pass: 14/14, `deno test --no-check tests/messaging-spam-reputation.test.ts`] **`tests/messaging-spam-reputation.test.ts`** — Layer 3 of layered spam defense. `computeConsiderDemote` (4 cases: not-trusted false, trusted+below-count false, trusted+count=5+rate=0.5 false (strict gt), trusted+rate=0.6 true). Hook (10 cases): trusted bypass even at 95% spam rate, below min count = accept, high threshold (rate=1.0 → spam-suspect:high), medium threshold (rate=0.5 → spam-suspect:medium), below medium (rate=0.2 → accept), idempotent on already-labeled, no sender, unknown sender, address normalization round-trip, custom thresholds (highThreshold=0.9 demotes 0.8 to medium). Behavior parity with the inline `computeConsiderDemote` in `src/messaging/http-routes.ts:2114` verified by lane agent. #test #messaging #spam-reputation
- [x] [pass: 23/23, `deno test --no-check tests/messaging-content-hash.test.ts`] **`tests/messaging-content-hash.test.ts`** — Layer 4 of layered spam defense. `normalizeBody` (5+: strips Mailchimp tracking URL; strips 1×1 imgs width-only/height-only/both; strips per-recipient `?token=` while preserving `?utm=`; collapses whitespace; strips `Hi <name>,` salutation at line start; bodies-differing-only-in-tracking-artifacts hash identical). `hashBody` (deterministic, 64-char hex, different inputs differ). `ContentHashStore` (record returns null first / existing on second; isRepeatWithin within window/outside/missing; prune drops old entries returns count). Hook (8 cases: first-seen accept; untrusted repeat → `campaign-blast`; trusted repeat → `repeated:trusted` (decision #4 amplification, NOT campaign-blast); outside-window treated fresh; empty body accept; no sender accept; idempotent on existing label; **normalization unifies repeats** — two different `?token=X` URLs hash to same value, second triggers label, proves normalize-then-hash chain end-to-end). One spec divergence noted: salutation regex tightened to require comma since the brief's `,?` optional caused `\S+` greedy to false-match `<img...>` and consume prose like "Hello world" — comma-required and `[A-Za-z][\w'.-]*` name token shape is the cheap fix; documented inline. #test #messaging #content-hash

### Spam triage Sprint 3 — rule suggestions + promote-rule

- [x] [pass: 17/17, `deno test --no-check tests/messaging-spam-stats.test.ts`] **`tests/messaging-spam-stats.test.ts`** — Sprint 3 ranking helper. Empty-index returns four empty lists. `senders_top_spam` ranks by spam_count desc with count-desc tiebreaker, excludes spam_count=0. `senders_recently_marked` filters by marked_at within windowDays, sorts by marked_at desc, custom windowDays honored. `suggested_blocklist` requires count >= 5 AND spam_rate >= 0.7, **excludes trusted senders**, sorts by spam_rate desc then spam_count, custom thresholds verified. `suggested_whitelist` requires explicit marks >= 3 AND not_spam > spam (strict, not >=), excludes trusted (already whitelisted), sorts by not_spam_count desc. `limit` caps each ranked list. Row shape: spam_rate divides by explicit decisions only (NOT total count), preserves display_name + tags. #test #messaging #spam-stats
- [x] [pass: 13/13, `deno test --no-check tests/messaging-spam-stats-http.test.ts`] **`tests/messaging-spam-stats-http.test.ts`** — HTTP integration. GET `/inbox/:name/spam-stats` (happy path returns inbox+four lists; empty index; window_days query honored; limit query caps lists; 501 when senderIndexFor unwired; 404 for unknown inbox). POST `/inbox/:name/spam-stats/promote-rule` (blocklist → priority 100 quarantine on `from_email`; whitelist → priority 0 tag with `{ tag: 'trusted' }` and applyRetroactive **actually applies the tag to existing items**, verified by reading the items back; invalid kind 400; missing sender 400; sender lowercased before storage; 501 when rulesStoreFor unwired). Reuses the Sprint 1 fixture pattern. #test #messaging #spam-stats-http
- [x] [pass: 4/4, included in 23/23 `tests/mcp-server.test.ts`] **MCP roundtrips for sm_inbox_spam_stats + sm_inbox_promote_spam_rule** — sm_inbox_spam_stats forwards GET with both query params present; omits query string when no opts; sm_inbox_promote_spam_rule forwards POST with `{ sender, kind }` body; rejects unknown kind LOCALLY before any HTTP call (mock.requests.length === 0). Tools/list assertion bumped 54 → 56 (now lists `sm_inbox_promote_spam_rule` + `sm_inbox_spam_stats` alphabetically). #test #mcp #spam-mcp

### Peer registry HTTP CRUD coverage

- [x] [pass: 23/23, `deno test --no-check tests/peers-http-routes.test.ts`] **`tests/peers-http-routes.test.ts`** — full CRUD + health-probe coverage. New file. Mounts `registerPeersRoutes` onto an in-process Hono app + MemoryAdapter-backed peerStore; auth middleware stubbed open. Coverage:
  - POST /peers — happy + 4 validation paths (missing name, invalid type, invalid URL, duplicate) + 2 B002 allowlist cases (TF_TOKEN ok, SMALLSTORE_TOKEN rejected, AWS basic-auth rejected)
  - GET /peers — empty list, multi-peer, type filter, include_disabled flag (disabled hidden by default)
  - GET /peers/:name — happy + 404
  - PUT /peers/:name — happy patch, read-only-fields stripped (id + created_at), 404, non-object body 400
  - DELETE /peers/:name — happy + 404
  - GET /peers/:name/health — disabled returns 409 without probing (asserts globalThis.fetch not called), unknown 404, happy probe stubs fetch + verifies upstream URL
  - Companion to `tests/peers-proxy.test.ts` (which covers proxyGet/proxyPost + B033 path-validation boundary at /fetch + /query) and `tests/peers-registry.test.ts` (CRUD store directly, not over HTTP). #test #peers #http

## Coverage Gaps — No Tests

### Adapters without offline (mocked) tests

- [x] [shipped 2026-04-28: 26/26 in tests/adapter-upstash.test.ts; commit 2928ff9. Mocks globalThis.fetch with URL-pattern responder.] Upstash adapter — live tests pass, no mocked offline test #gap #adapter
- [x] [shipped 2026-04-28: 17/17 in tests/adapter-notion.test.ts; commit 10d2184. Stubs NotionModernClient via private-property injection.] Notion adapter — live tests pass, no mocked offline test #gap #adapter
- [x] [shipped 2026-04-28: 28/28 in tests/adapter-sheetlog.test.ts; commit fb20b23. Companion to adapter-sheetlog-guard.test.ts (which covers the destructive-set/delete guards).] Sheetlog adapter — live tests pass, no mocked offline test #gap #adapter
- [x] [shipped 2026-04-28: 23/23 in tests/adapter-r2-direct.test.ts; commit ebcb522. Stubs s3Client.send via private-property injection; signed-URL tests use real S3Client (presigner is pure-local, works offline).] R2 Direct adapter — live tests pass, no mocked offline test #gap #adapter
- [x] [shipped 2026-04-28: 28/28 in tests/adapter-f2-r2.test.ts; commit 651e53d. Mocks globalThis.fetch with URL+bodyJson responder.] F2-R2 adapter — no dedicated offline test #gap #adapter

### Infrastructure

- [x] [shipped earlier; verified 2026-04-28: all 33 obsidian tests pass — `deno test --no-check tests/obsidian-adapter.test.ts tests/obsidian-codec.test.ts tests/obsidian-sync.test.ts` returns `33 passed | 0 failed`. This entry duplicated lines 146-149 above; closed for bookkeeping only.] Obsidian import map fix — unblock 3 test files #gap #infra

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
