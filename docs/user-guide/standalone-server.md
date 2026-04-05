---
title: Standalone Server
description: Run Smallstore as a standalone REST API without any framework.
---

# Standalone Server

Smallstore ships with two ready-to-run Deno/Hono servers. Drop one into any project for instant storage API.

## Quick Start

```bash
# From the smallstore package directory
deno task serve              # Full server with configurable routes
deno task api                # Lightweight REST API
```

Both auto-detect adapters from environment variables. Set your `.env` and go.

## Option 1: `serve.ts` — Configurable Server

The full-featured server reads from `.smallstore.json`, env vars, or presets.

### Run It

```bash
deno run --allow-all serve.ts
```

Or with env overrides:

```bash
SM_PORT=3000 deno run --allow-all serve.ts
```

### Configure with `.smallstore.json`

Drop this file in your working directory:

```json
{
  "preset": "local",
  "port": 9998
}
```

Preset options: `memory`, `local`, `local-sqlite`, `cloud`, `hybrid`.

### Full Config Example

```json
{
  "port": 8080,
  "dataDir": "./storage",
  "adapters": {
    "memory": {},
    "local": { "baseDir": "./storage" },
    "upstash": {
      "url": "$UPSTASH_REDIS_REST_URL",
      "token": "$UPSTASH_REDIS_REST_TOKEN"
    },
    "airtable": {
      "apiKey": "$SM_AIRTABLE_API_KEY",
      "baseId": "$SM_AIRTABLE_BASE_ID",
      "table": "MyTable"
    },
    "notion": {
      "secret": "$SM_NOTION_SECRET",
      "databaseId": "$SM_NOTION_DATABASE_ID"
    },
    "sheetlog": {
      "sheetUrl": "$SM_SHEET_URL"
    },
    "cloudflare-kv": {
      "baseUrl": "$COVERFLOW_WORKERS_URL",
      "namespace": "my-app"
    }
  },
  "defaultAdapter": "upstash",
  "mounts": {
    "cache/*": "memory",
    "media/*": "local",
    "crm/*": "airtable",
    "docs/*": "notion"
  }
}
```

Values starting with `$` are resolved from environment variables automatically.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Server info (adapters, mounts, port) |
| `GET` | `/health` | Health check |
| `GET` | `/api/collections` | List all collections |
| `GET` | `/api/:collection` | Get data |
| `POST` | `/api/:collection` | Append data |
| `PUT` | `/api/:collection` | Overwrite data |
| `PATCH` | `/api/:collection` | Merge data |
| `DELETE` | `/api/:collection` | Delete data |
| `GET` | `/api/:collection/keys` | List keys |
| `GET` | `/api/:collection/search?q=` | Full-text search |
| `POST` | `/api/:collection/query` | Structured query |
| `GET` | `/api/:collection/metadata` | Get metadata |
| `PUT` | `/api/:collection/metadata` | Set metadata |
| `GET` | `/api/:collection/schema` | Get schema |
| `GET` | `/api/tree` | Browse storage tree |
| `GET` | `/api/namespaces` | List namespaces |

---

## Option 2: `apps/api` — Lightweight REST API

A simpler server with CLI flags and a cleaner REST interface. Designed for the "shared storage for micro-apps" use case.

### Run It

```bash
deno run --allow-all apps/api/mod.ts
```

### CLI Flags

```bash
# Preset (default: local-sqlite)
deno run --allow-all apps/api/mod.ts --preset=cloud

# Custom port (default: 8787)
deno run --allow-all apps/api/mod.ts --port=3000

# Bearer token auth
deno run --allow-all apps/api/mod.ts --api-key=my-secret-key

# Combine
deno run --allow-all apps/api/mod.ts --preset=cloud --port=3000 --api-key=SECRET
```

### Endpoints

#### CRUD

```bash
# Store data
curl -X POST http://localhost:8787/store/users/jan \
  -H "Content-Type: application/json" \
  -d '{"name": "Jan", "role": "admin"}'

# Get data
curl http://localhost:8787/store/users/jan

# Update (merge)
curl -X PATCH http://localhost:8787/store/users/jan \
  -H "Content-Type: application/json" \
  -d '{"role": "superadmin"}'

# Overwrite
curl -X PUT http://localhost:8787/store/users/jan \
  -H "Content-Type: application/json" \
  -d '{"name": "Jan", "role": "owner"}'

# Delete
curl -X DELETE http://localhost:8787/store/users/jan
```

#### Discovery

```bash
# Server info + collection list
curl http://localhost:8787/

# List collections
curl http://localhost:8787/collections

# List keys in collection
curl http://localhost:8787/store/users/_keys

# Check existence
curl http://localhost:8787/store/users/jan/_has

# Get metadata
curl http://localhost:8787/store/users/_metadata

# Get schema
curl http://localhost:8787/store/users/_schema

# Browse tree
curl http://localhost:8787/tree

# List namespaces
curl http://localhost:8787/namespaces
```

