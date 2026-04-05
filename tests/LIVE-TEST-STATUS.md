# Smallstore Live Adapter Test Status

Last updated: 2026-03-08

Run: `deno test --no-check --allow-all tests/live-adapters.test.ts`

## Adapter Status

| Adapter | Status | Notes |
|---------|--------|-------|
| Local JSON | :white_check_mark: Pass | No credentials needed |
| Memory | :white_check_mark: Pass | No credentials needed |
| Upstash Redis | :white_check_mark: Pass | `SM_UPSTASH_URL`, `SM_UPSTASH_TOKEN` |
| Airtable | :white_check_mark: Pass | `SM_AIRTABLE_API_KEY`, `SM_AIRTABLE_BASE_ID`, `SM_AIRTABLE_TABLE_NAME` |
| Airtable (TinyAuth) | :white_check_mark: Pass | App example at `examples/tiny-auth/` — exercises Airtable adapter for auth |
| Notion | :white_check_mark: Pass | `SM_NOTION_SECRET`, `SM_NOTION_DATABASE_ID` (use DB ID, not page ID!) |
| Sheetlog | :white_check_mark: Pass | `SM_SHEET_URL`, `SM_SHEET_NAME` — needs deployed Apps Script |
| R2 Direct | :white_check_mark: Pass | `SM_R2_ACCOUNT_ID`, `SM_R2_ACCESS_KEY_ID`, `SM_R2_SECRET_ACCESS_KEY`, `SM_R2_BUCKET_NAME` |
| SQLite | :white_check_mark: Covered | Separate test: `sqlite.test.ts`, `sqlite-query.test.ts` |
| Structured SQLite | :white_check_mark: Covered | Separate test: `structured-sqlite.test.ts` |
| Local File | :white_check_mark: Covered | Separate test: `local-file.test.ts` |
| Cloudflare KV | :white_check_mark: Pass | HTTP mode via `SM_WORKERS_URL` — full CRUD |
| Cloudflare D1 | :white_check_mark: Pass | HTTP mode via `SM_WORKERS_URL` — full CRUD. Fixed `db.exec()` multiline SQL bug |
| Cloudflare DO | :white_check_mark: Pass | HTTP mode via `SM_WORKERS_URL` — full CRUD + clear |
| f2-r2 (Fuzzyfile) | :white_check_mark: Pass | Full CRUD via deterministic mode. JSON uses `cmd: "data"`, binary uses presigned URLs, delete uses `cmd: "delete"` with `authKey`. Separate test: `test-f2-r2-adapter.ts` |
| unstorage (Upstash) | :white_check_mark: Pass | Upstash driver via unstorage wrapper. CF KV/R2 drivers need Workers runtime |

## Bugs Fixed

| Date | Adapter | Bug | Fix |
|------|---------|-----|-----|
| 2026-03-04 | Airtable | `createAirtable()` passed `timeout: undefined` overriding 30s default, causing immediate abort + 3 retries = 14s hang | Only spread timeout when defined in `index.ts:createAirtable()` |
| 2026-03-06 | Notion | SDK v5.11 removed `databases.query`; adapter tried `dataSources.query` which doesn't work with API version `2022-06-28` | Added raw HTTP fallback via `client.request()` for older API versions; also check API version before using `dataSources.query` |
| 2026-03-06 | Notion | `.env` had page ID instead of database ID — full-page databases have a separate child database block | Use the child database ID, not the page URL ID. Added `SM_NOTION_PAGE_ID` for reference |
| 2026-03-06 | Sheetlog | All existing Apps Script deployment URLs in codebase were dead (404/script errors) | Redeployed fresh Apps Script, updated `SM_SHEET_URL` in `.env`. No code changes needed — adapter worked fine |
| 2026-03-06 | Airtable blobs | `Attachments` field was `multipleSelects` type instead of `multipleAttachments` — blob middleware wrote object to select field | Renamed old field to `_Attachments_old`, created new `Attachments` field as `multipleAttachments` via Airtable Meta API |
| 2026-03-06 | Airtable | `inferAirtableFieldType()` mapped ALL arrays to `multipleSelects`, including attachment arrays `[{url, filename}]` | Added attachment detection: if array items have `url` property → `multipleAttachments`. Also added `case 'multipleAttachments'` to value serializer and type union |
| 2026-03-06 | f2-r2 | `set()` POSTed to `/upload` endpoint that doesn't exist; F2 uses `{cmd: "presigned"}` flow | Rewrote `set()` to: POST `{cmd:"presigned"}` → PUT to presigned URL → cache nanoid key |
| 2026-03-06 | f2-r2 | `get()` tried `scope/filename` but F2 stores as `scope/NANOID/filename` | Added `keyMap` cache mapping logical keys → F2 keys with nanoid |
| 2026-03-06 | f2-r2 | Response bodies not consumed on 404/403, causing Deno resource leaks | Added `await response.body?.cancel()` and `await response.text()` to consume bodies |
| 2026-03-08 | f2-r2 | Ephemeral `keyMap` lost on restart; nanoid-based keys unresolvable | Rewrote adapter to use F2 deterministic mode (`nanoid: ""`, `useVersioning: false`). Removed keyMap entirely. Keys are always `scope/filename` |
| 2026-03-08 | f2-r2 | No delete support (F2 had no delete endpoint) | F2 added `cmd: "delete"` with `authKey`. Adapter uses single-key, bulk, and prefix delete |
| 2026-03-08 | f2-r2 | `keys()` returned empty array (no list API) | Implemented via F2 `cmd: "list"` with pagination support |
| 2026-03-08 | f2-r2 | JSON uploads used 2-step presigned URL flow unnecessarily | JSON values now use `cmd: "data"` (single POST) |
| 2026-03-08 | Cloudflare D1 | `db.exec()` splits multiline SQL on newlines, breaking `CREATE TABLE IF NOT EXISTS` | Changed to `db.prepare(sql).run()` with single-line SQL in `d1-handler.ts`. Redeployed workers |

