# Smallstore

Active work. See `TASKS.done.md` for shipped work; `TASKS-MAP.md`, `TASKS-DESIGN.md`, `TASKS-AUDIT.md`, `TASKS-TESTS.md`, `TASKS-MESSAGING.md` for area backlogs.

## Current

*(Five sprints shipped over 2026-04-23 / 2026-04-24 / 2026-04-25: mailroom pipeline, curation, peer registry, MCP reorg + tool families, in-Worker RSS pull-runner. All live at `smallstore.labspace.ai`. Canonical `skills/smallstore/SKILL.md` synced through mcp-hub to `~/.claude/skills/` + `~/.cursor/skills/` + `~/.codex/skills/` + `~/.agents/skills/`. 37 MCP tools across 3 families (core/inbox/peers). See `TASKS.done.md` + `.brief/2026-04-*-sprint.md` for full narratives.)*

### 2026-04-26 — webhook channel + valtown RSS template

- [x] **Webhook channel** — `src/messaging/channels/webhook.ts`. Generic HTTP receiver with HMAC verify (sha256 + sha1, env-resolved secrets, optional prefix-strip) + JSON-path field mapping (dotted paths promote payload values to InboxItem-level `summary`/`body`/`sent_at`/`thread_id`/`id`) + content-addressed dedup via `fields.id`. New peer type `webhook`. New HTTP route `POST /webhook/:peer` — does NOT use `requireAuth`, HMAC IS the auth. Plumbed via opaque `webhookConfigFor` + `resolveHmacSecret` options on `RegisterMessagingRoutesOptions` (no peers→messaging dep). 28 new tests; 619/619 messaging suite green. Detail: `TASKS-MESSAGING.md § Path B § Webhook channel`. Docs: `docs/user-guide/mailroom-quickstart.md § 2.10`. **In repo at `3456fec`; needs build+deploy to take effect on prod.** #messaging #channel-webhook
- [x] **Valtown RSS poller template** — `examples/valtown-rss-poller.ts`. Generic env-driven RSS-to-smallstore template (FEED_URL / TARGET_INBOX / DEFAULT_LABELS / SMALLSTORE_TOKEN / DRY_RUN). Content-addressed IDs match the in-Worker rss channel formula → both paths dedup cleanly. Graceful CF-challenge handling (logs `fetch_blocked` summary, exits 0). Smoke-tested against HN RSS. **bioRxiv polling parked** (`TASKS-MESSAGING.md § Decisions, 2026-04-26`) — feed is gated by Cloudflare bot challenge for external IPs; the `biorxiv` inbox stays as a generic POST target for whatever tools handle bioRxiv ingest end-to-end. Use this val for permissive feeds (arXiv, HN, Substack export-as-RSS, blogs). #rss-valtown-biorxiv-poller #rss-valtown-fanout
- [x] **A103 audit cleanup** — `merge` default-mode bug from TASKS-AUDIT was already fixed in `291617d` (2026-04-17); flipped audit entry to `[x]` with fix-commit citation, surfaced default in `MergeOptions.overwrite` JSDoc. #audit-A103
- [x] **README + mailroom-quickstart** — Added messaging plugin family + peer registry to README headline features. Added § 2.10 "Webhook ingest" walkthrough to `docs/user-guide/mailroom-quickstart.md` with the GitHub PR example + field reference. #docs
- [x] **Brief: forward notes + newsletter profiles** — `.brief/forward-notes-and-newsletter-profiles.md`. Three-phase plan: (1) extend forward-detect to capture `original_sent_at` / `message_id` / `newsletter_slug` at ingest, (2) derived `GET /newsletters[/:slug[/items|notes]]` views + MCP tools, (3) generic `POST /admin/inboxes/:name/replay` admin endpoint that generalizes the rules-engine `applyRetroactive` pattern to all hooks (so future field additions are backfillable for free, not script-of-the-month). User trigger: 26 IP Digest forwards landed out of order today + asked "do notes aggregate per newsletter?" Detail in `TASKS-MESSAGING.md § Forward notes + newsletter profiles`. Phase 1 is the next build target. #messaging #brief

