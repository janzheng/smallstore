# Smallstore

Active work. See `TASKS.done.md` for shipped work; `TASKS-MAP.md`, `TASKS-DESIGN.md`, `TASKS-AUDIT.md`, `TASKS-TESTS.md`, `TASKS-MESSAGING.md` for area backlogs.

## Current

*(Five sprints shipped over 2026-04-23 / 2026-04-24 / 2026-04-25: mailroom pipeline, curation, peer registry, MCP reorg + tool families, in-Worker RSS pull-runner. All live at `smallstore.labspace.ai`. Canonical `skills/smallstore/SKILL.md` synced through mcp-hub to `~/.claude/skills/` + `~/.cursor/skills/` + `~/.codex/skills/` + `~/.agents/skills/`. 33 MCP tools across 3 families (core/inbox/peers). See `TASKS.done.md` + `.brief/2026-04-*-sprint.md` for full narratives.)*

### Mailroom — annotation layer — SHIPPED 2026-04-24

Two annotation-layer features, live at `smallstore.labspace.ai` version `180701cc-5e31-4f07-a9dd-39ff3125d986`. Full detail in `TASKS-MESSAGING.md § Mailroom pipeline — remaining after curation sprint`.

- [*] **Forward-notes capture** — `extractForwardNote()` in `src/messaging/forward-detect.ts` pulls user-typed commentary above the forward delimiter into `fields.forward_note`. Strips trailing `On <date>, <Sender> wrote:` quote headers. 13 new tests cover Gmail/Outlook/Apple Mail separators + CRLF + empty/whitespace edge cases #messaging #mailroom-forward-notes
- [*] **Sender-name aliases** — new `src/messaging/sender-aliases.ts` — glob-pattern alias map, `createSenderAliasHook` wired into deploy preIngest chain. Prefers `original_from_email` so forwarded mail still tags with the original person. Writes `fields.sender_name` + `sender:<slug>` label. 31 new tests covering parse/glob/slug/apply/hook. Live config in `wrangler.toml [vars]`: `jessica.c.sacher@*:Jessica`, `jan@phage.directory:Jan`, `janzheng@*:Jan`, `janeazy@*:Jan`, `hello@janzheng.com:Jan` #messaging #mailroom-sender-aliases

### RSS pull-runner — SHIPPED 2026-04-23

In-Worker cron-driven poller for `type: 'rss'` peers. Live at `smallstore.labspace.ai` with `*/30 * * * *` trigger. Two boot-registered RSS inboxes: `biorxiv` + `podcasts`. Re-poll is idempotent (content-addressed ids). See `.brief/rss-channel.md` (parser surface + quirks) and `.brief/rss-as-mailbox.md` (ingestion story).

- 32 rss channel tests, 14 pull-runner tests — all green; 94/94 messaging tests
- RssChannel supports RSS 2.0, Atom 1.0, **RSS 1.0 (RDF)**
- Shared `dispatchItem()` helper — email-handler + pull-runner now both use it
- Boot-registered inboxes: `biorxiv` (preprints), `podcasts` (audio shows). Each has a dedicated D1 table to avoid `_index` / `items/` keyspace collisions
- Manual trigger endpoints: `POST /admin/rss/poll` (all feeds), `POST /admin/rss/poll/:peer` (one feed)

**Live state (as of 2026-04-23 evening):**

- `biorxiv` inbox — 60 items from bioRxiv neuroscience + bioinformatics. Both peers currently `disabled: true` (paused; no longer polled). Items remain readable
- `podcasts` inbox — 1565 items across 4 active feeds: Dumb Money Live (306), My First Million (857), Startup Ideas (333), How I AI (69). All four feeds publish their **entire episode history** in one XML doc, so the first poll captured the full back catalog

**Real-world quirks discovered (captured in `.brief/rss-channel.md`):**

- `www.biorxiv.org/rss/*` is behind Cloudflare's managed challenge — use `connect.biorxiv.org/biorxiv_xml.php?subject=...` (serves RDF, not RSS 2.0)
- `fast-xml-parser`'s default `processEntities.maxTotalExpansions: 1000` blocks busy podcast feeds (anchor.fm + flightcast both tripped). Raised to 1M; still safe against true entity bombs (which need DOCTYPE-defined recursive entities)
- Podcast feeds publish full history (not paginated), so capacity-plan accordingly: MFM's feed XML was 6MB, Startup Ideas 3.4MB

## Later

### Peer registry — SHIPPED 2026-04-25 (same-day after design)

Level 2 (metadata + authenticated proxy) live at `smallstore.labspace.ai` version `b1c385d1`. 45 peer tests + 1203/1203 total tests green. Brief: `.brief/peer-registry.md`. Full archive: `TASKS.done.md § 2026-04-25`.

Live workflow verified end-to-end:
- `POST /peers` creates a peer (tigerflare example) with auto id/created_at/disabled defaults
- `GET /peers` lists registered peers
- `GET /peers/:name/health` cleanly surfaces "env var X not set" when auth env missing (no crash)
- `GET /peers/:name/fetch?path=...` + `POST /peers/:name/query` proxy with per-type auth injection

