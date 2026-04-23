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
- [?] Deletion semantics — expose `DELETE /inbox/:name/items/:id` for spam (with audit row), or require separate admin tool? Lean expose
- [?] Pull-channel runner — share one scheduler module across RSS/API-poll/scrape, or per-channel? Lean shared, hooked to `scheduled()` Worker export

## Bugs found + fixed during first deploy (2026-04-23)

- [x] [fixed: scripts/build-npm.ts — `shims: { deno: false }`] dnt's `@deno/shim-deno` references `__dirname` which breaks in Workers ESM bundle. Disabling the shim cut bundle from 2MB to 533KB and unblocked deploy
- [x] [fixed: src/adapters/helpers/cloudflare-config.ts — removed top-level `import "jsr:@std/dotenv/load"`] Library files shouldn't load dotenv at module init; that's the app's job. The import broke the Workers bundle (`Deno is not defined` from dotenv module init)
- [x] [fixed: src/adapters/cloudflare-d1.ts ensureTable — single-line SQL via `prepare().run()` instead of `binding.exec()`] D1's `exec()` splits on newlines and requires each line to be a complete statement; the multi-line CREATE TABLE template tripped `Error in line 1: incomplete input: SQLITE_ERROR`. **First write through native D1 mode was broken before this fix** — anyone using cloudflare-d1 in native (binding) mode would hit it
- [x] [fixed: deploy/src/index.ts imports from `@yawnxyz/smallstore/factory-slim`] Root `mod.ts` re-exports ALL adapters, including SQLite which loads `@db/sqlite` (Deno FFI) at module init. factory-slim.ts is purpose-built for "create the router without pulling adapter barrels" — exactly what Workers need. Added as a build-npm subpath
- [*] **dist/ refresh trap** — yarn's `file:` link uses checksum on package.json; rebuilding dist with same package.json (different code) → yarn says "Already up-to-date" and keeps the OLD link. Workaround: `rm -rf deploy/node_modules/@yawnxyz && yarn install --force`. The `predeploy` hook in deploy/package.json triggers a fresh dist build but doesn't auto-prune; document for future contributors

## Plugin discipline (2026-04-24)

Audit ran against the "messaging should be a removable plugin" invariants. 3.5/4 passed out of the box. One real leak fixed same day:

- [x] [fixed 2026-04-24: `postal-mime` lazy-loaded in cf-email.ts + moved to optional peerDependencies] `postal-mime` was in core `dependencies`, meaning every npm consumer of `@yawnxyz/smallstore` pulled it even if they never used messaging. Fix: top-level `import PostalMime from 'postal-mime'` → lazy `loadPostalMime()` helper with clear error if missing. `build-npm.ts` moves it to `peerDependencies` + `peerDependenciesMeta: { optional: true }`, mirroring the `hono` pattern. Verified: 18/18 cf-email tests still green; deploy/ still installs postal-mime directly (as it should — it uses the channel) #plugin-discipline #postal-mime-lazy
- [ ] Apply same 4-invariant audit to the other plugin families (`search`, `graph`, `episodic`, `blob-middleware`, `disclosure`, `views`, `materializers`, `http`, `sync`) — look for heavy deps in core `dependencies` that only one plugin uses. Mechanical; catches sprawl before it calcifies. #plugin-discipline #audit-all-families
- [ ] Write `docs/plugin-authoring.md` — one-page: the 4 invariants, sub-entry-point convention, lazy-load pattern for heavy deps, example. Makes plugin-authoring self-serve for agents/contributors instead of tribal knowledge #plugin-discipline #docs

## Risks

