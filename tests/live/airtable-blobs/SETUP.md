# Airtable + Blob Middleware Live Test

## What This Tests

Full pipeline: fetch images from the web → upload to R2 → store in Airtable with attachment URLs.

- **Fetch** 3 bunny images from Wikimedia Commons
- **Upload** each to Cloudflare R2 via blob middleware
- **Store** contacts in Airtable with `Photo` as attachment URLs
- **Read back** and verify attachment format
- **Sidecar** metadata stored for each blob

## Prerequisites

Both adapters must be working independently first:
- `deno task live:airtable` — passes
- `deno task live:r2` — passes

## Setup

### 1. Airtable Table

Create a new table called `BlobTest` in your existing base (or use any name and set `SM_AIRTABLE_BLOB_TABLE`).

The table just needs a `Name` column (title) to start. The adapter will auto-create `Bio` (rich text) and `Photo` (URL) columns.

**Note:** Airtable attachment columns can't be auto-created via API. The `Photo` field will be stored as a URL string. If you want native attachment display, manually change the `Photo` column type to "Attachment" in Airtable after the first run.

### 2. Environment Variables

Add to `.env`:

```bash
# Airtable (same as live:airtable)
SM_AIRTABLE_API_KEY=pat...your-token...
SM_AIRTABLE_BASE_ID=appYourBaseId
SM_AIRTABLE_BLOB_TABLE=BlobTest          # optional, defaults to "BlobTest"

# R2 (same as live:r2)
SM_R2_ACCOUNT_ID=your-cloudflare-account-id
SM_R2_ACCESS_KEY_ID=your-r2-access-key-id
SM_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
SM_R2_BUCKET_NAME=smallstore-test
```

## Run

```bash
deno task live:airtable-blobs
```

## What Happens

1. Creates 3 bunny contacts (Cottontail, Snowball, Thumper)
2. For each: fetches image from Wikimedia → uploads to R2 → stores signed URL in Airtable
3. Reads back each record and verifies the Photo field has a URL
4. Shows sidecar metadata (R2 key, file size, content type)
5. Lists all keys from this test run
6. Data stays in Airtable + R2 for inspection

## Env Vars Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_AIRTABLE_API_KEY` | Yes | Airtable personal access token |
| `SM_AIRTABLE_BASE_ID` | Yes | Airtable base ID |
| `SM_AIRTABLE_BLOB_TABLE` | No | Table name (default: `BlobTest`) |
| `SM_R2_ACCOUNT_ID` | Yes | Cloudflare Account ID |
| `SM_R2_ACCESS_KEY_ID` | Yes | R2 API token access key |
| `SM_R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret key |
| `SM_R2_BUCKET_NAME` | Yes | R2 bucket name |
