# Smallstore — Completed Tasks

Archive of shipped work, newest at top. See `git log` for full diffs and individual commits.

---

## 2026-04-29 — Migration cleanup, mirror handoff, and `serve.ts` preflight

Cross-cutting session triggered by "things broke after `_deno/apps → __active/_apps`." Fixed user-scope MCP path drift, observed that the mailroom mirror's role had been absorbed by tigerflare server's universal space-sync (smallstore peer config target moved `/scratch/mailroom-mirror/` → `/mailroom/` mid-day; smallstore-specific plist became redundant), shipped the preflight feature that the orphan-server brief had been waiting on, cleaned up the now-obsolete mirror path. See `.journal/2026-04-29-migration-cleanup-and-mirror-handoff.md` for the full reasoning trail.

- [x] [done 2026-04-29, commit `a321b11`] **`preflightPort()` in `serve.ts` + `/health` instance fingerprint** — `serve.ts` now probes `http://127.0.0.1:<port>/health` (500ms timeout) before binding; refuses with a clear `Existing PID: <n> (since <iso>)` + `kill <pid>` message if another instance is already up. `/health` returns `{ status, pid, started_at }` so the preflight error identifies the running instance — additive change, existing `status: 'ok'` clients keep working. Runs after `loadConfig()` (we need the resolved port) but before adapter/inbox build, so a refused start doesn't open DBs or register inboxes. Verified end-to-end: fresh start → second start refused → `kill <pid>` → fresh start succeeds. Skipped `--force-replace` (low value; `kill <pid>` from the error message is one keystroke shorter than a flag). Brief: `.brief/orphan-server-instances.md`. Prod `/health` stays minimal — preflight is local-dev-specific by design (CF Workers don't have orphan-process problem). #ops
- [x] [done 2026-04-29, commit `1ced8a7`] **Path-sweep finish in `research/_workshop`** — two `_deno/apps → __active/_apps` rewrites that the main migration commit (`09ed81f`) missed in `messaging-plugins-inbox-outbox.md`. Trivial. #migration-cleanup
- [x] [done 2026-04-29, no commit — operational] **Orphan `/scratch/mailroom-mirror/` cleanup** — deleted both `tf://scratch/mailroom-mirror/` (11 stale .md files on tigerflare cloud) and `tigerflare/data/cloud/scratch/mailroom-mirror/` (736K stale local copy). Path was retired when the smallstore peer config moved its mirror target to `/mailroom/`. Confirmed scratch/'s siblings (other unrelated files) untouched. #migration-cleanup
- [x] [done 2026-04-29, no commit — user-scope config] **MCP server re-registrations** — `claude mcp remove` + `add` for smallstore, tigerflare, brigade to point at `__active/_apps/.../src/mcp-server.ts`. Was previously stale on `_deno/apps/...` paths (tigerflare + smallstore connected only because the old script files still existed; brigade was failing outright). Killed ~10 zombie `deno run … _deno/apps/.../mcp-server.ts` processes from prior Claude Code sessions. #ops #migration-cleanup
- [x] [done 2026-04-29, no commit — separate repo] **Hub `skills/smallstore/SKILL.md` sync** — copied project-canonical SKILL.md (which had ~50 more lines covering newsletter views, todos, mirror, replay tools) to the hub mirror at `mcp-hub/skills/smallstore/`, ran `sync-skills.sh` + `sync-remote.sh` to push to local consumers (Claude Code, Cursor, Codex, ~/.agents) + sparkie + erko. Hub commit deferred — separate repo, user's call. #hub-sync

---

## 2026-04-27 — Stale-unread auto-mark-read sweep

User pitched: "auto-mark-read sweep, will pay off as my subscription list grows."
Initial framing was "rule-shaped, ~10 min" — but the rules engine doesn't have
a `mark_read` action or age-based matching, so this shipped as a server-side
cron sweep instead. Same end result, slightly bigger surface: a configurable
env knob, runs on every cron tick, no-op when nothing's stale. 826/826 messaging
tests green.

- [x] [done 2026-04-27, deploy `dde2a916`] **`runUnreadSweep` + cron wiring** — new `src/messaging/unread-sweep.ts` exports a pure function: query items matching `{ labels: ["unread"], until: <now - cutoffDays> }`, drop the `unread` label, leave everything else (including `bookmark`, `newsletter:*`) intact. Cron handler in `deploy/src/index.ts` reads `UNREAD_SWEEP_DAYS` from env (default disabled, recommended `30`), iterates registered inboxes, runs the sweep per-inbox with isolation. Wrangler `[vars]` ships with `UNREAD_SWEEP_DAYS = "30"`. Items remain queryable post-sweep — only the `unread` label is removed, so all read paths still surface them. Idempotent (rerun = no-op since the filter intersects with `unread`). Hard cap of 10k items per run with `capped: true` flag for big batches. 8 new tests covering cutoff math, the disable knob, label preservation, idempotence, and the cap. Live verified: 6 unread items currently, 0 older than 30 days, sweep is a no-op until items age (correct). #messaging #unread-sweep #cron

---

## 2026-04-27 — Reading-list view (`recent.md`)

User asked for a cross-publisher feed: "what's new since I last looked," in
one file, instead of bouncing between 8 publisher `.md` files. Shipped same
shape as the per-publisher render — body inlined, newest-first, with each
item showing the publisher and a relative link back to its full archive.

