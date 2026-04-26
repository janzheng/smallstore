# Smallstore — Messaging

Area backlog for the new `messaging` plugin family — `Channel` + `Inbox` + (later) `Outbox`. Design lives at `.brief/messaging-plugins.md`. First consumer: `__resources/collections/mailroom/`.

## Decisions

- [x] [decided: plugin family alongside materializers/search/retrievers/views] Messaging is a plugin family — `Channel`, `Inbox`, `Outbox` are NOT new adapter types. Storage backing is any existing adapter
- [x] [decided: one Worker, config-driven] Deployment shape — one CF Worker (the existing `serve.ts` extended), N inboxes from config. Adding a channel TYPE = PR to package; adding an inbox using existing channel TYPE = config row
- [x] [decided: extend serve.ts] Reuse existing `serve.ts` host instead of inventing a separate `smallstore-host`. Add `email()` + `scheduled()` exports for CF Email channel + pull-channel cron
- [x] [decided: extend `requireAuth`] Reuse existing `SMALLSTORE_TOKEN` bearer-token middleware (`serve.ts:144-167`) for new inbox + admin routes
- [x] [decided: support both static AND runtime config] Static config from `.smallstore.json` populates registry at boot; admin API mutates registry at runtime. Same in-memory inbox registry under the hood
- [x] [decided: defer Outbox to v2] Ship Inbox + Channel first. Outbox sketched in brief for architectural coherence; built when first send use case is real (likely "agentic email responder")
- [x] [decided: opaque string cursors] Server-supplied opaque cursors (not raw ISO timestamps) — resilient to clock skew + internal index changes
- [x] [decided: filter specs live in consumer] Markdown filter specs (mailroom's `filters/`) describe consumer intent; not stored in smallstore
- [x] [decided 2026-04-26: bioRxiv polling parked from smallstore's side] bioRxiv RSS is gated by Cloudflare's bot challenge for external IPs. Even though Path B (in-Worker pull-runner) bypasses CF's gate Worker→Worker, the feed itself is unreliable enough that other tools (collections-side enrichers, valtown enrichment trios) handle bioRxiv ingest end-to-end. The `biorxiv` inbox stays boot-registered as a generic POST target — external tools push items via `POST /inbox/biorxiv/items` when they have content. No peers, no in-Worker polling. bioRxiv RSS is now useful only as a validation case for the graceful-CF-block code path in the valtown poller
- [?] Deletion semantics — expose `DELETE /inbox/:name/items/:id` for spam (with audit row), or require separate admin tool? Lean expose
- [?] Pull-channel runner — share one scheduler module across RSS/API-poll/scrape, or per-channel? Lean shared, hooked to `scheduled()` Worker export

## Bugs found + fixed during first deploy (2026-04-23)

- [x] [fixed: scripts/build-npm.ts — `shims: { deno: false }`] dnt's `@deno/shim-deno` references `__dirname` which breaks in Workers ESM bundle. Disabling the shim cut bundle from 2MB to 533KB and unblocked deploy
- [x] [fixed: src/adapters/helpers/cloudflare-config.ts — removed top-level `import "jsr:@std/dotenv/load"`] Library files shouldn't load dotenv at module init; that's the app's job. The import broke the Workers bundle (`Deno is not defined` from dotenv module init)
- [x] [fixed: src/adapters/cloudflare-d1.ts ensureTable — single-line SQL via `prepare().run()` instead of `binding.exec()`] D1's `exec()` splits on newlines and requires each line to be a complete statement; the multi-line CREATE TABLE template tripped `Error in line 1: incomplete input: SQLITE_ERROR`. **First write through native D1 mode was broken before this fix** — anyone using cloudflare-d1 in native (binding) mode would hit it
- [x] [fixed: deploy/src/index.ts imports from `@yawnxyz/smallstore/factory-slim`] Root `mod.ts` re-exports ALL adapters, including SQLite which loads `@db/sqlite` (Deno FFI) at module init. factory-slim.ts is purpose-built for "create the router without pulling adapter barrels" — exactly what Workers need. Added as a build-npm subpath
- [x] **dist/ refresh trap** — yarn's `file:` link uses checksum on package.json; rebuilding dist with same package.json (different code) → yarn says "Already up-to-date" and keeps the OLD link. Workaround: `rm -rf deploy/node_modules/@yawnxyz && yarn install --force`. The `predeploy` hook in deploy/package.json triggers a fresh dist build but doesn't auto-prune; document for future contributors

## Plugin discipline — SHIPPED 2026-04-24

Full audit + `docs/design/PLUGIN-AUTHORING.md` + postal-mime lazy-load fix all shipped 2026-04-24. Archive: `TASKS.done.md § 2026-04-24`. Deferred adapter-level reshape tasks live in top-level `TASKS.md § Later` → Plugin discipline.

## Risks

- [!] **CF Email Routing free-tier inbound limits** (~few hundred/day historically) — fine for personal mailroom, may bottleneck if mailroom ever ingests high volume. Watch for; paid plan is the escape valve
- [!] **CF Worker `email()` handler timeout** (sub-30s) — channel parser + storage write must complete synchronously; expensive ops (vector embedding, full-text indexing) deferred to follow-up Workflows
- [x] **Schema drift risk** — channel parsers' `fields` shape is the contract every downstream consumer reads. Plan: version channels (`source: 'email/v1'`); additive changes only; document in `inbox-pattern.md`
- [x] **Runtime-inbox leak** — caller-created inboxes accumulate if TTL not enforced or admin forgets to DELETE. Mitigation: server-side TTL cleanup + admin list endpoint with creation timestamps
- [x] **Auth-token-on-disk** — mailroom collection scripts need the bearer token in `.env`; standard "secret in dotfile" risk. Document rotation procedure

## Phase 1: Deploy host -> 2026-Q2

Get the existing `serve.ts` running on Cloudflare Workers as the personal smallstore deployment. **No messaging changes yet** — this validates the deploy pipeline so subsequent phases just add routes.

- [x] [decided: smallstore.labspace.ai] Decide on a domain for the smallstore host #host #deploy
- [x] [done: deploy/wrangler.toml — TOML form, mirrors coverflow-proxy] D1 (MAILROOM_D1) + R2 (MAILROOM_R2) bindings declared (database_id placeholder for `wrangler d1 create`) #host #deploy
- [x] [done: deploy/src/index.ts — node-shaped Worker, not re-export from serve.ts] Worker entry that builds Hono app + smallstore + InboxRegistry + email handler from the dist npm package via file:../dist #host #deploy
- [x] [done: 2026-04-23] `SMALLSTORE_TOKEN` set via `wrangler secret put` (piped from .env). Token saved in `deploy/.env` (gitignored) #host #deploy #auth
- [x] [done: 2026-04-23 — Version ID 5ab5e8ae-2634-42eb-aa9d-2f30b161892c] First deploy live at https://smallstore.labspace.ai #host #deploy
- [x] [done: 2026-04-23] Smoke tests: `/health`, `/`, `/admin/inboxes` (auth + no-auth), POST item, GET item, query (hit + miss), cursor — all green via real D1 + R2 bindings #host #verify
- [x] [done: deploy/README.md — install/build/d1-create/r2-create/secret/deploy/verify, plus Email Routing wire-up + failure modes] Deploy procedure documented #host #docs
- [x] **Bonus: build infra**
    - [x] [done: scripts/build-npm.ts updated] Added `./messaging`, `./messaging/types`, and CF adapter subpaths (`memory`, `cloudflare-{d1,r2,kv,do}`) to dnt entry points; bumped to `@yawnxyz/smallstore@0.2.0`; added postal-mime to dependencies + mappings
    - [x] [done: dist/ regenerated] `deno task build:npm` produces fresh `dist/esm/src/messaging/{cf-email,inbox,...}.js` with `import 'postal-mime'` rewriting confirmed
    - [x] [done: deploy/package.json] Wires `@yawnxyz/smallstore` → `file:../dist`; `predeploy` hook auto-rebuilds; scripts for `d1:create`, `r2:create`, `secret:set`, `tail`, `dev`

## Phase 2: Channel + Inbox interfaces -> 2026-Q2

Library code for the messaging plugin family. No HTTP / Worker / channel implementation yet — just the types and the in-memory plumbing.

- [x] [done: src/messaging/{mod,types}.ts] Create `src/messaging/` module skeleton #messaging #scaffold
- [x] [done: types.ts] Define `Channel<TRaw, TConfig>` interface (push + pull shapes) #messaging #channel-iface
- [x] [done: types.ts] Define `Inbox` interface (`list`, `read`, `query`, `cursor`, `_ingest`, optional `watch`) #messaging #inbox-iface
- [x] [done: types.ts] Define `InboxItem`, `InboxItemFull`, `InboxFilter`, `Attachment` types #messaging #inbox-iface
- [x] [done: types.ts] Sketch `Outbox`, `OutboxDraft`, `OutboxStatus` types — no impl #messaging #outbox-stub
- [x] [done: src/messaging/inbox.ts] Implement `Inbox` reference class — `_index` key + content-addressed dedup, storage-agnostic #messaging #inbox-impl
- [x] [done: src/messaging/cursor.ts] Implement opaque cursor encoding/decoding (`v1.<base64url(json)>`) #messaging #cursor
- [x] [done: src/messaging/filter.ts] Implement `InboxFilter` evaluator — 14 unit tests cover AND/OR/text/labels/since/until/source/thread #messaging #filter-eval
- [x] [done: src/messaging/filter-spec.ts] Add markdown frontmatter parser — handles `_in` array suffix + Date normalization #messaging #filter-spec
- [x] [done: tests/messaging-inbox.test.ts, 11 tests] Unit tests: ingest dedup, cursor pagination, query, read full #messaging #tests
- [x] [done: tests/messaging-filter-spec.test.ts, 9 tests] Unit tests: filter spec parser #messaging #tests
- [x] [done: jsr.json + deno.json] Export `./messaging` and `./messaging/types` #messaging #publish

## Phase 3: HTTP routes + admin API -> 2026-Q2

Wire the Inbox plugin into the existing HTTP layer so consumers (mailroom collection scripts, MCP, agents, runtime-config callers) can read and write over HTTP.

- [x] [done: src/messaging/http-routes.ts] HTTP route registration function `registerMessagingRoutes` — colocated with messaging module, not in `src/http/handlers.ts` (cleaner; messaging is its own surface) #messaging #http
- [x] [done: src/messaging/http-routes.ts] Bind `POST /inbox/:name/items`, `GET /inbox/:name`, `GET /inbox/:name/items/:id`, `POST /inbox/:name/query`, `GET /inbox/:name/cursor` — all behind injected `requireAuth` #messaging #http
- [x] [done: src/messaging/http-routes.ts] Admin routes — `POST/GET/DELETE /admin/inboxes[/:name]`, plus `GET /admin/channels` #messaging #admin-api #runtime-config
- [x] [done: src/messaging/registry.ts] In-memory `InboxRegistry` (populated at boot, mutable via admin API) + module-level `ChannelRegistry` (channels self-register) #messaging #registry
- [x] [done: registry.prune()] TTL cleanup method — caller hooks to setInterval/DO alarm. Boot-time inboxes never reaped #messaging #ttl #runtime-config
- [x] [done: config.ts inboxes field + resolveInboxStorage()] `inboxes:` section parsed; storage refs resolved to adapter instances at boot. Wired into serve.ts #messaging #config
- [x] [done: tests/messaging-http.test.ts, 17 tests] HTTP integration tests — POST/GET/query/cursor/pagination/auth/admin CRUD #messaging #tests

## Phase 4: CF Email channel + email() handler -> 2026-Q2

The first concrete `Channel` implementation, plus the Worker entry point that wires it.

- [x] [done: src/messaging/channels/cf-email.ts] CloudflareEmailChannel — postal-mime parser, EmailInput shape decouples from CF runtime types #messaging #channel-cf-email
- [x] [done: cf-email.ts field mapping] from_addr/from_email/to_addrs/cc_addrs/subject/message_id/date_header/in_reply_to/references/has_attachments + SPF/DKIM/DMARC verdicts #messaging #channel-cf-email
- [x] [done: BODY_INLINE_THRESHOLD = 64KB] Body-size policy — text inline if <64KB; else `body/<id>.txt` blob with `body_ref` #messaging #channel-cf-email
- [x] [done: attachments/<id>/<safe-filename>] Attachment handling — extracted to blobs map; metadata on `item.fields.attachments`. Path-traversal sanitized #messaging #channel-cf-email
- [x] [done: html/<id>.html always blob] HTML body always to blobs (never inlined) #messaging #channel-cf-email
- [x] [done: detectAutoReply()] Bounce/OOO detection via `labels` (Auto-Submitted header + heuristic patterns) #messaging #channel-cf-email
- [x] [done: contentAddressedId hash of message_id||raw_size] Idempotency — verified by 2 tests #messaging #channel-cf-email #tests
- [x] [done: tests/fixtures/cf-email/01-07] 7 .eml fixtures: plain text, multipart-html, with-attachment, no-message-id, bounce, ooo, threaded-reply #messaging #fixtures
- [x] [done: tests/messaging-channel-cf-email.test.ts, 18 tests] Unit tests — field mapping, blobs, body-size policy, idempotency, filename safety #messaging #tests
- [x] [done: serve.ts exports `email`] Wire emailHandler — `export const email = createEmailHandler({ registry })` from serve.ts; `deploy/worker.ts` re-exports it (Phase 1) #messaging #serve-handler
- [x] [shipped earlier — never flipped] Update `deploy/worker.ts` to re-export email — superseded: deploy structure became `deploy/src/index.ts`, which has its own `email` export wired through `createEmailHandler`. `serve.ts:356` also exports for local dev. #messaging #deploy
- [x] [shipped earlier — never flipped] Extend wrangler config — D1 + R2 bindings + email routing — bindings live in `deploy/wrangler.toml` (TOML form per the dist refresh-trap fix), email routing rule `d9d99419edc64a0ab92582ef4de91740` created via `wrangler email routing rules create`. #messaging #deploy
- [x] [shipped earlier — never flipped] Redeploy with email handler; verify `email()` is registered — has happened ~30+ times since 2026-04-23; latest deploy `219d88a4` confirms `email` export still wired. Real emails landing in mailroom is the daily smoke test. #messaging #deploy #verify
- [x] **Bonus: tests/messaging-email-handler.test.ts (6 tests)** — end-to-end orchestrator: read stream → parse → ingest → blobs persisted; idempotent on re-delivery; fan-out to multiple inboxes; setReject when no inbox configured #messaging #tests

## Phase 5: Wire mailroom (the integration test) -> 2026-Q2

End-to-end: real email → deployed smallstore → mailroom collection materialization.

- [x] [decided: mailroom@labspace.ai — specific address, not catch-all] Inbox domain pick #mailroom #domain
- [x] [done: 2026-04-23 — rule id d9d99419edc64a0ab92582ef4de91740, "to: mailroom@labspace.ai" → worker:smallstore via wrangler email routing rules create] CF Email Routing wired #mailroom #routing
- [x] [done: 2026-04-23 — id b4d71d61-a96f-4f27-9d06-c08215cd1ccc, region WNAM. Schema is the kv-shaped `mailroom_items` table created lazily by CloudflareD1Adapter (after the multi-line CREATE fix); the README.md schema is the *target* for a future StructuredSQLite-backed inbox variant] MAILROOM_D1 created #mailroom #d1
- [x] [done: 2026-04-23] MAILROOM_R2 bucket created (Standard storage class) #mailroom #r2
- [x] [done: 2026-04-23 — wired in deploy/src/index.ts as `createInbox({ channel: 'cf-email', storage: { items: d1, blobs: r2 } })` and registered at boot] Mailroom inbox in deployed config #mailroom #config
- [x] [done: 2026-04-23 — gmail → mailroom@labspace.ai → CF email() → postal-mime → D1+R2. id `0ead589ed94cfbd08e6aa0206f4d6c9f`. Subject/body/from/thread_id/sent_at/raw_ref all populated. Raw .eml verified in R2 with full headers (DKIM, mailgun routing path)] Real test email landed end-to-end #mailroom #verify
- [ ] Update `__resources/collections/mailroom/_tools/sync-raw.ts` to call `GET /inbox/mailroom?cursor=<saved>` instead of D1 directly. Saves new high-water mark locally #mailroom #consumer #needs:http
- [ ] Update `__resources/collections/mailroom/_tools/sync-filtered.ts` to read filter spec → `POST /inbox/mailroom/query` → materialize. Use `src/messaging/filter-spec.ts` parser (export it for consumers) #mailroom #consumer #needs:filter-spec
- [ ] Update mailroom `.env.example` to include `SM_BASE_URL` + `SMALLSTORE_TOKEN` #mailroom #docs
- [ ] First real filter — pick a real high-volume sender (newsletter), write `__resources/collections/mailroom/filters/<that-newsletter>.md`, run `sync-filtered`. Forces the full path through real use #mailroom #verify
- [ ] Add `inbox/raw/` and `items/` to mailroom collection's `.gitignore` (privacy default per its CLAUDE.md) #mailroom #privacy

## Phase 6: MCP tools -> 2026-Q2

Expose Inbox operations via MCP so agents can read inboxes without local install.

- [x] [shipped — moved to `src/mcp/tools/inbox.ts` during MCP reorg sprint] Register `sm_inbox_list`, `sm_inbox_read`, `sm_inbox_query` (cursor surfaced via list response). 19+ inbox tools live (verified mid-session). #messaging #mcp
- [?] **Admin MCP tools — NOT YET shipped**: `sm_inbox_create`, `sm_inbox_delete_inbox` (rename to disambiguate from per-item `sm_inbox_delete`), `sm_inbox_list_admin`. The HTTP `/admin/inboxes` surface exists; just no MCP wrapper. Promote when a real "spin up runtime inbox via Claude" workflow appears #messaging #mcp #runtime-config #needs:admin-api
- [x] [shipped earlier — never flipped] Update smallstore MCP `SKILL.md` — `skills/smallstore/SKILL.md` covers the inbox tool family and is mcp-hub-synced to `~/.claude/skills/` + `~/.cursor/skills/` + `~/.codex/skills/` + `~/.agents/skills/` #messaging #mcp #docs
- [x] [shipped earlier — never flipped] Restart MCP client + verify tools callable — done after every tool addition; CLAUDE.md documents the `claude mcp remove` + `add` re-register dance. #messaging #mcp #verify

## Later

### RSS as mailbox — bioRxiv + future feeds (design: `.brief/rss-as-mailbox.md`)

Two paths: fast (external poller POSTs via existing `/inbox/:name/items`) and later (in-Worker RSS channel). Start fast. Promote to in-Worker when 3+ feeders or valtown hiccups bite.

**Path A — ship today via valtown poller:**
- [x] [done 2026-04-25: registered `biorxiv` inbox via POST /admin/inboxes against smallstore.labspace.ai. Hit a real bug on first attempt — both inboxes shared `mailroom_d1` adapter, but Inbox class uses hardcoded `_index` + `items/` keys → collision. Fixed by adding a dedicated `biorxiv_d1` adapter (same MAILROOM_D1 binding, table `biorxiv_items`) in deploy + redeploy at version `ad0f065d`. R2 shared (content-addressed blob keys). Verified: `/inbox/biorxiv` returns empty cleanly, mailroom items unaffected] Register biorxiv inbox #rss-biorxiv-inbox
- [x] **`Inbox` keyPrefix option — SHIPPED 2026-04-24** — added `keyPrefix?: string` to `InboxOptions` + `InboxConfig`. Inbox class derives `indexKey` + `itemPrefix` from the prefix; helper `itemKey()` is now a method. Default `''` keeps the historical bare `_index` + `items/<id>` layout (mailroom + boot-time biorxiv/podcasts unchanged). `POST /admin/inboxes` auto-defaults `keyPrefix: 'inbox/<name>/'` for runtime inboxes so multiple runtime inboxes can share one D1 table without `_index` collisions; explicit `keyPrefix` in the body overrides. Wired through `serve.ts` + `deploy/src/index.ts` factories so `cfg.keyPrefix` flows into `createInbox()`. 4 new unit tests in `tests/messaging-inbox.test.ts` (backwards compat, prefixed layout, namespace isolation, list/query/cursor/delete-scoped) + 4 new HTTP tests in `tests/messaging-http.test.ts` (auto-default, explicit override, two-runtime-on-shared-adapter, GET surfaces resolved keyPrefix). 540/540 messaging tests green; `deno check mod.ts` clean #inbox-keyprefix-isolation
- [x] **Valtown poller — SHIPPED 2026-04-26** — generic RSS-to-smallstore template at `examples/valtown-biorxiv-poller.ts`. Uses `npm:rss-parser`, content-addressed `id = sha256(feed_url + ':' + guid).slice(0, 32)` (matches Path B's formula → both paths dedup cleanly against the same feed). Env-driven config: `FEED_URL` / `TARGET_INBOX` / `DEFAULT_LABELS` / `SMALLSTORE_URL` / `SMALLSTORE_TOKEN` / `DRY_RUN`. Graceful 403/CF-challenge detection (logs `fetch_blocked` in summary, exits 0 — valtown cron doesn't error-spam). Smoke-tested locally against HN RSS (20 items parsed, IDs computed, dry-run clean). **bioRxiv-specific finding:** bioRxiv is gated by Cloudflare's bot challenge — external pollers (valtown, local CLI) get 403's even with browser UA. Path B (in-Worker pull-runner already running on smallstore.labspace.ai) reaches bioRxiv successfully because Worker→Worker bypasses the bot gate. So this val is the right shape for permissive feeds (arXiv, HN, Substack export-as-RSS, blogs); for bioRxiv specifically, use Path B by re-enabling the bioRxiv peers in the registry. Header docs in the val explain the caveat. #rss-valtown-biorxiv-poller
- [x] **Valtown fanout via env config — addressed 2026-04-26 alongside the poller** — same val template can be cloned per feed (different env vars per val) OR generalized into one val that loops a feed-config array. The env-driven config is the foundation; clone-per-feed is the simplest deploy pattern. Promote to single-val-multi-feed when the count gets unwieldy (5+ feeds). #rss-valtown-fanout
- [~] **Add bioRxiv subjects (bioinformatics/genomics/etc) — DROPPED 2026-04-26.** bioRxiv polling parked from smallstore's side (see Decisions). For non-CF-gated sources (arXiv, HN, Substack export-as-RSS, blogs) clone the valtown val with new `FEED_URL` + `TARGET_INBOX` + `DEFAULT_LABELS`. #rss-biorxiv-coverage
- [ ] Document the pattern in valtown-side README so other agentic feeders reuse the template #rss-valtown-docs

**Path B — in-Worker RSS channel (defer until trigger fires):**
- [ ] `src/messaging/channels/webhook.ts` — generic HTTP receiver. Optional HMAC validation in `auth: { hmac: 'env:SECRET' }`. POST body → InboxItem via configurable JSON-path mapping. Useful independently (structured target for ANY external poller) #messaging #channel-webhook
- [ ] `src/messaging/channels/rss.ts` — pull-shape Channel<RssInput>. Parse feed, dedup by `<guid>`, map to InboxItem. Needs the runner #messaging #channel-rss #needs:pull-runner
- [ ] `src/messaging/channels/api-poll.ts` — generic JSON polling. Config: URL, response-path, item-id field, headers #messaging #channel-api-poll #needs:pull-runner
- [ ] `src/messaging/channels/voice.ts` — for voice-agent transcript streams (companion to `@cloudflare/voice` `withVoice`/`withVoiceInput`). Push-shape; transcripts arrive as InboxItems #messaging #channel-voice
- [ ] Pull runner — shared scheduler reading `inbox.schedule` from config; hooked to CF Worker `scheduled()` cron export. Per-feed watermark persistence. Per-channel concurrency cap #messaging #pull-runner
- [?] Promote path A → path B when: 3+ feeders OR valtown hiccup loses a day of data OR unified observability becomes valuable #rss-promotion-trigger

### Outbox

- [ ] Spike: D1-table-as-queue + R2-as-payload-store vs CF Queues + DO alarms — measure both for retry/backoff ergonomics. Decide before building #outbox #spike #needs:inbox-shipped
- [ ] `src/messaging/outbox.ts` — Outbox plugin: `enqueue` (idempotent), `status`, `list`, `cancel`, `history`. Reply linkage to inbox items #outbox #impl
- [ ] `src/messaging/channels/cf-email-out.ts` — first output channel. Wraps `env.EMAIL.send` (CF Email Sending public beta) #outbox #channel-cf-email-out
- [ ] HTTP routes for outbox — `POST /outbox/:name/send`, `GET /outbox/:name`, `GET /outbox/:name/items/:id/history`, `POST /outbox/:name/items/:id/cancel` #outbox #http
- [ ] MCP tools: `sm_outbox_send`, `sm_outbox_status`, `sm_outbox_list`, `sm_outbox_cancel`, `sm_outbox_history`, `sm_messaging_respond` (sugar: read inbox item + LLM callback + enqueue with `reply_to` + `idempotency_key`) #outbox #mcp
- [ ] Webhook output channel — `cf-webhook-out` — generic POST with retry policy. Useful for Slack, Discord, generic webhooks #outbox #channel-webhook-out

### Mailroom curation — SHIPPED 2026-04-25

Sprint complete. All ingestion hooks (forward-detect, plus-addr, rules), rules CRUD + retroactive apply, deploy wiring, polish (manual-tag, hard-delete, quarantine/restore routes, mainViewFilter), and removal taxonomy all live at `smallstore.labspace.ai`. Details + commits: `TASKS.done.md § 2026-04-25`. Sprint narrative: `.brief/2026-04-25-curation-sprint.md`. Design: `.brief/mailroom-curation.md`.

### Mailroom pipeline — remaining after curation sprint

- [x] **Newsletter auto-name + double-opt-in detector + auto-confirm** — 2026-04-24: shipped `src/messaging/newsletter-name.ts` (postClassify: reads `fields.from_addr`, extracts display name, adds `newsletter:<slug>` when the classifier already tagged `newsletter`; defers to manual `sender:*` labels), `src/messaging/confirm-detect.ts` (postClassify: subject heuristic for "confirm/verify subscription" patterns, body scan for confirm URL near anchor phrases or via path hints like `/subscribe/confirm`, explicitly avoids unsubscribe URLs; writes `fields.confirm_url` + `needs-confirm` label), and `src/messaging/auto-confirm.ts` (postClassify: follows `confirm_url` at ingest for senders matching `AUTO_CONFIRM_SENDERS` globs, swaps `needs-confirm` → `auto-confirmed`; HTTPS-only, domain-host-only, unsubscribe-URL-blocked defensively, 10s timeout). Manual-click surface: `POST /inbox/:name/confirm/:id` + `sm_inbox_confirm` MCP tool. 85 new tests total. CLAUDE.md instructs agents to always surface `needs-confirm` items as a callout and documents which senders auto-confirm #messaging #mailroom-newsletter-auto-name #mailroom-confirm-detect #mailroom-auto-confirm
- [x] **Read/unread state — SHIPPED 2026-04-24** — `stampUnreadHook` (postClassify, idempotent, skips `archived`/`quarantined`) wired into mailroom + biorxiv + podcasts. HTTP: `POST /inbox/:name/items/:id/read` + `/unread` (single, returns `{changed}`), `POST /inbox/:name/read` with `{ids}`, `POST /inbox/:name/read-all` with optional InboxFilter body (intersects with `labels:["unread"]` server-side, 10k hard cap with `capped: bool` response flag). MCP: `sm_inbox_mark_read` / `sm_inbox_mark_unread` / `sm_inbox_mark_read_many` (pass `ids` XOR `filter`). Existing pre-deploy items don't carry `unread` — only forward-stamping, by design. Docstring fix at `src/mcp/tools/inbox.ts` completed. 31 new tests (16 hook unit + 15 HTTP integration); 528/528 messaging suite green. Deploy: `27b36a8d-989e-45a8-8e53-d50098cc2fca`. #messaging #mailroom-read-state
- [?] **List-Id-derived newsletter slug (Beehiiv/ConvertKit polish)** — 2026-04-24: investigated + skipped. For Substack the `List-Id` header is just the author subdomain (same identity as display name) so `List-Id` extraction adds nothing; already `newsletter:<display-name-slug>` is the canonical identity. Value only appears for platforms that put a publisher-set human name in `List-Id` (Beehiiv sometimes does `"Publication" <slug.beehiiv.com>`). Promote when a real Beehiiv/ConvertKit case lands where the display-name-derived slug is actually wrong — otherwise adds ambiguity ("why is THIS newsletter tagged differently"). Escape hatch today: `SENDER_ALIASES` entry gives the item a `sender:<canonical-slug>` label manually #messaging #mailroom-newsletter-list-id-polish
- [x] **Runtime-configurable AUTO_CONFIRM_SENDERS — SHIPPED 2026-04-24** — `src/messaging/auto-confirm-senders.ts` (D1-backed `AutoConfirmSendersStore` with list/get/add/delete + per-pattern sentinels). Hook now reads via `getPatterns: () => store.patterns()` (cached 30s). HTTP: `GET /admin/auto-confirm/senders`, `POST /admin/auto-confirm/senders` (idempotent — same pattern returns existing row), `DELETE /admin/auto-confirm/senders/:pattern`. MCP: `sm_auto_confirm_list/add/remove`. Boot seeds from `AUTO_CONFIRM_SENDERS` env once per pattern (sentinel under `_seeded-auto-confirm/<pattern>`); runtime delete sticks across cold starts. New env patterns still seed on next boot. 16 store + 5 dynamic-source hook + 15 HTTP integration tests; 572/572 messaging green; `deno check mod.ts` clean #messaging #mailroom-auto-confirm-runtime-config
- [?] **MCP `sm_inbox_*` tool family** — `sm_inbox_list/read/query/unsubscribe/restore/quarantine_list/export/tag/delete/rules_*`. Doesn't exist yet; ship the family together so all inbox ops are equally exposed rather than one-off tools. Biggest remaining UX win — uses mailroom from inside Claude Code / Cursor without curl #messaging #mcp-inbox-family
- [?] Spam layers (non-LLM, composed as preIngest rules) — (1) regex blocklist terminal drop→quarantine, (2) header heuristics, (3) sender reputation `spam_count/count > 0.5 && count ≥ 3`, (4) content hash dedup. Rules engine already expresses layers 1-2 via user-configured rules; layers 3-4 need sender-reputation predicate + content-hash helpers. LLM classifier deferred as optional layer 5 #messaging #mailroom-spam #needs:mailroom-sender-index
- [x] **Attachment retrieval — SHIPPED 2026-04-24** — capture path was already live (cf-email channel writes `attachments/<item-id>/<filename>` to the blobs adapter + records metadata on `fields.attachments[]` since 2026-04-23); retrieval surface was the gap. New: `Inbox.readAttachment(itemId, filename)` (validates filename against `fields.attachments[]` to block path traversal, returns `null` for any miss including absent blobs adapter / partial-delete state); `GET /inbox/:name/items/:id/attachments` lists metadata + relative `download_url`; `GET /inbox/:name/items/:id/attachments/:filename` streams bytes through the Worker (`Content-Type` + `Content-Length` + `Content-Disposition` set; `?download=1` flips to attachment disposition). MCP: `sm_inbox_attachments_list`. 6 new inbox unit tests + 13 new HTTP integration tests; 591/591 messaging green; `deno check mod.ts` clean. Brief: `.brief/attachments.md` (capture/storage/retrieval/auth model/out-of-scope) #messaging #attachments
- [?] Raw + attachments inlining in export — `include=raw` base64-encodes the .eml; `include=attachments` adds presigned URLs. Body covers 80% of newsletter-to-LLM flows so these are polish (the new download endpoint covers most one-off retrieval flows; export-side inlining is for bulk LLM-feed pipelines) #messaging #newsletter-export-polish
- [x] **Forward-notes capture** — 2026-04-26: shipped in `src/messaging/forward-detect.ts`. New `extractForwardNote(body)` export anchors on the earliest Gmail/Outlook/Apple Mail separator, slices off the tail, strips trailing `On <date>, <Sender> wrote:` quote headers, collapses blank-line runs, and returns the trimmed note (or `undefined` when the anchor is missing or the text above it is empty). `ForwardDetectResult.forward_note` is populated and the hook writes `fields.forward_note`. 13 new tests in `tests/messaging-forward-detect.test.ts` (37/37 file green; 412/412 messaging green). Deploy pipeline unchanged — the existing forward-detect hook picks up the new field automatically on the next deploy #messaging #mailroom-forward-notes
- [x] **Sender-name aliases** — 2026-04-26: shipped as new `src/messaging/sender-aliases.ts` (207 LOC) — `SenderAliasRule[]`, `parseSenderAliases()` (accepts rule array, record, or CSV env-var string `pattern:name,pattern:name`), `matchSenderAlias()` (case-insensitive `*` glob, regex metachars escaped, first-match-wins, anchored), `slugifySenderName()` (lowercase, punctuation → dashes), `applySenderAlias()` (prefers `original_from_email` over `from_email` so forwarded mail tags the original sender), and `createSenderAliasHook()`. Exported from `src/messaging/mod.ts`. Wired into `deploy/src/index.ts` preIngest chain (position 2, between forward-detect and plus-addr); new `SENDER_ALIASES` env var documented in `deploy/README.md`. 31 new tests in `tests/messaging-sender-aliases.test.ts` (all green). Awaits `deno task build:npm` + deploy + `[vars]` entry in `wrangler.toml` #messaging #mailroom-sender-aliases

### Wave 1+2 discovered follow-ups (2026-04-24, none blocking)

- [?] Batch ingest in D1 messaging mode — `setMany(items: InboxItem[])` via `binding.batch([stmt1, ...])` — one round-trip per N items instead of N. Not in scope today; promote when mailroom volume makes ingest hot #messaging #d1-batch-ingest
- [?] Sender index D1 schema — when sender-index goes into production, add a `senders` table via `messagingMigrations` (currently all sender info is scanned from the items `fields` JSON). Cheap migration; promote when sender query latency becomes real pain #messaging #sender-index-d1-schema
- [?] FTS5 tokenizer choice — default tokenizer splits on hyphens and is ASCII-only case-insensitive. Consider `porter` (stemming for English) or `unicode61 remove_diacritics 2` (Unicode-aware). Worth a product call before promoting FTS5 to the HTTP surface #messaging #fts5-tokenizer
- [?] Test command flags in `docs/` — cf-d1 tests need `--allow-ffi --allow-net` (for @db/sqlite FFI + first-run dylib fetch), not just `--allow-read --allow-env`. Document in CONTRIBUTING or PLUGIN-AUTHORING #docs #test-flags
- [?] Spam reputation threshold — `isReputationSpam(record, { ratio, minCount })` configurable predicate. Referenced by brief § Spam layers; not encoded in sender-index yet #messaging #spam-reputation-predicate #needs:mailroom-rules
- [?] `markUnsubscribed(address)` action — explicit opt-in separate from automatic upsert. Needed for unsubscribe action surface (#7) #messaging #sender-unsubscribe-action #needs:mailroom-unsubscribe
- [?] `sender-index.query()` at scale — currently scans all keys via `adapter.keys(prefix)` + per-key get. Fine for MemoryAdapter; on D1 or Upstash with 10k+ senders wants a native `adapter.query()` path or a secondary tag index. Defer until senders count justifies #messaging #sender-index-scale
- [?] Unicode normalization on addresses — two senders with visually identical but NFC-vs-NFKC-different addresses treated as distinct. Probably fine; revisit if it bites #messaging #sender-unicode-norm
- [?] `multipart/report` subtype narrowing — classifier currently matches the full prefix (catches disposition-notification MDNs as 'bounce'). Narrow to `report-type=delivery-status` if false positives show up #messaging #classifier-report-narrow
- [?] `Return-Path: <MAILER-DAEMON@...>` shape — classifier misses this unless another signal fires. Add as a bounce signal if real bounces slip past #messaging #classifier-return-path-shape
- [?] Header value type drift — channels could deliver `string[]` multi-value headers; regex filter defensively coerces to string. Consider typed `InboxHeaders = Record<string, string | string[]>` + OR across entries in evaluator #messaging #filter-header-multivalue
- [?] Cross-invocation regex cache for filter — when the rules engine (#6) evaluates the same filter across a batch of items, recompiling per item is wasteful. `compileFilter(filter)` returning a closure. Promote when batch filtering hits measurable CPU #messaging #filter-regex-cache
- [?] cf-email `From` header fallback robustness — encoded-word display names (`=?utf-8?B?...?=`) without angle-bracketed address evade the bounce-from check. Low priority; `fields.from_email` already handles the normal path #messaging #classifier-from-encoded
- [?] **Inbox `_index` scaling cliff** — `Inbox` keeps a single JSON blob `<keyPrefix>_index = { entries: [{at, id}, ...] }`. Every ingest does read-modify-write on the whole blob; every list/query reads it whole. Storage itself is cheap (CF D1 $0.75/GB/mo, R2 $0.015/GB/mo — ~$8/mo at 10 GB), but the index is the actual bottleneck: ~80 KB at 1K items, ~800 KB at 10K, ~4 MB at 50K where D1 row-size limits start to bite. At current mailroom velocity (~2K items/year) we have ~5 years of runway before 10K. Candidate fixes when promoted: (a) shard `_index` by month — `_index/2026-04`, `_index/2026-05` — append-only per shard, (b) move index into a native D1 table (column on items, no separate blob), (c) JSONL append-only log + occasional compaction, (d) KV/DO for hot index. Pair with retention/prune tooling — soft-archive old items to R2-only and drop their D1 row. **Trigger:** any inbox crosses 10K items OR ingest latency becomes user-visible. Not blocking anything today #messaging #inbox-index-scaling #needs:retention-policy

### email() handler enhancements

- [?] **Per-address routing in `email()` handler.** Today, `email-handler.ts` `findByChannel('cf-email')` returns ALL inboxes registered for `cf-email` and ingests the same parsed item into every one (intentional fan-out). To support multi-inbox-per-channel by address (e.g. `mailroom@labspace.ai → mailroom`, `support@labspace.ai → support`), the handler needs to filter by `msg.to` (envelope_to) against either an inbox's `channel_config.address` OR a new `routes:` array on the inbox config. **Triggered by:** tigerflare bridge activation (see `_deno/apps/tigerflare/.brief/smallstore-bridge-activation.md`) OR any time we want a second receive address on labspace.ai. **Not blocking** anything today — we have one inbox + one route. #messaging #channel-cf-email #envelope-to-routing

### Polish

- [ ] `docs/design/messaging-pattern.md` — the plugin family explainer. Seven characteristics of an inbox, recommended D1 schema columns, filter spec format. Marks the channel/inbox/outbox contract as a public smallstore contract #messaging #docs
- [ ] `examples/cf-email-inbox/` — minimal CF Email channel walkthrough as a documentation-grade example for other smallstore users (not the user's own deployment) #messaging #examples
- [ ] Federated query — `sm_inbox_query` across multiple inboxes ("anything mentioning 'invoice' across mailroom + sms-room + forms-room") #messaging #federated-query
- [ ] Channel versioning conventions — `source: 'email/v1'`, `source: 'email/v2'`. Document additive-only field policy #messaging #docs #schema-stability
- [ ] Workflows V2 trigger from `inbox.watch` — when a matching item arrives, kick off a workflow instance. Durable execution from inbox event #messaging #workflows-integration

## Notes

- Brief: `.brief/messaging-plugins.md` (foundational primitives — InboxItem, Channel, Inbox)
- Brief: `.brief/mailroom-pipeline.md` (policy layer on top — sinks, hooks, rules, spam, unsubscribe; answers the "channel or system" question)
- Predecessor briefs (superseded): `research/_workshop/messaging-plugins-inbox-outbox.md`, `research/_workshop/inboxes-as-first-class.md`
- First consumer: `__resources/collections/mailroom/`
- Existing host: `serve.ts` (Hono, runs on Workers; gets `email` + `scheduled` exports added in Phases 1+4+later)
- Existing auth: `serve.ts:144-167` — `SMALLSTORE_TOKEN` bearer-token middleware; reused by all new routes
- Existing HTTP layer: `src/http/handlers.ts` + `src/http/integrations/hono.ts` — extend, don't replace
- Existing config loader: `config.ts` — extend with `inboxes:` parser
- Existing MCP server: `src/mcp-server.ts` — extend with `sm_inbox_*` tools
