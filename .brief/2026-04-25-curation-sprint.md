# 2026-04-25 — Mailroom curation sprint

**Status:** shipped
**Previous brief this built on:** `.brief/mailroom-curation.md` (design, written 2026-04-25 morning)
**Prior sprint:** `.brief/2026-04-24-mailroom-sprint.md` (pipeline foundation shipped yesterday)
**Deployed:** `smallstore.labspace.ai` version `c0bd59d7-199f-482f-8cdd-35fcc66efbf8`

## What shipped

The curation brief's design went end-to-end in one morning session. 322/322 messaging tests green (+94 from yesterday's 228), 9 commits, 4 live production deploys (iterating on real forwarded mail as we went). Full workflow end-to-end: forward a newsletter → lands labeled → `POST /rules` to archive future noise → retroactive tag existing matches → hard-delete one-offs via DELETE.

```
d86d772  Curation #1: sender-index memory → D1 (persistent across cold starts)
59740d4  Curation: forward-detect + plus-addr + rules + deploy wire (+81 tests)
b78bd62  deploy: SELF_ADDRESSES var for forward-detection whitelist
b17fd9e  Manual-tag endpoint: POST /inbox/:name/items/:id/tag
b2591d2  Hard-delete endpoint + 6-level removal taxonomy in brief
95555e7  Task cleanup: mark curation live-verify done + rules-table superseded
68dccd7  Curation polish: mainViewFilter + GET /quarantine + POST /restore/:id
```

## The arc

### Frame + prereq

Started with a reframe from the user: **mailroom is a product supporting many use cases, not just spam filtering.** Curation (bookmarks + auto-archive) is one use case the same primitives serve. Wrote `.brief/mailroom-curation.md` captures three core workflows (UC1 manual bookmarks, UC2 sender-rule auto-archive, UC3 retroactive rule application) and explicitly notes out-of-scope parallel use cases (spam, multi-user, outbox).

Foundational prereq: **sender-index memory → D1**. The deploy's in-memory sender aggregates were resetting on every Worker isolate cold-start. Swapped in `senderD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'mailroom_senders' })` — same binding, different table, generic k/v mode. Now persistent.

### Three parallel agents (main wave)

- **Agent A — forward-detection** (`src/messaging/forward-detect.ts`, 389 lines, 24 tests). Detects forwarded mail via `SELF_ADDRESSES` from_email match OR `X-Forwarded-For` / `X-Forwarded-From` / `Resent-From` headers. Parses Gmail / Outlook (CRLF) / Apple Mail (`Begin forwarded message:`) body patterns to extract `fields.original_from_email` / `original_from_addr` / `original_subject`. 40-line scan window prevents quoted-From lines deeper in a thread from hijacking extraction. Best-effort — tagging happens even when extraction fails.
- **Agent B — plus-addressing intent** (`src/messaging/plus-addr.ts`, 249 lines, 19 tests). Reads `fields.inbox_addr` for `mailroom+<intent>@` suffix, tags with intent label. Default allowed: `bookmark`/`archive`/`read-later`/`star`/`inbox`/`snooze`. 64-char intent cap, nested-plus noop, input immutability.
- **Agent C — rules family** (`src/messaging/rules.ts` 375 lines + `rules-hook.ts` 76 lines + 6 http-routes + 38 tests across 3 files). `MailroomRule = { id, match (InboxFilter), action, action_args, priority, notes, disabled, created_at, updated_at }`. Five action verbs — `archive` / `bookmark` / `tag` / `drop` / `quarantine`. Tag-style actions stack labels from all matching rules (additive); terminal actions `drop`/`quarantine` first-match-wins by priority (ties: oldest `created_at` first, then lex id). `applyRetroactive` iterates `inbox.query(rule.match)` and re-ingests with labels added via `_ingest({ force: true })`; skips items already carrying the derived label for zero-churn.

All three agents finished in the same working session, file scopes disjoint by design. **Zero merge conflicts.**

### Deploy wiring

`deploy/src/index.ts` registers mailroom with three preIngest hooks in order:

1. `forwardDetect` — auto-detects forwarded mail, tags `forwarded` + `manual`, extracts original_*
2. `plusAddr` — explicit intent wins over auto-detection
3. `rulesHook` — user-configured actions (archive/bookmark/tag/drop/quarantine)