- [x] [done 2026-04-27, deploy `cc44a64c`] **`recent.md` cross-publisher reading list** — new `renderRecentFeed` in `newsletter-markdown.ts` aggregates every item with a usable date (`fields.original_sent_at` ?? top-level `sent_at`) within the last `recent_window_days` days, sorted newest-first. Same body-inlining + 20KB cap + preheader-cruft scrub as the per-publisher render. Each item has a `**Publisher:** [Display](./slug.md)` line so the user can jump to the full archive in one click. Empty-window emits a friendly placeholder so the file doesn't disappear on quiet days. Two new `MirrorConfig` knobs: `include_recent` (default `true`) and `recent_window_days` (default `7`). The mirror engine reuses the bodies already hydrated by the per-publisher loop — no double R2 reads. Prune protected (`recent.md` added to active filename set so GC doesn't delete it). 5 new render tests + 3 new mirror integration tests. Live verified: 7 items across 7 publishers landed in `recent.md` (Substack notes digest, Every "You Are the Most Expensive Model", Sidebar "Alignment is the bottleneck", etc). 818/818 messaging tests green. #messaging #mirror #reading-list

---

## 2026-04-27 — Mirror garbage-collects orphans + welcome-email cleanup pass

User pointed out the mirror was leaving stale `.md` files behind when items got
deleted in smallstore (a publisher whose only item was a "Welcome to X" email
turned into a dead file at the destination). Closed the loop with prune-on-by-default
in the cron mirror; same engine now lists the destination after pushing and DELETEs
any `.md` that no longer corresponds to an active slug. Plus a manual cleanup pass
of all the welcome / "thanks for subscribing" / "confirm your subscription" emails
that came in with the initial wave of newsletter signups. 810/810 messaging tests green.

- [x] [done 2026-04-27, deploy `7f2452f1`] **Mirror prune step — garbage-collect orphan `.md` files** — `runMirror` now lists the target prefix via `GET <prefix>/` (tigerflare returns `[{name, path, isDirectory}]`), diffs against the active-slug filename set + `index.md`, and DELETEs the orphans. New `prune_orphans?: boolean` knob on `MirrorConfig` (defaults `true`). New `pruned: string[]` and `prune_error?: string` fields on `MirrorRunResult` so the API surfaces what got cleaned and any listing failures separately. Failed deletes go into `failed[]` with `slug: "__prune:<filename>"` so they're discoverable but don't tank the push. 7 new tests covering the happy path, index.md preservation, opt-out, non-`.md` files left alone, 404-on-listing graceful skip, failed-delete recording. Live verified end-to-end: dropped `orphan-test.md` at the destination via curl, ran `sm_inbox_mirror`, response showed `pruned: ["orphan-test.md"]`, post-flush listing confirmed it was gone. #messaging #mirror #garbage-collection
- [x] [done 2026-04-27] **Welcome-email cleanup pass** — 13 deleted total. First sweep: 10 obvious welcomes ("Welcome to X", "Thanks for subscribing", "You're subscribed to X", "Thank you + vision", "Confirm your subscription to Sidebar.io"). Second sweep: 3 Every.to onboarding sequence emails (2/9–4/9 — the rest of the marketing series after deleting 1/9 in the first sweep). User explicitly chose to keep welcome cleanup manual — "in case a welcome email also has actual stuff" — so no auto-delete rule was added. Mirror flushed; orphan files for now-empty publishers cleaned up by the prune step in the same pass. #messaging #ops
- [x] [done 2026-04-27] **launchd plist activated** — earlier session wrote `~/Library/LaunchAgents/com.smallstore.mailroom-sync.plist` but couldn't load it without explicit user approval. User approved; loaded via `launchctl bootstrap gui/$UID`. Process now running as PID 21579, state=running, auto-starts at login + restarts on non-zero exit. Initial post-load sync pulled the 11 fresh body-inlined files in one shot. Stop with `launchctl bootout gui/$UID com.smallstore.mailroom-sync`. #ops #launchd

---

## 2026-04-27 — Mirror is now self-contained (body inlining + slug polish)

Follow-up to the same-day mirror coverage work — the user pointed out that the
"View item →" links in the mirror are auth-gated, so they couldn't actually
*read* their newsletters from a Finder/Obsidian-opened `.md`. Closed the loop:
inlined the body content (HTML stripped to readable plain markdown) under each
issue heading, plus three slug-polish items found while looking. 802/802
messaging tests green.

