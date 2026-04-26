# Forward notes + newsletter profiles

**Status:** Brief — 2026-04-26.
**From:** chat session triaging 26 IP Digest forwards that landed out of order; user asked "if I forward several with notes, do they aggregate?"
**Pairs with:** `.brief/mailroom-curation.md` (the curation pipeline this extends) · `src/messaging/forward-detect.ts` (the hook this enriches).

## The user moment

> *"i forwarded a bunch of internetpipes emails out of order; any way you could help clean them up in order? also when we forward stuff and add notes will they land in a notes section that in aggregate describes that newsletter?"*

That's two clean asks, and they share an axis: **forwards aren't first-class enough.** Right now a forward is "an email that happens to be from the user about another email." We extract the original sender + subject. We DON'T extract the original date, and we DON'T have a surface that aggregates per-newsletter context (the user's accumulating commentary, the chronological reading list, the sender-level notes file).

This brief turns forwards into a real curation primitive: capture every meaningful signal at ingest, derive aggregate views on read, and make backfill a system pattern (not a one-off script) so adding a new field in the future is cheap.

## What "feels right" looks like

- **Forward an email**, optionally with a note above the delimiter. ✓ already works.
- **Query Internet Pipes by original send date** — see all 26 issues from oldest to newest, the way they were meant to be read. *(today: sorted by when you forwarded them.)*
- **See your annotations on a newsletter** — `GET /newsletters/internet-pipes/notes` returns every `forward_note` you've written about IP issues, with their original sent-date + your commentary, ordered chronologically. Cheap to LLM-summarize.
- **Newsletter profile page** — `GET /newsletters/internet-pipes` returns a small dashboard: count, last-issue date, your most recent note, the running themes (your tags + auto-extracted topics).
- **Add a field retroactively** — when forward-detect grows a new extraction (say, "extract the original `Reply-To`"), every existing forwarded item picks it up via a single admin call. No script-of-the-month, no ad-hoc Python.

The UX bet: **annotation on the way in, aggregation on the way out.** The user puts thought into forwarding-with-a-note; the system rewards that thought by surfacing it back in useful slices. The mailroom is already 80% there — this brief closes the loop.

## Data model

### What forward-detect captures today (`src/messaging/forward-detect.ts`)

```
fields.from_email           = user (because they forwarded it)
fields.original_from_email  = "internetpipes@broadcasts.lemonsqueezy-mail.com"
fields.original_from_addr   = "Steph at Internet Pipes <internetpipes@...>"
fields.original_subject     = "IP Digest: Whimsymaxxing, ..."   (Fwd: prefix stripped)
fields.forward_note         = "loved the agrivoltaics piece — ties into..."  (if user typed above delimiter)
labels                      = ["forwarded", "manual", ...]
```

### What forward-detect should ALSO capture (this brief)

```
fields.original_sent_at     = "2026-04-26T10:16:00.000Z"  (parsed from forward body's "Date:" line)
fields.original_message_id  = "<...>"                     (parsed from forward body's "Message-ID:" line)
fields.original_reply_to    = "internetpipes@..."         (when present in forward body)
fields.newsletter_slug      = "internet-pipes"            (derived from original_from_addr display name)
```

The first two are the load-bearing ones (sorting + deduping across forwards of the same item). The rest are nice-to-haves.

### Newsletter profile — derived, not stored

An `internet-pipes` newsletter profile is just **"every item where `newsletter_slug == 'internet-pipes'`"**, queried on demand. No new storage:

- **Notes view:** the items that have non-empty `forward_note`, ordered by `original_sent_at`.
- **Reading list:** every issue, ordered by `original_sent_at`.
- **Stats:** `count`, `first_seen`, `last_seen`, `notes_count`, `last_note`.

Promote to a stored aggregate (`senders/<slug>` record) only if rolling state needs to live somewhere — running summaries, accumulated topic tags, "I've been reading IP for 18 months and here's what changed in my taste" hindsight. Not v1.

### Sort key invariant

`received_at` stays canonical (when the inbox got the forward). `original_sent_at` is what the **content** is dated. Two-axis sorting solves the "out of order" gripe without lying about delivery.

---

## Phases

### Phase 1 — capture (extend forward-detect)

**Goal:** every forwarded email at ingest gets `original_sent_at`, `original_message_id`, `newsletter_slug` populated when the forward body is parseable.

- Extend `extractForwardHeaders()` in `src/messaging/forward-detect.ts` to also parse:
  - `Date:` line → `fields.original_sent_at` (ISO-8601 normalized; tolerate Gmail's `Sun, Apr 26, 2026 at 10:16 AM` shape, Outlook's `Sunday, April 26, 2026 10:16 AM`, Apple Mail's RFC 5322 form).
  - `Message-ID:` line → `fields.original_message_id`.
  - `Reply-To:` line → `fields.original_reply_to`.
- Derive `newsletter_slug` from `original_from_addr`'s display name (slugify "Steph at Internet Pipes" → "internet-pipes" — strip filler words, kebab-case, lowercase). Reuse `slugifySenderName` from `sender-aliases.ts` if it fits; otherwise sibling helper.
- Tests: parse-from-body for each major mail client, malformed-date tolerance, missing-fields graceful path (existing fields unaffected).

**Risk:** zero. Additive fields. Existing items unchanged. Worst case: a parser miss leaves new fields undefined (current behavior).

### Phase 2 — surface (newsletter profile + notes views)

**Goal:** querying "all my IP Digests in order" or "all my IP Digest notes" is one HTTP call, not a fan-out.

- **Sort by `original_sent_at`** — extend `Inbox.list` / `Inbox.query` with `order_by: 'original_sent_at' | 'received_at' | 'sent_at'` (default: `received_at`). Bracketed by `fields.original_sent_at` presence — items missing the field sort to the end (or get filtered, caller's choice).
- **Newsletter routes** (read-only, derived):
  - `GET /newsletters` — list slugs with counts (derived via index scan of `fields.newsletter_slug`).
  - `GET /newsletters/:slug` — profile dashboard (count, first_seen, last_seen, notes_count, last_note).
  - `GET /newsletters/:slug/items?order=original_sent_at` — chronological reading list.
  - `GET /newsletters/:slug/notes` — only items with non-empty `forward_note`, ordered chronologically. JSONL export option (`?format=jsonl`) for LLM pipelines.
- **MCP tools:** `sm_newsletters_list`, `sm_newsletter_get`, `sm_newsletter_notes`. Mirror the HTTP shape.

**Risk:** low. New read-only routes; doesn't touch ingest. The `newsletter_slug` field is the one cross-cutting concern — needs a sender-index-style secondary index for fast queries at scale, but at ~26 items the naive scan is fine.

### Phase 3 — retroactive backfill (the system, not a script)

This is what the user asked about: "is that a script or a system we use? that's clever."

**The precedent:** `RulesStore.applyRetroactive(rule, inbox)` (`src/messaging/rules.ts:120`) re-runs an existing rule's filter+action over every item already in the inbox. The rules engine treats retroactive as a first-class operation. We extend that pattern to hooks.

**The gap:** hooks (`preIngest`, `postClassify`, `postStore`) run only at ingest. There's no replay surface. Adding a field to `forward-detect` today means existing items don't get the new field — unless someone writes a one-shot script.

**The fix — a generic "replay hook over filtered items" admin endpoint:**

```
POST /admin/inboxes/:name/replay
{
  "hook": "forward-detect",            // or "sender-aliases" | "newsletter-name" | ...
  "filter": { "labels": ["forwarded"] }, // InboxFilter — which items to process
  "fields_only": true,                 // don't re-run ingest pipeline; just rewrite fields
  "dry_run": true                      // first call always: preview what would change
}
```

For each matching item, the endpoint re-runs the named hook against the **stored** item (not against re-fetched raw input — which we don't have for old items). The hook returns its `verdict.fields` patch; we merge into the existing item via `_ingest({ force: true, fields_only: true })`. New `fields_only` flag on `IngestOptions` skips appendIndex (no re-sort) + skips rerunning subsequent hooks.

**Why this is better than a script:**
- **Self-documenting** — every hook becomes retroactively-applicable for free; the same code path works for new ingest and old data.
- **Filterable** — backfill only items matching some criteria (e.g. only forwarded items, only items missing `original_sent_at`, only items from the last 90 days).
- **Auditable** — dry-run shows the diff; the real run records who ran it + when.
- **Reusable** — when forward-detect grows another field in 2027, the same endpoint backfills it. When a new hook ships, we add it to the dispatcher and `replay` works on day one.
- **MCP-friendly** — `sm_inbox_replay_hook` lets a user say "rerun forward-detect over my mailroom" without leaving their chat.

**Trade-off:** the hook has to be replayable from the stored item alone (it can't depend on the raw .eml that's now in R2 only as `raw_ref`). For forward-detect this is fine — it parses `body` + `fields`, both of which are in the stored item. For some future hook that needed raw bytes, we'd document the constraint.

**Risk:** medium. Adding `fields_only` flag to `_ingest` is a new code path that needs careful testing — labels mutation, blob writes, hook dispatch all need bypass logic. The dry-run gate is mandatory; no production calls without preview.

---

## More ideas (not blocking; promote when relevant)

### Annotation after-the-fact

Sometimes you forward an email without a note, then think of one later. Add `POST /inbox/:name/items/:id/note { text: "..." }` that writes/replaces `fields.forward_note`. MCP: `sm_inbox_annotate`. Pairs with the newsletter notes view — your retrospective annotations become first-class.

### Notes + tags as a kit

Forward-notes are free-form. A note can mention a topic. If we extract topic-style tags from notes (`#startup-ideas`, `#agrivoltaics`, or LLM-extracted on-demand), the newsletter profile gets a rolling topic cloud. Cheap to add later as a postClassify enrichment hook.

### Interest signal from notes

A long forward-note signals high engagement. Aggregate per-newsletter average note-length as a "how much do you actually engage with this" axis. Useful for "newsletters I should keep vs. drop."

### Cross-newsletter themes

Once notes are slugged + topic-tagged, aggregate by topic across senders: "everything I noted about agrivoltaics, regardless of which newsletter mentioned it." This is the genuine new view — newsletters fragment context; tags re-thread it.

### Reading queue with state

Forwards become a reading queue. New labels: `to-read`, `reading`, `read`. The newsletter profile tracks unread-count per source. Forward + immediately archive = queue insertion; reading marks it `read`. Implicit reading list, no separate tool.

### LLM summary surfaces

`POST /newsletters/:slug/summarize` — feeds the chronological notes into an LLM with a prompt template, returns a synthesized "what I've thought about Internet Pipes over time." Premium, expensive call; only on demand.

### Sender deduplication at slug level

Right now `original_from_email` distinguishes `internetpipes@broadcasts.lemonsqueezy-mail.com` from a hypothetical `internetpipes@convertkit.com` if they migrate ESPs. Slugifying on display name unifies them. Bonus: weather changes in delivery infrastructure don't fragment your newsletter history.

### Notes export to a "second brain"

`GET /newsletters/:slug/notes?format=markdown` produces a clean MD doc — date heading, original subject, your note, link to original. Drop in Obsidian / a tigerflare space / a daily note. Forwards become a deliberate research-capture flow.

---

## Out of scope

- **Multi-user** notes. Single-user mailroom assumption. If multi-user ever lands, notes get a `noted_by` field — easy.
- **Threaded conversations within forwards.** A forward-of-a-reply-of-a-forward is rare and we'll handle if it bites.
- **Inline rich text** in notes. Plaintext only; if someone wants markdown, we render on read.
- **Public sharing** of notes. Notes are private annotations; sharing requires a separate decision.

---

## Tasks

### Phase 1 — capture

- [ ] Extend `extractForwardHeaders()` in `src/messaging/forward-detect.ts` to parse `Date:`, `Message-ID:`, `Reply-To:` from forward body. Tolerate Gmail/Outlook/Apple Mail date shapes. Tests for each. #messaging #forward-detect-original-date
- [ ] Derive `fields.newsletter_slug` from `original_from_addr` display name. Reuse `slugifySenderName` if shape matches; otherwise sibling helper. Tests for slug stability across casing/punctuation. #messaging #newsletter-slug

### Phase 2 — surface

- [ ] Extend `Inbox.list` / `Inbox.query` with `order_by: 'received_at' | 'sent_at' | 'original_sent_at'`. Items missing the sort field tail. #messaging #inbox-multi-sort
- [ ] New HTTP routes: `GET /newsletters`, `GET /newsletters/:slug`, `GET /newsletters/:slug/items`, `GET /newsletters/:slug/notes`. All read-only, derived from inbox queries. #messaging #newsletter-routes
- [ ] MCP tools: `sm_newsletters_list`, `sm_newsletter_get`, `sm_newsletter_notes`. #messaging #newsletter-mcp

### Phase 3 — retroactive backfill

- [ ] `POST /admin/inboxes/:name/replay` — generic hook-replay endpoint. Filter + hook-name + dry-run + fields_only flags. Mirror `applyRetroactive` ergonomics. #messaging #replay-hook-system
- [ ] `IngestOptions.fields_only` — new flag on `_ingest` that merges fields into an existing item without re-running blobs/hooks/index-update. Path-traversal-style guard: forbid rewriting `id`, `received_at`, `source`. Tests for label union, fields merge, missing-item 404. #messaging #ingest-fields-only
- [ ] MCP: `sm_inbox_replay_hook`. #messaging #replay-mcp
- [ ] Concrete trigger — backfill the 26 IP Digest items: dry-run, then real run, populating `original_sent_at` + `newsletter_slug` retroactively. Validates the system end-to-end. #messaging #ipdigest-backfill

### Stretch

- [ ] `POST /inbox/:name/items/:id/note { text }` — after-the-fact annotation. #messaging #annotation-endpoint
- [ ] `GET /newsletters/:slug/notes?format=markdown` — second-brain export. #messaging #notes-md-export
- [ ] Interest-signal aggregation (note-length per sender). #messaging #interest-signal — defer until profile UX ships
- [ ] Cross-newsletter topic threading (extracted topics). #messaging #cross-newsletter-tags — defer until tags-from-notes ships

---

## Notable design decisions

1. **Aggregation is derived, not stored.** Newsletter profiles are queries-on-read until a use case demands rolling state. Keeps the data model thin.
2. **Two sort axes, not destructive rewrite.** `received_at` stays honest; `original_sent_at` is the new sort key. No lying about delivery time.
3. **Retroactive as a system, not a script.** The replay endpoint generalizes — every future hook becomes backfillable for free. The script-per-feature pattern is a code smell; this design eliminates it.
4. **Slug is the join key.** Email addresses fragment when ESPs change; display-name slug is durable. Pairs with sender-aliases for human-renamed sources.
5. **Annotation is the UX, aggregation is the payoff.** The bet is that users who write notes when they forward get more value over time than users who don't. Build for the annotator.

---

## References

- `src/messaging/forward-detect.ts` — the hook this brief extends
- `src/messaging/rules.ts:326` — `applyRetroactive` precedent for the replay-hook design
- `src/messaging/sender-aliases.ts` — `slugifySenderName` reuse target
- `.brief/mailroom-curation.md` — the curation pipeline this fits into
- `TASKS-MESSAGING.md § Mailroom pipeline` — current state of the mailroom backlog