Plus the existing `senderUpsertHook` as postClassify (runs after classifier labels are merged). New `rulesD1` adapter (`table: 'mailroom_rules'`) + `rulesStores` Map. `rulesStoreFor` resolver passed to `registerMessagingRoutes`. `SELF_ADDRESSES` env var threaded through `parseSelfAddresses`. `wrangler.toml [vars]` set to include user's forwarding addresses + whitelisted curators (Jane + Jessica).

### Live iteration on real mail

Where yesterday's sprint was "build then verify," today was "build, deploy, try, fix, redeploy." The user had a Sidebar.io newsletter subscription + a forwarded Claude-convo email already in the inbox pre-dating the curation deploy. Iteration loop:

- First deploy landed — created a test `archive` rule matching `from_email: "sidebar"`. Retroactive `affected: 0` (Sidebar's from_email is actually `hello@uxdesign.cc`, not "sidebar" — display-name-only).
- Updated rule to match `from_addr: "sidebar"` (which includes display name). Retroactive `affected: 1`. Sidebar tagged `['newsletter', 'archived']`. ✓
- Created whitelist-bookmark rule: `from_email: [hello@janzheng, jan@phage, janeazy@gmail, jessica.c.sacher@gmail]`. Retroactive `affected: 2` — caught the Claude forward + the chicken test email.
- User clarified: *"wait we don't want to archive Sidebar, I forwarded it manually and wanted it lol — signed sidebar up for newsletter, I like these!!"* Built `POST /inbox/:name/items/:id/tag` endpoint, deployed, used it to strip `archived` label from Sidebar. Deleted the archive rule.
- User: *"you can delete my stupid chicken crossing item loll"* — built `DELETE /inbox/:name/items/:id` + `Inbox.delete(id)` method. Deployed. Deleted chicken. 🐔💀

### Taxonomy crystallized from use

During the Sidebar-rollback moment, user surfaced a design observation: CF Email Routing has its own "drop" action, which is different from our archive. Documented a 6-level removal taxonomy in `.brief/mailroom-curation.md`:

| Level | Effect |
|---|---|
| CF-level drop | Email never reaches worker |
| Rules `drop` | Parsed, not stored (runtime-editable alt to CF-level) |
| Rules `quarantine` | Stored + tagged, excluded from main view, recoverable |
| Rules `archive` | Stored + tagged (main-view hidden) — "stuff I like but back-burner" |
| Tag remove | Strip a label on one item |
| Hard delete | Item + blobs fully removed |

The key user phrasing: **"archive is aspirational keeping, CF-drop is declared non-existence."** If you keep "archiving" a newsletter you actually want it — just not on top. If you genuinely never want it again, use CF-level drop or rules `drop`.

### Polish round

Closed two remaining `[?]` items the user flagged as worth shipping:

- `mainViewFilter(base?, opts?)` — ergonomic helper that merges `{exclude_labels: ['archived', 'quarantined']}` into the caller's filter. Prevents the "forgot to hide archived" footgun. `DEFAULT_HIDDEN_LABELS` exported for customization. 7 tests.
- `GET /inbox/:name/quarantine` + `POST /inbox/:name/restore/:id` — Agent F had deferred these in yesterday's Wave 2 to avoid dual-agent edits on http-routes.ts. Trivial single-edit-site add now. 6 tests.

## End-state capabilities (composite)

A user can now do all of this against `smallstore.labspace.ai`:

- **Subscribe a newsletter with `mailroom@labspace.ai`** — future issues classified automatically (`newsletter` label from List-Unsubscribe header)
- **Forward a cool email to `mailroom+bookmark@labspace.ai`** — lands labeled `['forwarded', 'manual', 'bookmark']` + any classifier labels; `fields.original_from_*` extracted from body
- **Whitelist trusted curators** — `SELF_ADDRESSES` env var + a `{match: {from_email: [...]}, action: 'bookmark'}` rule → everything from these addresses auto-bookmarked (retroactive on demand)
- **Auto-archive noisy senders** — `{match: {...}, action: 'archive'}` → future matches tagged `archived`, hidden from main view via `mainViewFilter()`
- **Undo an over-eager rule** — `POST /items/:id/tag {remove: ['archived']}` removes the label; delete the rule to stop future tagging
- **Download bookmarks as JSONL** — `GET /inbox/mailroom/export?filter={"labels":["bookmark"]}&include=body&format=jsonl` → stream into an LLM or save for later
- **Hard-remove one-offs** — `DELETE /inbox/mailroom/items/:id`
- **Review quarantined items** — `GET /inbox/mailroom/quarantine`; restore via `POST /inbox/mailroom/restore/:id`

All behind the same `SMALLSTORE_TOKEN` bearer auth.

## Metrics

| Measure | Value |
|---|---|
| Tests added (sprint) | 94 (228 → 322) |
| Commits pushed | 9 |
| Live production deploys | 4 (iterative with real mail) |
| Subagent dispatches | 3 (parallel) |
| Merge conflicts | 0 |
| Bundle growth | 583 KiB → 620 KiB (+37 KiB for all curation modules) |
| New endpoints | 9 (rules CRUD + retroactive + manual-tag + delete + quarantine list + restore) |
| New briefs | 2 (mailroom-curation.md + this sprint brief) |

## What's still queued (not blocking)

**Medium — real UX win when built:**
- MCP `sm_inbox_*` tool family — `sm_inbox_list / read / query / unsubscribe / restore / export / tag / delete / rules_*`. Ship together for consistency. Biggest win for using mailroom from inside Claude Code / Cursor without curl.

**Small polish:**
- Raw + attachments inlining in `/export` — `include=raw` base64s the .eml, `include=attachments` presigned URLs. Body-only covers 80% of newsletter-LLM cases.

**Different use cases (parked):**
- Spam layers — can partially be expressed via the shipped rules engine already (blocklist, header heuristics). Layers 3-4 (reputation + content-hash) would be additive. Promote when you actually see spam.
- Outbox — send mail / auto-respond. Parked from yesterday's sprint.
- More channels — webhook, RSS, voice. Parked from yesterday's sprint.

## Notable design decisions

1. **Rules reuse the existing filter DSL.** No new match syntax; rules are `InboxFilter` + an action verb. All filter capabilities (regex, headers, text, labels, since/until) apply to rule matching. Consistent surface.
2. **Tag-style stack, terminal first-match.** Adding an `archive` rule AND a `bookmark` rule that both match produces both labels. A `drop` rule short-circuits storage. A `quarantine` rule short-circuits sinks but still tags the item. Predictable semantics that match how users think about rules.
3. **Retroactive is opt-in and safe.** `applyRetroactive` skips items already carrying the derived label — running twice produces the same state. Tag-style actions only (you can't retroactively `drop` a stored item; that's what `DELETE` is for).
4. **Hook ordering matters and is documented.** forward-detect (auto) → plus-addr (explicit wins) → rules-hook (user config). Order encoded in `deploy/src/index.ts` with a comment explaining why.
5. **Removal taxonomy is 6 distinct levels, not one knob.** Documented explicitly because the user hit the "I archived something I wanted" and "I want to delete this stupid chicken" cases within 15 minutes of each other.
6. **SELF_ADDRESSES is a `[vars]`, not a secret.** Email addresses are not sensitive; deployment config is fine. Secret-store is available if the user prefers.
7. **Bookmarks vs archives are orthogonal to classifier labels.** An item can be `['newsletter', 'bookmark']` or `['newsletter', 'archived']` — the classifier + curation layers are independent facets that stack.

## References

- Curation brief: `.brief/mailroom-curation.md` (design; now has a "shipped" note)
- Pipeline foundation: `.brief/mailroom-pipeline.md`
- Yesterday's sprint: `.brief/2026-04-24-mailroom-sprint.md`
- Plugin discipline: `docs/design/PLUGIN-AUTHORING.md`
- Done archive: `TASKS.done.md` § `2026-04-25 — Mailroom curation sprint`

## Credits

6 hours, dragged into being by the user's "I want to forward newsletters and have them land as bookmarks" use case. 3 subagents in one wave, 0 conflicts. Four live deploys iterating on real mail within the sprint — the "see what it feels like" testing proved more valuable than any offline test could have.