- [x] [done 2026-04-27, deploy `b1778b77`] **Inline body content in mirror per-publisher pages** — root cause: the mirror only emitted "View item →" links to the auth-gated `/inbox/:name/items/:id` route, so a user opening `every.md` in Obsidian couldn't actually read the newsletters. Mirror now hydrates each item via `inbox.read(id, {full: true})` (O(N) R2 reads per slug — acceptable at current scale), passes `InboxItemFull[]` to `renderNewsletterProfile`, which extracts the body (preferring `body_inflated`, falling back to `body`), strips HTML to readable plain markdown via a new `htmlToText` utility, and inlines it under each issue heading with a 20KB cap + paragraph-boundary truncation. New module `src/messaging/html-to-text.ts` (zero dependencies — handles entities, headings → md, anchors → `[text](url)` with self-link collapse, list items, paragraph breaks, table cell flatten, script/style/comment strip). Plus a preheader-cruft scrub for invisible Unicode chars (zero-width joiner, combining grapheme joiner, soft hyphen — used by email platforms to pad preview text). 19 html-to-text tests + 4 new render tests. Live verified: `sidebar-io.md` now contains the full text of "Alignment is the bottleneck" issue, link-rich, readable. #messaging #mirror #body-inline
- [x] [done 2026-04-27, deploy `8390e12d`] **`(X from Y)` and bracketed-publisher slug patterns** — `Fabricio (from Sidebar.io) <hello@uxdesign.cc>` was producing `fabricio-from-sidebar-io` because `NEWSLETTER_FILLER_PREFIXES` only matched whitespace-bounded `at`/`by`/`from`, not parenthesized forms. Added a parens/brackets pattern that captures the publisher inside `(from X)` / `(at X)` / `(by X)` and `[from X]` etc. Also rewrote the `from` pattern: was capturing the *left* half ("Daily News from Acme" → "Daily News" — wrong direction), now captures publisher on the right ("Daily News from Acme" → "Acme"). 3 new tests. #messaging #newsletter-slug #filler-patterns
- [x] [done 2026-04-27, deploy `8390e12d`] **`newsletter-name` re-derives slug instead of preserving stale value** — on replay after the slug-pattern fix, the previous "preserve existing slug" rule blocked overwriting old slugs derived by inferior logic. Reasoning was wrong anyway: newsletter-name only fires on `newsletter`-labeled items, and forwarded items (where forward-detect's slug needs protecting) lack that label by design — verified live. Now the hook always re-derives; replay picks up better filler-prefix logic going forward. Replay produced 4 corrections: `fabricio-from-sidebar-io` → `sidebar-io` (merges with existing 2 items), `ben-reinhardt` → `spectech-newsletter`, `metacelsus` → `de-novo`, `dan-elton` → `more-is-different` (publisher slugs over author slugs — better matches the user's mental model of subscriptions). Old orphan `.md` files cleaned up from tigerflare. #messaging #newsletter-slug #replay
- [x] [done 2026-04-27, deploy `4bb14e7d`] **Notes-views date fallback in slim shape** — `renderNewsletterNotes` (`/inbox/:name/newsletters/:slug/notes`) and `renderAllNotes` (`/inbox/:name/notes`) still printed "(date unknown)" for direct subs because their slim shape didn't carry `sent_at`. Threaded `sent_at` through both projections in `http-routes.ts` and added the same `original_sent_at ?? sent_at` fallback to both renderers. #messaging #notes-views #date-fallback
- [x] [done 2026-04-27] **Bulk mark IP back-catalog read** — 27 forwarded Internet Pipes digests (24 slugged + 3 unslugged-but-IP-by-subject) marked read in one shot via `sm_inbox_mark_read_many`. The unread surface now shows actually-fresh items rather than the bulk historical forward-import. #messaging #ops
- [x] [done 2026-04-27] **launchd plist for persistent mailroom sync** — written at `~/Library/LaunchAgents/com.smallstore.mailroom-sync.plist`. Auto-starts at login + restarts on non-zero exit (KeepAlive.SuccessfulExit=false) with ThrottleInterval=30s. Logs at `/tmp/mailroom-sync.{log,err}`. **Activation pending — needs `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.smallstore.mailroom-sync.plist` to load.** #ops #launchd #persistence

---

## 2026-04-27 — Mirror coverage + SSE stability (mailroom triage finally readable)

User had no UI for the mailroom — only readable through the tigerflare mirror, which had been live but only carrying forwards (not direct subs). One session closed three gaps: direct subs now mirror, dates always render, SSE keeps the local sync alive past CF Workers' 30s idle timeout. End-to-end: tigerflare:sync set up for the first time on the user's mac → 15 publisher `.md` files synced to a Dropbox-backed folder → cron will keep them fresh every 30 min. 774/774 messaging tests green.

- [x] [done 2026-04-27, deploy `e6b9d050`] **`newsletter_slug` populated on direct subs** — root cause: `fields.newsletter_slug` was only set by `forward-detect` (preIngest, fires only on forwards). Direct subs (Substack/Every/etc landing at mailroom@labspace.ai) had no slug → mirror grouped them into nothing → invisible. Extended `newsletter-name.ts` (postClassify) to also write `newsletter_slug` using `deriveNewsletterSlug` from forward-detect — same shape, so direct subs + forwards group cleanly. Forward-detect's slug wins when already set (forwards keep upstream slug, not the forwarder's). Replay-hook backfill on the existing 50 items: 18 newly slugged. Mirror flush jumped from 2 publisher files to 14 (`every`, `thorsten-ball`, `dwarkesh-patel`, `decoding-bio`, `asimov-press`, `dan-elton`, `metacelsus`, `ben-reinhardt`, `not-boring`, `sidebar-io`, `substack`, …). 4 new tests + 2 updated. #messaging #newsletter-slug #direct-subs
- [x] [done 2026-04-27, deploy `cfbb0179`] **Mirror date fallback to `sent_at` for direct subs** — pure-render bug in `newsletter-markdown.ts`: per-publisher `.md` files only read `fields.original_sent_at`, so direct subs (which only have top-level `sent_at` from the email's Date header) all rendered "(date unknown)" and sorted to the tail. Added `pickItemSentAt()` helper that prefers `original_sent_at` then falls back to `sent_at`. Sort uses the same fallback so chronology stays consistent. Forwarded items unchanged (forward-detect's upstream-send-time still wins). 2 new tests (fallback path + precedence rule). Verified live: `every.md` chronologically lists items 04-24 → 04-27. Notes-views still use `original_sent_at` only — different surface, fix scoped to publisher pages where it matters. #messaging #mirror #date-fallback
- [x] [done 2026-04-27, tigerflare deploy `0c325f91`] **SSE heartbeat — keeps `tigerflare:sync` alive past CF idle timeout** — local mailroom sync was flapping (`SSE: connected → disconnected → reconnecting` every ~30s, eventually falling back to polling). Cloudflare Workers terminates streaming responses after ~30s of silence; tigerflare's `/_events` endpoint sent no heartbeat, so idle clients reliably tripped the cap. Added a 15s `: heartbeat\n\n` SSE comment in the worker. Comments are ignored by the client's parser (it only reads `data:` chunks), so existing consumers are unaffected. Verified live: sync stayed connected 1:14+ on a single SSE connection vs. flapping every 30s before. (Tigerflare repo edit, deployed separately from smallstore.) #tigerflare #sse #cloudflare-workers
- [x] [done 2026-04-27] **Mailroom local sync — first-time setup** — user had never run `/tigerflare:sync` before. Set up pull-only continuous sync from `tf://scratch/mailroom-mirror/` to `~/Library/CloudStorage/Dropbox/tigerflare/cloud/scratch/mailroom-mirror/` at 60s polling interval (PID 78949). 15 publisher `.md` files now openable in any editor; cron-driven mirror keeps them fresh. Closes the "no UI for the mailroom" gap surfaced this session. #tigerflare #sync #mailroom-readability

