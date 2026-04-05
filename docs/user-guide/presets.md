---
title: Presets
description: One-liner configurations for common storage patterns.
---

# Presets

Presets are pre-configured adapter combinations. One line gets you a working store.

## Available Presets

### `memory`

Pure in-memory. Nothing persists.

```typescript
const store = createSmallstore({ preset: 'memory' });
```

**Adapters:** memory
**Use case:** Testing, ephemeral scratch space

### `local`

JSON files on disk with a memory cache layer.

```typescript
const store = createSmallstore({ preset: 'local' });
```

**Adapters:** memory + local-json (`./data/`) + local-file (`./data/files/`)
**Routing:**
- `cache/*` → memory
- `files/*` → local-file (raw binary)
- Everything else → local-json

**Use case:** Local development, prototyping, CLI tools

### `local-sqlite`

SQLite database with file storage. Queryable.

```typescript
const store = createSmallstore({ preset: 'local-sqlite' });
```

**Adapters:** memory + sqlite (`./data/store.db`) + local-file (`./data/files/`)
**Routing:**
- `cache/*` → memory
- `files/*` → local-file
- Everything else → sqlite

**Use case:** Local apps needing search or queries

### `cloud`

Cloud-native. Auto-reads Upstash and R2 credentials from env vars.

```typescript
const store = createSmallstore({ preset: 'cloud' });
```

**Adapters:** memory + upstash (if env vars set) + r2 (if env vars set)
**Routing:**
- `cache/*` → memory
- Blobs → R2 (or memory fallback)
- Everything else → Upstash (or memory fallback)

**Env vars:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SM_R2_*`

**Use case:** Deployed services, serverless functions

### `hybrid`

SQLite locally + optional Upstash for sessions.

```typescript
const store = createSmallstore({ preset: 'hybrid' });
```

**Adapters:** memory + sqlite + local-file + upstash (optional)
**Routing:**
- `cache/*` → memory
- `files/*` → local-file
- `session/*` → upstash (if available)
- Everything else → sqlite

**Use case:** Apps that need both local persistence and cloud sessions

### `structured`

Structured SQLite with typed columns. You must provide your schema.

```typescript
import { createSmallstore, createStructuredSQLiteAdapter } from '@smallstore/core';

const store = createSmallstore({
  preset: 'structured',
  adapters: {
    structured: createStructuredSQLiteAdapter({
      path: './data/app.db',
      schema: {
        users: {
          columns: [
            { name: 'name', type: 'TEXT', notNull: true },
            { name: 'email', type: 'TEXT', unique: true },
          ],
        },
      },
    }),
  },
});
```

## Overriding Presets

Presets are a starting point. Override any part:

```typescript
// Start with local, add a cloud adapter
const store = createSmallstore({
  preset: 'local',
  adapters: {
    redis: createUpstashAdapter({ url: '...', token: '...' }),
  },
  mounts: {
    'sessions/*': 'redis',  // Add cloud sessions
  },
});
```

Override rules:
- `adapters` — merged (your adapters added to preset adapters)
- `mounts` — merged (your mounts added to preset mounts)
- `defaultAdapter` — overrides preset default
- `typeRouting` — overrides preset routing entirely
