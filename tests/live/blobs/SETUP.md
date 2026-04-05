# Blob Middleware Live Test

## What This Tests

Full blob middleware pipeline — upload files to R2 and store URLs in the data store:
- **Detect** blob fields in data
- **Upload** blobs to R2 (via F2 proxy or R2 direct)
- **Store** transformed data with URLs replacing blob inputs
- **Sidecar** metadata stored for cleanup
- **Delete** cleans up R2 blobs via sidecar

## Two Backends

| Backend | Flag | Easier? | Description |
|---------|------|---------|-------------|
| F2-R2 | (default) | Yes | Upload via F2 proxy (public URLs) |
| R2-Direct | `--r2` | No | Upload via AWS S3 SDK (signed URLs) |

## Setup — F2 Backend (Recommended)

F2 (Fuzzyfile) is a Cloudflare Worker that proxies R2 uploads with a simpler API.

Add to `.env`:

```bash
F2_URL=https://f2.phage.directory
F2_TOKEN=your-f2-token        # optional, if your F2 instance requires auth
```

## Setup — R2 Direct Backend

Same setup as the [R2 test](../r2/SETUP.md):

```bash
SM_R2_ACCOUNT_ID=your-cloudflare-account-id
SM_R2_ACCESS_KEY_ID=your-r2-access-key-id
SM_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
SM_R2_BUCKET_NAME=smallstore-test
```

## Run

```bash
# F2 backend (default)
deno task live:blobs

# R2 direct backend
deno task live:blobs --r2
```

## What Happens

1. Detects blob fields in test data (image as buffer, thumbnail as base64)
2. Stores data with blob middleware — blobs are uploaded to R2, URLs replace the raw data
3. Reads back and verifies URLs are in the stored data
4. Checks sidecar metadata at `{key}/_blobs`
5. Deletes the record (blob middleware cleans up R2 blobs)

## Env Vars Reference

### F2 Backend

| Variable | Required | Description |
|----------|----------|-------------|
| `F2_URL` | Yes | F2 proxy URL |
| `F2_TOKEN` | No | Auth token if F2 requires it |

### R2 Direct Backend

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_R2_ACCOUNT_ID` | Yes | Cloudflare Account ID |
| `SM_R2_ACCESS_KEY_ID` | Yes | R2 API token access key |
| `SM_R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret key |
| `SM_R2_BUCKET_NAME` | Yes | R2 bucket name |
