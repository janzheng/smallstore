# Attachments — capture, storage, retrieval

**Status:** capture + storage live since the cf-email channel shipped (2026-04-23). Download endpoint live 2026-04-24. Sits in `src/messaging/channels/cf-email.ts` (capture) + `src/messaging/http-routes.ts` (retrieval) + each item's `fields.attachments[]` (metadata).
**Consumer:** mailroom inbox today; any `cf-email` inbox tomorrow. Other channels (rss, webhook) don't currently emit attachments — the mechanism is generic but the only producer is email.

This brief is the **end-to-end story** for binaries arriving with email — where they go, how they're indexed, and how to get them back out. The capture path is small and stable; the retrieval surface is what gets touched as new use cases land.

## Capture

`postal-mime` parses `parsed.attachments[]` from the raw `.eml`. For each one (`src/messaging/channels/cf-email.ts:153-168`):

- `safeName = sanitizeFilename(att.filename ?? \`att-${i}\`)` — strips path traversal characters; falls back to `att-<n>` when the email omits a filename.
- `ref = \`attachments/<item-id>/<safeName>\`` — content-addressed by the item's id (a sha256 of `Message-Id || raw_size`), so re-deliveries of the same email overwrite identical refs idempotently.
- Bytes go into `ParseResult.blobs[ref]` with the original `content_type`.
- A metadata row joins `attachmentMeta`:
  ```ts
  { id, filename, content_type, size, ref, content_id? }
  ```
  `content_id` is preserved (sans `<>` brackets) for inline images so HTML body rendering can resolve `cid:` references.
- Final `fields.attachments = attachmentMeta[]` is set when the array is non-empty; `fields.has_attachments` boolean mirrors it for cheap filtering.

Inline images are treated as attachments by postal-mime — they show up in this list. `content_id` distinguishes "body asset" from "user attachment" at the application layer; smallstore doesn't enforce that distinction.

The `Inbox._ingest` path writes every blob via `storage.blobs.set(key, payload.content)` before persisting the item. The blobs adapter is whatever the inbox was wired with — R2 in production (`MAILROOM_R2`), `MemoryAdapter` in tests.

## Storage layout

Under the **blobs adapter** (R2 in prod):

```
attachments/<item-id>/<safe-filename>       # one per attachment
html/<item-id>.html                          # html body (always blob, never inline)
body/<item-id>.txt                           # plaintext body when ≥64KB
raw/<item-id>.eml                            # raw .eml, archived for replay
```

All four blob families share one bucket; the path prefixes keep them disjoint. There's no per-attachment lifecycle policy on the bucket today — they live as long as the item does.

Under the **items adapter** (D1 in prod):

```
items/<item-id>     # InboxItem JSON, with `fields.attachments[]` carrying the metadata
_index              # newest-first manifest of {at, id} entries
```

Note `<item-id>` is content-addressed (sha256 prefix) — multiple attachments from the same email naturally share the same parent path; cross-email collisions are vanishingly rare.

## Indexing + querying

`fields.has_attachments` is the cheap predicate. `fields.attachments[]` carries the per-attachment metadata for richer queries.

Today the InboxFilter's `fields` matcher does substring match on string values, so `fields.has_attachments: true` doesn't pass through cleanly (boolean → string comparison fails). Two workarounds:

- **Client-side filter** after `GET /inbox/:name?limit=N` — see `CLAUDE.md` for the `jq` shape.
- **Use the export route** with no server-side filter, then filter the JSONL stream — slower but works for one-off pulls.

A first-class typed-field operator on filters is queued under `#filter-typed-operators` (TASKS-MESSAGING.md backlog).

## Cleanup

`Inbox.delete(id)` walks `existing.fields.attachments[]` and best-effort-deletes each `ref` from the blobs adapter alongside `raw_ref` and `body_ref` (`src/messaging/inbox.ts:170-184`). Per-blob delete errors are swallowed so a missing object doesn't block the item delete.

There's no orphan-blob sweep today — if `delete()` fails partway, the item record may go away while some attachments stay in R2. Acceptable tradeoff: the orphan key is namespaced under `attachments/<dead-id>/` and won't collide with anything; an explicit `bucket sweep older than X days with no matching item` job can mop up if cost ever shows up. Not on any agent's list today.

## Retrieval

### `GET /inbox/:name/items/:id/attachments` — list

Returns `{ inbox, item_id, attachments: [{id, filename, content_type, size, content_id?, download_url}] }`. `download_url` is a relative path (e.g. `/inbox/mailroom/items/abc.../attachments/photo.png`) the caller can hit with the same bearer token. Returns `404` if the item doesn't exist; empty `attachments: []` if it has none.

### `GET /inbox/:name/items/:id/attachments/:filename` — download

Streams the blob through the Worker. Validates that `filename` matches a real entry in `item.fields.attachments[]` — arbitrary path components are rejected to prevent path-traversal reads of other inboxes' blobs. Sets:

- `Content-Type` from the stored attachment metadata (defaults to `application/octet-stream` if missing)
- `Content-Length` from `att.size`
- `Content-Disposition: inline; filename="<safe>"` so browsers preview rather than force-download (override with `?download=1` for a true download)

`404` if the item or filename is unknown. `500` if the blobs adapter is configured but the ref is missing — this is "should not happen, signals partial-delete state."

### Why no presigned URLs

The blobs adapter contract is `StorageAdapter` (a generic K/V interface), not "R2 specifically." Presigned-URL generation isn't part of `StorageAdapter`, and not every backend supports presigning (Memory, KV, D1-as-blob can't). Worker-streamed downloads work for every backend that implements `get(key)` — the universal path.

If/when a deployment specifically needs presigned URLs (e.g. very large attachments, offload Worker bandwidth), the path is to use the `r2-direct` adapter for blobs (it has `getSignedDownloadUrl()` baked in) and add a feature-detection branch in the route. Not today.

### Auth model

Same bearer token gates all `/inbox/*` and `/admin/*` routes — there's no per-user / per-attachment ACL. If you can read the inbox, you can download every attachment in it. Acceptable for a personal mailroom; the wrong shape for a multi-tenant deployment, but multi-tenant isn't on any roadmap.

## Out of scope (future work)

- **Base64 inlining in `/export?include=attachments`** — currently documented but not implemented (`src/messaging/http-routes.ts:163-164`). Punt until a real consumer needs it; download URLs in the JSONL stream cover most cases.
- **Range requests** — Worker can stream `Range:` headers for media playback. Not needed until the first large-video attachment lands.
- **Virus scanning** — should happen at ingest, not download. Out of scope until trust boundary changes.
- **Filter operator typed-comparison** — `fields.has_attachments: true` (boolean) instead of substring match. See `#filter-typed-operators`.

## Trail

- 2026-04-23: capture path shipped with the cf-email channel + 18 unit tests
- 2026-04-24: download endpoint shipped (this doc); `Inbox.delete` already cleaned up refs since 2026-04-23