## Setup Notes

- Env vars go in project root `.env` (see `.env.example`)
- Airtable table needs `_smallstore_key` field (singleLineText) — adapter uses it for key lookups
- Airtable blob test needs `Attachments` field as `multipleAttachments` type (not `multipleSelects`!), plus `_blob_meta` (multilineText) for inline sidecar metadata
- Notion: use the **child database ID**, not the page ID from the URL. Full-page databases have a separate child block. Find it via `blocks/{page_id}/children` → look for `child_database` type
- Notion database must be shared with the integration
- Sheetlog requires a deployed Google Apps Script (see https://github.com/yawnxyz/sheetlog)
- Sheetlog sheet tab needs at least 1 column header in Row 1 (e.g. `Name | Email | Notes | Score`), otherwise you get "number of columns must be at least 1" error
- Old Apps Script deployment URLs expire/break — if Sheetlog fails with 404, redeploy a new version
- R2 Direct uses S3-compatible API (`@aws-sdk/client-s3`). Create R2 API token in Cloudflare dashboard → R2 → Manage R2 API Tokens. Test uses `sanitizeResources: false` due to AWS SDK keeping TLS connections alive

## Feature Verification Status

Core adapter CRUD is verified. All 10 advanced live tests pass (10/10). Higher-level features verified below.

### Adapters — DONE

All locally-testable adapters have passing live tests (8/8 in `live-adapters.test.ts`).
Cloudflare D1/KV/DO require Workers runtime and can't be tested locally.

### Advanced Live Tests (script-style, run with `deno run`)

These are standalone scripts in `tests/live/`, run with `deno run --no-check --allow-all`.

| Test | Status | What it covers |
|------|--------|---------------|
| Notion wiki | :white_check_mark: Pass | Namespace tree (buildTree) + 3 retrievers (Metadata, Text, Filter) |
| Notion episodic | :white_check_mark: Pass | EpisodicStore: remember, recall, decay, timeline |
| Notion graph CRM | :white_check_mark: Pass | GraphStore: nodes, edges, traversal, relationship queries |
| Sheetlog views | :white_check_mark: Pass | ViewManager + Materializers (CSV, Markdown, JSON export) |
| Sheetlog disclosure | :white_check_mark: Pass | Progressive disclosure pattern + cross-topic query |
| R2 direct | :white_check_mark: Pass | JSON + binary blob storage, signed URLs, key listing |
| Blobs (R2) | :white_check_mark: Pass | Full blob middleware pipeline: detect → upload → URL in data → cleanup. Run with `--r2` flag |
| Notion blobs | :white_check_mark: Pass | Blob middleware with Notion file properties + R2 uploads |
| Multi-adapter network | :white_check_mark: Pass | Notion people + Sheetlog meetings + Graph relationships |
| Airtable blobs | :white_check_mark: Pass | Blob middleware with Airtable `multipleAttachments` field + R2 uploads |

### Higher-Level Features — Verification Status

| Feature | Module | Status | Verified By |
|---------|--------|--------|-------------|
| Views (ViewManager) | `src/views/` | :white_check_mark: Verified | sheetlog-views test |
| Graph Store | `src/graph/` | :white_check_mark: Verified | notion-graph-crm, multi-adapter-network tests |
| Episodic Store | `src/episodic/` | :white_check_mark: Verified | notion-episodic test |
| Blob Middleware | `src/blob-middleware/` | :white_check_mark: Verified | blobs (R2), notion-blobs, airtable-blobs tests |
| Namespace Tree | `src/namespace/` | :white_check_mark: Verified | notion-wiki test (buildTree) |
| Materializers | `src/materializers/` | :white_check_mark: Verified | sheetlog-views test (CSV, Markdown, JSON) |
| Smart Router | `src/router.ts` | :white_check_mark: Verified | All tests use SmartRouter internally |
| Presets | `presets.ts` | :white_check_mark: Covered | Separate test: `presets.test.ts` |
| Structured SQLite | `src/adapters/structured-sqlite.ts` | :white_check_mark: Covered | Separate test: `structured-sqlite.test.ts` |
| File Explorer | `src/explorer/` | :white_check_mark: Covered | Separate test: `file-explorer.test.ts` |
| Data Detector | `src/detector.ts` | :white_check_mark: Covered | Separate test: `detector.test.ts` (27 tests) |

### Remaining Items

All higher-level features are now verified (11/11).
