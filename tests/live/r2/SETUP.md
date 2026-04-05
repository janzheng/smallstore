# R2 Direct Live Test

## What This Tests

Direct blob upload/download against Cloudflare R2:
- **Store** JSON data
- **Store** binary blob (tiny PNG)
- **Generate** signed download URL
- **List** keys by prefix
- **Cleanup** — deletes all test data

## Prerequisites

A Cloudflare account with R2 enabled.

## Setup Steps

### 1. Enable R2 in Cloudflare

Go to your [Cloudflare dashboard](https://dash.cloudflare.com) > **R2**.

### 2. Create a Bucket

Create a bucket named something like `smallstore-test`.

### 3. Create an R2 API Token

Go to **R2 > Manage R2 API Tokens > Create API token**:
- Permissions: **Object Read & Write**
- Specify bucket: your test bucket

This gives you:
- **Access Key ID**
- **Secret Access Key**

Your **Account ID** is in the dashboard URL: `https://dash.cloudflare.com/ACCOUNT_ID/r2`

### 4. Set Environment Variables

Add to `.env`:

```bash
SM_R2_ACCOUNT_ID=your-cloudflare-account-id
SM_R2_ACCESS_KEY_ID=your-r2-access-key-id
SM_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
SM_R2_BUCKET_NAME=smallstore-test
```

## Run

```bash
deno task live:r2
```

## What Happens

1. Stores a JSON object to R2
2. Reads it back
3. Stores a tiny PNG blob
4. Checks it exists
5. Generates a signed download URL (5 min expiry)
6. Lists keys with the test prefix
7. **Cleans up** — deletes all test data from R2

## Env Vars Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_R2_ACCOUNT_ID` | Yes | Cloudflare Account ID |
| `SM_R2_ACCESS_KEY_ID` | Yes | R2 API token access key |
| `SM_R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret key |
| `SM_R2_BUCKET_NAME` | Yes | R2 bucket name |
