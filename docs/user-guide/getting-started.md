---
title: Getting Started
description: Install Smallstore and make your first storage calls.
---

# Getting Started

## Installation

Smallstore is a Deno-first package. Import directly from the local path or a registry:

```typescript
// Local import
import { createSmallstore } from './mod.ts';

// Or from your import map (deno.json)
import { createSmallstore } from '@smallstore/core';
```

## Your First Store

The fastest way to get started is with a preset:

```typescript
import { createSmallstore } from '@smallstore/core';

const store = createSmallstore({ preset: 'memory' });

// Set a value
await store.set("greeting", "Hello, world!");

// Get it back
const value = await store.get("greeting");
console.log(value); // "Hello, world!"
```

## Persistent Storage (Local Files)

Switch to the `local` preset to persist data as JSON files:

```typescript
const store = createSmallstore({ preset: 'local' });

// Stored as ./data/users/jan.json
await store.set("users/jan", {
  name: "Jan",
  email: "jan@example.com",
  role: "admin",
});

// Survives process restart
const jan = await store.get("users/jan");
```

## Manual Configuration

For full control, pass adapters directly:

```typescript
import {
  createSmallstore,
  createMemoryAdapter,
  createUpstashAdapter,
} from '@smallstore/core';

const store = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    redis: createUpstashAdapter({
      url: Deno.env.get('UPSTASH_REDIS_REST_URL')!,
      token: Deno.env.get('UPSTASH_REDIS_REST_TOKEN')!,
    }),
  },
  defaultAdapter: 'redis',
  mounts: {
    'cache/*': 'memory',  // Fast ephemeral cache
  },
});
```

## Core API

Every Smallstore instance has the same interface regardless of backend:

### `set(key, value, options?)`

Store a value. Keys use `/` as path separators.

```typescript
// Simple values
await store.set("config/theme", "dark");
await store.set("stats/visitors", 42);

// Objects
await store.set("users/jan", { name: "Jan", role: "admin" });

// Arrays
await store.set("tags/popular", ["typescript", "deno", "rust"]);

// Binary data
await store.set("files/logo.png", imageBytes);

// With options
await store.set("session/abc", sessionData, { adapter: 'redis', ttl: 3600 });
```

### `get(key, options?)`

Retrieve a value. Returns `null` if not found.

```typescript
const user = await store.get("users/jan");
// { name: "Jan", role: "admin" }

const missing = await store.get("users/nonexistent");
// null
```

### `has(key)`

Check if a key exists.

```typescript
if (await store.has("users/jan")) {
  console.log("User exists");
}
```

### `delete(key)`

Remove a key.

```typescript
await store.delete("session/expired");
```

### `keys(prefix?)`

List keys, optionally filtered by prefix.

```typescript
const allKeys = await store.keys();
const userKeys = await store.keys("users/");
// ["users/jan", "users/alex", "users/sam"]
```

### `clear(prefix?)`

Remove all keys, or all keys under a prefix.

```typescript
await store.clear("cache/");  // Clear only cache
await store.clear();           // Clear everything
```

## Path-Based Organization

Keys are just strings, but `/` gives you natural namespacing:

```typescript
// Flat
await store.set("user-jan", data);

// Hierarchical (recommended)
await store.set("users/jan", data);
await store.set("users/jan/settings", settingsData);
await store.set("users/jan/avatar", avatarBytes);

// List a "directory"
const janKeys = await store.keys("users/jan/");
// ["users/jan/settings", "users/jan/avatar"]
```

## Choosing an Adapter

Use the decision tree:

```
Need persistence?
├─ No  → memory
├─ Local only?
│  ├─ Need SQL queries? → local-sqlite
│  └─ Just key-value?   → local (JSON files)
├─ Cloud?
│  ├─ Fast KV?          → upstash or cloudflare-kv
│  ├─ SQL in cloud?     → cloudflare-d1
│  ├─ Blob storage?     → r2-direct or f2-r2
│  ├─ Spreadsheet UI?   → airtable or sheetlog
│  └─ Rich documents?   → notion
└─ Multiple backends?   → Use routing (see Routing guide)
```

## Run as a Standalone API

Don't want to write code? Run Smallstore as an HTTP service and use it from any language:

```bash
# Start the lightweight REST API
deno run --allow-all apps/api/mod.ts --preset=local-sqlite
```

Then use it from anywhere:

```bash
curl -X POST http://localhost:8787/store/users/jan \
  -H "Content-Type: application/json" \
  -d '{"name": "Jan", "role": "admin"}'

curl http://localhost:8787/store/users/jan
```

See [Standalone Server](./standalone-server.md) for full configuration.

## Next Steps

- [Adapters](./adapters.md) — All 17 adapters with configuration
- [Presets](./presets.md) — One-liner setups
- [Routing](./routing.md) — Route data to the right backend automatically
- [Standalone Server](./standalone-server.md) — Run as an HTTP API service
