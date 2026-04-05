---
title: Routing
description: How Smallstore routes data to the right backend.
---

# Routing

When you have multiple adapters, Smallstore needs to decide where to store each piece of data. Three mechanisms control this, evaluated in order:

1. **Explicit adapter** — `store.set(key, value, { adapter: 'redis' })`
2. **Path mounts** — Pattern matching on key paths
3. **Type routing** — Route by data type (object, blob, kv)
4. **Default adapter** — Fallback

## Explicit Adapter Override

Force a specific adapter for a single operation:

```typescript
await store.set("special-key", data, { adapter: 'redis' });
const value = await store.get("special-key", { adapter: 'redis' });
```

## Path Mounts

Route data based on key path patterns. Uses glob matching.

```typescript
const store = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    redis: createUpstashAdapter({ ... }),
    notion: createNotionAdapter({ ... }),
    airtable: createAirtableAdapter({ ... }),
    r2: createR2DirectAdapter({ ... }),
  },
  defaultAdapter: 'redis',
  mounts: {
    'cache/*':      'memory',     // Ephemeral cache
    'sessions/*':   'redis',      // Fast KV
    'wiki/*':       'notion',     // Rich documents
    'contacts/*':   'airtable',   // CRM with spreadsheet UI
    'uploads/*':    'r2',         // Binary files
  },
});

// Each key automatically routes to the right backend
await store.set("cache/token", "abc");           // → memory
await store.set("sessions/user-123", session);   // → redis
await store.set("wiki/getting-started", doc);    // → notion
await store.set("contacts/jan", contact);        // → airtable
await store.set("uploads/photo.png", bytes);     // → r2
await store.set("anything-else", data);          // → redis (default)
```

Mount patterns use glob syntax:
- `cache/*` — matches `cache/foo` but not `cache/foo/bar`
- `uploads/**` — matches `uploads/foo` and `uploads/foo/bar/baz`
- `*.json` — matches `data.json` at root level

## Type Routing

Route by detected data type. Smallstore has three types:

| Type | Detected when | Examples |
|------|--------------|---------|
| `object` | JSON objects, arrays | `{ name: "Jan" }`, `[1, 2, 3]` |
| `blob` | Binary data | `Uint8Array`, `ArrayBuffer`, `Blob` |
| `kv` | Primitives | `"hello"`, `42`, `true`, `null` |

```typescript
const store = createSmallstore({
  adapters: {
    redis: createUpstashAdapter({ ... }),
    r2: createR2DirectAdapter({ ... }),
  },
  defaultAdapter: 'redis',
  typeRouting: {
    object: 'redis',    // JSON → Redis
    kv: 'redis',        // Primitives → Redis
    blob: 'r2',         // Binary → R2
  },
});

// Automatic routing by data type
await store.set("user", { name: "Jan" });            // object → redis
await store.set("count", 42);                         // kv → redis
await store.set("photo", new Uint8Array([...]));      // blob → r2
```

## Routing Priority

When multiple rules could match:

```
1. Explicit { adapter: 'name' } in options    (highest priority)
2. Path mounts (first matching pattern wins)
3. Type routing (based on detected data type)
4. Default adapter                             (lowest priority)
```

## Smart Routing (Experimental)

Enable automatic routing based on adapter capabilities:

```typescript
const store = createSmallstore({
  adapters: { ... },
  defaultAdapter: 'memory',
  smartRouting: true,  // Analyze data, pick best adapter
});
```

Smart routing scores each adapter based on:
- Can it handle this data type?
- Can it handle this data size?
- Cost tier (prefer cheaper)
- Performance (prefer faster)

This is useful for experimentation but explicit routing is recommended for production.