#### Search & Query

```bash
# Full-text search
curl "http://localhost:8787/store/notes/_search?q=meeting"

# Structured query (MongoDB-style filters)
curl -X POST http://localhost:8787/store/users/_query \
  -H "Content-Type: application/json" \
  -d '{"filter": {"role": "admin"}, "sort": {"name": 1}, "limit": 10}'

# Upsert (insert or update by ID field)
curl -X POST http://localhost:8787/store/users/_upsert \
  -H "Content-Type: application/json" \
  -d '{"data": [{"id": "jan", "name": "Jan"}], "idField": "id"}'
```

#### Batch Operations

```bash
# Batch get
curl -X POST http://localhost:8787/_batch/get \
  -H "Content-Type: application/json" \
  -d '{"paths": ["users/jan", "users/alex", "config/theme"]}'

# Batch set
curl -X POST http://localhost:8787/_batch/set \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"path": "users/jan", "data": {"name": "Jan"}}, {"path": "users/alex", "data": {"name": "Alex"}}]}'

# Batch delete
curl -X POST http://localhost:8787/_batch/delete \
  -H "Content-Type: application/json" \
  -d '{"paths": ["temp/a", "temp/b", "temp/c"]}'
```

#### Webhooks

```bash
# Auto-timestamped webhook endpoint
curl -X POST http://localhost:8787/hooks/events \
  -H "Content-Type: application/json" \
  -H "X-Source: github" \
  -d '{"event": "push", "repo": "smallstore"}'
# Stores at events/<timestamp> with _ts and _source fields
```

#### Authentication

When started with `--api-key=SECRET`, all requests (except `/health`) require:

```bash
curl -H "Authorization: Bearer SECRET" http://localhost:8787/store/users
```

---

## Embed in Your Own App

Both servers are composable. Import the app builder to mount on your existing Hono server:

```typescript
import { Hono } from 'hono';
import { createSmallstore } from '@smallstore/core';
import { createApiApp } from '@smallstore/core/apps/api/app.ts';

const store = createSmallstore({ preset: 'cloud' });
const storageApp = createApiApp(store, { apiKey: 'optional-secret' });

const app = new Hono();
app.route('/storage', storageApp);   // Mount at /storage/*
app.get('/my-other-route', (c) => c.text('Hello'));

Deno.serve(app.fetch);
```

Or use the lower-level Hono integration:

```typescript
import { Hono } from 'hono';
import { createSmallstore } from '@smallstore/core';
import { createHonoRoutes } from '@smallstore/core/src/http/integrations/hono.ts';

const store = createSmallstore({ preset: 'local' });
const app = new Hono();

createHonoRoutes(app, store, '/api/storage');

Deno.serve(app.fetch);
```

---

## Auto-Detected Adapters

When no `.smallstore.json` is present, the server builds adapters from env vars:

| Env Var(s) | Adapter Added |
|------------|---------------|
| Always | `memory`, `local` |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | `upstash` |
| `SM_AIRTABLE_API_KEY` + `SM_AIRTABLE_BASE_ID` | `airtable` |
| `SM_NOTION_SECRET` + `SM_NOTION_DATABASE_ID` | `notion` |
| `SM_SHEET_URL` | `sheetlog` |
| `COVERFLOW_WORKERS_URL` | `cloudflare-kv`, `cloudflare-d1`, `cloudflare-do` |
| `SM_R2_ACCOUNT_ID` + `SM_R2_ACCESS_KEY_ID` + `SM_R2_SECRET_ACCESS_KEY` + `SM_R2_BUCKET_NAME` | `r2` |

The server uses whichever adapters it can find credentials for. Memory is always available as fallback.

---

## Supported Adapter Types in Config

These `type` values work in `.smallstore.json` adapter configs:

| Type | Required Fields |
|------|----------------|
| `memory` | (none) |
| `local` | `baseDir` (optional, default: `./data`) |
| `local-file` | `baseDir` (optional) |
| `sqlite` | `path` (optional), `table` (optional) |
| `upstash` | `url`, `token` |
| `airtable` | `apiKey`, `baseId`, `table` (optional) |
| `notion` | `secret`, `databaseId` |
| `sheetlog` | `sheetUrl` |
| `cloudflare-kv` | `baseUrl`, `namespace` (optional) |
| `cloudflare-d1` | `baseUrl`, `table` (optional) |
| `cloudflare-do` | `baseUrl`, `instanceId` (optional) |
| `r2` | `accountId`, `accessKeyId`, `secretAccessKey`, `bucketName` |
