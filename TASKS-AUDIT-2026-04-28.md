# Smallstore + Mailroom — Serious-Bug Audit (2026-04-28) [REMEDIATED 2026-04-28]

> **STATUS: 41/41 closed.** All findings shipped in 14 commits on the same day the audit ran. See `.brief/2026-04-28-security-audit.md` for the closing brief with the per-commit mapping; `TASKS-SECURITY.md` for the by-theme execution plan; `git log --oneline 1a781bc..02e9c7f` for the canonical commit chain. B013 was downgraded to "verified non-issue" (auditor misread the existing dedup-gate ordering). Below: the original raw findings list with bulk-marked `[x]` status. The detail (file:line, why-it-matters) is preserved as it was at audit time — not rewritten with post-fix descriptions.

Two-wave parallel sweep across mailroom (`src/messaging/`) and smallstore core (`src/router.ts`, `src/sync.ts`, adapters, peers, HTTP, deploy wiring). 8 agents read ~22k lines across 60+ files. **158 raw findings; 41 substantive after dedup + verification.** Findings list at audit time — every item closed by the commits referenced above.

> **Deployment context:** Public JSR library (`@yawnxyz/smallstore`) consumed by coverflow-v3 + the smallstore Worker at `smallstore.labspace.ai`. Single-tenant today, multi-user-shaped. `#local-real` = affects every session today. `#at-scale-only` = matters under concurrent / high-volume use.

> **Numbering:** This sweep uses `B`-prefixed IDs (B001-B041) to avoid colliding with the existing `A001-A244` audit history.

---

## 🚨 Fix-First List

**Tier 0 — Production auth bypass / data leak (fix immediately):**
- [x] [shipped 2026-04-28 — see git log] **B001** Empty `SMALLSTORE_TOKEN` silently disables ALL auth on /api, /inbox, /admin, /peers `deploy/src/index.ts:204-211` #auth-gap #local-real
- [x] [shipped 2026-04-28 — see git log] **B002** Peer auth `token_env` accepts ANY env var name — registering a peer with `token_env: "SMALLSTORE_TOKEN"` + attacker URL exfiltrates the master token on every `/peers/:name/fetch` `src/peers/http-routes.ts:317`, `src/peers/proxy.ts:101` #env-leak #defense-in-depth
- [x] [shipped 2026-04-28 — see git log] **B003** Webhook HMAC `secret_env` has the same unrestricted lookup — registering a webhook peer with `secret_env: "SMALLSTORE_TOKEN"` leaks the master token via the resolver, `deploy/src/index.ts:475-476`, `src/messaging/http-routes.ts:1463` #env-leak #defense-in-depth

**Tier 1 — Data integrity / corruption masked:**
- [x] [shipped 2026-04-28 — see git log] **B004** Inbox `_ingest` writes item then index in two un-rolled-back ops — crash between line 319 and 320 leaves an orphan item that won't appear in list/query `src/messaging/inbox.ts:319-320` #data-loss #local-real
- [x] [shipped 2026-04-28 — see git log] **B005** D1 adapter silently returns the raw string on `JSON.parse` failure instead of throwing — caller expecting an object receives a string, type contract broken `src/adapters/cloudflare-d1.ts:286-290` #data-loss #local-real
- [x] [shipped 2026-04-28 — see git log] **B006** Routing glob converts `*` to `.*` without first escaping regex metachars — pattern `cache.temp` matches `cacheXtemp`, `cache!temp`, etc. → wrong adapter receives data `src/router.ts:2108` #logic-bug #local-real
- [x] [shipped 2026-04-28 — see git log] **B007** Auto-confirm GET uses `redirect: 'follow'` — initial URL is `isSafeUrl()`-checked but the redirect target is not, so a hostile newsletter sender can 302 to an unsubscribe URL or out-of-allowlist host `src/messaging/auto-confirm.ts:281` #security #local-real

