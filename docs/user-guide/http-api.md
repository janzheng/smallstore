---
title: HTTP API
description: Expose Smallstore as a REST API with Hono.
---

# HTTP API

Smallstore includes framework-agnostic HTTP handlers. The built-in Hono integration gives you a REST API in a few lines.

## Quick Setup with Hono

```typescript
import { Hono } from 'hono';
import { createSmallstore } from '@smallstore/core';
import { createHonoRoutes } from '@smallstore/core/src/http/integrations/hono.ts';

const app = new Hono();
const store = createSmallstore({ preset: 'local' });

// Mount Smallstore routes
createHonoRoutes(app, store, '/api/storage');

// Start server
Deno.serve(app.fetch);
```

## Endpoints

All endpoints are relative to your mount path (e.g., `/api/storage`).

### Collections CRUD

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/collections` | List all collections |
| `GET` | `/:collection` | Get all data in collection |
| `GET` | `/:collection/:path*` | Get data at specific path |
| `POST` | `/:collection` | Append to collection |
| `PUT` | `/:collection` | Overwrite collection |
| `PATCH` | `/:collection` | Merge into collection |
| `DELETE` | `/:collection` | Delete collection |
| `DELETE` | `/:collection/:path*` | Delete specific path |

### Metadata & Schema

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:collection/metadata` | Get collection metadata |
| `PUT` | `/:collection/metadata` | Set collection metadata |
| `GET` | `/:collection/schema` | Get collection schema |
| `GET` | `/:collection/keys` | List keys in collection |

### Search & Query

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:collection/search?q=...` | Full-text search (BM25) |
| `POST` | `/:collection/query` | Query with filters, sort, pagination |

### Namespaces & Tree

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/namespaces` | List top-level namespaces |
| `GET` | `/namespaces/:path/children` | List child namespaces |
| `GET` | `/namespaces/:path/stat` | Get namespace stats |
| `DELETE` | `/namespaces/:path` | Delete namespace |
| `GET` | `/tree` | Full tree structure |
| `GET` | `/tree/:path` | Subtree at path |

## Example Requests

```bash
# Store data
curl -X POST http://localhost:8000/api/storage/users \
  -H "Content-Type: application/json" \
  -d '{"data": {"name": "Jan", "role": "admin"}}'

# Get data
curl http://localhost:8000/api/storage/users/jan

# List keys
curl http://localhost:8000/api/storage/users/keys

# Search
curl "http://localhost:8000/api/storage/notes/search?q=meeting&limit=5"

# Structured query
curl -X POST http://localhost:8000/api/storage/users/query \
  -H "Content-Type: application/json" \
  -d '{"filter": {"role": "admin"}, "sort": {"name": 1}, "limit": 10}'

# Delete
curl -X DELETE http://localhost:8000/api/storage/users/jan

# Browse tree
curl http://localhost:8000/api/storage/tree

# List namespaces
curl http://localhost:8000/api/storage/namespaces
```

## Subrouter Pattern

Create a separate router for mounting:

```typescript
import { Hono } from 'hono';
import { createSmallstore } from '@smallstore/core';
import { createHonoRouter } from '@smallstore/core/src/http/integrations/hono.ts';

const store = createSmallstore({ preset: 'cloud' });
const storageRouter = createHonoRouter(store, Hono);

const app = new Hono();
app.route('/api/storage', storageRouter);
```

## Middleware

Add Smallstore to Hono context for use in custom handlers:

```typescript
import { smallstoreMiddleware } from '@smallstore/core/src/http/integrations/hono.ts';

app.use('/api/*', smallstoreMiddleware(store));

app.get('/api/custom', async (c) => {
  const ss = c.get('smallstore');
  const data = await ss.get('my-collection');
  return c.json(data);
});
```

## Using Handlers Directly

For custom frameworks or non-Hono environments:

```typescript
import { handleGet, handleSet, handleDelete } from '@smallstore/core/src/http/mod.ts';
import type { SmallstoreRequest } from '@smallstore/core/src/http/mod.ts';

// Build a SmallstoreRequest from your framework's request
const request: SmallstoreRequest = {
  method: 'GET',
  path: '/users/jan',
  params: { collection: 'users', path: 'jan' },
  query: {},
  body: null,
  headers: {},
};

const response = await handleGet(request, store);
// { status: 200, body: { data: ..., collection: 'users', ... } }
```

## Standalone Server

For running Smallstore as its own service (no framework integration needed), see the [Standalone Server](./standalone-server.md) guide.
