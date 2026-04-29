---
name: smallstore
description: "Canonical access surface for agents — read/write Notion/Airtable/Sheets/Upstash/R2/SQLite (sm_* core tools), operate the mailroom inbox (sm_inbox_* — list/query/export/bookmark/archive/unsubscribe/rules/restore), browse newsletters chronologically with per-publisher notes (sm_newsletters_*), extract todos from forward-notes (sm_inbox_todos), annotate / mark todos done (sm_inbox_set_note with replace/append/edit modes), flush the markdown mirror to tigerflare on demand (sm_inbox_mirror), backfill new fields retroactively (sm_inbox_replay_hook), and browse/query external data sources via the peer registry (sm_peers_* — tigerflare, sheetlogs, other smallstores, webdav). Use when the user says: \"use smallstore\", \"read from Notion\", \"read from Airtable\", \"read from sheets\", \"write to a sheet\", \"sync between adapters\", \"check mailroom\", \"bookmark this newsletter\", \"archive this sender\", \"list my rules\", \"what newsletters have I forwarded\", \"read this newsletter in order\", \"show my notes for X newsletter\", \"what do I need to do\", \"show my todos\", \"action items from my notes\", \"mark this todo done\", \"add a note to this email\", \"flush the mirror\", \"sync to tigerflare\", \"push notes to obsidian\", \"backfill new fields onto old items\", \"replay forward-detect\", \"show my peers\", \"fetch from tigerflare\", \"what data sources do I have\", \"smallstore MCP\", or wants to hit any external storage, mailroom inbox, or registered peer through a single API surface. Peer to TigerFlare — TF is agent memory/filesystem, Smallstore is external service I/O + mailroom + peer atlas."
---

# Smallstore

One API, many backends — **plus mailroom curation and the peer registry.** Smallstore mounts Notion, Airtable, Sheets, Upstash, R2, SQLite, local files, and more behind a shared `collection/key` interface (core `sm_*` tools). On top of that, two newer tool families extend what an agent can reach:

- **`sm_inbox_*`** — operate the live mailroom inbox at `smallstore.labspace.ai`: list/query/export items, manage rules (archive/bookmark/tag/drop/quarantine), tag/untag items, unsubscribe from senders, quarantine/restore.
- **`sm_peers_*`** — register and query the peer registry: tigerflare, random sheetlogs, other smallstore deployments, webdav. Adds "sources I know about but don't own," all reachable via one bearer token.

Smallstore is a **peer** to TigerFlare — not a replacement. TigerFlare = agent memory and cross-session filesystem. Smallstore = external service I/O + mailroom + peer atlas.

**Full HTTP recipes (not MCP):** `docs/user-guide/mailroom-quickstart.md` in the smallstore repo. The tools below are thin MCP wrappers around those routes.

## Preflight: ensure server is up

Before the first `mcp__smallstore__sm_*` call, check the local HTTP server and start it detached if needed. The MCP server is stdio-only and forwards to this HTTP server:

```bash
curl -sf http://localhost:9998/ >/dev/null 2>&1 || (cd /Users/janzheng/Desktop/Projects/__active/_apps/smallstore && nohup deno task serve > /tmp/smallstore.log 2>&1 & disown && sleep 3)
```

`nohup ... & disown` detaches the process so the server survives this session. Only tell the user about the autostart if it fails. Logs: `/tmp/smallstore.log`. The repo's `.smallstore.json` pins port **9998**; if your `.smallstore.json` sets a different port, update the URL. On machines with a different smallstore path, check `mcp__deno-hub__list_projects` first.

`SMALLSTORE_URL` (used by the MCP server) must match the port the HTTP server is on.

## Quick orientation

Call `mcp__smallstore__sm_adapters` first to see what's mounted:

```
Call mcp__smallstore__sm_adapters
```

Returns the configured adapter names, the default adapter, and the `mounts` table (path-pattern → adapter). If the adapter you want isn't listed, the server's `.smallstore.json` doesn't have it — add a mount and restart the server. See the Sheetlog example at `examples/.smallstore.json.example`.

## When to use

- Reading directly from Notion / Airtable / Sheets / Obsidian without SDK boilerplate
- Writing agent output to an external service (e.g. append a row to a shared sheet)
- Migrating a collection from one adapter to another (`sm_sync`)
- Listing what's in an external collection before deciding what to do
- Querying filtered records across any mounted adapter with a uniform filter syntax

Use **TigerFlare** instead when the target is cross-session agent notes, scratch files, or shared markdown.

