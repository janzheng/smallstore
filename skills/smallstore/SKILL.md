---
name: smallstore
description: "External service I/O for agents — read and write Notion, Airtable, Google Sheets, Obsidian, Upstash, R2, and other backends through a single Smallstore API. Use when the user says: \"use smallstore\", \"read from Notion\", \"read from Airtable\", \"read from sheets\", \"write to a sheet\", \"sync between adapters\", \"migrate from X to Y\", \"copy this to Notion\", \"smallstore MCP\", \"list mounted adapters\", or wants to hit an external storage service without wiring adapter code. Peer to TigerFlare — TF is agent memory/filesystem, Smallstore is external service I/O."
---

# Smallstore

One API, many backends. Smallstore mounts Notion, Airtable, Sheets, Upstash, R2, SQLite, local files, and more behind a shared collection/key interface. Use it when the user wants to read or write an external service directly, migrate data between services, or let an agent operate on live external data without bespoke glue code.

Smallstore is a **peer** to TigerFlare — not a replacement. TigerFlare = agent memory and cross-session filesystem. Smallstore = external service I/O.

## Preflight: ensure server is up

Before the first `mcp__smallstore__sm_*` call, check the local HTTP server and start it detached if needed. The MCP server is stdio-only and forwards to this HTTP server:

```bash
curl -sf http://localhost:9998/ >/dev/null 2>&1 || (cd /Users/janzheng/Desktop/Projects/_deno/apps/smallstore && nohup deno task serve > /tmp/smallstore.log 2>&1 & disown && sleep 3)
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

Append items to a log-shaped collection without wiping what's there. `sm_write` on sheetlog is destructive (overwrites the whole tab); `sm_append` is the safe path for adding rows.

```
Call mcp__smallstore__sm_append with collection: "sheets/Sheet1", items: [
  { "url": "https://example.com", "title": "Example", "date": "2026-04-21 10:00:00" }
]
```

- `items` is a single object or an array of objects.
- On sheetlog, if the tab has an `_id` column and the payload omits it, the Apps Script auto-generates one and returns the assigned id(s) in `_ids: [...]`.
- Returns 501 if the target adapter doesn't implement a native `append()` — currently only `SheetlogAdapter` does. For other adapters, write with a unique key via `sm_write` (e.g. `sm_write("logs/events", "2026-04-17T12:34:56Z", {...})`).

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
- **Sheetlog `sm_write` wiped the sheet** — the sheetlog adapter implements `set()` as a destructive replace (bulk-delete + insert). Use `sm_append` instead for row-by-row logging. Key-per-row with `sm_write` does NOT append — the key is ignored and the whole tab is still rewritten.

## Gotchas

- Collection names with slashes (e.g. `sheets/Sheet1`) are path-like and match against glob-style mount patterns (`sheets/*`).
- The `memory` adapter always exists — Smallstore guarantees it as fallback. Don't rely on it for anything persistent.
- `.smallstore.json` values starting with `$` resolve from env (`"$SM_NOTION_SECRET"`). This runs when the server boots — restart after env changes.
- `sm_sync` between adapters with incompatible schemas (e.g. Sheets → Notion with typed fields) may need adapter-side normalization. Dry-run first.
- The Sheetlog adapter is Apps Script-backed and rate-limited; don't loop writes without throttling.
