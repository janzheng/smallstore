# Smallstore — Pre-0.1.8 Audit

Focused sweep of this session's changes (new features + 7 bug fixes). Findings only — no fixes applied. Created 2026-04-17. **Wave 3 added 2026-04-18** covering paging + JSONL job-log feature (post-b24338f commits).

**Totals: 47 + 11 = 58 findings, 58 resolved / 3 open as of 2026-04-28**
> 58 fixed + 1 won't-fix (A042-path deprecated). 3 deferrable remain — A022 (CacheManager disjoint-key race, at-scale-only), A025 (stats divergence with remote adapter, at-scale-only), A201 (JSONL growth/cleanup, at-scale-only — needs a rotation policy). A103 (merge default) fixed 2026-04-17. A203/A204/A220/A242/A243 closed 2026-04-28 in cleanup commit 5393ef9.

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
- [x] **A023** [fixed: loud `console.warn` when entry exceeds maxCacheSize — "caching anyway, but maxCacheSize enforcement is effectively bypassed for this key" so operators can raise the cap or shard, src/utils/cache-manager.ts:176-180] Oversized single entry #contract-violation #local-real
- [x] **A024** [fixed: SIZE_ENCODER = new TextEncoder(); estimateSize returns encode(json).byteLength — proper UTF-8 sizing] estimateSize UTF-16 vs UTF-8 #contract-violation #at-scale-only
- [ ] **A025** Stats divergence with remote adapter (per-process hits/misses vs adapter-wide keys/size). `src/utils/cache-manager.ts:260-320` #contract-violation #at-scale-only

### retryFetch 304 handling (new this session)

- [x] **A030** [fixed: `CacheValidError` class exported from external-fetcher; router now uses `err instanceof CacheValidError` — survives message wrapping] Typed CacheValidError #bug-fix
- [x] **A031** [fixed: 304 now throws `CacheValidError` (not bare `Error('CACHE_VALID')`) so `err instanceof CacheValidError` checks in router survive message wrapping, src/utils/external-fetcher.ts:107-111] 304 typed sentinel #error-handling #local-real

### Search providers

