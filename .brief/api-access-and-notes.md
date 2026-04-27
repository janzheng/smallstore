# API access, notes, and todos — the mental model

A reference for how the smallstore Worker at `https://smallstore.labspace.ai` is reached, how forward-notes flow through it, and how the todo extraction sits on top of those notes. Companion to `.brief/forward-notes-and-newsletter-profiles.md` (which covers the *why* of newsletter profiles) and `.brief/notes-todos-and-mirror.md` (which covers the *why* of todo extraction). This brief is the *what* and *how*.

---

## 1. Authentication

### The bearer token

One static bearer token guards every route under `/api/*`, `/inbox/*`, `/admin/*`, `/peers/*`. The token lives in two places:

- **On the Worker** — as a Cloudflare secret `SMALLSTORE_TOKEN`, set via `wrangler secret put SMALLSTORE_TOKEN`. Cloudflare encrypts it at rest; not visible after the initial set.
- **On your laptop** — mirrored into `deploy/.env` (gitignored) so shell curl can `set -a && source deploy/.env && set +a` and use `Authorization: Bearer $SMALLSTORE_TOKEN`.

The Worker compares the bearer in the `Authorization` header against `env.SMALLSTORE_TOKEN` byte-for-byte. Wrong/missing → `401 Unauthorized` with a generic message. There's no token rotation, no expiry, no per-user split. One token, two copies, that's it.

To rotate: `wrangler secret put SMALLSTORE_TOKEN` with a new value, then update `deploy/.env` to match. MCP server config also has it baked in (`SMALLSTORE_TOKEN=...` in the `claude mcp add` command), so re-register MCP if you rotate.

### What's public, what isn't

After the 2026-04-27 lockdown, the public surface is exactly:

| Route | Returns |
|---|---|
| `GET /` | `{name: "smallstore", version, status: "ok"}` — three fields, nothing more |
| `GET /health` | `{status: "ok"}` |
| `POST /webhook/:peer` | HMAC-authed (different model, see below) |

The full inbox + endpoint catalog moved behind auth at `GET /admin/manifest`. Anything you used to read from `GET /` lives there now.

### Webhook auth — different model

`POST /webhook/:peer` is intentionally NOT bearer-gated. The peer registry stores a per-webhook HMAC secret reference (`metadata.webhook_config.hmac.secret_env`), and the Worker verifies the inbound HMAC signature against the named env var. Bearer ≠ webhook auth — they're orthogonal. This lets external services (GitHub, Stripe, custom feeders) post into smallstore without ever seeing the master token.

---

## 2. Notes — what they are, where they live

A "note" is just a string field on an inbox item: `fields.forward_note`. Two ways it gets populated:

### (a) Implicitly, at ingest, via forward-detect

When you forward an email to `mailroom@labspace.ai` with text typed *above* the forwarded block, the `forward-detect` hook treats that prefix as your note and writes it to `fields.forward_note`. Same hook also extracts:

- `original_from_email` / `original_from_addr` / `original_subject` — who originally sent it
- `original_sent_at` — when the publisher sent it (parses Gmail/Outlook/RFC-5322/ISO date headers)
- `original_message_id` / `original_reply_to` — for cross-mailbox threading
- `newsletter_slug` — derived from sender display name (e.g. "Steph at Internet Pipes" → `internet-pipes`); the slug is what groups all forwards from the same publisher into a newsletter profile

If you forward without typing anything above the forwarded block, `forward_note` is just absent — the item still gets the other fields.

### (b) Explicitly, after the fact, via the annotation endpoint

Forgot to add a note when forwarding? Or want to revise one a month later? `POST /inbox/:name/items/:id/note` writes / replaces / appends:

```json
{ "note": "your text", "mode": "replace" | "append" }
```

- `replace` (default) — overwrites whatever was there
- `append` — joins to the existing note via `\n\n---\n\n` (a markdown thematic break) so multiple thoughts over time read as a stack
- `""` (empty string) — clears the note
- Stamps `fields.note_updated_at` (ISO) every call

The annotation merge uses `IngestOptions.fields_only` under the hood, which preserves identity (`id`, `received_at`, `source`, `summary`, `body`, `labels`) and the inbox index entry. So a late annotation never re-orders your inbox or duplicates an item. The note immediately surfaces in the newsletter views below — no separate "publish" step.

MCP wrapper: `sm_inbox_set_note(inbox, id, note, mode?)`.

### Where notes are read back

Three cuts of the same data:

| Route | Shape |
|---|---|
| `GET /inbox/:name/items/:id?full=true` | The whole item with `fields.forward_note` inline |
| `GET /inbox/:name/newsletters/:slug/notes` | All notes for one publisher, slim `{id, original_sent_at, received_at, subject, from, note}` projection — chronological, LLM-ready |
| `GET /inbox/:name/newsletters/:slug?format=markdown` | Full publisher view: profile header + chronological items + notes inlined as blockquotes |

Notes are **markdown** by convention. The notes route returns them verbatim (no escaping); the markdown export wraps them in blockquotes (`> `) so your voice is visually separated from the publisher's.

---

## 3. Aggregation + search — what exists, what's missing

### What works today

**Cross-newsletter, raw shape — via `/query`:**
```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fields_regex":{"forward_note":".+"}}' \
  "$BASE/inbox/mailroom/query"
```
Returns every item with a non-empty note across all newsletters. Heavy though — full items including bodies.