### Investigated, no fix needed

- [x] [investigated 2026-04-27] **`index.md` 500 on first mirror push** — first `sm_inbox_mirror` flush returned `pushed: 14, failed: [{slug: "__index__", error: "PUT /scratch/mailroom-mirror/index.md → 500"}]`. Repro: direct PUT to the same path with a similar body returned 201. Subsequent `sm_inbox_mirror` runs got 15/15 with 0 failures. Transient — likely a CF/D1 hiccup at the tail of the batch (index pushes last). If it recurs systematically, retry-with-backoff in `pushFile()` is the fix. #ops #transient

---

## 2026-04-27 — Wrap-up: query() order fix + engagement signal

Two small items from the brief's "next adds" list, shipped to close out the day. Total ~30 min including tests + deploy + verify. 769/769 messaging suite green.

- [x] [done 2026-04-27, deploy `7420fa65`] **`inbox.query()` filter path honors `options.order` natively** — pre-fix, the cursor-aware filter path in `inbox.query()` ignored `order: 'oldest'`, so cross-publisher routes like `/inbox/:name/notes` workaround-sorted in memory post-hydration. Now reverses the entries array before iterating; `startIndex` finds cursor entries by id so it works in either direction. The `/inbox/:name/notes` route's in-memory sort fallback dropped in the same commit. 2 new tests in `tests/messaging-inbox.test.ts` (newest/oldest in filter path; oldest with cursor pagination). #cleanup #inbox-query-order
- [x] [done 2026-04-27, deploy `e467258a-3341-4077-9fc2-b3c562eef857`] **Note-length engagement signal** — `total_note_chars` + `notes_count` on `/inbox/:name/newsletters` index entries; `total_note_chars` + `avg_note_chars` on the per-publisher profile dashboard. `avg_note_chars` correctly returns `0` (not `NaN`) when `notes_count` is 0, and only counts noted issues (not total issues). Markdown export gets a one-line `**Engagement:** N chars across M notes (avg X/note)` header — only renders when `total_note_chars > 0` so silent newsletters stay clean. `NewsletterProfile` type extended in `newsletter-markdown.ts`; `mirror.ts buildProfile()` updated alongside (so the cron-mirror's tigerflare files also carry the Engagement line). 5 new tests in `tests/messaging-newsletters.test.ts`. Live verified: rosieland shows `116 chars across 1 notes (avg 116/note)` (the [x]-marked completion line); internet-pipes shows `0` across the board (24 issues, no notes yet). #messaging #interest-signal

---

## 2026-04-27 — Notes → todos + browsable mirror + done-state primitive

Big day. Shipped Phase 1 (todo extraction) + Phase 2a (markdown export) of the notes-todos brief, then went past it: cross-newsletter notes endpoint, edit-mode for `sm_inbox_set_note` (closes the todo done-state gap), Ghost confirm-detect support, and the public-manifest lockdown. 751/751 messaging tests green by EOD; +73 new tests across 5 new test files. Brief: `.brief/api-access-and-notes.md` (the unified mental-model explainer written this day).

- [x] [done 2026-04-27, deploy `fc37dd95`] **Phase 1 — `/inbox/:name/todos` + `sm_inbox_todos`** — derived view scanning every `forward_note` for action-shaped lines via 6 regex patterns (unchecked-checkbox, todo-prefix, action-prefix, remind, subscribe, follow-up). Skips quoted-reply (`> ...`) and checked-checkbox lines. New module `src/messaging/todos.ts` exports pure `scanNoteForTodos`. 28 tests. Live verified — picks up the rosieland note "reminder to self: sub mailroom to rosieland" cleanly via `remind` pattern. #messaging #notes-todos
- [x] [done 2026-04-27, deploy `0e9178ed`] **Phase 2a — markdown export endpoints** — `?format=markdown` on three newsletter routes returns `text/markdown; charset=utf-8`. Index uses relative `./<slug>.md` links (folder-browseable in Obsidian/tigerflare); profile view = chronological items + notes inlined as blockquotes. Pure renderer module `src/messaging/newsletter-markdown.ts` (no I/O — Phase 2b's cron will reuse). 16 tests. #messaging #markdown-export
- [x] [done 2026-04-27, deploy `2a67e4a8`] **Cross-newsletter notes endpoint** — `GET /inbox/:name/notes` + `sm_inbox_notes`. Closes the "show me everything I've written" gap surfaced in the api-access brief. Slim shape projection. Optional `?text=` substring filter on `forward_note` only (NOT body — distinct from `?text=` on `/query`); `?slug=` / `?since=` / `?order=` / `?format=markdown` (groups by slug with H2 per publisher, surfaces filter metadata in header). New `renderAllNotes` in newsletter-markdown.ts. The filter path of `inbox.query()` doesn't honor `options.order`, so the route hydrates and sorts in memory; documented as a future cleanup. 14 tests. #messaging #cross-newsletter-notes
- [x] [done 2026-04-27, deploy `336fc939`] **`sm_inbox_set_note(mode: 'edit')`** — line-level surgery primitive that closes the todo done-state gap. Body `{mode: 'edit', find, replace}`. Marks single todo lines done by wrapping as `- [x] ...`; the existing /todos skip rule auto-excludes. Generic enough for typo fixes / partial revisions / line deletions too. No new state. 10 tests. Live used to mark the rosieland todo done end-to-end (todo count 1→0; note preserved as record of completion). #messaging #note-edit-mode
- [x] [done 2026-04-27, deploy `c91e0166`] **Ghost confirm-detect support** — user signed up to rosieland.com (Ghost-hosted), confirmation went unflagged because Ghost says "Complete your sign up" instead of "Confirm subscription". Extended `confirm-detect.ts`: subject pattern `\bcomplete\s+(?:your\s+)?sign[\s-]?up\b`, anchor phrases `tap the link below` / `complete the signup`, path hint `action=signup` (Ghost's `/members/?token=...&action=signup&r=...` query shape). 7 tests on the real rosieland email. Followed up with `*@ghost.io` runtime addition to auto-confirm allowlist via `POST /admin/auto-confirm/senders`. CLAUDE.md updated. #messaging #confirm-detect #ghost
- [x] [done 2026-04-27, deploy `b0e93ed6`] **Public manifest lockdown** — `/` was returning the full inbox list (mailroom/biorxiv/podcasts) + every endpoint pattern unauthenticated — recon roadmap for any visitor. Stripped `/` to `{name, version, status}` and `/health` to `{status}`. Moved full manifest behind auth at new route `GET /admin/manifest` (also expanded with the newer routes: newsletters, todos, replay, note, webhook, auto-confirm). Auth-gated routes unchanged. CLAUDE.md updated. #security #public-surface
- [x] [done 2026-04-27] **Brief: api-access-and-notes** — `.brief/api-access-and-notes.md`. Five-section explainer: auth model (token mechanics + public-vs-gated post-lockdown, webhook HMAC as separate model), notes (`forward_note` as the only data primitive, two write paths, three read paths), aggregation/search (gap surfaced + design for cross-newsletter endpoint, shipped same-day), todos (pure-derived projection + why), unified picture diagram. Companion to forward-notes-and-newsletter-profiles + notes-todos-and-mirror briefs. #messaging #brief

---

## 2026-04-26 — Forward-notes + webhook channel + deploy hardening

Two arcs in one day. Morning: webhook channel + valtown RSS template. Then user forwarded 26 IP Digest issues out of order with a "do notes aggregate per newsletter?" question, which kicked off the forward-notes brief and a same-day three-phase ship: capture (`original_sent_at`/`newsletter_slug`), surface (newsletter routes/profiles/items/notes), retroactive backfill (generic `/admin/inboxes/:name/replay` endpoint). Backfill ran live against the 26 IP Digest items. Caught a deploy-staleness gotcha (yarn `file:` caches by version, doesn't reinstall on rebuild) — fixed by switching `deploy/package.json` to `link:../dist`. Annotation endpoint shipped end-of-day. 676/676 messaging tests green; +90 new tests across forward-notes + webhook + replay + annotation files. Briefs: `.brief/forward-notes-and-newsletter-profiles.md`, `.brief/notes-todos-and-mirror.md`, `.brief/deploy-gotchas.md`.

- [x] [done 2026-04-26, repo `3456fec`] **Webhook channel** — `src/messaging/channels/webhook.ts` (`WebhookChannel`, `verifyHmac`, `extractByPath`). HMAC verify (sha256 + sha1, env-resolved secrets, optional prefix-strip) + JSON-path field mapping (dotted paths promote payload values to InboxItem-level `summary`/`body`/`sent_at`/`thread_id`/`id`) + content-addressed dedup via `fields.id`. New peer type `webhook`. New HTTP route `POST /webhook/:peer` — does NOT use requireAuth, HMAC IS the auth. Plumbed via opaque `webhookConfigFor` + `resolveHmacSecret` options on `RegisterMessagingRoutesOptions` (no peers→messaging dep). 28 tests. Docs: `mailroom-quickstart.md § 2.10`. #messaging #channel-webhook
- [x] [done 2026-04-26] **Valtown RSS poller template** — `examples/valtown-rss-poller.ts`: generic env-driven RSS-to-smallstore (`FEED_URL` / `TARGET_INBOX` / `DEFAULT_LABELS` / `SMALLSTORE_TOKEN` / `DRY_RUN`). Content-addressed IDs match in-Worker rss channel formula → both paths dedup cleanly. Graceful CF-block detection (logs `fetch_blocked`, exits 0). bioRxiv polling parked from smallstore's side (CF bot challenge gates external IPs); inbox stays as POST target for whatever tools handle bioRxiv ingest end-to-end. Use the val for permissive feeds (arXiv, HN, Substack export-as-RSS, blogs). #rss-valtown
- [x] [done 2026-04-26, deploy `14081bd9`] **Forward-notes Phase 1 — capture** — extended `forward-detect.ts` to parse `Date:` / `Message-ID:` / `Reply-To:` from forward bodies (Gmail's `at`-infix shape, RFC 5322, Outlook longform, ISO) + derive `newsletter_slug` from display name (`X at Y` → Y heuristic, slugify-then-fallback-to-domain). New exports: `parseForwardDate`, `deriveNewsletterSlug`. 19 tests. #messaging #forward-detect-original-date
- [x] [done 2026-04-26, deploy `14081bd9`] **Forward-notes Phase 2 — surface** — `order_by` on Inbox.list/query (`received_at` | `sent_at` | `original_sent_at`; missing-field-tails; cursor disabled for non-default). Four newsletter HTTP routes (`/inbox/:name/newsletters[/:slug[/items|notes]]`) + four MCP tools (`sm_newsletters_list`, `sm_newsletter_get`, `sm_newsletter_items`, `sm_newsletter_notes`). Slug regex-escaped before lookup. 15 tests. #messaging #newsletter-routes
- [x] [done 2026-04-26, deploy `14081bd9`] **Forward-notes Phase 3 — retroactive backfill** — `IngestOptions.fields_only` (shallow-merge fields, union labels, preserve identity, skip index). `POST /admin/inboxes/:name/replay` endpoint generic over any registered hook (mailroom registers forward-detect, sender-aliases, plus-addr, newsletter-name). `sm_inbox_replay_hook` MCP tool with dry-run-first contract (returns up to 10 sample diffs). The generic version of `RulesStore.applyRetroactive`. 10 tests. #messaging #replay-hook-system
- [x] [done 2026-04-26] **IP Digest backfill — live validated** — replay scanned 26, applied 24 (2 already populated, 0 errors). `/inbox/mailroom/newsletters/internet-pipes/items` now returns chronological order Aug 2024 → Apr 2026. End-to-end validation of the Phase 1+2+3 system against the user's actual data. #messaging #ipdigest-backfill
- [x] [done 2026-04-26, deploy `96fd9c9f`] **Deploy hardening — `link:../dist` swap** — yarn 1's `file:` form caches by package.json version which dnt writes as a stable string, so rebuilds with same version skip reinstall and wrangler ships stale code. (First three deploys today shipped Apr 24 code through three `yarn deploy` runs before staleness caught.) Switched `deploy/package.json` to `link:../dist` (yarn's symlink form) so any `build:npm` is visible to wrangler immediately with no install step. Marker test confirmed instant propagation. Documented in `.brief/deploy-gotchas.md` so the trap doesn't recur. #deploy #yarn-file-dep-staleness
- [x] [done 2026-04-26, deploy `cc96815b`] **`POST /inbox/:name/items/:id/note`** — after-the-fact annotation (replace/append/clear modes; mode=edit added 2026-04-27). `replace` (default) overwrites; `append` joins via `\n\n---\n\n` thematic break; empty string clears. Stamps `fields.note_updated_at`. Uses `IngestOptions.fields_only` so identity, labels, body, index entry all preserved. New MCP `sm_inbox_set_note`. 13 tests. The note immediately surfaces in newsletter notes. #messaging #annotation-endpoint
- [x] [done 2026-04-26] **A103 audit cleanup** — `merge` default-mode bug from TASKS-AUDIT was already fixed in `291617d` (2026-04-17); flipped audit entry to `[x]` with fix-commit citation; surfaced default in `MergeOptions.overwrite` JSDoc. #audit-A103
- [x] [done 2026-04-26] **Brief: forward notes + newsletter profiles** — `.brief/forward-notes-and-newsletter-profiles.md`. Three-phase plan (capture → surface → retroactive backfill). All three phases shipped same day. #messaging #brief
- [x] [done 2026-04-26] **Brief: notes-todos-and-mirror** — `.brief/notes-todos-and-mirror.md`. Three phases for turning notes into a workable todo list + browsable markdown mirror. Phase 1 + 2a shipped 2026-04-27; Phase 2b open (cron mirror). #messaging #brief

---

## 2026-04-25 — MCP tool family + reorg (late afternoon)

Canonical access surface. The old monolithic 505-line `src/mcp-server.ts` split into per-family tool files under `src/mcp/`, with two new tool families added alongside the existing core. 33 MCP tools now live: 10 core + 15 inbox + 8 peers. 1203/1203 tests green.

- [x] [done 2026-04-25: Split src/mcp-server.ts (505 LOC) into src/mcp/ folder — config.ts (env validation), http.ts (shared HTTP forwarder with createHttpFn + readCapped), tools/types.ts (Tool, Args, HttpFn, HttpResult, requireString, validateName, formatHttpError, encodeCollectionKey shared helpers), tools/core.ts (existing 10 tools migrated verbatim), server.ts (composition + dispatch), mod.ts (entry). src/mcp-server.ts now a 3-line shim that imports src/mcp/mod.ts — existing ~/.claude.json configs don't break] MCP reorg: src/mcp-server.ts → src/mcp/ folder #mcp-reorg
- [x] [done 2026-04-25 agent A: src/mcp/tools/inbox.ts (508 LOC, 15 tools) — sm_inbox_list/read/query/export/tag/delete/unsubscribe/quarantine_list/restore + sm_inbox_rules_list/get/create/update/delete/apply_retroactive. Thin HTTP forwarders with arg validation (action enum, at-least-one-of add/remove, etc). Export forces format=json since MCP can't stream. Snake-case MCP args mapped to server camelCase (skip_call → skipCall)] sm_inbox_* tool family #messaging #mcp-inbox-family
- [x] [done 2026-04-25 agent B: src/mcp/tools/peers.ts (378 LOC, 8 tools) — sm_peers_list/get/create/update/delete + sm_peers_health/fetch/query. Auth JSON schema kept permissive (object with required 'kind' enum); server's runtime validator handles deeper union shape with clean 400s. client_query on fetch merges with path via URLSearchParams.append. Description calls out "secrets via wrangler secret put separately" footgun] sm_peers_* tool family #peers-mcp
- [x] [done 2026-04-25: skills/smallstore/SKILL.md description + body updated to reflect the new tool families. Added § "Mailroom tools" + § "Peer registry" with typical-workflow code blocks. Pointer to docs/user-guide/mailroom-quickstart.md for full HTTP recipes. Canonical skill stays in smallstore repo per user's "don't fork to mcp-hub" direction] Canonical /smallstore skill updated #skill-update
- [x] [done 2026-04-25: tests/mcp-server.test.ts tools/list expected list updated from 10 → 33 entries (10 core + 15 inbox + 8 peers). 16/16 mcp tests green. deno check clean on src/mcp-server.ts shim + the whole tree] MCP test coverage refresh #mcp-tests
- [x] [done 2026-04-25: `.brief/2026-04-25-mcp-reorg-sprint.md` written — narrative of the reorg + 5-file structure + extension contract + end-state 33 tools. Mirrors the 2026-04-24-mailroom-sprint.md + 2026-04-25-curation/peer-registry sprint brief patterns] MCP reorg sprint brief #mcp-reorg-brief
- [x] [done 2026-04-25: canonical smallstore/SKILL.md aligned across the topology. Edited in `__active/_apps/smallstore/skills/smallstore/SKILL.md` (project repo canonical, 237 LOC with new mailroom + peers sections). Copied to `mcp-hub/skills/smallstore/SKILL.md` (distribution slot) and committed to mcp-hub as `a6c3185b`. Ran `mcp__deno-hub__hub_sync-skills` — propagated to `~/.claude/skills/` + `~/.cursor/skills/` + `~/.codex/skills/` + `~/.agents/skills/` (0 added, 1 updated, 59 unchanged in each). post-sync git checkpoint at 2026-04-23T19-16-47Z. Memory note `feedback_mcp_hub_skills_not_canonical.md` updated with smallstore-specific canonical entry so future agents don't drift] Canonical skill synced through hub #skill-hub-sync
- [*] **Session stats:** ~1250 net LOC added (plus 505 LOC removed from old mcp-server.ts and recreated inside the split). 2 parallel agents (inbox + peers, clean file-scope split). 33 MCP tools. 1203/1203 tests green. 2 commits across 2 repos (smallstore `a798d1d`, mcp-hub `a6c3185b`). 1 sprint brief. Memory updated.

---

## 2026-04-25 — Peer registry sprint (afternoon session)

- [x] [done 2026-04-25 end-of-sprint: registered tigerflare as a live peer end-to-end. TF_TOKEN set as wrangler secret on smallstore Worker (from `__active/_apps/tigerflare/.tigerflare.json` servers.cloud.token). Peer `tigerflare-demo` URL corrected from tigerflare.labspace.ai to the actual tigerflare.yawnxyz.workers.dev via PUT /peers/:name. Required a redeploy because env was captured at buildApp time (cached isolate held the pre-secret env). Post-redeploy verification: health probe returns ok:true status:200 latency 81ms; proxy-fetch GET / returns tigerflare directory listing. Also fixed probePeer to use `/` for tigerflare type (no /health route) instead of /health. Live at version ff397427] Wire up tigerflare as a live peer #peers-wire-tigerflare



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

## 2026-04-24 — Polish session (seven small features)

Seven back-to-back small features, all live at `smallstore.labspace.ai`; `@yawnxyz/smallstore@0.2.0` published to JSR. Detail in `TASKS-MESSAGING.md`.

- [x] [done 2026-04-24, deploy `718c083d`] `Inbox.keyPrefix` option — runtime inboxes auto-namespace at `inbox/<name>/` within a shared adapter. Boot-time inboxes (mailroom/biorxiv/podcasts) keep bare `_index` + `items/<id>` (backwards-compat). Wired through `serve.ts` + `deploy/src/index.ts` factories. 4 unit + 4 HTTP tests. #inbox-keyprefix-isolation
- [x] [done 2026-04-24, deploy `46a93db3`] Runtime-configurable `AUTO_CONFIRM_SENDERS` — D1-backed allowlist (`AutoConfirmSendersStore` with list/get/add/delete + per-pattern sentinels). Hook reads via `getPatterns: () => store.patterns()` (cached 30s). `GET/POST/DELETE /admin/auto-confirm/senders` + `sm_auto_confirm_*` MCP tools. Env seeds once-per-pattern (sentinel-tracked); runtime delete sticks across cold starts. 16+5+15 tests. #mailroom-auto-confirm-runtime-config
- [x] [done 2026-04-24] Plugin discipline — full lazy-load sweep — postal-mime recipe applied to 4 remaining adapter SDKs (aws-sdk in `blob-middleware/resolver.ts` + `r2-direct.ts`, `@notionhq/client` in `notionModern.ts`, `unstorage` in `adapters/unstorage.ts`). Cached module refs + lazy `loadX()` helpers with helpful "install ..." errors. Combined with the postBuild stripper in `scripts/build-npm.ts`, **`dist/package.json` `dependencies` is now `{}`** — every adapter SDK is an optional peerDep. yarn.lock shrank by ~1200 lines. #plugin-discipline
- [x] [done 2026-04-24, deploy `219d88a4`] Attachments retrieval — capture path was already live (cf-email channel writes `attachments/<item-id>/<filename>` to blobs adapter + records metadata on `fields.attachments[]` since 2026-04-23); retrieval surface was the gap. New: `Inbox.readAttachment(itemId, filename)` (validates filename against `fields.attachments[]` to block path traversal); `GET /inbox/:name/items/:id/attachments` lists metadata; `GET /inbox/:name/items/:id/attachments/:filename` streams bytes through the Worker (Content-Type / Content-Length / Content-Disposition set; `?download=1` flips disposition). MCP `sm_inbox_attachments_list`. 6 unit + 13 HTTP tests. Brief: `.brief/attachments.md`. #messaging #attachments
- [x] [done 2026-04-24] JSR publish 0.2.0 — caught up four months of shipped work on the registry. JSR jumped from `0.1.11` → `0.2.0`. Three slow-type fixes needed at the cf-email/rss channel exports + `createEmailHandler` return type. https://jsr.io/@yawnxyz/smallstore@0.2.0 #jsr-publish
- [x] [done 2026-04-24] Sheetlog patch verifier + Bug #2/#4 LIVE — earlier in the day; tracked separately, see Sheetlog section below.

---

## 2026-04-24 — Mailroom annotation layer

Five mailroom curation features live at `smallstore.labspace.ai`. Detail in `TASKS-MESSAGING.md § Mailroom pipeline`.

- [x] [done 2026-04-24] **Forward-notes capture** — `extractForwardNote()` in `src/messaging/forward-detect.ts` pulls user-typed commentary above the forward delimiter into `fields.forward_note`. Strips trailing `On <date>, <Sender> wrote:` quote headers. 13 tests cover Gmail/Outlook/Apple Mail separators + CRLF + empty/whitespace edge cases. #messaging #mailroom-forward-notes
- [x] [done 2026-04-24] **Sender-name aliases** — new `src/messaging/sender-aliases.ts` (207 LOC) — glob-pattern alias map, `createSenderAliasHook` wired into deploy preIngest chain. Prefers `original_from_email` so forwarded mail still tags with the original person. Writes `fields.sender_name` + `sender:<slug>` label. 31 tests. Live config: `jessica.c.sacher@*:Jessica`, `jan@phage.directory:Jan`, `janzheng@*:Jan`, `janeazy@*:Jan`, `hello@janzheng.com:Jan`. #messaging #mailroom-sender-aliases
- [x] [done 2026-04-24] **Newsletter auto-name** — `src/messaging/newsletter-name.ts` postClassify hook. When classifier tags `newsletter`, pulls display name from `fields.from_addr` (`"Sidebar.io" <hello@uxdesign.cc>` → `newsletter:sidebar-io`). Defers to manual `sender:*` when present. 17 tests. #messaging #mailroom-newsletter-auto-name
- [x] [done 2026-04-24] **Double-opt-in detector + auto-click** — `src/messaging/confirm-detect.ts` postClassify hook: subject heuristic + body URL extraction (prefers anchor-line URLs, then path-hint URLs like `/subscribe/confirm`, avoids `unsubscribe` paths). Writes `fields.confirm_url` + `needs-confirm` label. Auto-click surface: `POST /inbox/:name/confirm/:id` (gated on `needs-confirm` so the endpoint isn't an arbitrary URL fetcher) + `sm_inbox_confirm` MCP tool. 33 tests. CLAUDE.md instructs future sessions to always sweep `needs-confirm` before summarizing the mailroom. #messaging #mailroom-confirm-detect
- [x] [done 2026-04-24] **Auto-confirm on ingest (allowlist-gated)** — `src/messaging/auto-confirm.ts` postClassify hook that runs after confirm-detect. For senders matching `AUTO_CONFIRM_SENDERS` globs, GETs the extracted `fields.confirm_url` at ingest, swaps `needs-confirm` → `auto-confirmed`, writes `fields.auto_confirmed_at` + `auto_confirm_status`. Safety: HTTPS-only, named-domain hosts only (rejects raw IPs), URLs containing `unsubscribe`/`opt-out` rejected defensively, 10s timeout, upstream 4xx/5xx leaves labels unchanged so manual retry still works. 35 tests. (Allowlist runtime-configurable via 2026-04-24 polish session above.) #messaging #mailroom-auto-confirm
- [x] [done 2026-04-24, deploy `27b36a8d-989e-45a8-8e53-d50098cc2fca`] **Read/unread state** — `stampUnreadHook` (postClassify, idempotent, skips `archived`/`quarantined`) wired into mailroom + biorxiv + podcasts. HTTP: `POST /inbox/:name/items/:id/read` + `/unread` (single, returns `{changed}`); `POST /inbox/:name/read` with `{ids}`; `POST /inbox/:name/read-all` with optional InboxFilter body (intersects with `labels:["unread"]` server-side, 10k hard cap with `capped: bool`). MCP: `sm_inbox_mark_read` / `sm_inbox_mark_unread` / `sm_inbox_mark_read_many` (pass `ids` XOR `filter`). Existing pre-deploy items don't carry `unread` — only forward-stamping by design. 31 tests (16 hook unit + 15 HTTP integration). #messaging #mailroom-read-state

---

## 2026-04-23 — RSS pull-runner

In-Worker cron-driven poller for `type: 'rss'` peers. Live at `smallstore.labspace.ai` with `*/30 * * * *` trigger. Two boot-registered RSS inboxes (`biorxiv` + `podcasts`). Re-poll idempotent (content-addressed ids). 32 channel tests + 14 pull-runner tests; 94/94 messaging tests at the time. Briefs: `.brief/rss-channel.md` (parser surface + quirks), `.brief/rss-as-mailbox.md` (ingestion story).

- [x] [done 2026-04-23] RssChannel supports RSS 2.0, Atom 1.0, **RSS 1.0 (RDF)**.
- [x] [done 2026-04-23] Shared `dispatchItem()` helper — email-handler + pull-runner now both use it.
- [x] [done 2026-04-23] Boot-registered inboxes: `biorxiv` (60 items from neuroscience + bioinformatics; both peers later set `disabled: true` post-CF-bot-challenge); `podcasts` (1565 items across MFM 857, Startup Ideas 333, Dumb Money Live 306, How I AI 69 — all four feeds publish their **entire episode history** in one XML doc, so the first poll captured the full back catalog). Each has dedicated D1 table to avoid keyspace collisions.
- [x] [done 2026-04-23] Manual triggers: `POST /admin/rss/poll` (all feeds), `POST /admin/rss/poll/:peer` (one feed).
- [x] [done 2026-04-23] Real-world quirks captured in `.brief/rss-channel.md`: `www.biorxiv.org/rss/*` is behind Cloudflare's managed challenge — use `connect.biorxiv.org/biorxiv_xml.php?subject=...` (RDF, not RSS 2.0); `fast-xml-parser`'s default `processEntities.maxTotalExpansions: 1000` blocks busy podcast feeds (anchor.fm + flightcast both tripped) — raised to 1M; podcast feeds publish full history (MFM 6MB XML, Startup Ideas 3.4MB).

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