### Forward notes + newsletter profiles — SHIPPED + BACKFILLED 2026-04-26

Per `.brief/forward-notes-and-newsletter-profiles.md`. All three phases live on prod (Worker version `14081bd9-6f4b-4d5f-b1d8-3290b2a1966d`); IP Digest end-to-end validation passed.

- [x] **Phase 1 — capture — SHIPPED 2026-04-26.** Extended `forward-detect.ts` to parse `Date:` / `Message-ID:` / `Reply-To:` from forward bodies (Gmail/Outlook/RFC-5322/ISO) + derive `newsletter_slug` from display name (`X at Y` → Y heuristic, slugify-then-fallback-to-domain). New public exports: `parseForwardDate`, `deriveNewsletterSlug`. 19 new tests; 638/638 messaging suite green. Detail: `TASKS-MESSAGING.md § Forward notes + newsletter profiles § Phase 1`
- [x] **Phase 2 — surface — SHIPPED 2026-04-26.** Added `order_by` to Inbox.list/query (received_at/sent_at/original_sent_at; missing-field-tails; cursor disabled for non-default). New routes `GET /inbox/:name/newsletters[/:slug[/items|notes]]` derived from `fields.newsletter_slug`. New MCP tools `sm_newsletters_list`, `sm_newsletter_get`, `sm_newsletter_items`, `sm_newsletter_notes`; existing `sm_inbox_list/query` gained `order_by`. 15 new tests; 653/653 messaging suite green. Detail: `TASKS-MESSAGING.md § Forward notes + newsletter profiles § Phase 2`
- [x] **Phase 3 — retroactive backfill — SHIPPED 2026-04-26.** New `IngestOptions.fields_only` (shallow-merge fields, union labels, preserve identity, skip index). New `POST /admin/inboxes/:name/replay` endpoint generic over any registered hook (mailroom registers forward-detect / sender-aliases / plus-addr / newsletter-name today). New `sm_inbox_replay_hook` MCP tool. Dry-run-first contract: returns up to 10 diffs without writing. 10 new tests including the IP Digest backfill end-to-end scenario. 663/663 messaging suite green. Detail: `TASKS-MESSAGING.md § Forward notes + newsletter profiles § Phase 3`
- [x] **IP Digest backfill — VALIDATED 2026-04-26.** Live run scanned 26 / matched 26 / applied 24 / errored 0. `/inbox/mailroom/newsletters/internet-pipes/items` returns Aug 2024 → Apr 2026 in chronological order. Notes route returns the empty list correctly (no notes on these forwards). System fully exercised. Detail: `TASKS-MESSAGING.md § Forward notes § Phase 3 § IP Digest backfill`

### Deploy hardening — SHIPPED 2026-04-26

- [x] **`file:../dist` → `link:../dist` in `deploy/package.json` — SHIPPED 2026-04-26.** Yarn 1's `link:` form symlinks the dep instead of copying, so `deno task build:npm` is visible to wrangler immediately with no reinstall step. Verified end-to-end: deploy `96fd9c9f-88cf-4ba8-8be2-6aa5b15ca6c4`, marker test confirmed dist→node_modules propagation is instant. Replaces the wipe-and-reinstall workaround surfaced in the morning's deploy. Detail: `.brief/deploy-gotchas.md § 1`. #deploy #yarn-file-dep-staleness

### Stretch — forward-notes follow-ups

From `.brief/forward-notes-and-newsletter-profiles.md`:

