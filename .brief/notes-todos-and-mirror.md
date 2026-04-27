# Notes → todos + browsable mirror

**Trigger (2026-04-27):** the after-the-fact note endpoint shipped (`.brief/forward-notes-and-newsletter-profiles.md`); user immediately tested it on a Rosieland forward whose note was *"reminder to self: sub mailroom to rosieland"* — i.e. a real action item buried inside a free-text note. Two distinct asks fell out:

1. *"extract todos from notes into a /fold:mxit"* — turn the action-item shape that already exists in notes into something the user can actually work through.
2. *"get them out into something more browsable… is copying to tigerflare too much?"* — the `/newsletters/:slug/notes` API is real-time but curl-only; user wants a markdown surface they can read in Obsidian/tigerflare.

A third item came up in conversation but is **deferred** — see § 4.

---

## Design constraints (carry-overs)

- **Smallstore stays the source of truth.** Anything that mirrors goes one-way; no round-trip, no conflict resolution. Same shape as the rules-engine retroactive system + the hook-replay endpoint: smallstore writes; everyone else reads.
- **Derived views, not new schema.** Wherever possible, scan existing `fields.forward_note` / `fields.newsletter_slug` rather than introducing new storage. Same discipline that kept the newsletter-profile routes free of a separate "publishers" table.
- **No state in v1 for todos.** "Done" tracking is a separate axis with its own UX questions (where does the toggle live? does marking done edit the original note?). v1 is read-only discovery.

---

## Phase 1 — todo view (cheapest, ship first)

Pure derived endpoint that scans every item with `forward_note` for action-shaped lines. No schema change, no extraction-at-ingest, no LLM. Regex pass; promote to LLM later if the regex misses too much.

### API

```
GET /inbox/:name/todos
  ?slug=<newsletter-slug>     # scope to one publisher
  ?since=<iso>                 # only items received after
  ?limit=<n>                   # default 100
```

Response:
```json
{
  "inbox": "mailroom",
  "count": 1,
  "todos": [
    {
      "item_id": "a32e8f984cc...",
      "newsletter_slug": "rosieland",
      "newsletter_display": "Rosieland",
      "subject": "The overglorification of 'the pivot'",
      "original_sent_at": "2026-04-26T08:16:00.000Z",
      "received_at": "2026-04-27T00:46:38.928Z",
      "matched_line": "reminder to self: sub mailroom to rosieland",
      "matched_pattern": "remind",
      "full_note": "<entire forward_note for context>"
    }
  ]
}
```

### MCP

`sm_inbox_todos(inbox, slug?, since?, limit?)` — same shape.

### Pattern set (line-by-line scan over `forward_note`)

Line matches if it contains any of (case-insensitive):

| Pattern | Examples it catches |
|---|---|
| `^\s*-?\s*\[\s*\]\s+` (markdown unchecked checkbox) | `- [ ] sub to rosieland` |
| `^\s*todo:` | `TODO: review part 2` |
| `^\s*action:` | `Action: respond by Friday` |
| `\b(remind|remember)\s+(me\s+)?to\b` | "remind me to bookmark this" |
| `\bsub\s+(me\s+)?to\b` | "sub mailroom to rosieland" |
| `\bfollow\s*up\b` | "followup with author" |

The `matched_pattern` field returns the rule name that fired so the UI can show "(via TODO: prefix)" / "(via 'remind me')" — useful while we're tuning.

### Edge cases worth flagging in the test suite

- A note with **multiple** matching lines emits multiple todos for the same item_id.
- Lines that are pure quoted-reply (`> ...`) should be skipped — those are the original publisher's content, not user notes.
- `[x]` (checked) lines should NOT match — that's the "done" form.
- Empty / whitespace-only `forward_note` → no todos.
- `since` filter applies to `received_at` (when the user forwarded), not `original_sent_at` — todos are about user actions, not publisher cadence.

### Out of scope for Phase 1