**Text search inside notes — partial:**
The `?text=` filter on `/inbox/:name` and `POST /query` searches across the whole body, not just `forward_note`. It works for keyword recall but is noisy if the keyword appears in the publisher's content.

**Per-newsletter notes — clean:**
`GET /inbox/:name/newsletters/:slug/notes` is exactly what you want, just scoped to one slug.

### What's missing

A first-class **cross-newsletter notes endpoint** with the same slim shape:

```
GET /inbox/:name/notes
  ?text=<keyword>          # full-text search within forward_note (not body)
  ?slug=<newsletter-slug>  # optional scope (degenerates to existing /newsletters/:slug/notes)
  ?since=<iso>             # filter by received_at
  ?limit=<n>               # default 100, max 500
  ?format=markdown         # (Phase 2a-style) render as one big markdown doc
```

Returns:
```json
{
  "inbox": "mailroom",
  "count": N,
  "notes": [
    {
      "id": "...",
      "newsletter_slug": "internet-pipes",
      "newsletter_display": "Steph at Internet Pipes",
      "original_sent_at": "...",
      "received_at": "...",
      "subject": "...",
      "from": "...",
      "note": "..."
    }
  ]
}
```

**Cost:** ~15-20 min including tests. Reuses the existing slim projection from `/newsletters/:slug/notes` — same query, drop the slug filter, add an optional `?text=` that filters on `fields.forward_note` substring (case-insensitive). The markdown form would group by slug with a `## <publisher>` heading per group.

MCP wrapper: `sm_inbox_notes(inbox, text?, slug?, since?, limit?)`.

---

## 4. Todos — derived view on top of notes

Todos aren't a separate primitive — they're a *projection* over `forward_note`. The `/inbox/:name/todos` endpoint scans every note for action-shaped lines via six regex patterns (first-match-wins, case-insensitive):

| Pattern name | Catches |
|---|---|
| `unchecked-checkbox` | `- [ ] sub to rosieland`, `[ ] follow up` |
| `todo-prefix` | `TODO: review part 2`, `todo: bookmark` |
| `action-prefix` | `Action: respond by Friday` |
| `remind` | `remind me to ...`, `reminder to self`, `remember to ...`, `remembered ...` |
| `subscribe` | `sub me to X`, `sub mailroom to Y`, `subscribe me to ...` |
| `follow-up` | `follow up`, `followup`, `follow-up` |

Skip rules (lines that never count as todos even if they match):
- `> ...` — quoted-reply lines (publisher's content, not your note)
- `- [x] ...` — checked checkboxes (the "done" form)

Multi-line note → multi-todo. Each emit carries `matched_pattern` (which rule fired) + `full_note` (entire note for context) + the newsletter metadata (`newsletter_slug`, `newsletter_display`, `subject`, `original_sent_at`).

### Why pure-derived

Three properties matter:

1. **No state.** Adding a new pattern is one-line; no migration, no backfill. Removing a pattern un-emits the matching todos with no cleanup.
2. **No duplication.** The note in `forward_note` is the only source of truth — there's no sidecar todo store that can drift from it.
3. **Edit the note → todos update.** Annotate via `sm_inbox_set_note` and the todo view picks up the new shape on the next `/todos` call. No separate todo-edit API.

### What's deferred

**"Done" tracking** — there's no way to mark a todo done today. Cheapest future implementation: append `[x]` to the matched line via `sm_inbox_set_note(mode: 'edit')` (which would need a new `mode` that diffs lines, not implemented yet). Or simpler: the user manually edits the note to checkbox `[x]` form, and the existing skip rule excludes it from the next view. Neither is built.

**LLM extraction** — promote when the regex set demonstrably misses too much. Today the patterns cover what shows up in real notes; the rosieland note ("reminder to self: sub mailroom to rosieland") fired the `remind` pattern correctly without an LLM.

### MCP wrapper

`sm_inbox_todos(inbox, slug?, since?, limit?)` — same shape as the HTTP route.

---

## 5. The unified picture

Forwards and annotations write to the same field (`forward_note`) on the same items. Everything else — newsletter profiles, todos, markdown exports — is a derived view. No sidecars, no separate stores, no duplication.

```
                                                ┌──────── /todos ─────────────────────────┐
                                                │   (regex scan over forward_note)        │
                                                ▼                                          │
forward email ──────► forward-detect hook ─► fields.forward_note ─────► /newsletters/:slug/notes
                              │                     ▲                  └────► /newsletters/:slug?format=markdown
                              ▼                     │
                        fields.newsletter_slug      │
                              │                     │
                              ▼                     │
                       /newsletters[/:slug...]      │
                                                    │
              POST /items/:id/note ─────────────────┘
              (replace | append | clear)
```

The whole system has one data primitive (`InboxItem.fields.forward_note`) with one writer (the user, via either ingest-time forward or post-hoc annotation) and many readers.

---

## Suggested next adds (in priority order)

1. **`GET /inbox/:name/notes`** — cross-newsletter notes endpoint, ~20 min. Closes the "I want all my notes searchable" gap that motivated this brief.
2. **`?text=` on the new notes endpoint** — substring filter over `forward_note` only (not body). Trivial once the endpoint exists.
3. **`?format=markdown` on the new notes endpoint** — group by slug, one doc with all your notes. Mirrors the Phase 2a treatment.
4. **`sm_inbox_set_note(mode: 'edit')`** — line-level diff for marking a single todo `[x]` done without overwriting the rest of the note. Defer until manual edits feel awkward.
