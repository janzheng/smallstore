# Smallstore — Pre-0.1.8 Audit

Focused sweep of this session's changes (new features + 7 bug fixes). Findings only — no fixes applied. Created 2026-04-17. **Wave 3 added 2026-04-18** covering paging + JSONL job-log feature (post-b24338f commits).

**Totals: 47 + 11 = 58 actionable findings across 8 agents / 3 waves**

> **Deployment context:** Public JSR library (`@yawnxyz/smallstore`) consumed by coverflow-v3 (production Deno service, multi-user). Treat race conditions, error-swallowing, and wiring failures as real.
> `#local-real` = affects every caller / every session.
> `#at-scale-only` = matters under concurrent / high-volume use.

---

## P1 — Regressions or Silent-Failure (strongly consider before 0.1.8)

### Regressions introduced by this session's fixes

- [x] **A001** [fixed: cached wrapper, sync fast-path once `_hydrated=true`, hydrate retries on rejection — also closes A100 + A101] LocalJsonAdapter wrapper forces `search()` to return Promise #bug-fix
- [x] **A002** [fixed: SqliteFtsSearchProvider now excludes `smallstore:meta:` and `smallstore:index:` keys via `AND key NOT LIKE ...` in the FTS query] SqliteFtsSearchProvider metadata-key leak #bug-fix
- [x] **A003** [fixed: clear() now awaits `provider.clear()` when present, falls back to per-key `await provider.remove()` for bare providers without clear()] MemoryAdapter clear() race with async providers #bug-fix

### Bug-fix misses (same bug class, site we didn't patch)

- [x] **A004** [fixed: `this.get(collectionPath, { raw: true })` at src/router.ts:707] deleteFromArray missing raw unwrap #bug-fix
- [x] **A005** [fixed: deno-fs now has the same cached-wrapper + lazy-hydrate pattern as LocalJson] deno-fs reopen-empty-index gap #bug-fix

### CSV adapter silent-data-loss (new feature this session)

- [x] **A006** [fixed: `if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)` in parseRows] CSV BOM stripping #bug-fix
- [x] **A007** [fixed: keyRows() throws `keyColumn "X" not found in CSV header` listing available columns] CSV keyColumn validation #bug-fix

### Search-provider root cause (now fixed)

- [x] **A008** [fixed: shared `isInternalKey()` in src/utils/path.ts covers meta/index/view/_viewdata/_cache prefixes; all 4 search providers guard at index() time + keep search-time filter as defense-in-depth] index()-time guard for internal keys #bug-fix

---

## P1 — MCP / HTTP security + data-loss (now fixed)

- [x] **A010** [fixed: optional SMALLSTORE_TOKEN bearer auth gates /_adapters + /_sync; open if unset for backwards compat] Auth on admin endpoints #bug-fix
- [x] **A011** [fixed: SYNC_OPTION_WHITELIST restricts to mode/conflictResolution/dryRun/prefix/syncId; baseline + baselineAdapter dropped] /_sync option passthrough #bug-fix
- [x] **A012** [fixed: 400 BadRequest when source === target] Self-sync guard #bug-fix
- [x] **A013** [fixed: in-process Map<sourceーtarget, Promise> prevents concurrent runs on the same pair; returns 409 Conflict if one is already in flight] Concurrent sync lock #bug-fix

---

## P2 — Medium (ship 0.1.8, track for follow-up)

### CacheManager LRU (new this session)