## Tool reference

Collection names are resolved against `.smallstore.json` mounts. A call to `sheets/Sheet1` on a server with `"sheets/*": "sheetlog"` routes to the sheetlog adapter; unmatched collections fall through to the default adapter.

### `sm_adapters`

List configured adapters and mounts. Call first to orient.

```
Call mcp__smallstore__sm_adapters
```

### `sm_read`

GET a single record.

```
Call mcp__smallstore__sm_read with collection: "sheets/Sheet1", key: "row-42"
Call mcp__smallstore__sm_read with collection: "docs/inbox", key: "abc123"
```

Sheetlog note: the sheet is treated as a single collection, so `sm_read("sheets", ...)` returns the whole sheet as an array.

### `sm_write`

PUT a record (create or overwrite). `data` is a JSON object.

```
Call mcp__smallstore__sm_write with collection: "crm/contacts", key: "jan", data: {
  "name": "Jan",
  "email": "jan@phage.directory",
  "role": "admin"
}
```

### `sm_delete`

DELETE a record.

```
Call mcp__smallstore__sm_delete with collection: "crm/contacts", key: "jan"
```

### `sm_list`

List keys in a collection with pagination. Returns `{ keys, hasMore, cursor?, total? }`.

```
Call mcp__smallstore__sm_list with collection: "crm/contacts"
Call mcp__smallstore__sm_list with collection: "docs/inbox", options: { "limit": 50, "prefix": "2026-" }

# Paging through a large collection — pass cursor back for the next page
Call mcp__smallstore__sm_list with collection: "notion/papers", options: { "limit": 100 }
# → { keys: [...], hasMore: true, cursor: "abc123" }
Call mcp__smallstore__sm_list with collection: "notion/papers", options: { "limit": 100, "cursor": "abc123" }
```

Paging support is native per adapter when available (Notion page-cursor, Airtable offset, SQLite LIMIT/OFFSET). Other adapters fall back to loading all keys then slicing — still correct, but not a network-cost win.

### `sm_query`

Filter records. Filter syntax is MongoDB-style (`eq`, `$gt`, `$lt`, `$contains`, etc.) — maps to the Smallstore query engine.

```
Call mcp__smallstore__sm_query with collection: "crm/contacts", filter: { "role": "admin" }
Call mcp__smallstore__sm_query with collection: "events", filter: { "ts": { "$gt": 1700000000 } }
```

### `sm_sync`

Copy/migrate between two adapters. Wraps `syncAdapters()`. **`source_adapter` and `target_adapter` are ADAPTER names** (e.g. `"notion"`, `"airtable"`, `"local"`), not collection names — call `sm_adapters` first to see what's configured. Always preview with `dryRun: true` first.

```
# Preview the migration first
Call mcp__smallstore__sm_sync with source_adapter: "airtable", target_adapter: "notion", options: { "dryRun": true, "prefix": "contacts/" }

# Then run it for real
Call mcp__smallstore__sm_sync with source_adapter: "airtable", target_adapter: "notion", options: { "prefix": "contacts/" }
```

One-liner migration pattern: mount both adapters in `.smallstore.json`, call `sm_sync` with `dryRun: true`, review the diff, then re-run without `dryRun`.

For long syncs (thousands of records), pass `background: true` so `sm_sync` returns a `jobId` immediately and the sync runs with its progress streamed to a JSONL file under `<dataDir>/jobs/<jobId>.jsonl`. Poll `sm_sync_status` or `tail -f` the file directly:

```
Call mcp__smallstore__sm_sync with source_adapter: "airtable", target_adapter: "notion", background: true
# → { jobId: "sync-2026-04-18T...", logPath: "...", status: "running" }

Call mcp__smallstore__sm_sync_status with jobId: "sync-2026-04-18T..."
# → { status: "running" | "completed" | "failed", events: [...], ... }

Call mcp__smallstore__sm_sync_jobs
# → { jobs: [...] }  # recent runs, newest first — useful for post-mortem
```

### `sm_append` (non-destructive append — sheetlog-style adapters)

Append items to a log-shaped collection without wiping what's there. `sm_write` on sheetlog **throws** (it used to silently wipe the whole tab because the `key` arg was ignored); `sm_append` is the safe path for adding rows.

```
Call mcp__smallstore__sm_append with collection: "sheets/Sheet1", items: [
  { "url": "https://example.com", "title": "Example", "date": "2026-04-21 10:00:00" }
]
```