**Out of scope (level 3 parked):** compound adapter — peer types implement StorageAdapter, `peer:name` as routing target, full webdav/tigerflare adapter semantics. Promote when a specific peer type needs routing-level integration (webdav likely first). Tracked as `#peers-level-3-compound`.

Remaining small polish:
- [?] HTTP integration tests (tests/peers-http.test.ts) — agents A+B covered registry + proxy; HTTP routes rely on both and have live-verification but no unit tests yet. ~8-10 tests, ~1 hour #peers-tests-http
- [?] HTTP test fixture polish — extract a reusable buildApp for peers tests matching messaging pattern #peers-tests-fixture

### MCP tool family + reorg — SHIPPED 2026-04-25

Monolithic `src/mcp-server.ts` split into `src/mcp/` with per-family tool files. Core migrated + 15 inbox tools + 8 peers tools = 33 total. Details in `TASKS.done.md § 2026-04-25 — MCP tool family`.

### Plugin discipline — adapter-level reshape (post-sprint, priority-ordered)

### Plugin discipline — adapter-level reshape (post-sprint, priority-ordered)

Audit findings from 2026-04-24 surfaced adapter-level sprawl in root `dependencies`. `factory-slim.ts` mitigates this for production consumers, but the underlying leaks are worth fixing when the pain shows up. Full context: `.brief/plugin-discipline-audit.md`, `docs/design/PLUGIN-AUTHORING.md`.

- [?] **blob-middleware aws-sdk lazy-load** — priority because blob-middleware IS a real plugin family (not just an adapter). Apply postal-mime recipe to `src/blob-middleware/resolver.ts`. ~30 min #plugin-discipline #blob-middleware-aws-lazy
- [?] Notion adapter lazy-load (`@notionhq/client`) + `src/clients/notion/*` — postal-mime recipe #plugin-discipline #notion-lazy
- [?] r2-direct adapter lazy-load (`@aws-sdk/*`) — postal-mime recipe #plugin-discipline #r2-direct-lazy
- [?] unstorage adapter lazy-load (`unstorage`) — postal-mime recipe #plugin-discipline #unstorage-lazy
- [?] Add all adapters to `build-npm.ts` `entryPoints` — currently only 5 CF adapters are in npm sub-entries; deno.json already has all adapters. Enables per-adapter npm imports for tree-shaking without factory-slim #plugin-discipline #adapter-npm-entrypoints
- [?] Remove adapter re-exports from root `mod.ts` — **breaking change** for 0.3.0 major. Consumers migrate to per-adapter imports; factory-slim becomes the default factory. Do after the lazy-load pass above, so the migration target exists #plugin-discipline #adapter-reshape-breaking

**Intentionally NOT on this list:** search/BM25 coupling. `src/search/` is imported by 7 adapters for BM25 indexing; this is **intentional core by design** (ubiquitous utility promotes to core, not a leak). Documented in `docs/design/PLUGIN-AUTHORING.md § When something is core vs. a plugin`.

### Motivating examples parked (not in the sprint; unblocked by discipline doc)

- [?] Obsidian adapter + channel — ~100 LOC adapter (frontmatter-aware local-file); channel is a vault watcher
- [x] [done: RssChannel + pull-runner + boot-registered biorxiv inbox, 60 items ingested end-to-end 2026-04-23] RSS channel — pull-shape
- [?] Webhook channel — push-shape; the "agentic feeders dump data somewhere" affordance
- [?] Tigerflare adapter — parked + questioned; tigerflare is being used the OTHER direction today. Re-evaluate when a real consumer appears

### Mailroom — Wave 3 (not shipped in the EOD sprint)