- [x] **A020** [fixed: TTL-expired get() now drops tracking + totalBytes alongside adapter.delete()] TTL drift #bug-fix
- [x] **A021** [fixed: entries + totalBytes snapshot taken before evict; restored on adapter.set() rejection] Torn state on set throw #bug-fix
- [ ] **A022** Concurrent `set()` on disjoint keys: both read pre-state `totalBytes`, both decide no eviction, both land → can exceed `maxBytes`. Double-evict in `evictUntilFits` can make `totalBytes` negative. `src/utils/cache-manager.ts:127-147` #race-condition #at-scale-only
- [ ] **A023** Oversized single entry (`bytesNeeded > maxBytes`) evicts everything then lands anyway — contract quietly violated. `src/utils/cache-manager.ts:158-172` #contract-violation #local-real
- [ ] **A024** `estimateSize` uses `.length` on JSON — UTF-16 code units, not UTF-8 bytes. Non-ASCII undercounts. `src/utils/cache-manager.ts:353-355` #contract-violation #at-scale-only
- [ ] **A025** Stats divergence with remote adapter (per-process hits/misses vs adapter-wide keys/size). `src/utils/cache-manager.ts:260-320` #contract-violation #at-scale-only

### retryFetch 304 handling (new this session)

- [x] **A030** [fixed: `CacheValidError` class exported from external-fetcher; router now uses `err instanceof CacheValidError` — survives message wrapping] Typed CacheValidError #bug-fix
- [ ] **A031** 304 without conditional headers bypasses the fetch but `fetchExternal` still throws CACHE_VALID — if `source.cacheKey` is unset, caller gets a bare sentinel error with no data. `src/utils/external-fetcher.ts:94-96`, `src/router.ts:3001-3007` #error-handling #local-real

### Search providers

