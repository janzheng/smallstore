# Smallstore — Security Remediation [shipped 2026-04-28]

> **Status: complete.** All 41 findings closed (40 fixed, 1 verified non-issue) in a single autonomous fan-out session. 12 commits, 1831/1832 tests green (1 pre-existing failure unrelated). See `.brief/2026-04-28-security-audit.md` for the closing brief; `TASKS-AUDIT-2026-04-28.md` for individual finding details.
>
> **Re-laning note:** Plan agent recommended re-cutting Phase C from "by theme" to "by file" — adopted at execution time. The headings below reflect the original (by-theme) plan; the actual commits map by file (see commit log). Both views are consistent — the work is done.

Original plan:

---

## Sprint 0: Token + auth hardening -> 2026-04-29

Single PR. ~30 min. The biggest blast radius items in the audit — fix before anything else.

### Lane A — boot-time token validation (no shared deps)

- [x] **B001** Reject empty/whitespace `SMALLSTORE_TOKEN` at boot — middleware currently does `if (!token) return next()` which silently disables all auth on `""` `deploy/src/index.ts:204-211` #security #B001 #goal:token-hardening
- [x] **B011** Switch bearer-token compare to constant-time helper — currently `m[1] !== token` short-circuits on first mismatched char. Use `crypto.subtle.timingSafeEqual` (after equal-length check) or a small wrapper `deploy/src/index.ts:208`, `src/http/middleware/mod.ts:269` #security #B011 #goal:token-hardening

### Lane B — env-var allowlist (one shared module, three callers)

- [x] **B002-pre** Build the allowlist module — `src/peers/env-allowlist.ts` (or similar). Static safe-name regex (e.g. `/^(TF_|NOTION_|SHEET_|GH_)[A-Z0-9_]+$/`), or explicit list. Reject `SMALLSTORE_*` and any unlisted name. Export `assertEnvNameAllowed(name: string)` `src/peers/` #security #B002-pre #env-allowlist
- [x] **B002** Gate peer auth env-var resolution behind allowlist — call `assertEnvNameAllowed()` in `validateAuthShape` (HTTP route) AND in `resolvePeerAuth` (proxy) for defense-in-depth `src/peers/http-routes.ts:317-342`, `src/peers/proxy.ts:90-157` #security #B002 #needs:env-allowlist #goal:token-hardening
- [x] **B003** Gate webhook HMAC `secret_env` resolver behind same allowlist — `resolveHmacSecret` in `deploy/src/index.ts:475-476` should call the shared helper `deploy/src/index.ts:475-476` #security #B003 #needs:env-allowlist #goal:token-hardening
- [x] **B010** Webhook 500 returns generic "configuration error" — strip the env-var name from the response body, log it server-side instead `src/messaging/http-routes.ts:1465` #security #B010 #goal:token-hardening

### Tests

- [x] **B001-test** Test that `SMALLSTORE_TOKEN=""` returns 401 on /api/foo — currently passes (broken behavior) `tests/messaging-auth.test.ts` #test #needs:B001
- [x] **B002-test** Test that registering a peer with `token_env: "SMALLSTORE_TOKEN"` is rejected with 400 `tests/peers-*.test.ts` #test #needs:B002
- [x] **B010-test** Test that `/webhook/<peer>` with missing HMAC env var returns generic error, not the env-var name `tests/messaging-webhook.test.ts` #test #needs:B010

---

## Sprint 1: Auto-confirm hardening -> 2026-04-30

Single PR. ~20 min. Two related findings on the auto-confirm path.

- [x] **B007** `redirect: 'manual'` on auto-confirm fetch + walk up to 3 hops re-running `isSafeUrl()` each time. Abort + log on disallowed redirect (unsubscribe URL, IP host, non-https, off-allowlist domain) `src/messaging/auto-confirm.ts:281` #security #B007 #goal:auto-confirm-safety
- [x] **B016** Confirm-detect URL extraction validates the URL is the `href` of an actual `<a>` tag containing the anchor phrase, not just the first URL on the same line `src/messaging/confirm-detect.ts:182-225` #security #B016 #goal:auto-confirm-safety

