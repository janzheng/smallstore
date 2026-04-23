# Mailroom curation — bookmarks, auto-archive, personal KB

**Status:** SHIPPED 2026-04-25 (same-day). Live at `smallstore.labspace.ai` version `c0bd59d7`. Sprint narrative: `.brief/2026-04-25-curation-sprint.md`. Full task archive: `TASKS.done.md § 2026-04-25`.
**Parent:** `.brief/mailroom-pipeline.md` (pipeline + hooks already shipped)
**From:** 2026-04-25 morning conversation after the mailroom EOD sprint

## Framing: one use case among many

Mailroom is a **product that supports many email-handling use cases**. The existing pipeline already has spam-shaped capabilities (classifier, sender-index, quarantine, filter DSL, hook stages) — those are real, intentional, and used by other use cases. This brief covers ONE specific use case the user wants right now: **personal email curation as a knowledge base.**

Other use cases the same primitives serve, NOT replaced by this brief:

- **Spam filtering / threat detection** — Wave 3 spam layers task; uses the same hook pipeline + sender-index + quarantine, just with security rules rather than curation rules
- **Newsletter triage / read-later** — exists today via classifier + filter DSL + export endpoint
- **Agent fan-out** — items POSTed to external services via httpSink (tigerflare bridge, Slack webhooks)
- **Per-address routing** — multiple addresses → different inboxes once envelope_to routing ships
- **Auto-respond / templated replies** — when outbox lands

The curation use case below is **additive**: it composes existing primitives + adds three new pieces (forward-detection hook, plus-addressing intent, runtime-editable rules). Nothing existing changes; no other use case is precluded.

### What this brief covers

The user's immediate workflow:

1. *"I found a cool newsletter email, I want it saved as a bookmark in smallstore."*
2. *"I don't read this newsletter anymore, auto-archive everything from them going forward."*
3. *"Show me my bookmarked emails."*

That's a knowledge-base curation workflow. It reshapes several design decisions for these features specifically:

- **Manual forwards are first-class** for this use case (other use cases may treat them differently)
- **`bookmark` / `archived` / `read-later`** are curation labels (coexisting alongside `spam` / `quarantine` from other use cases — labels don't conflict, they stack)
- **Retroactive application matters** — adding an archive rule should optionally tag existing items
- **`SELF_ADDRESSES` env var** scopes "what counts as forwarded by me" — orthogonal to other senders' identity

The existing pipeline primitives (Sink abstraction, hook stages, sender-index, filter DSL) all compose cleanly. What's missing for this use case:

- A way to ingest *forwarded* mail with its original-sender metadata intact
- A way to express intent at receive-time (this is a bookmark, not a normal inbox item)
- A runtime-editable rules surface for auto-tag-on-sender
- A retroactive apply action

## Three use cases + how each composes primitives

### UC1 — Manually bookmark a cool newsletter

**User intent:** "I read something interesting in Gmail, I want it saved to smallstore as a `bookmark`."

**Flow:**
1. User forwards the email from Gmail to `mailroom+bookmark@labspace.ai`
2. CF Email Routing delivers to the worker (needs plus-addressing route — see infra below)
3. cf-email channel parses as normal; `envelope_to = "mailroom+bookmark@labspace.ai"`
4. **Forward-detection hook** (preIngest) recognizes the forwarded shape:
   - `envelope_to` matches `mailroom+<intent>@` pattern → extract `intent = "bookmark"`
   - `from_email` matches user's own forwarding address OR `X-Forwarded-For` header present → flag `manual = true`
   - Best-effort parse the forwarded body for the original `From:` line → store as `fields.original_from_email`, `fields.original_from_addr`, `fields.original_subject`
5. Hook returns a mutated item with:
   - `labels: ['bookmark', 'manual']`
   - `fields.intent: 'bookmark'`
   - `fields.original_*` populated where extractable
6. Classifier + sinks proceed as normal — item lands in `mailroom` inbox with `bookmark` label
7. User queries: `GET /inbox/mailroom/export?filter={"labels":["bookmark"]}&include=body` → JSONL of every bookmarked newsletter

**Queryable by:** label (`bookmark`), original sender (`fields.original_from_email`), intent (`fields.intent`).

### UC2 — Auto-archive a newsletter going forward

**User intent:** "I don't want to see `news@annoying.com` in my main view anymore. Archive everything from them from now on, but keep the items queryable."

**Flow:**
1. User calls `POST /inbox/mailroom/rules` with `{ match: { from_email: "news@annoying.com" }, action: "archive" }`
2. Rule persists in D1 (`mailroom_rules` table, adapter-agnostic source)
3. Future incoming mail: preIngest hook looks up rules table, evaluates match (uses existing filter.ts evaluator), applies action
4. Matching items get `labels: ['archived']` added
5. Main view query uses `exclude_labels: ['archived']` to hide them
6. Dedicated archive view: `labels: ['archived']`

Action verbs supported at v1: `archive`, `bookmark`, `tag:<name>`, `drop` (hard-drop, rare — use archive for reversibility), `quarantine` (reuses Wave 2 machinery).

### UC3 — Retroactively apply a rule

**User intent:** "I just added that archive rule — can you also archive the 47 existing items from that sender?"

**Flow:**
1. Rule creation endpoint accepts `?apply_retroactive=true`
2. Server queries the inbox with the rule's match filter
3. For each matching existing item, applies the action (tag) via `inbox._ingest(item, { force: true })` with updated labels
4. Returns `{ created: {...rule}, retroactive_applied: 47 }`
5. User can also trigger retroactive apply later: `POST /inbox/mailroom/rules/:id/apply-retroactive`

## Design decisions

### D1 — Label-based, single inbox (no sub-inboxes)

`bookmark` / `archived` / `read-later` are labels on items in the same `mailroom` inbox. Matches the quarantine pattern (Wave 2 #9) and keeps the ops story simple. Consumers of main view pass `exclude_labels: ['archived']`; dedicated views use `labels: ['bookmark']` etc.

### D2 — Two paths for intent: plus-addressing AND forward-detection

Both should work; they reinforce each other:

- **Plus-addressing (explicit, user-typed)**: `mailroom+bookmark@labspace.ai` is user-intentional. Clear, unambiguous.
- **Forward-detection (heuristic, automatic)**: even if you just forward to plain `mailroom@labspace.ai`, the hook can still detect "this was forwarded from your own address" and tag `forwarded` / `manual`. User intent for a specific label is absent, but the fact of manual-ness is captured.

Combination: if plus-addressing + forward-detection both fire, plus-addressing wins (explicit intent). If only forward-detection fires, item lands as `forwarded` + `manual` but no specific intent label — user can tag it later via a manual-tag action.

### D3 — Rules stored in D1, runtime-editable

Rules live in a `mailroom_rules` D1 table (or any smallstore adapter — pluggable). Schema:

```ts
interface MailroomRule {
  id: string;              // uuid or hash
  match: InboxFilter;      // reuses the existing filter DSL (regex, labels, fields, headers)
  action: RuleAction;      // 'archive' | 'bookmark' | 'tag' | 'drop' | 'quarantine'
  action_args?: { tag?: string };  // for 'tag' action: { tag: 'read-later' }
  priority: number;        // lower wins on terminal actions
  notes?: string;          // human annotation
  created_at: string;
  disabled?: boolean;      // soft-disable without deleting
}
```

HTTP surface: `GET /inbox/:name/rules`, `POST /inbox/:name/rules`, `PUT /inbox/:name/rules/:id`, `DELETE /inbox/:name/rules/:id`, `POST /inbox/:name/rules/:id/apply-retroactive`.

Priority: tag-style actions (`tag`, `bookmark`, `archive`) apply ALL matching rules (additive). Terminal actions (`drop`, `quarantine`) first-match-wins by priority. Mirrors mxit's own "match-all-for-tags, first-match-for-terminal" semantics.

### D4 — Original sender extraction is best-effort

Forwarded mail has the original sender buried in the body (Gmail inlines "---------- Forwarded message ----------\nFrom: original@sender.com\n..."). Parse this defensively; null out `fields.original_from_*` on parse failure. Don't throw.

Supporting headers if present: `X-Forwarded-For`, `X-Forwarded-From`, `Resent-From`, `Reply-To` (weaker signal, but sometimes carries original).

### D5 — Plus-addressing needs a CF Email Routing rule change

The existing rule matches `mailroom@labspace.ai` literally. Plus-addressing requires a **new routing rule** for `mailroom+*@labspace.ai → worker:smallstore`. One-time CF dashboard edit, or wrangler-managed if we add it to `wrangler.toml` routing config.

Without this, `mailroom+bookmark@labspace.ai` gets bounced by CF. Worth doing early — it's infra, not code.

### D6 — Self-address list for forward-detection

To detect "this is a forward from the user's own inbox," the worker needs to know the user's own email addresses. Options:

- **Env var**: `SELF_ADDRESSES=jan@phage.directory,hello@janzheng.com` comma-separated
- **Config file**: in `.smallstore.json` under `mailroom.self_addresses`
- **D1 table**: `mailroom_self_addresses` editable at runtime

I'd pick env var for simplicity (shipping today) + document the upgrade path to a runtime-editable list when it matters.

## Task queue

Ordered by dependency. Each is small; total is ~1 day of work.

### Foundational

- [ ] **Move sender-index from memory → D1** (prereq for all rules work; already-flagged follow-up). Same `cloudflareD1` adapter in non-messaging mode with `senders/mailroom/*` key prefix. `deploy/src/index.ts` swap. ~30 min #sender-index-d1
- [ ] **CF Email Routing: add `mailroom+*@labspace.ai` rule** — dashboard or wrangler config. One-time infra. ~10 min #email-routing-plus-addr

### Ingestion-side

- [ ] **Forward-detection hook** — new `src/messaging/forward-detect.ts` with `detectForward(item, opts: { selfAddresses: string[] }): InboxItem | null` that returns a mutated item with `manual`/`forwarded` labels + best-effort `fields.original_*` extraction from body + common forwarding headers. Wire as a preIngest hook in `deploy/src/index.ts`. Tests: 5-7 cases covering Gmail forward format, Outlook forward, X-Forwarded-For header, no-forward baseline. ~2 hours #forward-detect
- [ ] **Plus-addressing intent hook** — preIngest hook that reads `item.fields.inbox_addr` (which is `envelope_to` lowercased), extracts intent from `mailroom+<intent>@...` pattern, tags item with that label. Small (~20 LOC). Tests: 4-5 cases covering `+bookmark`, `+archive`, `+read-later`, no-plus, malformed plus. ~30 min #plus-addr-intent

### Rules

- [ ] **Rules storage module** — `src/messaging/rules.ts` with `createRulesStore(adapter, { keyPrefix })` → `{ list, get, create, update, delete, apply(item) }`. Uses InboxFilter + existing evaluator for match. Actions: `archive`, `bookmark`, `tag`, `drop`, `quarantine`. Adapter-agnostic (same pattern as sender-index). Tests: 8-10 cases covering CRUD + apply + priority + disabled rules. ~2 hours #rules-store
- [ ] **Rules HTTP surface** — add routes to `http-routes.ts`: `GET/POST /inbox/:name/rules`, `PUT/DELETE /:id`, `POST /:id/apply-retroactive`. Requires a `rulesStoreFor(name)` resolver in RegisterMessagingRoutesOptions. Tests: 6-8 cases. ~1 hour #rules-http
- [ ] **Rules preIngest hook** — `src/messaging/rules-hook.ts` factory: `createRulesHook(rulesStore)` returns a PreIngestHook that evaluates all rules against the item and applies matching actions (tag stacking for tag-style, first-match for terminal). Tests: 5-6 cases. ~1 hour #rules-hook
- [ ] **Retroactive apply** — method on rules store: `applyRetroactive(rule, inbox, opts)` iterates `inbox.query(rule.match)` and re-ingests each matching item with labels added via `_ingest({ force: true })`. HTTP route wires to this. Tests: 3-4 cases. ~45 min #rules-retroactive

### Deploy wiring

- [ ] **deploy/src/index.ts updates** — instantiate rulesStore + forwardDetect + plusAddrHook, wire as preIngest hooks in `registerSinks` for the mailroom inbox. Pass `SELF_ADDRESSES` env var through. Expose `rulesStoreFor` + `senderIndexFor` resolvers in `registerMessagingRoutes` options. ~30 min #curation-deploy-wire

### Polish (optional, same-day if time)

- [ ] **Manual-tag surface** — `POST /inbox/:name/items/:id/tag` with `{ add?: string[], remove?: string[] }` for after-the-fact labeling. Useful when forward-detection fires but user wants to upgrade the label (e.g. from `manual` to `bookmark`). ~30 min #manual-tag-action
- [ ] **Main-view filter helper** — `mainViewFilter()` returning `{ exclude_labels: ['archived', 'quarantined'] }` merged with caller's filter. So consumers don't have to remember every "hide these" label. Follow-up from quarantine work #main-view-helper

## Removal / hiding taxonomy — 6 levels of "don't show this"

A design observation surfaced 2026-04-25 during live use: different "hide/remove" workflows have genuinely different semantics, and smushing them together makes the model worse. The system now supports six levels, ordered roughly by destructiveness:

| Level | Where | Effect | Use when |
|---|---|---|---|
| **CF-level drop** | Cloudflare Email Routing dashboard — set action on a routing rule to "Drop" | Email never reaches the worker; not stored anywhere, not counted, not auditable | Domain-level true unsubscribe — spam relays, ex-newsletters you want zero trace of |
| **Rules `drop` action** | `POST /inbox/:name/rules {match, action:"drop"}` | Email reaches worker + gets parsed, but hook returns `'drop'` verdict → no sink invoked, no storage | Same intent as CF-level drop but runtime-editable without touching CF dashboard. Use when you want a quick "stop seeing this" that you can toggle off later |
| **Rules `quarantine` action** | `POST /inbox/:name/rules {match, action:"quarantine"}` | Stored + labeled `quarantined`; main view excludes via `exclude_labels` | "Probably spam, want to review" — recoverable, auditable |
| **Rules `archive` action** | `POST /inbox/:name/rules {match, action:"archive"}` | Stored + labeled `archived`; main view excludes | **"Stuff I like, want to keep, but are on the back burner"** (user's phrasing). Dedicated archive view via `?labels=archived` |
| **Manual tag remove** | `POST /inbox/:name/items/:id/tag {remove:["<label>"]}` | Strips a label from one item without deleting it | "Auto-labeler was wrong on this specific item" — item stays, just reclassified |
| **Hard delete** | `DELETE /inbox/:name/items/:id` | Item + blobs fully removed; index updated | "This one item I don't want anywhere" — one-off cleanup, not pattern-based |

Key distinction: **archive is aspirational keeping, CF-drop is declared non-existence.** If you liked a newsletter and keep "archiving" it, you actually want to keep it — just not at the top of the inbox. If you genuinely never want to see anything from `news@spammer.com` again, use CF-level drop (or the rules `drop` action) — the storage cost is zero, and queries can't accidentally re-surface it.

The `drop` action and CF-level drop are technically equivalent for storage purposes, but differ operationally:
- **CF-level** = managed via CF dashboard, requires dashboard access, more permanent-feeling, harder to debug ("why didn't this email arrive?")
- **Rules-level** = managed via our HTTP API, easy to toggle `disabled: true`, shows up in a `GET /rules` audit

Lean towards archive for "like but busy"; lean towards CF-level drop for "truly gone"; use rules-level drop when you want the easy-to-toggle middle ground.

## Out of scope for this brief

These are real other use cases / features that the same primitives could support — **not deprecated by this brief, just not addressed by it.** Each has its own follow-up task (or already exists):

- **True spam filtering** (regex blocklists, sender reputation thresholds, content hash dedup) — Wave 3 spam layers, separate task, composes on the same rules engine
- **LLM-based classification** ("is this interesting?") — layer 5; defer until the explicit-rules surface feels insufficient. Worth adding when the set of bookmark-worthy senders is too dynamic to maintain manually
- **Multi-user isolation** — single-tenant assumed. If mailroom ever hosts multiple users, rules scope by user (small change to the rules-store key prefix)
- **Search over bookmarks** — already works: FTS5 + `?filter={"labels":["bookmark"]}&fts=keyword`
- **Per-address routing to different inboxes** — `mailroom@labspace.ai` → mailroom inbox vs `support@labspace.ai` → support inbox; that's the existing envelope_to routing task. Plus-addressing in this brief is intent-tagging on the *same* inbox, not routing to a different inbox
- **Outbox / auto-respond** — separate plugin family

## Success criteria

User can:
1. Forward an email from Gmail to `mailroom+bookmark@labspace.ai`, have it land with `bookmark` label, original sender preserved in `fields.original_*`, queryable via `?filter={"labels":["bookmark"]}`
2. `POST /inbox/mailroom/rules {match: {fields: {from_email: "news@annoying.com"}}, action: "archive"}` → future mail from that sender auto-labeled `archived`, invisible in main view, recoverable via `?filter={"labels":["archived"]}`
3. Add `?apply_retroactive=true` to the rule creation → existing items from that sender also get tagged
4. `DELETE /inbox/mailroom/rules/:id` → removes the rule. Existing already-labeled items stay labeled (that's history); only future mail stops getting auto-tagged.

## References

- Parent pipeline design: `.brief/mailroom-pipeline.md`
- Sprint narrative: `.brief/2026-04-24-mailroom-sprint.md` (what's already built)
- Filter DSL this reuses: `src/messaging/filter.ts` + `.ts` + filter-spec
- Quarantine pattern this mirrors: `src/messaging/quarantine.ts` (label-based, store-first)
- Sender-index foundational piece: `src/messaging/sender-index.ts` (persistence migration needed first)