- [x] **`POST /inbox/:name/items/:id/note` — SHIPPED 2026-04-26.** After-the-fact annotation. Body `{note: string, mode?: 'replace'|'append'}`. `replace` (default) overwrites; `append` joins via `\n\n---\n\n`; empty string clears. Stamps `fields.note_updated_at` (ISO). Uses `IngestOptions.fields_only` so identity (id/received_at/source/summary/body/labels) and the inbox index are preserved. New MCP tool `sm_inbox_set_note`. 13 new tests in `tests/messaging-annotation.test.ts`; 676/676 messaging suite green. Verified live on prod (deploy `cc96815b-fe29-4206-91cf-e238bcd9ac72`) including replace/append/clear flows. #messaging #annotation-endpoint
- [?] Note-length aggregation as engagement signal per newsletter #messaging #interest-signal
- [?] Cross-newsletter topic threading (LLM-extracted from notes) #messaging #cross-newsletter-tags

### Notes → todos + browsable mirror — IN BRIEF (design: `.brief/notes-todos-and-mirror.md`)

User trigger 2026-04-27: forwarded a Rosieland newsletter with `forward_note: "reminder to self: sub mailroom to rosieland"` — a real action item buried inside a free-text note. Two distinct asks fell out: surface the action items as a workable list, and mirror the whole notes corpus into a browsable markdown surface (tigerflare). Detail in brief; phase breakdown in `TASKS-MESSAGING.md § Notes → todos + mirror`.

- [x] **Phase 1 — `/inbox/:name/todos` + `sm_inbox_todos` — SHIPPED 2026-04-27.** Derived view; six regex patterns (unchecked-checkbox / todo-prefix / action-prefix / remind / subscribe / follow-up); skips quoted-reply + checked-checkbox lines; first-match-wins per line. Multi-line note → multi-todo. New module `src/messaging/todos.ts` exports pure `scanNoteForTodos`. 28 new tests in `tests/messaging-todos.test.ts` (704/704 messaging suite). Live verified on prod (deploy `fc37dd95-cc4f-4002-9470-374fe57b29da`) — picks up the rosieland note "reminder to self: sub mailroom to rosieland" cleanly. #messaging #notes-todos #phase1
- [ ] **Phase 2a — markdown export endpoints** — `?format=markdown` on the three newsletter routes (index + per-slug + notes). Pure read-side, no new dependencies. ~45 min. #messaging #markdown-export #phase2a
- [ ] **Phase 2b — peer-mediated tigerflare cron mirror** — extend `scheduled()` handler to render markdown via Phase 2a path and push to tigerflare via the peer registry. Configurable target via peer metadata. ~60-90 min. #messaging #tigerflare-mirror #phase2b
- [?] **Phase 3 — newsletter-level meta-notes — DEFERRED.** `POST /inbox/:name/newsletters/:slug/note`. Per-issue notes already aggregate well; revisit only if writing a meta-note feels awkward in practice. Storage shape (synthetic item with `id: __meta__:<slug>` + `_meta_` label) captured in brief. #messaging #newsletter-meta-note

### Polish session — SHIPPED 2026-04-24

Seven back-to-back small features, all live at `smallstore.labspace.ai`; `@yawnxyz/smallstore@0.2.0` published to JSR. Detail in area files (`TASKS-MESSAGING.md` + below).