**Tier 2 — Pipeline reliability:**
- [x] [shipped 2026-04-28 — see git log] **B008** Rules-hook does not wrap `evaluateFilter()` in try/catch — a single malformed user-supplied filter (regex syntax error, etc.) crashes the entire ingest pipeline for every subsequent email `src/messaging/rules.ts:283-293`, `src/messaging/rules-hook.ts:50-75` #error-handling #local-real
- [x] [shipped 2026-04-28 — see git log] **B009** Classifier exceptions are caught + logged but dispatch continues — `postClassify` hooks (e.g., `confirm-detect`, `auto-confirm`) silently see items missing the `newsletter` label they gate on, so confirmation links never get processed `src/messaging/dispatch.ts:116-125` #error-handling #local-real
- [x] [shipped 2026-04-28 — see git log] **B010** Webhook 500 leaks the configured env var name to an unauthenticated caller: `"HMAC secret env \"MY_SECRET\" not set"` exposes the Worker's env schema to anyone POSTing to `/webhook/<peer>` `src/messaging/http-routes.ts:1465` #security #local-real

---

## P1 — High (fix before more multi-tenant or external traffic)

### Auth / secrets

- [x] [shipped 2026-04-28 — see git log] **B001** Empty bearer token bypasses all auth — `if (!token) return next()` opens routes when `SMALLSTORE_TOKEN=""` (CI mistake, accidental var clobber, etc.). Should reject empty or whitespace-only tokens at boot, or fail-closed on the request `deploy/src/index.ts:204-211` #auth-gap #local-real
- [x] [shipped 2026-04-28 — see git log] **B002** No env-var allowlist on peer auth — `resolvePeerAuth` looks up `env[auth.token_env]` for any string the peer-create caller supplies. Same for `value_env`, `user_env`, `pass_env`. Today only the master-token holder can register peers, so this is defense-in-depth — but the JSR library docstring says "secrets via env-ref, never inline" implying safety the code does not provide. Add a static allowlist of safe names (e.g., `TF_*`, `NOTION_*`) and reject `SMALLSTORE_*` `src/peers/http-routes.ts:317-342`, `src/peers/proxy.ts:90-157` #env-leak #defense-in-depth
- [x] [shipped 2026-04-28 — see git log] **B003** Same unrestricted env-var resolver for webhook HMAC — `resolveHmacSecret(envName) => env[envName]` accepts anything. A webhook peer with `secret_env: "SMALLSTORE_TOKEN"` would HMAC-sign with the master token; combined with B002 a single peer registration leaks both the bearer token and any HMAC secret `deploy/src/index.ts:475-476` #env-leak #defense-in-depth
- [x] [shipped 2026-04-28 — see git log] **B010** HMAC error reveals env-var name to unauthenticated caller — `c.json({ error: \`HMAC secret env "${secretEnv}" not set\` }, 500)` returns env schema details to anyone posting to `/webhook/<peer>`. Return a generic "configuration error" without the var name `src/messaging/http-routes.ts:1465` #security #local-real
- [x] [shipped 2026-04-28 — see git log] **B011** Bearer-token compare is non-timing-safe — `m[1] !== token` short-circuits at first mismatched char. Practically hard to exploit over HTTPS but cryptographically incorrect; switch to a constant-time compare `deploy/src/index.ts:208`, `src/http/middleware/mod.ts:269` #security #at-scale-only

### Inbox / pipeline