- [!] **CF Email Routing free-tier inbound limits** (~few hundred/day historically) — fine for personal mailroom, may bottleneck if mailroom ever ingests high volume. Watch for; paid plan is the escape valve
- [!] **CF Worker `email()` handler timeout** (sub-30s) — channel parser + storage write must complete synchronously; expensive ops (vector embedding, full-text indexing) deferred to follow-up Workflows
- [*] **Schema drift risk** — channel parsers' `fields` shape is the contract every downstream consumer reads. Plan: version channels (`source: 'email/v1'`); additive changes only; document in `inbox-pattern.md`
- [*] **Runtime-inbox leak** — caller-created inboxes accumulate if TTL not enforced or admin forgets to DELETE. Mitigation: server-side TTL cleanup + admin list endpoint with creation timestamps
- [*] **Auth-token-on-disk** — mailroom collection scripts need the bearer token in `.env`; standard "secret in dotfile" risk. Document rotation procedure

## Phase 1: Deploy host -> 2026-Q2

Get the existing `serve.ts` running on Cloudflare Workers as the personal smallstore deployment. **No messaging changes yet** — this validates the deploy pipeline so subsequent phases just add routes.

- [x] [decided: smallstore.labspace.ai] Decide on a domain for the smallstore host #host #deploy
- [x] [done: deploy/wrangler.toml — TOML form, mirrors coverflow-proxy] D1 (MAILROOM_D1) + R2 (MAILROOM_R2) bindings declared (database_id placeholder for `wrangler d1 create`) #host #deploy
- [x] [done: deploy/src/index.ts — node-shaped Worker, not re-export from serve.ts] Worker entry that builds Hono app + smallstore + InboxRegistry + email handler from the dist npm package via file:../dist #host #deploy
- [x] [done: 2026-04-23] `SMALLSTORE_TOKEN` set via `wrangler secret put` (piped from .env). Token saved in `deploy/.env` (gitignored) #host #deploy #auth
- [x] [done: 2026-04-23 — Version ID 5ab5e8ae-2634-42eb-aa9d-2f30b161892c] First deploy live at https://smallstore.labspace.ai #host #deploy
- [x] [done: 2026-04-23] Smoke tests: `/health`, `/`, `/admin/inboxes` (auth + no-auth), POST item, GET item, query (hit + miss), cursor — all green via real D1 + R2 bindings #host #verify
- [x] [done: deploy/README.md — install/build/d1-create/r2-create/secret/deploy/verify, plus Email Routing wire-up + failure modes] Deploy procedure documented #host #docs
- [*] **Bonus: build infra**
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
- [ ] Update `deploy/worker.ts` to re-export `email: emailHandler` (Phase 1 task — pending domain/wrangler.jsonc) #messaging #deploy #needs:host
- [ ] Extend `wrangler.jsonc` — declare actual D1 + R2 bindings for mailroom storage; declare email routing rule (Phase 1/5 task) #messaging #deploy #needs:host
- [ ] Redeploy with email handler; verify `email()` is registered (Phase 1 task) #messaging #deploy #verify #needs:host
- [*] **Bonus: tests/messaging-email-handler.test.ts (6 tests)** — end-to-end orchestrator: read stream → parse → ingest → blobs persisted; idempotent on re-delivery; fan-out to multiple inboxes; setReject when no inbox configured #messaging #tests

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

- [ ] Extend `src/mcp-server.ts` — register `sm_inbox_list`, `sm_inbox_read`, `sm_inbox_query`, `sm_inbox_cursor` #messaging #mcp #needs:http
- [ ] Register admin tools: `sm_inbox_create`, `sm_inbox_delete`, `sm_inbox_list_admin` #messaging #mcp #runtime-config #needs:admin-api
- [ ] Update smallstore MCP `SKILL.md` with the new inbox tools and a worked example #messaging #mcp #docs
- [ ] Restart MCP client and verify the new tools are callable end-to-end against the deployed Worker #messaging #mcp #verify

## Later

### More channels (each is its own small task; ship as needed)

