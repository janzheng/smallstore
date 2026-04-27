# Smallstore

Active work. See `TASKS.done.md` for shipped work; `TASKS-MAP.md`, `TASKS-DESIGN.md`, `TASKS-AUDIT.md`, `TASKS-TESTS.md`, `TASKS-MESSAGING.md` for area backlogs.

## Current

*(Eight sprints shipped 2026-04-23 → 2026-04-27 — mailroom pipeline, curation, peer registry, MCP reorg + tool families, RSS pull-runner, forward-notes (capture + newsletter views + retroactive backfill), notes/todos derived views + markdown export + cross-newsletter aggregation, and a public-manifest lockdown. All live at `smallstore.labspace.ai`. 41 MCP tools across 3 families (core/inbox/peers). Deploy uses `link:../dist` symlink (no more stale-code trap). 751/751 messaging tests green. See `TASKS.done.md` for daily detail; `.brief/forward-notes-and-newsletter-profiles.md`, `.brief/notes-todos-and-mirror.md`, `.brief/api-access-and-notes.md` for design.)*

### Notes → todos + browsable mirror — Phase 2b open (design: `.brief/notes-todos-and-mirror.md`)

Phases 1 + 2a both shipped 2026-04-27. Phase 2b is the remaining piece — a peer-mediated tigerflare cron mirror that uses the Phase 2a markdown renderers.

- [ ] **Phase 2b — peer-mediated tigerflare cron mirror** — extend `scheduled()` handler to render markdown via Phase 2a path and push to a tigerflare peer registered with `metadata.mirror_config = { source_inbox, target_space, include_index? }`. Auth via the peer's `auth.token_env`; no smallstore-side TF token. Idempotent (re-rendering same markdown is a no-op write). Per-slug failure logs and skips. Needs ~30 min config (TF_TOKEN secret + tigerflare peer registration) before code can land. Total ~60-90 min. #messaging #tigerflare-mirror #phase2b

### Stretch / parked

- [?] **`inbox.query()` order honoring** — fix the underlying limitation so the filter path respects `options.order` natively, removing the in-memory sort fallback in `/inbox/:name/notes`. Not user-visible; pure cleanup. #cleanup #inbox-query-order
- [?] **Note-length engagement signal per newsletter** — correlate aggregate note length with interest score; surface in profile dashboard. From original forward-notes brief. #messaging #interest-signal
- [?] **Cross-newsletter topic threading (LLM-extracted from notes)** — `/inbox/:name/topics`. Needs an LLM call path. From original forward-notes brief. #messaging #cross-newsletter-tags
- [?] **Phase 3 — newsletter-level meta-notes — DEFERRED.** `POST /inbox/:name/newsletters/:slug/note` (separate from per-issue). Per-issue notes already aggregate well; revisit only if writing a meta-note feels awkward in practice. Detail: `.brief/notes-todos-and-mirror.md § Phase 3`. #messaging #newsletter-meta-note

## Later

### Mailroom — Wave 3 / messaging backlog

See `TASKS-MESSAGING.md` for the full deferred list (multi-address routing, batch ingest in D1, sender-index D1 schema, FTS5 tokenizer, spam layers, raw/attachments export inlining, federated query, etc.).

### Plugin discipline — adapter-level reshape (open)

Audit findings from 2026-04-24 surfaced adapter-level sprawl in root `dependencies`. The lazy-load sweep is shipped (see `TASKS.done.md § 2026-04-24`); two breaking-change items remain.

- [?] Add all adapters to `build-npm.ts` `entryPoints` — currently only 5 CF adapters are in npm sub-entries; deno.json already has all adapters. Enables per-adapter npm imports for tree-shaking without factory-slim. #plugin-discipline #adapter-npm-entrypoints
- [?] Remove adapter re-exports from root `mod.ts` — **breaking change** for 0.3.0 major. Consumers migrate to per-adapter imports; factory-slim becomes the default factory. Do after the lazy-load pass above, so the migration target exists. #plugin-discipline #adapter-reshape-breaking

**Intentionally NOT on this list:** search/BM25 coupling. `src/search/` is imported by 7 adapters for BM25 indexing; this is **intentional core by design** (ubiquitous utility promotes to core, not a leak). Documented in `docs/design/PLUGIN-AUTHORING.md § When something is core vs. a plugin`.

### Motivating examples (parked)