- "Mark done" — defers until we have a real workflow ("I worked through these, where do I tick them off"). Cheapest answer when we do: encode `[x]` in the original note via the existing `sm_inbox_set_note` with `mode: 'append'` or a future `mode: 'edit'`. No new state needed.
- LLM extraction — the regex set covers the obvious shapes; promote when something specific gets missed.
- Cross-newsletter aggregation ("all my todos this week regardless of slug") — already free via no `slug` filter.

---

## Phase 2 — markdown export + tigerflare mirror

Two parts, ordered. Ship Phase 2a alone first (pure read-side, no new dependencies); only build 2b if 2a turns out to be insufficient in practice.

### Phase 2a — markdown export endpoint

Add `?format=markdown` to the existing newsletter routes:

```
GET /inbox/:name/newsletters/:slug?format=markdown
GET /inbox/:name/newsletters/:slug/notes?format=markdown
GET /inbox/:name/newsletters?format=markdown    # index of all publishers
```

Response is `Content-Type: text/markdown; charset=utf-8` — the full publisher view rendered as a single markdown document.

Per-newsletter shape (`newsletters/<slug>.md`):

```markdown
# Internet Pipes

**Display:** Steph at Internet Pipes
**First seen:** 2024-08-31
**Last seen:** 2026-04-26
**Issues:** 24
**Notes:** 3

---

## 2024-08-31 — IP Digest: New Events, Disaster Insurance, Bubble Tea & More!

_(no note)_

[View item →](https://smallstore.labspace.ai/inbox/mailroom/items/abc123)

## 2025-09-30 — IP Digest: Fitness Testing, …

**Note:**
> I loved the section on factory tours.

[View item →](https://smallstore.labspace.ai/inbox/mailroom/items/def456)
```

Index shape (`newsletters/index.md`):

```markdown
# Mailroom newsletters

| Slug | Display | Issues | Notes | Last seen |
|------|---------|--------|-------|-----------|
| [internet-pipes](./internet-pipes.md) | Steph at Internet Pipes | 24 | 3 | 2026-04-26 |
| [rosieland](./rosieland.md) | Rosieland | 1 | 1 | 2026-04-26 |
```

**Why this is worth doing alone:** any tool — including manual `curl > file.md` — can pull the same markdown that a future cron job would write. The export is the contract; the cron job is just an automation on top.

### Phase 2b — periodic tigerflare push (cron)

The Worker already has `schedule: */30 * * * *`. Extend the `scheduled()` handler with an optional tigerflare-mirror task:

1. Read `GET /inbox/mailroom/newsletters?format=markdown` (own Worker, no auth roundtrip needed — the handler can call internal Inbox APIs directly).
2. For each slug, render the markdown via the same code path as Phase 2a.
3. Push to tigerflare via the existing peer-registry HTTP surface — peer named e.g. `tigerflare-mailroom-mirror`, target path configured in the peer's metadata.

Configuration shape on the peer:
```json
{
  "name": "tigerflare-mailroom-mirror",
  "type": "tigerflare",
  "metadata": {
    "mirror_config": {
      "source_inbox": "mailroom",
      "target_space": "mailroom-mirror",
      "include_index": true
    }
  }
}
```

Triggered every 30 minutes (matching existing cron). Idempotent — re-rendering the same markdown is a no-op write. Failures log + skip the slug; don't retry-loop.

### Why peer-mediated, not a direct sink

- **Smallstore doesn't bake tigerflare auth.** Auth lives in `wrangler secret put TF_TOKEN`, referenced by the peer row's `auth.token_env`. Same pattern as every other peer — no special case.
- **Disable / re-target without redeploy.** Pause the mirror by disabling the peer; change the target space by editing the peer; remove the mirror entirely by deleting the peer. All runtime ops, no rebuild.
- **Same path as future mirrors.** If the user wants a second mirror to a different target (e.g. notion, an obsidian sync folder via webdav), that's another peer row. The cron task iterates over all `mirror_config`-equipped peers.

### Edge cases worth flagging