### Tests

- [x] **B007-test** Test that auto-confirm aborts when the initial URL 302s to an unsubscribe URL `tests/messaging-auto-confirm.test.ts` #test #needs:B007
- [x] **B016-test** Test that confirm-detect picks the `<a href>` URL, not a stray URL on the same line `tests/messaging-confirm-detect.test.ts` #test #needs:B016

---

## Sprint 2: Pipeline + adapter correctness -> 2026-05-02

Five fixes across five files. **Lanes A-E run in parallel** — disjoint file scopes, no internal deps. Recommend three to five subagents fanning out.

### Lane A — Inbox ingest atomicity

- [x] **B004** `_ingest` writes index entry first (with `pending: true` marker) then item, then clears the marker. Crash-recovery: `loadIndex` filters out entries with `pending: true` whose item key is missing `src/messaging/inbox.ts:319-320` #data-integrity #B004 #goal:pipeline-correctness

### Lane B — D1 corruption surfacing

- [x] **B005** Throw a typed `CorruptValueError` (export from adapter errors) instead of returning the raw string on `JSON.parse` failure in D1's `get()` `src/adapters/cloudflare-d1.ts:286-290`, `src/adapters/errors.ts` #data-integrity #B005 #goal:pipeline-correctness

### Lane C — Routing glob safety

- [x] **B006** Escape regex metachars before `replace(/\*/, '.*')` in `patternMatches` — single line: `pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')` `src/router.ts:2104-2110` #correctness #B006 #goal:pipeline-correctness

### Lane D — Rules engine resilience

- [x] **B008** Wrap `evaluateFilter()` in try/catch in `rules.ts`. On throw: return "no match" with a `console.warn` including rule id + error. Add a separate try/catch around `rulesStore.apply()` in the hook so the pipeline survives even if rules infrastructure crashes `src/messaging/rules.ts:283-293`, `src/messaging/rules-hook.ts:50-75` #error-handling #B008 #goal:pipeline-correctness

### Lane E — Classifier failure semantics

- [x] **B009** When the classifier throws, abort the pipeline with a logged drop instead of continuing with a half-classified item. Drop = item is not stored; emit a `classifier-failed` log line with item id + error so we can see what's failing `src/messaging/dispatch.ts:116-125` #error-handling #B009 #goal:pipeline-correctness

### Tests

- [x] **B004-test** Crash-during-ingest test: simulate item.set success + appendIndex failure; verify recovery on next read `tests/messaging-inbox.test.ts` #test #needs:B004
- [x] **B005-test** Test D1 `get()` throws `CorruptValueError` on malformed JSON, doesn't return the raw string `tests/cloudflare-d1.test.ts` #test #needs:B005
- [x] **B006-test** Test that pattern `cache.temp` matches `cache.temp` only, not `cacheXtemp` or `cache!temp` `tests/router-routing.test.ts` #test #needs:B006
- [x] **B008-test** Create a rule with a regex that throws when compiled; verify ingest survives and the rule is logged `tests/messaging-rules.test.ts` #test #needs:B008
- [x] **B009-test** Stub the classifier to throw; verify item is dropped + logged, not partially-stored `tests/messaging-dispatch.test.ts` #test #needs:B009

---

## Sprint 3: Concurrency + race hardening -> 2026-05-09