- [ ] `src/messaging/channels/webhook.ts` — generic HTTP receiver. Optional HMAC validation in `auth: { hmac: 'env:SECRET' }`. POST body → InboxItem via configurable JSON-path mapping #messaging #channel-webhook
- [ ] `src/messaging/channels/rss.ts` — pull-shape. Polls feed at `schedule` cadence; dedup by `<guid>` or hash; maps to InboxItem. Needs the runner #messaging #channel-rss #needs:pull-runner
- [ ] `src/messaging/channels/api-poll.ts` — generic JSON polling. Config: URL, response-path, item-id field, headers #messaging #channel-api-poll #needs:pull-runner
- [ ] `src/messaging/channels/voice.ts` — for voice-agent transcript streams (companion to `@cloudflare/voice` `withVoice`/`withVoiceInput`). Push-shape; transcripts arrive as InboxItems #messaging #channel-voice
- [ ] Pull runner — shared scheduler module reading `inbox.schedule` from config; hooked to CF Worker `scheduled()` cron export. Per-channel concurrency cap #messaging #pull-runner #needs:rss-or-similar

### Outbox

- [ ] Spike: D1-table-as-queue + R2-as-payload-store vs CF Queues + DO alarms — measure both for retry/backoff ergonomics. Decide before building #outbox #spike #needs:inbox-shipped
- [ ] `src/messaging/outbox.ts` — Outbox plugin: `enqueue` (idempotent), `status`, `list`, `cancel`, `history`. Reply linkage to inbox items #outbox #impl
- [ ] `src/messaging/channels/cf-email-out.ts` — first output channel. Wraps `env.EMAIL.send` (CF Email Sending public beta) #outbox #channel-cf-email-out
- [ ] HTTP routes for outbox — `POST /outbox/:name/send`, `GET /outbox/:name`, `GET /outbox/:name/items/:id/history`, `POST /outbox/:name/items/:id/cancel` #outbox #http
- [ ] MCP tools: `sm_outbox_send`, `sm_outbox_status`, `sm_outbox_list`, `sm_outbox_cancel`, `sm_outbox_history`, `sm_messaging_respond` (sugar: read inbox item + LLM callback + enqueue with `reply_to` + `idempotency_key`) #outbox #mcp
- [ ] Webhook output channel — `cf-webhook-out` — generic POST with retry policy. Useful for Slack, Discord, generic webhooks #outbox #channel-webhook-out

### Mailroom curation — bookmarks + auto-archive (personal KB use case)

Design: `.brief/mailroom-curation.md` (2026-04-25). Reframes mailroom from "spam filter" to "personal email curation surface" — manual forwards as first-class bookmarks, sender rules for auto-archive, retroactive tag application. Composes existing hook pipeline + filter DSL + sender-index; no new pipeline primitives needed.

**Foundational (do first):**
- [ ] Move sender-index from memory → D1 — swap in `cloudflareD1` in non-messaging mode with `senders/mailroom/*` prefix. Prereq for all rules work. ~30 min #curation-sender-index-d1
- [ ] CF Email Routing: add `mailroom+*@labspace.ai` rule — dashboard or wrangler config. Unblocks plus-addressing intent. ~10 min #curation-plus-addr-routing

**Ingestion-side:**
- [ ] Forward-detection hook — `src/messaging/forward-detect.ts` detects forwarded mail, adds `manual`/`forwarded` labels, best-effort extracts `fields.original_from_email` + `original_from_addr` + `original_subject` from body + `X-Forwarded-*` headers. Uses `SELF_ADDRESSES` env var for self-detection. ~2 hours #curation-forward-detect
- [ ] Plus-addressing intent hook — preIngest hook reads `fields.inbox_addr` for `mailroom+<intent>@` pattern, tags item with `<intent>` label (`bookmark`, `archive`, `read-later`). ~30 min #curation-plus-addr-intent