- [?] Obsidian adapter + channel — ~100 LOC adapter (frontmatter-aware local-file); channel is a vault watcher.
- [?] Tigerflare adapter — parked + questioned; tigerflare is being used the OTHER direction today (smallstore mirrors INTO tigerflare via Phase 2b above). Re-evaluate if a real consumer wants tigerflare-as-storage.

### Peer registry — small polish (open)

Level 2 (metadata + authenticated proxy) live since 2026-04-25 (`b1c385d1`). Two small follow-ups remain.

- [?] HTTP integration tests (`tests/peers-http.test.ts`) — agents A+B covered registry + proxy; HTTP routes rely on both and have live-verification but no unit tests yet. ~8-10 tests, ~1 hour. #peers-tests-http
- [?] HTTP test fixture polish — extract a reusable `buildApp` for peers tests matching the messaging pattern. #peers-tests-fixture

**Out of scope (level 3 parked):** compound adapter — peer types implement StorageAdapter, `peer:name` as routing target, full webdav/tigerflare adapter semantics. Promote when a specific peer type needs routing-level integration. #peers-level-3-compound

### Publishing + infra

- [?] **npm publish — PARKED indefinitely.** Smallstore is JSR-first; the dist build (`deno task build:npm`) is Node-compatible and the Worker already consumes it via `link:../dist`, so npm-shape correctness is exercised. But there's no real Node consumer asking for it on the registry today. Promote when a real Node consumer materializes — `cd dist && npm publish` is the one-shot, peerDeps split is already correct. Do NOT surface as a default next-step. #npm-publish #parked
- [?] **npm validation in Node.js projects** — same trigger as the publish task above. #npm-validate #parked
- [ ] Migrate coverflow-workers into smallstore-owned worker → see `.brief/smallstore-workers-takeover.md`. #infra

### Sheetlog — fully resolved

The sheetlog destructive-set bug was fully addressed 2026-04-21 → 2026-04-24:

- `SheetlogAdapter.set()` and `delete()` now throw with actionable errors pointing at `append()` / `upsert()` / `replace()` / `clear()`.
- New `Smallstore.append()` router method + `POST /api/:collection/append` HTTP handler + `sm_append` MCP tool.
- Apps Script-side bug fixes (Bug #2 silent-accept of POST without `_id`, Bug #4 bulk-delete-by-`_id`-value) live on `SmallstoreTest`.
- 13 guard tests in `tests/adapter-sheetlog-guard.test.ts`; `tests/live-adapters.test.ts` switched to `append()`.
- See `TASKS.done.md` for the full archive.

### Other

- [x] LLM/agent features → see [TASKS-MAP.md Phase 8](./TASKS-MAP.md) (rerank, context window, RAG pipeline, semantic recall, working memory, etc.)

## Validation Holes

Pre-existing gaps from the 0.1.0 publish validation — none blocking, just need credentials to flip:

- [ ] `deno task interview:serve` — needs `GROQ_API_KEY` or `OPENAI_API_KEY`.
- [ ] `deno task auth:airtable` — needs Airtable env vars.
- [x] `deno task paste` — `.env` loading bug (pre-existing, not a publish blocker).
- [x] Cloudflare DO live test — DO binding not active on deployed worker (12/13 live adapter tests green).

## Dependency Notes

- [x] **Zod 4 migration shipped in coverflow on 2026-04-20** (`coverflow-v3` commits `2b9f8c04` + `c37d9722` + `36546951`). Smallstore is unaffected — grep confirms zero zod imports in `src/`. The "smallstore Zod schemas need updating too" note from the original v3-vs-v4 standoff turned out to be moot.
- [x] **Notion v5 cleanup learnings from coverflow** (cross-reference `/Users/janzheng/Desktop/Projects/_deno/coverflow/coverflow-v3` Archive section in TASKS.md):
  - The SDK v5 `after` param on `blocks.children.append` is `@deprecated` in types but still accepts at runtime. Coverflow added `position` support alongside `after` — same change applied here on 2026-04-21.
  - Coverflow had a dead `shared/notion/api/` wrapper directory (13 files, zero imports) that hard-coded a v4-only `databases.query` call. Worth a periodic grep here for similar abandoned wrappers — they'd silently break a future bump.
  - Coverflow's `notionModern.queryDatabase()` uses `dataSources.query` exclusively. Smallstore's version is more sophisticated — has SDK v4 fallback + raw HTTP fallback for older API versions. Keep the smallstore approach.
- [x] `@notionhq/client` v5 and `@modelcontextprotocol/sdk` v1.29 both accept `zod ^3.25 || ^4.0` — no forced upgrade if smallstore ever does add zod schemas.