See `TASKS-MESSAGING.md` § Later for the full deferred list (rules table, spam layers, MCP `sm_inbox_*` tool family, raw/attachments export inlining, 14 Wave 1/2 #discovered follow-ups).

### Publishing + infra

- [ ] Publish to npm (`deno task build:npm && cd dist && npm publish`) #npm-publish
- [ ] Test and validate npm build works in Node.js projects #npm-validate
- [ ] Migrate coverflow-workers into smallstore-owned worker `-> foxfire .brief/smallstore-workers-takeover.md` #infra

### Known issues

- [*] **Sheetlog adapter `set()` is destructive — added non-destructive `append()` path** #sheetlog #bug 2026-04-21
    - Added `append?(items)` to `StorageAdapter` interface
    - Implemented `SheetlogAdapter.append(items)` — direct wrap of `client.dynamicPost()`, bypasses the destructive `set()` bulkDelete
    - Added `Smallstore.append(collectionPath, items)` router method with append-specific mount resolution (bare collection paths match `pattern/*` mounts, unlike routeData which requires trailing segment)
    - Added `POST /api/:collection/append` HTTP handler (`handleAppend`) — returns 501 if adapter doesn't implement native append
    - Added `sm_append` MCP tool (new MCP tool registration requires client restart)
    - Tested end-to-end against the faves yawnxyz sheet: test row landed, existing rows preserved
    - Docs remaining: update `examples/.smallstore.json.sheetlog-docs.md` and the MCP `SKILL.md` to reference `sm_append` / `/append` endpoint for sheetlog writes; mark the old "per-row keys for append-style logging" advice as deprecated (it doesn't actually work). **This is a doc-only TODO.**
- [ ] ~~Sheetlog adapter original TODO (superseded above)~~
    - Discovered 2026-04-21 during faves `/faves:add` work: `sm_write("yawnxyz", key, data)` → `sheetlog.set()` at `src/adapters/sheetlog.ts:131` calls `bulkDelete(ids)` on every existing row, then inserts. The `key` arg is documented as `@param key - Storage key (ignored)` — so callers can't scope the wipe. A single `sm_write` destroys the entire sheet.
    - Worse: `examples/.smallstore.json.sheetlog-docs.md` and the smallstore agent-skill `SKILL.md` both say "use per-row keys for append-style logging" — that's incorrect for this adapter. Callers following the docs would lose data.
    - Workaround users currently need: bypass smallstore, hit the Apps Script webapp directly with `{method: DYNAMIC_POST, sheet, payload: [...]}`. See `__resources/collections/faves/_tools/add-to-sheet.ts` for a working example.
    - Proposed fix (in order of preference):
        1. Add an `append(items)` method to the sheetlog adapter that wraps `client.dynamicPost(items)` directly (no wipe). Expose via a new MCP tool `sm_append` — clean separation from `sm_write`'s current "replace whole sheet" semantics.
        2. Update `set(key, value)` to differentiate: if `value` is a single object, append; if array, replace. Keeps MCP surface area small but changes semantics of existing `sm_write` calls.
        3. At minimum: fix the misleading docs. The current "per-row keys for append-style logging" pattern is not supported. Note the sheet-as-single-collection reality in the user-facing docs.
    - Scope: small. The sheetlog client (`src/clients/sheetlog/client.ts`) already has a `dynamicPost()` primitive — the fix is plumbing.
    - **Additional findings from 2026-04-21 pilot test — status update:**
        - **Bug #2 (DYNAMIC_POST silent-accept without `_id`): PATCHED upstream** in sheetlog.js (`/Users/janzheng/Desktop/Projects/__active/sheetlog/sheetlog.js`) — `handlePost` and `handleDynamicPost` now auto-generate `_id` when the column exists and the payload omits it. Response now includes the generated id(s) as `{_id: 123}` or `{_ids: [...]}`. **Awaiting GAS redeploy** to take effect.
        - **Bug #3 (UPSERT with `idColumn: "url"` doesn't match): NOT REPRODUCED cleanly**, possibly a timing artifact from the pilot test. Deferred pending a clean repro.
        - **Bug #4 (BULK_DELETE/DELETE by `_id` value vs row-number): PATCHED upstream** in sheetlog.js — `handleDelete` and `handleBulkDelete` now accept a `byId: true` flag to treat the id/ids as `_id` column values (resolved to row numbers via `findRowIndexById`). Default behavior unchanged (row-numbers). **Awaiting GAS redeploy.** Smallstore client types should be updated to reflect the new `byId` parameter once the deploy is confirmed.
- [*] LLM/agent features → see [TASKS-MAP.md Phase 8](./TASKS-MAP.md) (rerank, context window, RAG pipeline, semantic recall, working memory, etc.)

## Validation Holes

Pre-existing gaps from the 0.1.0 publish validation — none blocking, just need credentials to flip:

- [ ] `deno task interview:serve` — needs `GROQ_API_KEY` or `OPENAI_API_KEY`
- [ ] `deno task auth:airtable` — needs Airtable env vars
- [*] `deno task paste` — `.env` loading bug (pre-existing, not a publish blocker)
- [*] Cloudflare DO live test — DO binding not active on deployed worker (12/13 live adapter tests green)

## Dependency Notes

- [*] **Zod 4 migration shipped in coverflow on 2026-04-20** (`coverflow-v3` commits `2b9f8c04` + `c37d9722` + `36546951`). Smallstore is unaffected — grep confirms zero zod imports in `src/`. The "smallstore Zod schemas need updating too" note from the original v3-vs-v4 standoff turned out to be moot.
- [*] **Notion v5 cleanup learnings from coverflow** (cross-reference `/Users/janzheng/Desktop/Projects/_deno/coverflow/coverflow-v3` Archive section in TASKS.md):
  - The SDK v5 `after` param on `blocks.children.append` is `@deprecated` in types but still accepts at runtime. Coverflow added `position` support alongside `after` — same change applied here on 2026-04-21
  - Coverflow had a dead `shared/notion/api/` wrapper directory (13 files, zero imports) that hard-coded a v4-only `databases.query` call. Worth a periodic grep here for similar abandoned wrappers — they'd silently break a future bump
  - Coverflow's `notionModern.queryDatabase()` uses dataSources.query exclusively. Smallstore's version is more sophisticated — has SDK v4 fallback + raw HTTP fallback for older API versions. Keep the smallstore approach
- [*] @notionhq/client v5 and @modelcontextprotocol/sdk v1.29 both accept zod ^3.25 || ^4.0 — no forced upgrade if smallstore ever does add zod schemas