**Rules:**
- [ ] Rules storage module — `src/messaging/rules.ts` with `createRulesStore(adapter, opts)` → CRUD + `apply(item)`. Adapter-agnostic; reuses InboxFilter DSL for match. Actions: `archive`, `bookmark`, `tag`, `drop`, `quarantine`. Tag-style = apply-all; terminal = first-match by priority. ~2 hours #curation-rules-store
- [ ] Rules HTTP surface — `GET/POST /inbox/:name/rules`, `PUT/DELETE /:id`, `POST /:id/apply-retroactive` in http-routes.ts. Requires `rulesStoreFor(name)` resolver in RegisterMessagingRoutesOptions. ~1 hour #curation-rules-http
- [ ] Rules preIngest hook — `createRulesHook(rulesStore)` returns PreIngestHook evaluating all rules against item + applying matching actions. ~1 hour #curation-rules-hook
- [ ] Retroactive apply — `rulesStore.applyRetroactive(rule, inbox)` iterates `inbox.query(rule.match)` + re-ingests each with labels added via `_ingest({ force: true })`. HTTP route wires to this. ~45 min #curation-rules-retroactive

**Deploy wiring:**
- [ ] deploy/src/index.ts updates — instantiate rulesStore + forwardDetect + plusAddrHook; wire as preIngest hooks; pass `SELF_ADDRESSES` env var; expose `rulesStoreFor` + `senderIndexFor` resolvers in registerMessagingRoutes. ~30 min #curation-deploy-wire

**Polish (optional, same-sprint if time):**
- [?] Manual-tag surface — `POST /inbox/:name/items/:id/tag` with `{ add?, remove? }` for after-the-fact labeling. Upgrade `manual` to `bookmark` when forward-detection fires but intent wasn't specified #curation-manual-tag
- [?] Main-view filter helper — `mainViewFilter(extra?)` returning `{ exclude_labels: ['archived', 'quarantined'] }` merged with caller's filter. Prevents "forgot to hide archived" footgun #curation-main-view-helper

Success criteria: forward an email to `mailroom+bookmark@labspace.ai` → lands with `bookmark` label + original sender preserved; `POST /rules {match, action:'archive'}` + `?apply_retroactive=true` → existing matching items auto-tagged + future mail archived automatically.

### Mailroom pipeline — Wave 3 (remaining)

Waves 0-2 + newsletter export + deploy all shipped 2026-04-24; see `TASKS.done.md` § 2026-04-24 and narrative in `.brief/2026-04-24-mailroom-sprint.md`. Pipeline is live at `smallstore.labspace.ai` version `b32121f0`. What's left:

- [?] Rules table + runtime-editable rules — pluggable source (D1 row / YAML file / JS array). `{id, inbox, priority, filter_spec, action, action_args}`. Core rules live in code; user rules extend. Enables runtime rule edits without a deploy #messaging #mailroom-rules #needs:mailroom-regex
- [?] Spam layers (non-LLM, composed as preIngest rules) — (1) regex blocklist terminal drop→quarantine, (2) header heuristics, (3) sender reputation `spam_count/count > 0.5 && count ≥ 3`, (4) content hash dedup. LLM classifier deferred as optional layer 5 #messaging #mailroom-spam #needs:mailroom-rules #needs:mailroom-sender-index
- [?] MCP `sm_inbox_*` tool family — `sm_inbox_list/read/query/unsubscribe/restore/quarantine_list/export`. Doesn't exist yet; ship the family together so all inbox ops are equally exposed rather than one-off tools #messaging #mcp-inbox-family
- [?] HTTP routes for quarantine/restore — `POST /inbox/:name/restore/:id` + `GET /inbox/:name/quarantine`. Deferred from Wave 2 agent F to avoid dual-agent edits on http-routes.ts; clean to add now that it's a single edit site #messaging #mailroom-quarantine-routes
- [?] Raw + attachments inlining in export — `include=raw` base64-encodes the .eml; `include=attachments` adds presigned URLs. Body covers 80% of newsletter-to-LLM flows so these are polish #messaging #newsletter-export-polish

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
