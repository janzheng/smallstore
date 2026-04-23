# Smallstore — Completed Tasks

Archive of shipped work, newest at top. See `git log` for full diffs and individual commits.

---

## 2026-04-25 — MCP tool family + reorg (late afternoon)

Canonical access surface. The old monolithic 505-line `src/mcp-server.ts` split into per-family tool files under `src/mcp/`, with two new tool families added alongside the existing core. 33 MCP tools now live: 10 core + 15 inbox + 8 peers. 1203/1203 tests green.

- [x] [done 2026-04-25: Split src/mcp-server.ts (505 LOC) into src/mcp/ folder — config.ts (env validation), http.ts (shared HTTP forwarder with createHttpFn + readCapped), tools/types.ts (Tool, Args, HttpFn, HttpResult, requireString, validateName, formatHttpError, encodeCollectionKey shared helpers), tools/core.ts (existing 10 tools migrated verbatim), server.ts (composition + dispatch), mod.ts (entry). src/mcp-server.ts now a 3-line shim that imports src/mcp/mod.ts — existing ~/.claude.json configs don't break] MCP reorg: src/mcp-server.ts → src/mcp/ folder #mcp-reorg
- [x] [done 2026-04-25 agent A: src/mcp/tools/inbox.ts (508 LOC, 15 tools) — sm_inbox_list/read/query/export/tag/delete/unsubscribe/quarantine_list/restore + sm_inbox_rules_list/get/create/update/delete/apply_retroactive. Thin HTTP forwarders with arg validation (action enum, at-least-one-of add/remove, etc). Export forces format=json since MCP can't stream. Snake-case MCP args mapped to server camelCase (skip_call → skipCall)] sm_inbox_* tool family #messaging #mcp-inbox-family
- [x] [done 2026-04-25 agent B: src/mcp/tools/peers.ts (378 LOC, 8 tools) — sm_peers_list/get/create/update/delete + sm_peers_health/fetch/query. Auth JSON schema kept permissive (object with required 'kind' enum); server's runtime validator handles deeper union shape with clean 400s. client_query on fetch merges with path via URLSearchParams.append. Description calls out "secrets via wrangler secret put separately" footgun] sm_peers_* tool family #peers-mcp
- [x] [done 2026-04-25: skills/smallstore/SKILL.md description + body updated to reflect the new tool families. Added § "Mailroom tools" + § "Peer registry" with typical-workflow code blocks. Pointer to docs/user-guide/mailroom-quickstart.md for full HTTP recipes. Canonical skill stays in smallstore repo per user's "don't fork to mcp-hub" direction] Canonical /smallstore skill updated #skill-update
- [x] [done 2026-04-25: tests/mcp-server.test.ts tools/list expected list updated from 10 → 33 entries (10 core + 15 inbox + 8 peers). 16/16 mcp tests green. deno check clean on src/mcp-server.ts shim + the whole tree] MCP test coverage refresh #mcp-tests
- [*] **Session stats:** ~1250 net LOC added (plus 505 LOC removed from old mcp-server.ts and recreated inside the split). 2 parallel agents (inbox + peers, clean file-scope split). 33 MCP tools. 1203/1203 tests green.

---

## 2026-04-25 — Peer registry sprint (afternoon session)

- [x] [done 2026-04-25 end-of-sprint: registered tigerflare as a live peer end-to-end. TF_TOKEN set as wrangler secret on smallstore Worker (from `_deno/apps/tigerflare/.tigerflare.json` servers.cloud.token). Peer `tigerflare-demo` URL corrected from tigerflare.labspace.ai to the actual tigerflare.yawnxyz.workers.dev via PUT /peers/:name. Required a redeploy because env was captured at buildApp time (cached isolate held the pre-secret env). Post-redeploy verification: health probe returns ok:true status:200 latency 81ms; proxy-fetch GET / returns tigerflare directory listing. Also fixed probePeer to use `/` for tigerflare type (no /health route) instead of /health. Live at version ff397427] Wire up tigerflare as a live peer #peers-wire-tigerflare



Shipped same-day after morning curation sprint. Brief: `.brief/peer-registry.md`. Level 2 (metadata + authenticated proxy) live at `smallstore.labspace.ai` version `b1c385d1`.

- [x] [done: src/peers/types.ts. Peer, PeerAuth, PeerType, PeerStore, PeerQueryFilter, PeerQueryResult, CreatePeerStoreOptions + proxy types. Secrets via env-ref (token_env/user_env/pass_env), never inline. Reserved path_mapping for level-3 compound adapter] Peer types #peers-types
- [x] [done agent A, 316 LOC + 18 tests: src/peers/peer-registry.ts with createPeerStore(adapter, opts) → CRUD + list + paging. Slug regex `[a-z0-9][a-z0-9_-]{0,63}` enforces URL-safe names 1-64 chars. Alias key `_by_id/<id>` stores slug string (not full record) so renames are 3 writes with stable id. Tags permissive (32-char entries, 16-total cap, no case normalization)] Peer registry storage #peers-store
- [x] [done agent B, 528 LOC + 27 tests: src/peers/proxy.ts with resolvePeerAuth + proxyGet + proxyPost + probePeer. Per-type auth (bearer/header/query/basic) with env-var resolution at request time. Header precedence auth > peer-static > client with hop-by-hop + authorization stripped. AbortController timeout (default 10s). Health probe per type: GET /health for smallstore/tigerflare, OPTIONS for webdav, HEAD for others. 2xx + 3xx both count as reachable. Fetch-mocking test helper w/ abort-signal support for timeout tests] Peer proxy #peers-proxy
- [x] [done: src/peers/http-routes.ts ~390 LOC with registerPeersRoutes(app, {peerStore, requireAuth, env}). 8 routes: GET/POST/PUT/DELETE /peers + GET /peers/:name/health + GET /peers/:name/fetch + POST /peers/:name/query. HTTP-boundary input validation (type/auth-kind/header-shape). Disabled peers 404 from operational routes but remain in CRUD. Proxy responses scrub hop-by-hop + content-encoding; add X-Peer-Latency-Ms header. Auth short-circuit on missing env → 502 Bad Gateway] Peer HTTP routes #peers-http
- [x] [done: src/peers/mod.ts + sub-entry "./peers" + "./peers/types" in deno.json, jsr.json, scripts/build-npm.ts entryPoints. Plugin invariants verified: core doesn't import peers, no heavy deps (fetch/crypto/btoa only), self-contained, deletable] Peer plugin entry #peers-plugin-entry
- [x] [done: deploy/src/index.ts wires peersD1 adapter (table peers) + peerStore Map + registerPeersRoutes. env cast through for auth resolution. Landing page updated to advertise /peers + peers_proxy endpoints. AppHandle type extended with peerStore] Peer deploy wiring #peers-deploy-wire
- [x] [done: wrangler deploy → version b1c385d1-f2d1-4ccb-88db-2842945dbfd1 at smallstore.labspace.ai. Live-verified: POST /peers creates tigerflare-demo with correct defaults. GET /peers lists it. GET /peers/tigerflare-demo/health cleanly surfaces "env var TF_TOKEN is not set" (graceful failure, no crash) — proves auth resolution + error-path propagation both work end-to-end] Peer live verification #peers-live-verify
- [x] [bonus, unrelated-pre-existing fix: tests/mcp-server.test.ts tools/list expected list didn't include sm_append which was added 2026-04-21. One-line fix — 1202 → 1203/1203 tests green] sm_append tools/list test fix
- [*] Session stats: 45 peer tests (18 registry + 27 proxy) + 1 mcp fix; ~1250 LOC across types/registry/proxy/http-routes/mod; 2 parallel agents + me sequential; 1 hour wall-clock; zero merge conflicts; 1 live production deploy

---

## 2026-04-25 — Mailroom curation sprint

Full narrative: `.brief/2026-04-25-curation-sprint.md`. **322/322 messaging tests green (+94 from 228), 9 commits, 4 live production deploys iterating on real forwarded mail.** Live at `smallstore.labspace.ai` version `c0bd59d7`.

### Foundation

- [x] [done: senderD1 adapter with table `mailroom_senders`, generic k/v mode. createSenderIndex wraps it. Survives isolate cold-starts. Commit `d86d772`] Move sender-index from memory → D1 #curation-sender-index-d1
- [x] [done: CF Email Routing "Enable subaddressing" already on; `mailroom+*@labspace.ai` reaches worker via existing rule. No dashboard change needed] CF Email Routing: plus-addressing #curation-plus-addr-routing

### Ingestion hooks

- [x] [done agent A, 389 lines + 24 tests: src/messaging/forward-detect.ts. Detects Gmail/Outlook/Apple Mail forwards via SELF_ADDRESSES match + X-Forwarded-*/Resent-From headers. Extracts fields.original_from_* from body. 40-line scan window, best-effort. Commit `59740d4`] Forward-detection hook #curation-forward-detect
- [x] [done agent B, 249 lines + 19 tests: src/messaging/plus-addr.ts. Reads fields.inbox_addr for mailroom+<intent>@ suffix; tags with intent. Default allowed: bookmark/archive/read-later/star/inbox/snooze. 64-char cap, nested-plus noop, input immutability. Commit `59740d4`] Plus-addressing intent hook #curation-plus-addr-intent

### Rules family

- [x] [done agent C, 375 lines + 19 tests: src/messaging/rules.ts with createRulesStore(adapter, opts) → CRUD + apply + applyRetroactive. MailroomRule = {id, match(InboxFilter), action, action_args, priority, notes, disabled, created_at, updated_at}. 5 action verbs (archive/bookmark/tag/drop/quarantine). Tag-style stack; terminal first-match by priority (ties: oldest created_at first). Retroactive skips already-labeled items. Commit `59740d4`] Rules storage module #curation-rules-store
- [x] [done agent C, +140 lines + 11 tests in http-routes.ts: GET/POST /inbox/:name/rules, GET/PUT/DELETE /:id, POST /:id/apply-retroactive, POST /rules?apply_retroactive=true. 501 when rulesStoreFor absent. Commit `59740d4`] Rules HTTP surface #curation-rules-http
- [x] [done agent C, 76 lines + 8 tests: src/messaging/rules-hook.ts. createRulesHook(opts) returns PreIngestHook that calls rulesStore.apply, merges labels, returns drop/mutated-item/accept verdict. quarantineLabel matches email-handler's. Commit `59740d4`] Rules preIngest hook #curation-rules-hook
- [x] [done agent C: rulesStore.applyRetroactive iterates inbox.query(match) + re-ingests each via _ingest({force:true}). Terminal actions no-op with error message. Commit `59740d4`] Retroactive apply #curation-rules-retroactive

### Deploy wiring

- [x] [done: deploy/src/index.ts wires preIngest hooks in order: forwardDetect → plusAddr → rulesHook. senderUpsertHook stays postClassify. New rulesD1 (table mailroom_rules) + rulesStores Map. rulesStoreFor resolver passed to registerMessagingRoutes. SELF_ADDRESSES env var via parseSelfAddresses. Bundle 583 → 605 KiB (+22 KiB). Commit `59740d4`] Deploy hook wiring #curation-deploy-wire
- [x] [done: wrangler.toml [vars] SELF_ADDRESSES = "hello@janzheng.com,jan@phage.directory,janeazy@gmail.com,jessica.c.sacher@gmail.com". Commit `b78bd62`] SELF_ADDRESSES var configured

### Polish / ergonomics (same-sprint)

- [x] [done: POST /inbox/:name/items/:id/tag body {add?, remove?}. Set-merge on add, Set-delete on remove, dedup-safe. force:true re-ingest. Used live to undo an over-eager archive rule. Commit `b17fd9e`] Manual-tag surface #curation-manual-tag
- [x] [done: DELETE /inbox/:name/items/:id + new Inbox.delete(id). Removes item, updates index, best-effort blob ref cleanup. Used live to delete the chicken-crossing test item. Commit `b2591d2`] Hard-delete item endpoint #curation-item-delete
- [x] [done: 6-level removal taxonomy section in .brief/mailroom-curation.md — CF-drop / rules-drop / quarantine / archive / tag-remove / hard-delete. Captures user insight "archive is stuff I like but back-burner" vs "truly gone". Commit `b2591d2`] Removal taxonomy documented #curation-removal-taxonomy
- [x] [done: mainViewFilter(base?, opts?) + DEFAULT_HIDDEN_LABELS in filter.ts. Merges {exclude_labels: ['archived','quarantined']} into caller's filter (Set union, dedup). Does not mutate. 7 tests. Commit `68dccd7`] Main-view filter helper #curation-main-view-helper
- [x] [done: GET /inbox/:name/quarantine?cursor=&limit=&label= + POST /inbox/:name/restore/:id?label=. Thin wrappers over listQuarantined/restoreItem. 6 tests. Live-verified. Commit `68dccd7`] HTTP routes for quarantine/restore #messaging #mailroom-quarantine-routes

### Supersedes (from prior queue)

- [x] [superseded by curation sprint rules family (rules.ts + rules-hook.ts + HTTP routes). Shipped Wave 3 task in a different form than the original brief imagined, same outcome: runtime-editable rules persisted in D1, 5 action verbs, retroactive apply] Rules table + runtime-editable rules #messaging #mailroom-rules

### Live verification (end of sprint)

- [x] [done live on production: Sidebar.io subscription confirmation stored with 'newsletter' label. Whitelist→bookmark rule retroactively tagged 2 self-forwards (Claude + chicken). Archive-rule-on-Sidebar accident corrected via manual tag-remove; rule deleted. Chicken hard-deleted. Full end-to-end workflow exercised during sprint] Verify against real forwarded mail #curation-live-verify

**Session stats:** 322/322 tests (+94 from sprint start), 9 commits, 4 live deploys (iterative), 3 subagent dispatches (one wave, zero merge conflicts), ~2600 net LOC insertions, 2 new briefs.

---

## 2026-04-24 — Mailroom pipeline + plugin discipline sprint

Full narrative: `.brief/2026-04-24-mailroom-sprint.md`. **228/228 messaging tests green, 8 commits, 1 live production deploy** (smallstore.labspace.ai version `b32121f0`).

### Plugin discipline audit (brief: `.brief/plugin-discipline-audit.md`, doc: `docs/design/PLUGIN-AUTHORING.md`)

- [x] [done: postal-mime moved to optional peer + lazy-loaded in cf-email.ts; 18/18 tests green. Commit `d4a74a9`] Messaging family audit — 3.5/4 invariants passed; leak fixed same day #plugin-discipline
- [x] [done: 7 real plugin families audited (messaging/graph/episodic/blob-middleware/http/disclosure/vault-graph) — 6 clean + 1 known-leak (blob-middleware→aws-sdk); 3 "plugins" reclassified as core modules (views/materializers/search). Commit `f549ee7`] Audit other plugin families against 4 invariants #plugin-discipline
- [x] [done: root deps audited — @notionhq/client, @aws-sdk/*, unstorage leak into core via root barrel; factory-slim.ts is the already-proven mitigation; full fix deferred as follow-up tasks. Commit `f549ee7`] Audit root package.json dependencies #plugin-discipline
- [x] [done: `docs/design/PLUGIN-AUTHORING.md` shipped — 4 invariants + lazy-load recipe with postal-mime worked example + sub-entry-point convention + checklist + known exceptions + role decision tree (adapter/channel/sink/processor with Obsidian/Tigerflare/Email/RSS worked examples). Commit `f549ee7`] Plugin authoring doc + role decision tree #plugin-discipline #docs
- [x] [done: user clarified "bm25 is useful might as well make it core (it kind of sprawled but everything wants it)." Ubiquitous utility → core; leak pattern is *one* caller dragging heavy dep the others don't need. Documented + saved to agent memory. Commit `c0585c3`] Core vs plugin decision criterion #plugin-discipline

### Mailroom pipeline (brief: `.brief/mailroom-pipeline.md`)

- [x] [done Wave 0 (claude, sequential): Sink/SinkContext/SinkResult types + sinks.ts (inboxSink/httpSink/functionSink) + InboxRegistration.sinks[] + registerSinks/addSink + email-handler dispatches sinks independently with try/catch per sink + cf-email preserves full headers in fields.headers. 27/27 cf-email + email-handler tests green. Commit `6361d6a`] Sink abstraction + email-handler refactor #mailroom-sinks
- [x] [done Wave 1 agent A: `cloudflareD1({ messaging: true })` + messaging schema migration (10 migrations, d1_migrations tracking, single-line DDL per D1 exec() gotcha) + items_fts virtual table + 4 triggers (ai/ad/au_delete/au_insert) + `query({ fts: "..." })` option. 26/26 tests pass via in-mem sqlite D1-shim. Adapter does not import from messaging/ — local MessagingRowInput/Output structural types preserve plugin invariant 1. Commit `c851e3f`] FTS5 + D1 messaging mode #mailroom-fts5
- [x] [done Wave 1 agent B: `src/messaging/sender-index.ts` with createSenderIndex(adapter, opts) → upsert/get/query/delete. Adapter-agnostic. 16/16 tests. Normalizes address lowercase+trim, list-unsubscribe https>mailto>raw extraction, spam_count on spam/quarantine labels, tag merge with bounce→bounce-source. Types kept local per invariant 3. Commit `c851e3f`] Sender index #mailroom-sender-index
- [x] [done Wave 1 agent C: `src/messaging/classifier.ts` pure `classify(item) → string[]` + `classifyAndMerge(item) → InboxItem`. Labels: newsletter/list/bulk/auto-reply/bounce with 4 independent bounce signals. 37/37 tests. Commit `c851e3f`] Header-based classifier #mailroom-classifier
- [x] [done Wave 1 agent D: extended `InboxFilter` with `fields_regex`/`text_regex`/`headers` (present/absent/regex). Evaluator: compile-once per invocation, invalid-regex safe-skip, case-insensitive default. filter-spec parses `<field>_regex:` + `headers.<name>:` + `text_regex:`. 39/39 tests (24 filter + 15 filter-spec). AND-semantics when both `from_email` and `from_email_regex` appear. Commit `c851e3f`] Regex operator in filter.ts + filter-spec #mailroom-regex
- [x] [done: cf-email detectAutoReply() emits 'auto-reply' (was 'auto'); aligns with classifier. 'ooo' stays distinct (specific subtype). 178/178 tests green after rename. Commit `ee4cab0`] Label naming standardization (cf-email auto → auto-reply) #label-naming
- [x] [done Wave 2 #4 (claude): HookVerdict ('accept'|'drop'|'quarantine'|InboxItem), HookContext, PreIngestHook/PostClassifyHook/PostStoreHook types. RegistrationHooks on InboxRegistration. addHook(name, stage, hook). email-handler refactored into 5 stages: parse → preIngest → built-in classify (opt-out via `classify: false`) → postClassify → sink fan-out → postStore. Quarantine verdict auto-tags 'quarantined' label. Throwing hooks caught + logged, pipeline continues. 10 new tests. Commit `8f36de9`] Hook interface in pipeline #mailroom-hooks
- [x] [done Wave 2 agent E: `src/messaging/unsubscribe.ts` with unsubscribeSender + addSenderTag. RFC 8058 one-click (POSTs `List-Unsubscribe=One-Click` form-urlencoded). mailto: falls through with ok=false + attempted_url echoed. Sender tagged unsubscribed even when URL missing. sender-index extended with setRecord. POST /inbox/:name/unsubscribe HTTP route via senderIndexFor resolver. 12/12 tests. Commit `8f36de9`] Unsubscribe surface #mailroom-unsubscribe
- [x] [done Wave 2 agent F: `src/messaging/quarantine.ts` — label-based (NOT sub-inbox) for zero-new-infrastructure + stable content-addressed ids. quarantineSink(inbox, opts) factory; quarantineItem(id)/restoreItem(id) using `_ingest({ force: true })`. listQuarantined() convenience. Consumers of main view must pass exclude_labels: ['quarantined']. 19/19 tests. Commit `8f36de9`] Quarantine sub-inbox + restore surface #mailroom-quarantine
- [x] [done: `GET /inbox/:name/export?format=jsonl|json&filter=<url-encoded-json>&include=body&limit=N` streams ND-JSON with body inflation from blobs adapter. Filter accepts full InboxFilter shape. ~140 LOC + 9 tests. Partial-export failures land as `{"_error":"..."}` last line. Raw + attachments inlining parked. Commit `e65cddf`] Bulk export endpoint #newsletter-export
- [x] [done: deploy/src/index.ts registers mailroom with postClassify hook that upserts into a per-inbox memory-backed senderIndex. senderIndexFor resolver wired into registerMessagingRoutes. Built-in classifier runs automatically. Commit `e65cddf`] Deploy hook wiring #mailroom-deploy
- [x] [done: wrangler deploy → version b32121f0-47e6-4e8d-a262-15ebe5342829 at smallstore.labspace.ai/*. Live-verified /health, /inbox/mailroom, /inbox/mailroom/export end-to-end. D1+R2 data persists across deploys] Production deploy #mailroom-deploy-live
- [*] **Session stats**: 228/228 messaging tests (+186 from start-of-day), 8 commits, 6 subagent dispatches, 0 merge conflicts across parallel work, 1 live production deploy, ~5400 net LOC insertions, 4 new briefs

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