- [x] [shipped 2026-04-28 — see git log] **B004** _ingest item-then-index race — item set at line 319 succeeds, `appendIndex` at line 320 fails (network blip, D1 timeout, CPU budget) → item exists in storage but is invisible to list/query. No rollback path. Fix: set index first then item, or merge into a single atomic write where the adapter supports it `src/messaging/inbox.ts:319-320` #data-loss #local-real
- [x] [shipped 2026-04-28 — see git log] **B009** Classifier throw → silent pipeline degradation — `dispatch.ts` catches classifier exceptions and continues. But every postClassify hook gates on classifier-applied labels (`newsletter`, `list`, `bounce`). Throw → no labels → confirm-detect, auto-confirm, sender-index all see an unlabelled item and skip. The user's confirmation flow silently breaks `src/messaging/dispatch.ts:116-125` #error-handling #local-real
- [x] [shipped 2026-04-28 — see git log] **B008** Rules engine throws → ingest pipeline crashes — neither `evaluateFilter` (rules.ts:284) nor `rulesStore.apply` (rules-hook.ts) is try/wrapped. A user creates a rule with a malformed regex or `$regex` payload that makes `RegExp` throw → from that moment on every incoming email crashes at the rules hook → mailroom is dead until the bad rule is deleted. Fix: wrap evaluateFilter in try/catch, return "no match" with logged warning `src/messaging/rules.ts:283-293`, `src/messaging/rules-hook.ts:50-75` #error-handling #local-real
- [x] [shipped 2026-04-28 — see git log] **B012** Sender-index runs even on dropped/quarantined items — `senderUpsertHook` is `postClassify`, but preIngest hooks can already mark the item as dropped/quarantined. The hook still upserts, inflating sender stats with mail the user never saw. Either guard on `labels.includes('quarantined')` or move the upsert later in the pipeline `deploy/src/index.ts:351-358` #logic-bug #local-real
- [x] [verified non-issue: dedup gate already precedes blob writes; auditor misread] **B013** `_ingest` blob writes happen before the dedup check on retry — second ingest with same id + same blobs re-writes blobs (line 314-317) then returns the existing item (line 307 fast-path is reached only on the dedup branch with `force=false`, but blobs were already written above the dedup gate). Two re-deliveries of the same email → wasted R2 PUTs `src/messaging/inbox.ts:305-321` #logic-bug #local-real
- [x] [shipped 2026-04-28 — see git log] **B014** `_ingest` index dedup is TOCTOU — `appendIndex` reads index, checks `entries.some(e => e.id === entry.id)`, writes. Two concurrent ingests of the same id (rare but possible on retry storms) both see "not present" and produce a duplicate entry `src/messaging/inbox.ts:336-342` #race-condition #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B015** Auto-confirm cache TTL gap — patterns are cached for 30s; deletes via `/admin/auto-confirm/senders` take up to 30s to propagate. During that window, allowlisted-but-just-revoked senders still get auto-confirmed. Add explicit cache invalidation on store mutations `src/messaging/auto-confirm-senders.ts`, `src/messaging/auto-confirm.ts:230-250` #race-condition #local-real

### Auto-confirm safety

- [x] [shipped 2026-04-28 — see git log] **B007** `redirect: 'follow'` on auto-confirm fetch — `isSafeUrl()` checks the initial URL (HTTPS, named host, no `unsubscribe` in path), but the fetch follows redirects without re-validation. A malicious newsletter sends `https://legit-publisher.com/confirm` that 302s to `https://legit-publisher.com/unsubscribe?id=...`, or to a third-party tracker. Fix: `redirect: 'manual'` + walk up to N redirects, re-validating each hop `src/messaging/auto-confirm.ts:281` #security #local-real
- [x] [shipped 2026-04-28 — see git log] **B016** Confirm-detect picks first non-unsubscribe URL on a "confirm" line — but the heuristic line-search doesn't validate the URL is the link inside an actual `<a>` tag. A crafted email with `confirm your subscription <a href="https://attacker.com">click</a>` plus a benign-looking second URL on the same line could swap the extracted target. Combined with B007 + an allowlist sender, auto-confirm follows the attacker URL `src/messaging/confirm-detect.ts:182-225` #security #local-real

### Routing / data correctness