- `items` is a single object or an array of objects.
- On sheetlog, if the tab has an `_id` column and the payload omits it, the Apps Script auto-generates one and returns the assigned id(s) in `_ids: [...]`.
- Returns 501 if the target adapter doesn't implement a native `append()` — currently only `SheetlogAdapter` does. For other adapters, write with a unique key via `sm_write` (e.g. `sm_write("logs/events", "2026-04-17T12:34:56Z", {...})`).

## Mailroom tools — `sm_inbox_*`

Operate the live mailroom inbox (bookmarks, auto-archive, export, rules). The inbox is a specific kind of smallstore collection with classifier labels, forward-detection, and a rules engine. Design: `.brief/mailroom-curation.md`. Full HTTP recipes: `docs/user-guide/mailroom-quickstart.md § Part 1`.

**Reading:**
- `sm_inbox_list(inbox, cursor?, limit?, order?, order_by?)` — list newest-first by default. `order_by`: `received_at` (default, cursor-aware) | `sent_at` | `original_sent_at` (in-memory sort, missing-field-tails, cursor disabled).
- `sm_inbox_read(inbox, id, full?)` — single item; `full: true` inflates body_ref from blobs adapter.
- `sm_inbox_query(inbox, filter, cursor?, limit?, order_by?)` — filter DSL supports `labels`, `fields`, `fields_regex`, `text`, `text_regex`, `headers`, `since`, `until`.
- `sm_inbox_export(inbox, filter?, include?, limit?)` — bulk download as JSON array. `include=body` inflates bodies. For streaming JSONL, hit the HTTP endpoint directly (MCP can't stream).
- `sm_inbox_quarantine_list(inbox, cursor?, limit?, label?)` — list items in quarantine.

**Newsletter views** (forwards grouped by `fields.newsletter_slug` — auto-derived from sender display name on ingest):
- `sm_newsletters_list(inbox, limit?)` — every newsletter slug with count + latest_at + display name. Latest-first.
- `sm_newsletter_get(inbox, slug)` — profile dashboard (count, first/last seen, notes count, latest note).
- `sm_newsletter_items(inbox, slug, order?, limit?)` — chronological reading list. `order: oldest` (default) | `newest`. Sorts by `original_sent_at` (when the publisher sent it), not by when you forwarded it.
- `sm_newsletter_notes(inbox, slug, limit?)` — slim shape `{id, original_sent_at, received_at, subject, from, note}` — pipe straight into an LLM.
- `sm_inbox_todos(inbox, slug?, since?, limit?)` — derived todo view: scans every `forward_note` for action-shaped lines (`- [ ]`, `TODO:`, `Action:`, `remind/remember`, `sub me to`, `follow up`). Each todo carries `matched_pattern` + `full_note` for context. Multi-line note → multi-todo. Skips quoted-reply (`>`) and checked (`[x]`) lines. Use when the user says "what do I need to do", "show my todos", "action items from my notes".
- `sm_inbox_notes(inbox, text?, slug?, since?, order?, limit?)` — cross-newsletter notes search/aggregate: every item with a non-empty `forward_note`, slim shape, newest-by-received-date by default. `text` does case-insensitive substring on `forward_note` only (NOT body — distinct from `sm_inbox_query` `text` which searches everything). Use when the user says "show all my notes", "search my notes for X", "what have I written about Y", "aggregate my notes". For per-publisher chronological reading lists use `sm_newsletter_notes` instead.

**Markdown export** — the three newsletter routes all accept `?format=markdown` over HTTP for Obsidian/tigerflare-friendly rendering: `GET /inbox/:name/newsletters?format=markdown` (index), `GET /inbox/:name/newsletters/:slug?format=markdown` (full publisher view: profile header + chronological issues + notes inlined as blockquotes), `GET /inbox/:name/newsletters/:slug/notes?format=markdown` (notes-only). No MCP wrapper — markdown is for humans, JSON is for agents. Use the markdown form when the user asks to "browse my newsletters", "export to obsidian", "save this as a markdown file".

**Cron-driven tigerflare mirror** — peers registered with `metadata.mirror_config = { source_inbox, target_path_prefix?, include_index?, link_origin? }` get the per-newsletter markdown PUT to their URL on the existing `*/30 * * * *` cron. Manual flush via `sm_inbox_mirror(inbox, peer?)` — same engine, on demand (use right after annotating a note when you don't want to wait 30 min). Idempotent (re-rendering same markdown is a no-op write at the destination); per-slug + per-peer failures are isolated and reported in the response. Disable by setting peer `disabled: true` (`sm_peers_update`) or removing `mirror_config`. All runtime ops, no redeploy.

**Tagging / mutation:**
- `sm_inbox_tag(inbox, id, add?, remove?)` — add/remove labels on one item. Use for "changed my mind" corrections.
- `sm_inbox_set_note(inbox, id, mode?, note?, find?, replace?)` — set, append, or surgically edit `fields.forward_note` after the fact. **`mode: 'replace'`** (default) — needs `note`; overwrites. **`'append'`** — needs `note`; joins to existing via thematic break. **`'edit'`** — needs `find` + `replace`; line-level rewrite (find one line by exact trimmed match, replace with new content). Empty `replace` deletes the line. Use `edit` mode to mark a todo done: pass `matched_line` from `sm_inbox_todos` as `find`, and `'- [x] ' + line` as `replace` — the /todos skip rule auto-excludes `[x]` lines so the todo self-cleans. Stamps `fields.note_updated_at`. Identity + labels preserved.
- `sm_inbox_restore(inbox, id, label?)` — remove the quarantine label from one item.
- `sm_inbox_delete(inbox, id)` — hard delete (item + blob refs gone).

**Unsubscribe:**
- `sm_inbox_unsubscribe(inbox, address, skip_call?, timeout_ms?)` — RFC 8058 one-click (HTTPS) or mailto passthrough; tags sender `unsubscribed` in the sender index.

**Rules (the curation engine):**
- `sm_inbox_rules_list(inbox, cursor?, limit?)` / `sm_inbox_rules_get(inbox, id)` — inspect.
- `sm_inbox_rules_create(inbox, match, action, action_args?, priority?, notes?, apply_retroactive?)` — create. `action` is one of `archive | bookmark | tag | drop | quarantine`. Tag-style actions stack; terminal actions (drop/quarantine) use first-match-by-priority. `apply_retroactive: true` tags existing matching items in the same call.
- `sm_inbox_rules_update(inbox, id, patch)` — partial update (disable/rename/change action).
- `sm_inbox_rules_delete(inbox, id)` — remove (already-tagged items stay tagged).
- `sm_inbox_rules_apply_retroactive(inbox, id)` — re-run retroactive tagging on an existing rule. **Only tag-style actions mutate retroactively** — drop/quarantine are no-ops with an error message.

**Replay hooks (admin-side retroactive backfill — generalized form of rule retroactive):**
- `sm_inbox_replay_hook(inbox, hook, filter?, dry_run?, limit?)` — re-run a registered hook over filtered items to backfill new fields onto historical items. Always pass `dry_run: true` first — returns up to 10 sample diffs without writing. Hooks registered for `mailroom`: `forward-detect`, `sender-aliases`, `plus-addr`, `newsletter-name`. Preserves identity (id/received_at/source) + index entry; only shallow-merges new `fields` keys + unions `labels`. Real precedent: 2026-04-26 backfilled 24 IP Digest forwards with `newsletter_slug` + `original_sent_at` after the field shipped.

**Typical workflow:**
```
// 1. Agent checks what's in the mailroom
mcp__smallstore__sm_inbox_list { inbox: "mailroom", limit: 20 }

// 2. Queries for bookmarked newsletters
mcp__smallstore__sm_inbox_query {
  inbox: "mailroom",
  filter: { labels: ["bookmark"] }
}

// 3. Bulk exports bookmarks with bodies inlined for LLM processing
mcp__smallstore__sm_inbox_export {
  inbox: "mailroom",
  filter: { labels: ["bookmark"] },
  include: "body"
}

// 4. Creates an archive rule that also retroactively tags existing items
mcp__smallstore__sm_inbox_rules_create {
  inbox: "mailroom",
  match: { fields: { from_email: "noisy@newsletter.com" } },
  action: "archive",
  apply_retroactive: true
}
```

## Peer registry — `sm_peers_*`

Register + query external data sources (tigerflare, sheetlogs, other smallstores, webdav). Peers are runtime-configurable (no redeploy), auth lives in Worker env vars referenced by peer rows. Design: `.brief/peer-registry.md`. Full HTTP recipes: `docs/user-guide/mailroom-quickstart.md § Part 2`.

**CRUD:**
- `sm_peers_list(name?, type?, tags?, include_disabled?, cursor?, limit?)` — the data atlas. Call first when an agent needs to orient ("what data sources do I know about?").
- `sm_peers_get(name)` — one peer's metadata.
- `sm_peers_create({name, type, url, auth?, headers?, tags?, description?, capabilities?})` — register a new source. Types: `smallstore`, `tigerflare`, `sheetlog`, `http-json`, `webdav`, `generic`. **Auth references an env var** via `token_env` / `value_env` / `user_env`+`pass_env` — the actual secret must be set on the Worker separately via `wrangler secret put`.
- `sm_peers_update(name, patch)` — partial. Rename via `patch.name = "new-slug"` (id stays stable).
- `sm_peers_delete(name)` — remove.

**Operational:**
- `sm_peers_health(name, timeout_ms?)` — probe reachability. Per-type: GET `/health` (smallstore), GET `/` (tigerflare — no dedicated /health), OPTIONS (webdav), HEAD (others).
- `sm_peers_fetch(name, path, client_query?)` — proxied GET. Smallstore injects the peer's auth from env; client sees just smallstore's bearer.
- `sm_peers_query(name, body, path?, content_type?)` — proxied POST. `body` is forwarded verbatim.

**Typical workflow:**
```
// 1. What's in the atlas?
mcp__smallstore__sm_peers_list

// 2. Is tigerflare alive?
mcp__smallstore__sm_peers_health { name: "tigerflare-prod" }

// 3. Browse a path over there
mcp__smallstore__sm_peers_fetch {
  name: "tigerflare-prod",
  path: "/inbox/mailroom.md"
}

// 4. Register a new peer (one-time; secret must be set via wrangler secret put)
mcp__smallstore__sm_peers_create {
  name: "faves-sheetlog",
  type: "sheetlog",
  url: "https://script.google.com/macros/s/.../exec",
  auth: { kind: "query", name: "key", value_env: "SHEETLOG_KEY" }
}
```

## Relationship to TigerFlare

| Task | Use |
|------|-----|
| Save notes/context between Claude sessions | TigerFlare |
| Read/write a shared Notion database | Smallstore |
| Cross-machine scratch filesystem | TigerFlare |
| Append a row to a Google Sheet | Smallstore |
| Agent memory and working context | TigerFlare |
| Migrate data between external services | Smallstore (`sm_sync`) |

They can be combined: use TigerFlare to stage drafts, then `sm_write` to publish to Notion/Airtable/Sheets.

## Troubleshooting

- **"Connection refused" / MCP tool errors** — HTTP server isn't running. Re-run the preflight curl + `deno task serve` command. Check `/tmp/smallstore.log`.
- **`sm_adapters` returns only `memory` + `local`** — no `.smallstore.json` in the server's CWD, or it has no extra adapters. Create one (see `examples/.smallstore.json.example`) and restart the server.
- **Adapter listed but calls fail with auth errors** — env vars missing when the server started. Check `.env` at the server's working directory matches `docs/user-guide/env-vars.md` (e.g. `SM_NOTION_SECRET`, `SM_NOTION_DATABASE_ID`, `SM_SHEET_URL`, `SM_AIRTABLE_API_KEY`). Restart the server after updating `.env`.
- **Write succeeded but nothing in Notion/Airtable** — check `sm_adapters` mounts: the collection probably routed to the default adapter, not the external one. Add a mount like `"docs/*": "notion"`.
- **Port mismatch** — `SMALLSTORE_URL` in the MCP server env must match the port in `.smallstore.json` or `SM_PORT`. Repo default: `9998`. Bare default: `9999`.
- **Sheetlog `sm_write` now throws** — the adapter's `set()` used to silently wipe the whole tab (key ignored, bulk-delete every row, then insert). Now it errors with guidance pointing at `sm_append`. For row-by-row logging use `sm_append`; for keyed updates use the Sheetlog client's `upsert(idField, items)` via direct adapter access; for an intentional full-sheet reseed use `adapter.replace(items)`.

## Gotchas

- Collection names with slashes (e.g. `sheets/Sheet1`) are path-like and match against glob-style mount patterns (`sheets/*`).
- The `memory` adapter always exists — Smallstore guarantees it as fallback. Don't rely on it for anything persistent.
- `.smallstore.json` values starting with `$` resolve from env (`"$SM_NOTION_SECRET"`). This runs when the server boots — restart after env changes.
- `sm_sync` between adapters with incompatible schemas (e.g. Sheets → Notion with typed fields) may need adapter-side normalization. Dry-run first.
- The Sheetlog adapter is Apps Script-backed and rate-limited; don't loop writes without throttling.