- [x] **`Inbox.keyPrefix` option** — runtime inboxes now namespace within a shared adapter (`inbox/<name>/` auto-default on `POST /admin/inboxes`). Boot-time inboxes (mailroom/biorxiv/podcasts) keep bare `_index` + `items/<id>` keys — backwards-compat. Detail: `TASKS-MESSAGING.md § Inbox keyPrefix option`. Deploy `718c083d` #inbox-keyprefix-isolation
- [x] **Runtime-configurable AUTO_CONFIRM_SENDERS** — D1-backed allowlist + admin API + MCP tools (`sm_auto_confirm_list/add/remove`); env var seeds once-per-pattern (sentinel-tracked, runtime delete sticks across cold starts). Detail: `TASKS-MESSAGING.md § Runtime-configurable AUTO_CONFIRM_SENDERS`. Deploy `46a93db3` #mailroom-auto-confirm-runtime-config
- [x] **Plugin discipline — full lazy-load sweep** — applied postal-mime recipe to all four remaining adapter SDKs (aws-sdk in `src/blob-middleware/resolver.ts` + `src/adapters/r2-direct.ts`; `@notionhq/client` in `src/clients/notion/notionModern.ts`; `unstorage` in `src/adapters/unstorage.ts`). Combined with the postBuild stripper, **`dist/package.json` `dependencies` is now `{}`** — every adapter SDK is an optional peerDep. Detail: `TASKS.md § Plugin discipline — adapter-level reshape` below #plugin-discipline #blob-middleware-aws-lazy #r2-direct-lazy #notion-lazy #unstorage-lazy
- [x] **Attachments retrieval** — capture path was already live; new `Inbox.readAttachment(itemId, filename)` + `GET /inbox/:name/items/:id/attachments[/:filename]` (Worker-streamed, path-traversal guarded) + `sm_inbox_attachments_list`. Brief: `.brief/attachments.md`. Detail: `TASKS-MESSAGING.md § Attachment retrieval`. Deploy `219d88a4` #messaging #attachments
- [x] **JSR publish 0.2.0** — caught up four months of shipped work on the registry. JSR jumped from `0.1.11` (2026-04-22) → `0.2.0`. Three slow-type fixes needed at the cf-email/rss channel exports + `createEmailHandler` return type. https://jsr.io/@yawnxyz/smallstore@0.2.0 #jsr-publish
- [x] **Sheetlog patch verifier + Bug #2/#4 LIVE** — earlier in the day, before the session-of-five above; tracked separately at `TASKS.md § Known issues`

### Mailroom — annotation layer — SHIPPED 2026-04-24

Four annotation-layer features live at `smallstore.labspace.ai`. Full detail in `TASKS-MESSAGING.md § Mailroom pipeline — remaining after curation sprint`.

