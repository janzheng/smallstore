# Notion + Blob Middleware Live Test

## What This Tests

Full pipeline: fetch images from the web → upload to R2 → store in Notion with file properties.

- **Fetch** 3 bunny images from Wikimedia Commons
- **Upload** each to Cloudflare R2 via blob middleware
- **Store** contacts in Notion with `Photo` as external file properties
- **Read back** and verify file format
- **Sidecar** metadata stored for each blob

## Prerequisites

Both adapters must be working independently first:
- `deno task live:notion` — passes
- `deno task live:r2` — passes

## Setup

### 1. Notion Database

You can use the same database as `live:notion`, or create a separate one.

If creating a separate database:
1. Create a new full-page database in Notion
2. It just needs a `Name` (title) column — the adapter auto-creates the rest
3. Share it with your integration ("..." → "Add connections")
4. Copy the database ID from the URL

### 2. Environment Variables

Add to `.env`:

```bash
# Notion (same as live:notion, or use a separate DB)
SM_NOTION_SECRET=secret_your-integration-token
SM_NOTION_BLOB_DATABASE_ID=your-32-char-database-id   # optional, falls back to SM_NOTION_DATABASE_ID

# R2 (same as live:r2)
SM_R2_ACCOUNT_ID=your-cloudflare-account-id
SM_R2_ACCESS_KEY_ID=your-r2-access-key-id
SM_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
SM_R2_BUCKET_NAME=smallstore-test
```

## Run

```bash
deno task live:notion-blobs
```

## What Happens

1. Creates 3 bunny contacts (Cottontail, Snowball, Thumper)
2. For each: fetches image from Wikimedia → uploads to R2 → stores signed URL as Notion file property
3. Reads back each record and verifies the Photo field has a file URL
4. Shows sidecar metadata (R2 key, file size, content type)
5. Lists all keys from this test run
6. Data stays in Notion + R2 for inspection

## Gotchas

- **Notion file properties**: Notion supports "Files & media" property type. If Photo is auto-created as rich_text, it will store the URL as text. For native file display, manually set the column type to "Files & media" in Notion before running.
- **API version**: The adapter pins to Notion API v4 (`2022-06-28`) for SDK compatibility.

## Env Vars Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_NOTION_SECRET` | Yes | Notion integration secret |
| `SM_NOTION_BLOB_DATABASE_ID` | No | Database ID (falls back to `SM_NOTION_DATABASE_ID`) |
| `SM_R2_ACCOUNT_ID` | Yes | Cloudflare Account ID |
| `SM_R2_ACCESS_KEY_ID` | Yes | R2 API token access key |
| `SM_R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret key |
| `SM_R2_BUCKET_NAME` | Yes | R2 bucket name |