- [x] **A040** [fixed: isInternalKey helper covers all 6 prefixes (meta/index/view/_views/_viewdata/_cache)] Filter prefix set #bug-fix
- [x] **A041** [fixed: index()-time guard means internal keys never reach zvec's vector store, so topk inflation is no longer possible] Zvec topk #bug-fix
- [x] **A042-filter** [fixed: router applies MongoDB-style filter post-search via matchesFilter at src/router.ts:1242-1250, hydrating only the matched results] SearchOptions.filter forwarded #wiring #local-real
- [x] **A042-path** [won't-fix: `SearchOptions.path` is marked `@deprecated Unused` in src/types.ts:1539 — "the collection path passed to router.search() already scopes results; there's no sub-path below collection for search. Remove in a future major."] SearchOptions.path forwarding #wiring #local-real
- [x] **A043** [documented as intentional: comment at src/router.ts:1214-1217 explains metric is baked in at provider construction and a per-call value is ignored] metric pass-through dead code #dead-code #local-real
- [x] **A044** [fixed: all 3 providers use keyMatchesCollection() (strict prefix match) at src/utils/path.ts instead of key.includes(collection). Verified at memory-bm25-provider.ts:119, memory-vector-provider.ts:92, zvec-provider.ts:194] Collection scoping loose match #logic-bug #at-scale-only

### CSV adapter (more)

- [x] **A050** [fixed: AbortController tied to each in-flight fetch; clear() aborts + resets] clear() aborts in-flight #bug-fix
- [x] **A051** [fixed: configurable `timeoutMs` (default 30s) via AbortSignal.timeout, composed with the clear() abort signal] Request timeout #bug-fix
- [x] **A052** [fixed: list() iterates the `keyed` Map instead of the raw rows — list/keys now in lockstep] list/keys consistency #bug-fix
- [x] **A053** [fixed: parses raw headers first to detect collisions; throws descriptive error listing dup names at src/adapters/google-sheets-csv.ts:309-323] Duplicate header columns collapse silently #data-loss #local-real
- [x] **A054** [fixed: once-per-load warning when duplicate keys collapse — last-write-wins with rowCount vs keyCount diff logged, src/adapters/google-sheets-csv.ts:375] Duplicate key values silently overwrite #data-loss #local-real
- [x] **A055** [fixed: `age >= 0 && age <= refreshMs` — negative age (wall-clock rollback) treated as expired so cache auto-refreshes, src/adapters/google-sheets-csv.ts:228-231] Clock skew guard #logic-bug #at-scale-only
- [x] **A056** [fixed: `new URL(config.url)` validates at construction; only http/https scheme accepted, src/adapters/google-sheets-csv.ts:110] URL validation #ux #local-real
- [x] **A057** [fixed: `@internal` JSDoc marker + warning "Intended for testing only; leaving this set in production swaps the real network for the stub" at src/adapters/google-sheets-csv.ts:51-57] fetchImpl @internal marker #ux #local-real
- [x] **A058** [fixed: error messages use safeUrl = this.url.split('?')[0] — strips query auth params, src/adapters/google-sheets-csv.ts:273] Auth params in error URL #security #at-scale-only
- [x] **A059** [fixed: `readOnly: true` capability flag added, src/adapters/google-sheets-csv.ts:88] Capabilities over-claim #contract-violation #local-real

### MCP server (more)

- [x] **A070** [fixed: validateCollection() rejects empty-after-trim, '.', '..', slashes, and reserved sub-route segments (keys/query/search/metadata/schema/slice/split/deduplicate) at src/mcp-server.ts:154-167] Collection encoding/validation #injection #local-real
- [x] **A071** [fixed: JSON.stringify wrapped in try/catch with clear error "sm_write/sm_query body is not JSON-serializable" at src/mcp-server.ts:94-102] sm_write body stringify guard #error-handling #local-real
- [x] **A072** [fixed: SMALLSTORE_TOKEN rejected at startup if contains CR/LF; fails fast with clear error, src/mcp-server.ts:64-68] Token CRLF injection guard #ux #local-real
- [x] **A073** [fixed: MAX_RESPONSE_BYTES (default 10MB, configurable via SMALLSTORE_MAX_RESPONSE_BYTES) enforced by readCapped() at src/mcp-server.ts:47-51,116,124+] Response-size ceiling #resource-leak #at-scale-only
- [x] **A074** [fixed: new URL(RAW_URL) at startup; rejects non-http(s) schemes with fail-fast exit, src/mcp-server.ts:52-61] URL validation #ux #local-real
- [x] **A075** [fixed: SIGTERM + SIGINT handlers close transport/server gracefully, src/mcp-server.ts:479-480] Graceful shutdown #resource-leak #local-real
- [x] **A076** [fixed: unknown tool throws McpError(MethodNotFound) which bubbles as proper JSON-RPC error -32601, src/mcp-server.ts:431-433,461] Unknown tool RPC error #contract-violation #local-real
- [x] **A077** [fixed: sm_list now just returns r.body — no client-side mutation of total, src/mcp-server.ts:372] sm_list total mutation #logic-bug #local-real
- [x] **A078** [fixed: limit/offset/cursor all passed to server URL in sm_list, src/mcp-server.ts:366-369] sm_list drops limit from URL #logic-bug #at-scale-only
- [x] **A079** [fixed: renamed to source_adapter/target_adapter with clear descriptions at src/mcp-server.ts:259-282] sm_sync schema names mismatched adapter vs collection #ux #local-real
- [x] **A080** [fixed: sm_query now rejects empty/missing filter with clear error at src/mcp-server.ts:381-384 — directs caller to sm_list instead] Empty-filter scan footgun #ux #at-scale-only
- [x] **A081** [fixed: tool + argument descriptions warn "Omitting `key` reads the whole collection, which can be expensive on Notion/Airtable/Sheets — prefer passing a specific key or using sm_list/sm_query" at src/mcp-server.ts:185,190] sm_read cost warning #ux #at-scale-only

### MCP / HTTP (more)

- [x] **A090** [fixed: /_sync now returns `sync failed (<ErrorName>)` — no message body to leak tokens/paths] Error message sanitization #bug-fix
- [x] **A091** [fixed: POST /_sync now returns 202 + jobId in background mode; JSONL log at <dataDir>/jobs/<jobId>.jsonl; GET /_sync/jobs + /_sync/jobs/:id; ?wait=true for sync; MCP sm_sync_status + sm_sync_jobs] Long /_sync connection / no job-ID #resource-leak #ux #local-real

### LocalJson / Memory / data-ops (more)

- [x] **A100** [fixed: hydrate() catch block sets `this._hydratePromise = null` before re-throwing — next call retries instead of poisoning all future searches, src/adapters/local-json.ts:100-103] LocalJson hydrate-promise poisoning #error-handling #local-real
- [x] **A101** [fixed: searchProvider getter caches the wrapper in `this._searchProviderWrapper` and returns the same instance on subsequent calls, src/adapters/local-json.ts:87,110] LocalJson wrapper identity #wiring #at-scale-only
- [x] **A102** [fixed: index() receives the cloned storedValue, so async providers (vector/zvec) can't observe caller mutations] MemoryAdapter clone on index #bug-fix
- [x] **A103** `merge` default mode is `append` — callers expecting "replace dest" get doubled data on re-runs. **FIXED 2026-04-17 in commit `291617d`** — flipped `overwrite: false` → `overwrite: true` in `router.ts` `merge()` defaults; added explanatory comment. **2026-04-26**: also annotated `MergeOptions.overwrite` JSDoc in `types.ts` to surface the default in the public contract. `src/router.ts:1651-1660`, `src/types.ts:2110-2111` #logic-bug #local-real #breaking-change
- [x] **A104** [fixed: null/undefined check instead of truthy check] merge() preserves scalar 0 / '' / false #bug-fix

---

## Wave 3 — Paging + JSONL job logs (2026-04-18, post-b24338f)

Three agents swept the new surface: `src/utils/job-log.ts`, `serve.ts` new `/_sync` routes, `src/mcp-server.ts` sync tools, and the adapter `listKeys()` implementations. 20 candidate findings reduced to 11 after verification — dropped false positives around Notion hasMore (actually correct), CF KV list_complete (handled), JSONL atomicity (PIPE_BUF applies to pipes not regular files), `.catch(()=>{})` (is the handler, not missing), and intentional error swallowing in `job-log.append()` (documented best-effort).

### P2 — Moderate (worth fixing before publish; none are stoppers)

- [x] **A200** [fixed: createJobLog moved INSIDE the IIFE so the outer handler has no awaits between has() and set(); lockPath is computed deterministically from jobId + dataDir so the response still includes logPath] Lock TOCTOU race in POST /_sync #race-condition #at-scale-only
- [x] **A224** [fixed: cursor accepted as stringified non-negative integer (round-trips the adapter's own output); non-numeric cursor throws rather than silently restarting at offset 0; adapter now emits `cursor: String(nextOffset)` when `hasMore` — tested with 2 new cases] SQLite listKeys cursor handling #wiring #local-real
- [x] **A220** [fixed: documented at the type level in `src/types.ts` `KeysPageOptions` JSDoc + at both adapter call sites (airtable.ts + upstash.ts). Commit 5393ef9.] Cursor + offset precedence undocumented #ux #local-real

### P3 — Low (cosmetic, at-scale-only, or UX polish)

- [ ] **A201** `summarizeJob` reads entire JSONL file via `Deno.readTextFile` (up to n=2000 events), so `GET /_sync/jobs?limit=50` reads 50 full files in parallel. Fine for small job counts; no rotation/cleanup so log dir grows forever. `src/utils/job-log.ts:108-123, 154-183` #resource-leak #at-scale-only
- [x] **A203** [fixed: `crypto.getRandomValues(Uint8Array(6))` → 12 hex chars (~48 bits), replaces the prior 6-char Math.random base36 slice. Commit 5393ef9.] generateJobId collision risk #logic-bug #at-scale-only
- [x] **A222** [fixed: `Number(raw)` + `Number.isInteger()` rejects "999x" as NaN; parseInt's loose parsing removed at src/http/handlers.ts:436-443] parseInt leniency #ux #local-real
- [x] **A228** [fixed: limit must be a *positive* integer (`limit <= 0` rejected with 400) so `?limit=0` no longer returns empty-keys-with-hasMore:true confusion, src/http/handlers.ts:438] `?limit=0` UX #ux #local-real
- [x] **A204** [fixed: `SUMMARIZE_CONCURRENCY = 8`, chunked sequential await in `serve.ts:282-298`. Commit 5393ef9.] /_sync/jobs unbounded summarizeJob fan-out #ux #at-scale-only
- [x] **A242** [fixed: introduced `JobCompletedEvent` + `JobFailedEvent` narrowing types; summarizeJob branches via the typed shape instead of `as any`. `src/utils/job-log.ts:18-46,173-194`. Commit 5393ef9.] Weak as-any casts in summarizeJob #type-safety #local-real
- [x] **A244** [fixed: extracted `DEFAULT_TAIL_EVENTS = 50` and `SUMMARY_SCAN_EVENTS = 2000` exported constants with JSDoc explaining the trade-off; tailJobLog default references DEFAULT_TAIL_EVENTS, summarizeJob calls tailJobLog(path, SUMMARY_SCAN_EVENTS), src/utils/job-log.ts:102-109] Magic tail/summary window constants #magic-number #local-real
- [x] **A243** [fixed: runtime check against the `PresetName` union in `serve.ts:75-95`; invalid preset names now throw at startup with the allowed list instead of being silently passed through. Commit 5393ef9.] `config.preset as any` cast bypassed type safety #type-safety #local-real

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