- **Slug with regex meta-chars** in the URL — already handled by the newsletter routes (escapeRegex), markdown export inherits.
- **Big newsletters (50+ issues)** — markdown gets long but still bounded. Don't paginate; one file per publisher is the shape.
- **No `original_sent_at`** on an item — sort it to the tail with a `(date unknown)` heading. Same semantics as the existing `/newsletters/:slug/items` route.
- **Empty publishers** (slug exists with 0 items, theoretically possible after delete) — skip emitting the file; remove from index.
- **Note with markdown** — pass through verbatim. User notes are markdown by convention; we wrap them in a blockquote for visual containment but don't escape.

---

## Phase 3 — deferred: newsletter-level meta-notes

Not building yet. Captured here so the design isn't lost.

User mentioned wanting "sender/newsletter-level notes" separate from per-issue notes — the "what I think about this newsletter overall" surface. Per-issue notes already aggregate well (see `/newsletters/:slug/notes`), so the marginal value of a separate primitive is unclear until someone tries to write one and finds it awkward.

When it's needed, the API mirrors per-item annotation:

```
POST /inbox/:name/newsletters/:slug/note
Body: { note: string, mode?: 'replace' | 'append' }
```

Storage option (a): a synthetic item with `id: __meta__:<slug>`, `source: 'meta'`, in the same inbox storage. Cheap, no new collection, but pollutes inbox listings unless we filter out the meta items at list time.

Storage option (b): a separate `newsletter_meta` collection / D1 table keyed by `(inbox, slug)`. Cleaner, but introduces a new storage seam.

Recommendation when it's time: **option (a) with an `_meta_` label that the default mainViewFilter excludes.** Reuses everything; one new label is cheap.

---

## More ideas (parked, in priority order if revisited)

- **Todo "done" state** — append `[x]` to the matched line via a `sm_inbox_check_todo(item_id, line_hash)` MCP tool. No new storage; the original note becomes the source of truth for done state.
- **Tigerflare reverse-sync** — read tigerflare-edited notes back into smallstore. Reject by default (smallstore is the source of truth) but worth thinking through if Obsidian editing becomes the primary write path.
- **Topic threading from notes** — parked from the original forward-notes brief. LLM-extract topics across all `forward_note` content per slug; surface as `/newsletters/:slug/topics`.
- **Note-length as engagement signal** — also from the original brief. Correlate note-length with `interest_score`; surface in `/newsletters/:slug` profile dashboard.
- **Per-todo "send to..." action** — todos that read like "sub mailroom to X" could trigger an automated subscribe via the peer registry (or surface a one-click confirm URL when the corresponding signup confirmation lands).

---

## Order

Ship in this order. Each phase is independently shippable; don't gate later phases on the experience of earlier ones unless they fail in practice.

1. **Phase 1 — `/inbox/:name/todos` + `sm_inbox_todos`** (~45 min build + tests)
2. **Phase 2a — markdown export endpoints** (~45 min)
3. **Phase 2b — peer-mediated tigerflare cron mirror** (~60-90 min, depends on the peer-config plumbing)

Total: half a day if all three ship. Each is a real, sufficient stopping point.

---

## Tests to plan

For Phase 1, the test file is `tests/messaging-todos.test.ts` and should cover:

- All six pattern shapes match (one fixture each)
- Multi-line note → multi-todo
- Quoted-reply `> ...` lines skipped
- `[x]` checked lines do NOT match
- Empty `forward_note` returns nothing for that item
- `slug` filter restricts to one publisher
- `since` filter on `received_at`
- 404 unknown inbox / 200 empty for known inbox with no notes
- MCP tool dispatch + arg validation

For Phase 2a:

- Markdown rendering snapshot for the IP Digest case (real chronology, real notes)
- Index page enumerates all known slugs with correct counts
- `Content-Type: text/markdown` header set
- Empty-publisher edge case (no items) returns empty markdown but valid response
- Slug regex meta-chars survive (use a fixture slug with `.`)

For Phase 2b:

- Cron handler renders markdown identical to the HTTP path
- Peer disabled → no push, no error
- Peer not found → log + skip, no error
- Tigerflare write failure on one slug → other slugs still attempt
- Re-running with no changes → idempotent (same markdown, no diff)