Race conditions and lazy-init safety. Mostly P2 (#at-scale-only) — fix before sustained scale or multi-tenant. Lanes are parallel.

### Lane A — Inbox + sender-index races

- [x] **B014** `appendIndex` dedup TOCTOU — use append-with-if-not-exists at adapter level if available, or accept idempotent duplicates with a periodic dedup pass `src/messaging/inbox.ts:336-342` #race-condition #B014
- [x] **B026** Sender-index concurrent upsert RMW — switch to append-only counter rows aggregated at read time, OR add a per-sender lock (in-process Map) `src/messaging/sender-index.ts:188-221` #race-condition #B026

### Lane B — Cron mirror serialization

- [x] **B019** Mutex `runMirror()` calls — in-process `Map<source, Promise>` lock; manual trigger returns 409 if cron is already running, cron skips if manual is in flight `src/messaging/mirror.ts:119-268` #race-condition #B019
- [x] **B020** Mirror prune races mid-write — gate prune on the same mutex from B019; prune only after all PUTs have settled `src/messaging/mirror.ts:236-263` #race-condition #B020 #needs:B019
- [x] **B015** Auto-confirm cache invalidation — `addPattern` / `removePattern` clears the in-memory cache so deletes propagate immediately `src/messaging/auto-confirm-senders.ts`, `src/messaging/auto-confirm.ts:230-250` #race-condition #B015

### Lane C — Boot + adapter init

- [x] **B039** Memoize `appHandle` as `Promise<AppHandle>` instead of a boolean check — concurrent cold-start requests share the same in-flight build `deploy/src/index.ts:585-588` #race-condition #B039
- [x] **B035** D1 `ensureTable` memoize as `Promise<void>` — concurrent first writes share the same migration run `src/adapters/cloudflare-d1.ts:188-217` #race-condition #B035
- [x] **B040** `seedAutoConfirmFromEnv` — either `await` it before serving the first request, or document the ~300ms cold-start gap explicitly `deploy/src/index.ts:339-347` #race-condition #B040

---

## Sprint 4: Resource + budget caps -> 2026-05-16

Bounded-execution polish. P2 — fixes scale problems before they bite.

### Lane A — Mirror

- [x] **B021** Cap `Promise.all(items.map(...))` at 10-20 in-flight per slug; chunk + sequential await between chunks `src/messaging/mirror.ts:194-203` #budget #B021
- [x] **B022** Cap `recent.md` rendered size — cap by item count (e.g. 200 items max) AND by aggregated body bytes (e.g. 10 MB) `src/messaging/mirror.ts:227` #budget #B022

### Lane B — Sweep + rules retroactive

- [x] **B023** Move `hardCap` check inside the inner item loop in `runUnreadSweep`; break immediately on hit `src/messaging/unread-sweep.ts:76-89` #budget #B023
- [x] **B024** Detect cursor non-advance in `applyRetroactive` — track previous cursor + bail if it stops advancing for N pages `src/messaging/rules.ts:349-373` #budget #B024

### Lane C — Adapters

- [x] **B034** D1 `clear()` — sequential batches with optional `concurrency` knob (default 4), not unbounded `Promise.all` `src/adapters/cloudflare-d1.ts:489` #budget #B034
- [x] **B036** D1 `list()` with offset uses SQL `LIMIT/OFFSET` directly instead of `keys()` + slice `src/adapters/cloudflare-d1.ts:681-684` #budget #B036
- [x] **B037** Memory adapter — amortized TTL eviction in `set()` (cheap probabilistic check) instead of full O(n) scan in `keys()` `src/adapters/memory.ts:165-183` #budget #B037

---

## Sprint 5: Hygiene + injection polish -> 2026-05-23

Smaller-scope correctness items. P2 — safe to batch-merge by file.

### Lane A — Mailroom hooks polish

- [x] **B012** Skip `senderUpsertHook` when item carries `dropped` or `quarantined` label — guard at top of hook `deploy/src/index.ts:351-358` #logic-bug #B012
- [x] **B013** Move blob writes below the dedup gate in `_ingest` `src/messaging/inbox.ts:305-321` #logic-bug #B013
- [x] **B025** Tighten `extractEmailAddress` regex to forbid percent-encoding + unusual chars in local-part `src/messaging/forward-detect.ts:693` #injection #B025
- [x] **B027** Tighten confirm-detect subject pattern — require explicit double-opt-in keywords (`confirm subscription`, `confirm your email subscription`) instead of generic `verify your email` `src/messaging/confirm-detect.ts:93-103` #logic-bug #B027
- [x] **B028** Quarantine restore: skip `stampUnreadHook` on force-ingest, OR honor a `read_at` sentinel in fields `src/messaging/unread.ts:59-93`, `src/messaging/quarantine.ts:135` #logic-bug #B028
- [x] **B029** Sort sender-aliases patterns by literal-prefix length (longest-first) before matching, so narrower patterns win even if added later `src/messaging/sender-aliases.ts:182-189` #logic-bug #B029

### Lane B — Channels + markdown export

- [x] **B030** Drop RSS entity-expansion cap from 1,000,000 to ~50,000 `src/messaging/channels/rss.ts:216` #budget #B030
- [x] **B031** RSS GUID collision — add `items_collided` counter to `FeedResult`, surface in cron logs `src/messaging/channels/rss.ts:290-301` #data-loss #B031
- [x] **B032** Markdown export — sanitize subjects: escape backticks, escape lines containing only `---`, escape leading `# ` `src/messaging/newsletter-markdown.ts:138,214,301` #injection #B032
- [x] **B033** Validate `path` query param in peer proxy against strict char class before passing to `URL` constructor; reject CRLF + control chars `src/peers/proxy.ts:209-217`, `src/peers/http-routes.ts:168` #injection #B033

### Lane C — Router + adapter polish

- [x] **B017** Sort routing patterns by specificity (longest literal prefix first) before matching `src/router.ts:2087` #logic-bug #B017
- [x] **B018** Reconcile `set()` and `append()` routing — both should try `fullPath`, `parsed.collection`, then `parsed.collection + '/'` `src/router.ts:681-698`, `src/router.ts:2001-2002` #logic-bug #B018
- [x] **B038** Remove `as unknown as Response` double cast in R2 adapter; tighten the wrapper type so the cast isn't needed `src/adapters/cloudflare-r2.ts:332` #type-safety #B038
- [x] **B041** Validate cursor JSON shape after parse — `at` is ISO-8601, `id` is bounded length `src/messaging/cursor.ts:36-51` #type-safety #B041

---

## Tracking

- **Sprint 0 ships first** — single PR, all four findings (B001 + B002 + B003 + B010 + B011 + the env-allowlist module). Aim for same-day.
- **Sprint 1 second** — single PR, auto-confirm hardening (B007 + B016).
- **Sprints 2-5 fan out** — each lane is a separate PR; subagents can work in parallel across lanes within a sprint. Within a lane, fixes are sequential.
- **`#needs:env-allowlist`** is the only cross-finding dep in Sprint 0; **`#needs:B019`** is the only cross-finding dep in Sprint 3 (mirror prune mutex depends on the mirror mutex).
- **Tests** are listed inline. Tier 0/1 (Sprints 0-2) fixes get tests; Tier 2 (Sprints 3-5) fixes piggyback on existing tests where possible.

## After remediation

When all sprints ship:

- [x] Move `TASKS-AUDIT-2026-04-28.md` → `TASKS-AUDIT-2026-04-28.done.md`
- [x] Update `.brief/2026-04-28-security-audit.md` status: `findings only` → `remediated 2026-MM-DD`
- [x] Mark `TASKS-SECURITY.md` items `[x]` with resolution brackets, then archive this file → `TASKS-SECURITY.done.md`
- [x] Add a section to `TASKS-DESIGN.md § Decisions` capturing the env-allowlist policy + the boot-time empty-token check (so future contributors don't accidentally regress them)
- [x] Schedule a follow-up audit in 90 days (`/schedule` or calendar) — incremental sweep of new code only, excluding the closed `B###` IDs

---

## Cross-references

- Detail (every finding, file:line, why it matters): `TASKS-AUDIT-2026-04-28.md`
- Brief (executive summary, threat model, themes): `.brief/2026-04-28-security-audit.md`
- Prior audit history (closed): `TASKS-AUDIT.md` (A001-A244)