- [x] **A040** [fixed: isInternalKey helper covers all 6 prefixes (meta/index/view/_views/_viewdata/_cache)] Filter prefix set #bug-fix
- [x] **A041** [fixed: index()-time guard means internal keys never reach zvec's vector store, so topk inflation is no longer possible] Zvec topk #bug-fix
- [ ] **A042** Router still drops `SearchOptions.filter` and `SearchOptions.path` (defined in types but not forwarded). Two-sided gap with `SearchProviderOptions` which also doesn't define them. `src/router.ts:1161`, `src/types.ts:1504-1621` #wiring #local-real
- [ ] **A043** `metric` pass-through is dead code — both `MemoryVectorSearchProvider` and `ZvecSearchProvider` use the metric baked in at construction; the forwarded per-call value is ignored. `src/router.ts:1170`, `src/search/memory-vector-provider.ts:144-150` #dead-code #local-real
- [ ] **A044** Collection scoping via `key.includes(collection)` is loose — `"docs"` matches `"old-docs"`, `"docs-archive"`. Amplified now that internal-key filter is the only guard. `src/search/memory-bm25-provider.ts:116`, `memory-vector-provider.ts:90`, `zvec-provider.ts:194` #logic-bug #at-scale-only

### CSV adapter (more)

- [x] **A050** [fixed: AbortController tied to each in-flight fetch; clear() aborts + resets] clear() aborts in-flight #bug-fix
- [x] **A051** [fixed: configurable `timeoutMs` (default 30s) via AbortSignal.timeout, composed with the clear() abort signal] Request timeout #bug-fix
- [x] **A052** [fixed: list() iterates the `keyed` Map instead of the raw rows — list/keys now in lockstep] list/keys consistency #bug-fix
- [ ] **A053** Duplicate header columns collapse silently (`@std/csv` uses headers as object keys). Real Google Sheets allow dup column names. `src/adapters/google-sheets-csv.ts:246-249` #data-loss #local-real
- [ ] **A054** Duplicate key values silently overwrite with no warning. `src/adapters/google-sheets-csv.ts:270` #data-loss #local-real
- [ ] **A055** Clock skew: `Date.now() - fetchedAt` can go negative on wall-clock correction → cache never refreshes. Use `performance.now()` or guard `age < 0`. `src/adapters/google-sheets-csv.ts:200-201` #logic-bug #at-scale-only
- [ ] **A056** No URL validation — accepts relative/file/http scheme. Failure surfaces only at first `get()`. `src/adapters/google-sheets-csv.ts:89-92` #ux #local-real
- [ ] **A057** `fetchImpl` is a public config field with no `@internal` marker — test code copy-pasted into production would silently run with a stub. `src/adapters/google-sheets-csv.ts:48,95` #ux #local-real
- [ ] **A058** `fetchAndParse` errors include the raw URL, which can contain auth query params. `src/adapters/google-sheets-csv.ts:227` #security #at-scale-only
- [ ] **A059** Capabilities over-claim: `writeLatency: 'high'` is misleading when writes throw; no `readOnly: true` flag. Router may pick this adapter for writes based on capabilities. `src/adapters/google-sheets-csv.ts:64` #contract-violation #local-real

### MCP server (more)

- [ ] **A070** Collection encoded with `encodeURIComponent` but not validated — empty-after-trim, `..`, or path-like inputs pass through. Keys are split on `/` and encoded per segment, so segments like `keys`/`query`/`search`/`metadata`/`schema` collide with sub-routes. `src/mcp-server.ts:82-88,86-87` #injection #local-real
- [ ] **A071** `sm_write` body → `JSON.stringify` has no guard for BigInt (throws), circular refs (throws), `undefined` fields (dropped), Date (lossy coerce). Errors surface as raw TypeError. `src/mcp-server.ts:67,230-237` #error-handling #local-real
- [ ] **A072** `SMALLSTORE_TOKEN` not validated — non-ASCII / CRLF throws `TypeError: Invalid header value` at first use. `src/mcp-server.ts:40,59` #ux #local-real
- [ ] **A073** No response-size ceiling on `sm_list` / `sm_query` / `sm_read` — full body buffered + re-stringified 2-space → can OOM. `src/mcp-server.ts:74,310` #resource-leak #at-scale-only
- [ ] **A074** `SMALLSTORE_URL` not validated at startup — mistyped scheme passes until first call. `src/mcp-server.ts:39` #ux #local-real
- [ ] **A075** No SIGTERM / stdin-close cleanup. `src/mcp-server.ts:318-319` #resource-leak #local-real
- [ ] **A076** Unknown tool returns `isError: true` inside `result` rather than JSON-RPC `error`. `src/mcp-server.ts:287-288,312-315` #contract-violation #local-real
- [ ] **A077** `sm_list` client-side limit mutates `r.body.total` — hides true count. `src/mcp-server.ts:256-260` #logic-bug #local-real
- [ ] **A078** `sm_list` drops `limit` from server URL — server pays full cost. `src/mcp-server.ts:249-253` #logic-bug #at-scale-only
- [ ] **A079** `sm_sync` schema names `source_collection` / `target_collection` but they're actually adapter names. Agent will misuse. `src/mcp-server.ts:173-174` #ux #local-real
- [ ] **A080** `sm_query` with empty filter returns whole collection silently — dangerous for Notion/Airtable at scale. `src/mcp-server.ts:264-270` #ux #at-scale-only
- [ ] **A081** `sm_read` with omitted key returns whole collection, no cap, no cost warning. `src/mcp-server.ts:82-88,222-228` #ux #at-scale-only

### MCP / HTTP (more)

- [x] **A090** [fixed: /_sync now returns `sync failed (<ErrorName>)` — no message body to leak tokens/paths] Error message sanitization #bug-fix
- [ ] **A091** Long `/_sync` holds connection — no job-ID / streaming. Client disconnect doesn't cancel the server operation. `serve.ts:174`, `src/sync.ts:769` #resource-leak #ux #local-real

### LocalJson / Memory / data-ops (more)

- [ ] **A100** LocalJson `_hydratePromise` never reset — first rejection poisons all future searches. `src/adapters/local-json.ts:83-92` #error-handling #local-real
- [ ] **A101** LocalJson `searchProvider` getter builds a fresh wrapper EVERY call — identity pins / WeakMaps break. `src/adapters/local-json.ts:94-106` #wiring #at-scale-only
- [x] **A102** [fixed: index() receives the cloned storedValue, so async providers (vector/zvec) can't observe caller mutations] MemoryAdapter clone on index #bug-fix
- [ ] **A103** `merge` default mode is `append` — callers expecting "replace dest" get doubled data on re-runs. `src/router.ts:1503-1568` #logic-bug #local-real #breaking-change
- [x] **A104** [fixed: null/undefined check instead of truthy check] merge() preserves scalar 0 / '' / false #bug-fix

---

## Wave 3 — Paging + JSONL job logs (2026-04-18, post-b24338f)

Three agents swept the new surface: `src/utils/job-log.ts`, `serve.ts` new `/_sync` routes, `src/mcp-server.ts` sync tools, and the adapter `listKeys()` implementations. 20 candidate findings reduced to 11 after verification — dropped false positives around Notion hasMore (actually correct), CF KV list_complete (handled), JSONL atomicity (PIPE_BUF applies to pipes not regular files), `.catch(()=>{})` (is the handler, not missing), and intentional error swallowing in `job-log.append()` (documented best-effort).

### P2 — Moderate (worth fixing before publish; none are stoppers)

- [x] **A200** [fixed: createJobLog moved INSIDE the IIFE so the outer handler has no awaits between has() and set(); lockPath is computed deterministically from jobId + dataDir so the response still includes logPath] Lock TOCTOU race in POST /_sync #race-condition #at-scale-only
- [x] **A224** [fixed: cursor accepted as stringified non-negative integer (round-trips the adapter's own output); non-numeric cursor throws rather than silently restarting at offset 0; adapter now emits `cursor: String(nextOffset)` when `hasMore` — tested with 2 new cases] SQLite listKeys cursor handling #wiring #local-real
- [ ] **A220** Cursor + offset precedence undocumented — Airtable/Upstash silently prefer `cursor` (offset-skip disabled when cursor is set via `!options.cursor` guard). Correct behavior, but no user-facing doc says so; passing both silently drops one. `src/adapters/airtable.ts:462`, `src/adapters/upstash.ts:375` #ux #local-real

### P3 — Low (cosmetic, at-scale-only, or UX polish)

- [ ] **A201** `summarizeJob` reads entire JSONL file via `Deno.readTextFile` (up to n=2000 events), so `GET /_sync/jobs?limit=50` reads 50 full files in parallel. Fine for small job counts; no rotation/cleanup so log dir grows forever. `src/utils/job-log.ts:108-123, 154-183` #resource-leak #at-scale-only
- [ ] **A203** `generateJobId` uses `Date.now()` truncated to seconds + 6-char `Math.random()` suffix — ~2^31 space per second, but burst-parallel requests in the same second have non-trivial collision probability (~P=1e-6 per 1k/sec). Consider `crypto.randomUUID()` or `crypto.getRandomValues()`. `src/utils/job-log.ts:42-46` #logic-bug #at-scale-only
- [ ] **A222** `parseInt("999x", 10)` returns 999 silently — `handleListKeys` validates `Number.isFinite(limit) && limit >= 0` but lets parseInt's leniency through, so "999x" is accepted as 999. Use `Number(limitRaw)` + `Number.isInteger` instead. `src/http/handlers.ts:436-443` #ux #local-real
- [ ] **A228** `?limit=0` passes validation and returns `{keys: [], hasMore: true, total: N}` — confusing UX (empty but hasMore). Either reject `limit === 0` or special-case to `hasMore: false`. `src/http/handlers.ts:438` #ux #local-real
- [ ] **A204** `sm_sync_jobs` / `GET /_sync/jobs` fires `Promise.all` over `summarizeJob` for up to `limit` jobs — 50 concurrent full-file reads at default. Acceptable at dev scale; cap parallelism if job dir grows. `serve.ts:269-271` #ux #at-scale-only
- [ ] **A242** Weak `(last as any).result` / `(last as any).message` casts in `summarizeJob` — only safe because caller contract writes exactly these fields in `completed`/`failed` events. Narrow with event-typed union instead. `src/utils/job-log.ts:179-180` #type-safety #local-real
- [ ] **A244** Default tail window hardcoded at 50 events in `tailJobLog(path, n=50)` and `summarizeJob` calls `tailJobLog(path, 2000)` — no const. Both are magic numbers for what "enough of the log" means. `src/utils/job-log.ts:106, 164` #magic-number #local-real
- [ ] **A243** `config.preset as any` cast in `serve.ts:75` — bypasses type safety on preset resolution; not a bug today but narrows the compiler's ability to catch a future preset-shape change. `serve.ts:75` #type-safety #local-real

### Verified fine (dropped from audit)

- Notion `listKeys` `hasMore` logic at `src/adapters/notion.ts:449` — checked the boolean composition, no off-by-one
- CloudflareKV `list_complete` handling — correctly breaks the outer loop at `src/adapters/cloudflare-kv.ts:418`
- JSONL write atomicity — single `write()` per line with O_APPEND is atomic at the kernel for regular files (PIPE_BUF only applies to pipes/FIFOs)
- Background-sync `.catch(() => {})` at `serve.ts:258` — this IS the rejection handler (intentional, error already in JSONL)
- `job-log.append()` error swallowing — documented best-effort: log-writing errors must not tear down the job

---

## Fix-First List (blocking 0.1.8 publish — my recommendation)

**Tier 0 — Regressions introduced this session (MUST fix):**
- [!] **A001** LocalJson wrapper makes search() async, breaks sync callers
- [!] **A003** MemoryAdapter.clear() doesn't await async provider.clear()

**Tier 1 — Same-class bugs our fixes missed:**
- [!] **A002** SqliteFtsSearchProvider still has the metadata leak
- [!] **A004** deleteFromArray missing `{ raw: true }`
- [!] **A005** deno-fs has the same reopen-empty-index gap as LocalJson

**Tier 2 — New-feature silent-data-loss:**
- [!] **A006** CSV BOM → zero rows
- [!] **A007** CSV missing keyColumn → zero rows

**Deferrable to 0.1.9 (real but not regressions):**
- A008 index() symmetric guard (root cause fix — larger change)
- A010-A013 MCP/HTTP security/sync issues (pre-existing auth deferral)
- A020-A091, A100-A104 (edge cases, ergonomics, at-scale-only)

**Wave 3 (paging + JSONL job-log feature, post-b24338f):**
- Nothing blocking. A200 (lock race) + A224 (SQLite cursor silently ignored) are worth a small patch before publish; everything else is at-scale-only / cosmetic / UX polish.

---

## Top Themes

1. **Partial-fix regressions** — Three times this session we patched N sites and missed N+1: search providers (missed SqliteFts), data-ops raw unwrap (missed deleteFromArray), LocalJson reopen (deno-fs has the same bug). Symptom: fix by symptom not by root cause. Lesson: grep for the pattern, not the named file.
2. **Search-time filter vs index-time guard** — The metadata-leak fix patches the read path. Internal keys still reach the index. A symmetric guard at `index()` + `remove()` is the real fix (A008).
3. **Concurrency gaps in new features** — CacheManager, CSV adapter, and `/_sync` all have disjoint-key / in-flight / concurrent-caller races. None are stoppers at single-user scale; all matter once coverflow-v3 concurrent users hit them.
4. **No auth / no validation on new HTTP endpoints** — `/_adapters` and `/_sync` assume trusted local caller. Fine for dev; tripwire if someone runs smallstore with a non-loopback bind.
5. **Error sentinels as strings** — `CACHE_VALID` is a string match; any wrapping breaks it. Throughout the code, prefer typed error classes.

---

## Stats

| Category | Count |
|----------|------:|
| logic-bug | 15 |
| contract-violation | 9 |
| error-handling | 6 |
| ux | 8 |
| data-loss | 6 |
| race-condition | 4 |
| security | 5 |
| resource-leak | 5 |
| wiring | 2 |
| dead-code | 2 |
| injection | 1 |