- [x] **Forward-notes capture** — `extractForwardNote()` in `src/messaging/forward-detect.ts` pulls user-typed commentary above the forward delimiter into `fields.forward_note`. Strips trailing `On <date>, <Sender> wrote:` quote headers. 13 new tests cover Gmail/Outlook/Apple Mail separators + CRLF + empty/whitespace edge cases #messaging #mailroom-forward-notes
- [x] **Sender-name aliases** — new `src/messaging/sender-aliases.ts` — glob-pattern alias map, `createSenderAliasHook` wired into deploy preIngest chain. Prefers `original_from_email` so forwarded mail still tags with the original person. Writes `fields.sender_name` + `sender:<slug>` label. 31 new tests. Live config: `jessica.c.sacher@*:Jessica`, `jan@phage.directory:Jan`, `janzheng@*:Jan`, `janeazy@*:Jan`, `hello@janzheng.com:Jan` #messaging #mailroom-sender-aliases
- [x] **Newsletter auto-name** — `src/messaging/newsletter-name.ts` postClassify hook. When classifier tags `newsletter`, pulls display name from `fields.from_addr` (`"Sidebar.io" <hello@uxdesign.cc>` → `newsletter:sidebar-io`). Defers to manual `sender:*` when present. 17 tests #messaging #mailroom-newsletter-auto-name
- [x] **Double-opt-in detector + auto-click** — `src/messaging/confirm-detect.ts` postClassify hook: subject heuristic + body URL extraction (prefers anchor-line URLs, then path-hint URLs like `/subscribe/confirm`, avoids `unsubscribe` paths). Writes `fields.confirm_url` + `needs-confirm` label. Auto-click surface: `POST /inbox/:name/confirm/:id` (gated on `needs-confirm` so the endpoint isn't an arbitrary URL fetcher) + `sm_inbox_confirm` MCP tool. 33 tests. CLAUDE.md now instructs future sessions to always sweep `needs-confirm` before summarizing the mailroom #messaging #mailroom-confirm-detect
- [x] **Auto-confirm on ingest (allowlist-gated)** — `src/messaging/auto-confirm.ts` postClassify hook that runs after confirm-detect. For senders matching `AUTO_CONFIRM_SENDERS` globs, GETs the extracted `fields.confirm_url` at ingest, swaps `needs-confirm` → `auto-confirmed`, writes `fields.auto_confirmed_at` + `auto_confirm_status`. Safety: HTTPS-only, named-domain hosts only (rejects raw IPs), URLs containing `unsubscribe`/`opt-out` rejected defensively, 10s timeout, upstream 4xx/5xx leaves labels unchanged so manual retry still works. Current allowlist: `*@substack.com`, `*@substackmail.com`, `*@convertkit.com`, `*@beehiiv.com`, `*@mailerlite.com`, `*@emailoctopus.com`, `*@uxdesign.cc`. 35 tests #messaging #mailroom-auto-confirm

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

- [x] **blob-middleware aws-sdk lazy-load — SHIPPED 2026-04-24** — `src/blob-middleware/resolver.ts` got the postal-mime recipe: cached module refs (`_S3Module` / `_S3PresignerModule`), lazy `loadS3()` / `loadS3Presigner()` helpers with helpful "install @aws-sdk/..." errors, shared `buildR2Client()` factory dedup'd across upload + delete paths #plugin-discipline #blob-middleware-aws-lazy
- [x] **r2-direct adapter lazy-load — SHIPPED 2026-04-24** — same recipe applied; static `import { S3Client, ... }` removed; `s3Client` constructed lazily on first method via async `getClient()`; type annotations loosened to `any` so dnt doesn't re-pin aws-sdk into `dependencies`. Combined with the postBuild hook in `scripts/build-npm.ts`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` are now `peerDependencies (optional)` in `dist/package.json` instead of `dependencies` — npm consumers no longer force-install ~50MB of aws-sdk for nothing if they don't use r2 #plugin-discipline #r2-direct-lazy
- [x] **Notion adapter lazy-load — SHIPPED 2026-04-24** — `src/clients/notion/notionModern.ts` got the recipe. Static `import { Client }` flipped to `import type { Client }`; new `loadNotionClient()` cached lazy loader; `_resolveClient()` instance method builds the SDK Client on first method call (auth secret captured in constructor). All 21 internal `this.client.X` call sites + 10 `(this.client as any).X` SDK-version-fallback sites rewritten to `(await this._resolveClient()).X`. Public `getClient()` is now `async` (small breaking change for downstream consumers if any rely on sync access). The notion *adapter* (`src/adapters/notion.ts`) only imports `NotionModernClient` + `.d.ts` types — no runtime change there #plugin-discipline #notion-lazy
- [x] **unstorage adapter lazy-load — SHIPPED 2026-04-24** — `src/adapters/unstorage.ts` got the recipe. Static top-level `import { createStorage } / upstashDriver` removed; `loadUnstorage()` + `loadUpstashDriver()` cached loaders. The CF-driver branches were already dynamic; the upstash branch was sync — now async (returns a Promise the existing `_storageReady` machinery already normalizes). Combined with the postBuild stripper, **`dist/package.json` `dependencies` is now `{}`** — every adapter SDK is an optional peerDep. yarn.lock shrinks another 133 lines on top of aws-sdk's 1100 #plugin-discipline #unstorage-lazy
- [?] Add all adapters to `build-npm.ts` `entryPoints` — currently only 5 CF adapters are in npm sub-entries; deno.json already has all adapters. Enables per-adapter npm imports for tree-shaking without factory-slim #plugin-discipline #adapter-npm-entrypoints
- [?] Remove adapter re-exports from root `mod.ts` — **breaking change** for 0.3.0 major. Consumers migrate to per-adapter imports; factory-slim becomes the default factory. Do after the lazy-load pass above, so the migration target exists #plugin-discipline #adapter-reshape-breaking

**Intentionally NOT on this list:** search/BM25 coupling. `src/search/` is imported by 7 adapters for BM25 indexing; this is **intentional core by design** (ubiquitous utility promotes to core, not a leak). Documented in `docs/design/PLUGIN-AUTHORING.md § When something is core vs. a plugin`.

### Motivating examples parked (not in the sprint; unblocked by discipline doc)

- [?] Obsidian adapter + channel — ~100 LOC adapter (frontmatter-aware local-file); channel is a vault watcher
- [x] [done: RssChannel + pull-runner + boot-registered biorxiv inbox, 60 items ingested end-to-end 2026-04-23] RSS channel — pull-shape
- [?] Webhook channel — push-shape; the "agentic feeders dump data somewhere" affordance
- [?] Tigerflare adapter — parked + questioned; tigerflare is being used the OTHER direction today. Re-evaluate when a real consumer appears

### Mailroom — Wave 3 (not shipped in the EOD sprint)

See `TASKS-MESSAGING.md` § Later for the full deferred list (read/unread state, rules table, spam layers, MCP `sm_inbox_*` tool family, raw/attachments export inlining, 14 Wave 1/2 #discovered follow-ups).

### Publishing + infra

- [?] **npm publish — PARKED indefinitely.** Smallstore is JSR-first; the dist build (`deno task build:npm`) is Node-compatible and the Worker already consumes it via `file:../dist`, so npm-shape correctness is exercised. But there's no real Node consumer asking for it on the registry today. Promote when a real Node consumer materializes — `cd dist && npm publish` is the one-shot, peerDeps split is already correct. Do NOT surface as a default next-step. #npm-publish #parked
- [?] **npm validation in Node.js projects** — same trigger as the publish task above #npm-validate #parked
- [ ] Migrate coverflow-workers into smallstore-owned worker `-> foxfire .brief/smallstore-workers-takeover.md` #infra

### Known issues

- [x] **Sheetlog adapter `set()` is destructive — added non-destructive `append()` path** #sheetlog #bug 2026-04-21
    - Added `append?(items)` to `StorageAdapter` interface
    - Implemented `SheetlogAdapter.append(items)` — direct wrap of `client.dynamicPost()`, bypasses the destructive `set()` bulkDelete
    - Added `Smallstore.append(collectionPath, items)` router method with append-specific mount resolution (bare collection paths match `pattern/*` mounts, unlike routeData which requires trailing segment)
    - Added `POST /api/:collection/append` HTTP handler (`handleAppend`) — returns 501 if adapter doesn't implement native append
    - Added `sm_append` MCP tool (new MCP tool registration requires client restart)
    - Tested end-to-end against the faves yawnxyz sheet: test row landed, existing rows preserved
    - Docs remaining: update `examples/.smallstore.json.sheetlog-docs.md` and the MCP `SKILL.md` to reference `sm_append` / `/append` endpoint for sheetlog writes; mark the old "per-row keys for append-style logging" advice as deprecated (it doesn't actually work). **This is a doc-only TODO.**
- [x] ~~Sheetlog adapter original TODO (superseded above)~~ — **SHIPPED 2026-04-24 (guard)**: `SheetlogAdapter.set(key, value)` and `delete(key)` now throw with actionable errors pointing at `append()` / `upsert()` / `replace()` (explicit wipe-and-reseed) / `clear()`. Previously both silently wiped the entire tab because `key` was ignored. `clear()` keeps the explicit whole-sheet wipe; `append()` / `upsert()` / `merge()` paths unchanged. Docs updated: `examples/.smallstore.json.sheetlog-docs.md`, `skills/smallstore/SKILL.md`, `src/adapters/README.md`, `src/adapters/SHEETLOG-QUICK-START.md` (banner added). Live test `tests/live-adapters.test.ts` switched from `adapter.set()` → `adapter.append()`. 13 new guard tests in `tests/adapter-sheetlog-guard.test.ts` (all green; no network); 557/557 messaging + adapter suite green.
    - **Additional findings from 2026-04-21 pilot test — status update:**
        - **Bug #2 (DYNAMIC_POST silent-accept without `_id`): LIVE 2026-04-24** on `SmallstoreTest` (.env SM_SHEET_URL). Patched `handlePost` + `handleDynamicPost` in `/Users/janzheng/Desktop/Projects/__active/sheetlog/sheetlog.js`; Apps Script editor source replaced and redeployed via Deploy → Manage deployments → pencil → New version. Verified via `tests/live/sheetlog-patches/verify.ts`: response shape flipped from bare `{status:201}` → `{status:201, data:{message, count}}`. `_ids: [...]` appears when the tab's header row contains `_id`; current `SmallstoreTest` tab has no such column, so ensureId returns null and `_ids` is omitted — correct by design. Other sheetlog deployments (decentralized by design per sheetlog's container-bound GAS model) remain on old code until individually redeployed.
        - **Bug #3 (UPSERT with `idColumn: "url"` doesn't match): NOT REPRODUCED cleanly**, possibly a timing artifact from the pilot test. Deferred pending a clean repro.
        - **Bug #4 (BULK_DELETE/DELETE by `_id` value vs row-number): LIVE 2026-04-24** on `SmallstoreTest`. Patched `handleDelete` + `handleBulkDelete` take the new `byId: true` branch — verified because the server now returns a structured `{error: {code: "id_column_not_found"}}` when `byId` is set on a sheet without an `_id` header, which only the patched code path produces (pre-patch silently treated ids as row-numbers). Smallstore's vendored TS client already exposes the `byId` param on `delete()` + `bulkDelete()` — no client changes needed.
- [x] LLM/agent features → see [TASKS-MAP.md Phase 8](./TASKS-MAP.md) (rerank, context window, RAG pipeline, semantic recall, working memory, etc.)

## Validation Holes

Pre-existing gaps from the 0.1.0 publish validation — none blocking, just need credentials to flip:

- [ ] `deno task interview:serve` — needs `GROQ_API_KEY` or `OPENAI_API_KEY`
- [ ] `deno task auth:airtable` — needs Airtable env vars
- [x] `deno task paste` — `.env` loading bug (pre-existing, not a publish blocker)
- [x] Cloudflare DO live test — DO binding not active on deployed worker (12/13 live adapter tests green)

## Dependency Notes

- [x] **Zod 4 migration shipped in coverflow on 2026-04-20** (`coverflow-v3` commits `2b9f8c04` + `c37d9722` + `36546951`). Smallstore is unaffected — grep confirms zero zod imports in `src/`. The "smallstore Zod schemas need updating too" note from the original v3-vs-v4 standoff turned out to be moot.
- [x] **Notion v5 cleanup learnings from coverflow** (cross-reference `/Users/janzheng/Desktop/Projects/_deno/coverflow/coverflow-v3` Archive section in TASKS.md):
  - The SDK v5 `after` param on `blocks.children.append` is `@deprecated` in types but still accepts at runtime. Coverflow added `position` support alongside `after` — same change applied here on 2026-04-21
  - Coverflow had a dead `shared/notion/api/` wrapper directory (13 files, zero imports) that hard-coded a v4-only `databases.query` call. Worth a periodic grep here for similar abandoned wrappers — they'd silently break a future bump
  - Coverflow's `notionModern.queryDatabase()` uses dataSources.query exclusively. Smallstore's version is more sophisticated — has SDK v4 fallback + raw HTTP fallback for older API versions. Keep the smallstore approach
- [x] @notionhq/client v5 and @modelcontextprotocol/sdk v1.29 both accept zod ^3.25 || ^4.0 — no forced upgrade if smallstore ever does add zod schemas