- [x] [shipped 2026-04-28 — see git log] **B006** Routing glob unescaped metachars — `pattern.replace(/\*/g, '.*')` only escapes `*`. A configured pattern like `cache.temp` compiles to `/^cache.temp$/` which matches `cacheXtemp`, `cache!temp`, etc. Same for `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `^`, `$`, `|`, `\`. Today's mounts (`mailroom/*`, `blobs/*`) are safe; any future pattern with a literal `.` (e.g., `users.profile/*`) silently matches the wrong collections `src/router.ts:2108` #logic-bug #local-real
- [x] [shipped 2026-04-28 — see git log] **B005** D1 silent JSON-parse fallback — when `JSON.parse(result.value)` throws, the adapter returns the raw string instead. Callers receive a `string` where they expected `object` and either crash on `.foo` access or silently store wrong-shaped data. Should throw a typed `CorruptValueError` (or similar) instead `src/adapters/cloudflare-d1.ts:286-290` #data-loss #local-real
- [x] [shipped 2026-04-28 — see git log] **B017** Routing pattern order is insertion-order dependent — `Object.entries(rules)` iteration order is spec-stable in ES2020+ but the routing config is JSON-parsed, so any reorder by a serializer changes the first-match-wins outcome. Sort patterns by specificity (longest literal prefix first) before matching `src/router.ts:2087` #logic-bug #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B018** Routing fallback inconsistent — `set()` routes via `routeData(fullPath)` then `routeData(parsed.collection)`. `append()` adds a third try: `parsed.collection + '/'` to match mount patterns. So `set('foo', ...)` and `append('foo', ...)` can pick different adapters when a `foo/*` mount exists `src/router.ts:681-698` vs `:2001-2002` #logic-bug #at-scale-only

### Cron / mirror correctness

- [x] [shipped 2026-04-28 — see git log] **B019** Concurrent mirror runs not mutex'd — cron fires `runMirror()` every 30 min; `POST /admin/inboxes/:name/mirror` calls the same function. Two simultaneous runs both PUT `${prefix}slug.md` to the peer with potentially different content (note ordering, recent.md window) → last-write-wins on the peer, with the loser silently overwritten `src/messaging/mirror.ts:119-268` #race-condition #local-real
- [x] [shipped 2026-04-28 — see git log] **B020** Mirror prune races mid-write — `runMirror` lists peer directory then deletes orphans. If a concurrent cron tick is mid-PUT for slug `foo`, prune may delete `foo.md` between the lister's snapshot and PUT completion. Either disable prune when another mirror is in flight, or protect with a peer-side marker file `src/messaging/mirror.ts:236-263` #race-condition #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B021** Mirror `Promise.all(items.map(...))` unbounded per slug — a newsletter with 10k items spawns 10k concurrent R2 GETs. Cap concurrency (10-20 in-flight) to avoid request-budget blow-ups + memory spikes `src/messaging/mirror.ts:194-203` #resource-leak #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B022** `recent.md` size unbounded — renders all items hydrated within `recent_window_days`. With a 365-day window + 50k items the file blows past CF's 30 MB response cap. Cap by item count first, then by size budget `src/messaging/mirror.ts:227` #budget-overrun #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B023** Unread-sweep page-cap check is page-level, not item-level — `runUnreadSweep` increments `matched` per page but only checks the cap after iterating the entire page. With `hardCap=10` and a 500-item page, all 500 items are processed before `capped=true` is set. Move the check inside the inner loop `src/messaging/unread-sweep.ts:76-89` #budget-overrun #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B024** Rules retroactive apply has 10k-page ceiling but no cursor-non-advancement detection — if `inbox.query()` returns a stable cursor (bug or data corruption signaling more), the loop spins until 10k page calls × per-page latency burns the cron's CPU budget. Detect cursor non-advance and break `src/messaging/rules.ts:349-373` #budget-overrun #at-scale-only

---

## P2 — Medium (track, address before sustained operation)

### Mailroom hooks

- [x] [shipped 2026-04-28 — see git log] **B025** Forward-detect email regex permissive — `[A-Z0-9._%+\-]+@...` allows `+` and percent-encoded chars in local-part. A malicious forward can inject `attacker+newsletter%40example.com` as `original_from_email`, and downstream sender-aliases / auto-confirm key off that field. Tighten the regex `src/messaging/forward-detect.ts:693` #injection #local-real
- [x] [shipped 2026-04-28 — see git log] **B026** Sender-index upsert is read-modify-write without coordination — concurrent ingests from the same sender both read `count`, increment, write. One increment lost per collision. Switch to append-only counter rows or an adapter-level transaction `src/messaging/sender-index.ts:188-221` #race-condition #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B027** Confirm-detect heuristic misfires on transactional mail — pattern `/\bverify\s+(your\s+)?(email|...)/i` matches both "confirm your subscription" and account-verification mail. Today's `requireNewsletterLabel` guard mostly covers it; if a classifier mistags a transactional mail as `newsletter`, the false positive leaks through. Tighten the subject pattern `src/messaging/confirm-detect.ts:93-103` #logic-bug #local-real
- [x] [shipped 2026-04-28 — see git log] **B028** Quarantine restore re-stamps `unread` — `quarantineItem` calls `_ingest({force: true})` which re-runs the postClassify pipeline including `stampUnreadHook`. If the user previously marked the item read, restoring from quarantine resurrects the `unread` label. Either skip stamp on force-ingest or honor a "user-marked-read" sentinel `src/messaging/unread.ts:59-93`, `src/messaging/quarantine.ts:135` #logic-bug #local-real
- [x] [shipped 2026-04-28 — see git log] **B029** Sender-aliases first-match-wins glob without specificity ordering — broad patterns added first eat narrower ones added later. Document the semantics or sort patterns by literal-prefix length before matching `src/messaging/sender-aliases.ts:182-189` #logic-bug #local-real

### HTTP / channels

- [x] [shipped 2026-04-28 — see git log] **B030** RSS entity-expansion cap is 1,000,000 — three orders of magnitude above legitimate feed needs. Even with DTD recursive entities disabled by default, a malicious feed crafted near the cap can chew CPU budget. Drop to ~50,000 `src/messaging/channels/rss.ts:216` #xxe #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B031** RSS GUID collision = silent drop — dedup key is `sha256(feed_url + ':' + (guid ?? link ?? title ?? ''))`. Two distinct feed entries that both lack guid/link/title (or both reuse same guid) collide; second one is silently skipped + counted in `items_dropped`. Add an `items_collided` counter and surface in logs `src/messaging/channels/rss.ts:290-301` #data-loss #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B032** Markdown export does not escape backticks / frontmatter delimiters in subject — a subject line containing `---` injects YAML frontmatter into the rendered file; backticks open inline-code blocks. Sanitize subjects before interpolating into markdown `src/messaging/newsletter-markdown.ts:138,214,301` #injection #local-real
- [x] [shipped 2026-04-28 — see git log] **B033** Proxy `path` query param feeds raw into `peer.url + path` — `URL` constructor catches obvious bypasses, but if `URL` parsing fails the code "bails back to raw string" (proxy.ts:217) and CRLF in `path` could inject headers when later passed to `fetch`. Validate `path` against a strict char class before use `src/peers/proxy.ts:209-217`, `src/peers/http-routes.ts:168` #injection #local-real

### Adapters

- [x] [shipped 2026-04-28 — see git log] **B034** D1 `clear()` fans out unbounded `Promise.all` deletes — 10k batches × 100 deletes = 10k concurrent statements. Will hit D1 rate limits + saturate the connection pool. Use a semaphore or sequential batches `src/adapters/cloudflare-d1.ts:489` #resource-leak #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B035** D1 `ensureTable` race — `migrated` boolean is non-atomic; two concurrent first writes both pass the check and both run the migration sequence. `CREATE TABLE IF NOT EXISTS` is idempotent but the messaging-mode migrations table writes a UNIQUE row per migration step, which collides on the second runner. Memoize as a `Promise<void>` instead of a boolean `src/adapters/cloudflare-d1.ts:188-217` #race-condition #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B036** D1 `list()` with offset = full keys-scan in memory — implementation calls `keys()` (full table scan) then slices. With a 100k-row table + offset 50k, every list call loads 100k keys to discard half. Use `LIMIT/OFFSET` in SQL directly `src/adapters/cloudflare-d1.ts:681-684` #resource-leak #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B037** Memory adapter `keys()` does O(n) TTL scan on every call — no periodic eviction; expired entries pile up until manually removed. With 1M in-memory entries each `keys()` is O(N). Run a sweep on a timer (or amortized in `set`) `src/adapters/memory.ts:165-183` #resource-leak #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B038** R2 `get()` double-cast `as unknown as Response` — type-confused if `httpRequest` ever returns a non-Response wrapper, the `.text()` call crashes. Tighten the wrapper type and remove the double cast `src/adapters/cloudflare-r2.ts:332` #type-safety #local-real

### Misc

- [x] [shipped 2026-04-28 — see git log] **B039** `appHandle` lazy-init is not double-init-safe — two cold-start requests both call `buildApp()`. `registerChannel` already-registered exception is caught, but the duplicate `Hono` app, registry, peerStore, etc. are constructed and discarded. Memoize as a `Promise<AppHandle>` `deploy/src/index.ts:585-588` #race-condition #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B040** `seedAutoConfirmFromEnv` fire-and-forget on boot — first ~300ms after cold start the auto-confirm cache is empty, so allowlisted senders get manual-confirm treatment until D1 returns. Document or `await` it before serving the first request `deploy/src/index.ts:339-347` #logic-bug #at-scale-only
- [x] [shipped 2026-04-28 — see git log] **B041** Cursor decode trusts JSON shape — `decodeCursor` parses arbitrary JSON from a base64 query param without validating `at` is an ISO date or `id` is bounded. Malicious cursor can cause a query for an absurd date range or include a 10MB id. Validate shape after parsing `src/messaging/cursor.ts:36-51` #type-safety #local-real

---

## Top Themes

1. **Defense-in-depth on env-var lookups is missing** (B002, B003, B010). The peer registry and webhook config both treat env-var-name strings as user data and resolve them against the entire Worker env. Today only the master-token holder can register peers, so it's not exploitable in isolation — but the pattern repeats across two surfaces and the docstrings imply a safety the code doesn't enforce. A static allowlist closes both at once.

2. **Two-write operations have no rollback path.** B004 (item then index), B015 (auto-confirm cache delete vs hook read), B019/B020 (mirror write vs prune), B026 (sender-index RMW). Every "first do X, then do Y" pair in this codebase can leave inconsistent state under failure or concurrency. The system mostly tolerates this on a single-tenant Worker; it will break under scale.

3. **Pipeline error-handling is uneven.** B008 (rules throws → mailroom dies), B009 (classifier throws → silent label loss), B040 (seed throws → quiet fallback). The hook system treats some errors as "log + continue" (good) and others as "log + continue with broken state" (bad). Audit every catch block in the dispatch path.

4. **Globs and regexes are user-data without sanitization.** B006 (routing glob unescaped), B025 (forward-detect email regex permissive), B029 (sender-aliases first-match-wins). Any place that compiles a regex from config or user input is a place to add validation.

5. **Cron paths have no per-step time budgets.** B019, B021, B022, B023, B024. The 30-min cron fires three sequential jobs (RSS → mirror → unread-sweep), each capable of consuming the entire 30s CPU budget. Add per-step timeouts and early-exit on budget exhaustion.

---

## Stats

| Category | Count |
|----------|-------|
| auth-gap / env-leak | 4 |
| security (open-redirect, error-leak, injection) | 6 |
| race-condition | 8 |
| data-loss | 4 |
| error-handling | 5 |
| logic-bug | 9 |
| resource-leak / budget-overrun | 6 |
| type-safety | 3 |
| **Total substantive** | **41** |

Raw findings before dedup + verification: 158 across 8 agents. Findings cut: ~75% (duplicate reports, theoretical-only at this scale, the agent overstating impact, behavior-is-correct false alarms).

---

## Wave / Source Provenance

- **Wave 1A** (`src/messaging/inbox|dispatch|registry|filter|classifier|cursor|email-handler`) → B004, B009, B012, B013, B014
- **Wave 1B** (mailroom hooks) → B007, B008, B015, B016, B025, B026, B027, B028, B029
- **Wave 1C** (`http-routes.ts`, channels) → B010, B030, B031, B032, B033
- **Wave 1D** (cron mirror, RSS, peers proxy) → B019, B020, B021, B022, B023, B024
- **Wave 2A** (`router.ts`, `sync.ts`) → B006, B017, B018
- **Wave 2B** (deploy + HTTP layer) → B001, B011, B039, B040
- **Wave 2C** (adapters) → B005, B034, B035, B036, B037, B038
- **Wave 2D** (peers, MCP) → B002, B003, B041

---

## Handoff to mxit

The Tier 0–2 list above is mxit-compatible (`- [!]` / `- [ ]`). Suggested execution order:

1. **B001 first.** Single-line fix, biggest blast radius. Do this before anything else.
2. **B002 + B003 + B010 together.** All three close the env-var leak surface in one PR (allowlist + sanitized error message).
3. **B007.** Auto-confirm `redirect: 'manual'` is a small, well-bounded change.
4. **B005, B006, B009.** Each is a one- or two-line fix surfacing real bugs.
5. **B004, B008.** Pipeline reliability — slightly bigger but well-scoped.
6. **Tier 2 batches** as time allows. Group by file (`mirror.ts`, `cloudflare-d1.ts`, etc.) to minimize churn.

Tag closed findings with `#audit` when archiving.
