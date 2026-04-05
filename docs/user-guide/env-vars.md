---
title: Environment Variables
description: Complete reference for all Smallstore environment variables.
---

# Environment Variables

Smallstore reads credentials from environment variables with an `SM_` prefix for isolated testing, or standard names for production.

## Upstash Redis

| Variable | Description |
|----------|-------------|
| `SM_UPSTASH_URL` | Upstash Redis REST URL |
| `SM_UPSTASH_TOKEN` | Upstash Redis REST token |
| `UPSTASH_REDIS_REST_URL` | Standard Upstash URL (fallback) |
| `UPSTASH_REDIS_REST_TOKEN` | Standard Upstash token (fallback) |

## Airtable

| Variable | Description |
|----------|-------------|
| `SM_AIRTABLE_API_KEY` | Personal access token (`pat...`) |
| `SM_AIRTABLE_BASE_ID` | Base ID (`app...`) |
| `SM_AIRTABLE_TABLE_NAME` | Table name |

**Setup:** Create a [Personal Access Token](https://airtable.com/create/tokens) with `data.records:read`, `data.records:write`, `schema.bases:read`, `schema.bases:write` scopes.

## Notion

| Variable | Description |
|----------|-------------|
| `SM_NOTION_SECRET` | Integration secret (`secret_...`) |
| `SM_NOTION_DATABASE_ID` | Database ID (not page ID!) |
| `SM_NOTION_PAGE_ID` | Page ID (for reference only) |

**Setup:** Create a [Notion integration](https://www.notion.so/my-integrations), share your database with it. Use the **child database ID**, not the page URL ID.

## Google Sheets (Sheetlog)

| Variable | Description |
|----------|-------------|
| `SM_SHEET_URL` | Deployed Apps Script URL |
| `SM_SHEET_NAME` | Sheet tab name |

**Setup:** Deploy the [Sheetlog Apps Script](https://github.com/yawnxyz/sheetlog).

## Cloudflare R2 (Direct)

| Variable | Description |
|----------|-------------|
| `SM_R2_ACCOUNT_ID` | Cloudflare account ID |
| `SM_R2_ACCESS_KEY_ID` | R2 API token access key |
| `SM_R2_SECRET_ACCESS_KEY` | R2 API token secret key |
| `SM_R2_BUCKET_NAME` | R2 bucket name |

**Setup:** Create an R2 API token in Cloudflare dashboard → R2 → Manage R2 API Tokens.

## Cloudflare Workers (KV / D1 / DO)

| Variable | Description |
|----------|-------------|
| `SM_WORKERS_URL` | Deployed Cloudflare Workers URL |

All three Cloudflare adapters (KV, D1, DO) use HTTP mode via this single URL. Also accepts `COVERFLOW_WORKERS_URL` for backward compatibility.

## F2 / Fuzzyfile

| Variable | Description |
|----------|-------------|
| `F2_DEFAULT_URL` | F2 service URL |
| `F2_URL` | F2 URL (fallback) |
| `FUZZYFILE_URL` | Fuzzyfile URL (fallback) |

Default: `https://f2.phage.directory`

## Server Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SM_PORT` | Server port for `serve.ts` | `9999` |
| `SM_DATA_DIR` | Base directory for local storage | `./data` |
| `SM_DEFAULT_ADAPTER` | Default adapter name | `memory` |
| `SM_WORKERS_URL` | Cloudflare Workers URL (primary) | — |

These are used by the [Standalone Server](./standalone-server.md) when no `.smallstore.json` config file is present.

## `.env` File Location

Place your `.env` file at the **project root**. Deno loads it from the working directory.

```bash
# Run tests from project root
deno test --allow-all tests/live-adapters.test.ts
```

See `.env.example` for a complete template.
