# Smallstore

Smallstore is a universal storage abstraction layer for JavaScript and TypeScript. It provides a single API that works across 17+ storage backends, from in-memory stores to cloud services like Upstash, Airtable, Notion, and Cloudflare.

- **Unified interface** -- `get`, `set`, `delete`, `keys` work the same regardless of backend
- **Path-based routing** -- mount different adapters at different key prefixes
- **Built-in search** -- BM25 full-text search and vector similarity search
- **Graph and episodic modules** -- relationship traversal and time-aware memory
- **HTTP API** -- expose any store as a REST API with Hono

## Installation

### Deno

```bash
deno add jsr:@yawnxyz/smallstore
```

```typescript
import { createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";
```

### Node.js

```bash
npm install smallstore
```

```typescript
import { createSmallstore, createMemoryAdapter } from "smallstore";
```

## Basic usage

Create a store, then use `set()`, `get()`, `delete()`, and `keys()` to manage data.

```typescript
import { createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

await store.set("users/alice", { name: "Alice", role: "admin" });
const alice = await store.get("users/alice");
// { name: "Alice", role: "admin" }

const userKeys = await store.keys("users/");
// ["users/alice"]

await store.delete("users/alice");
```

## Presets

Presets provide one-line configurations for common setups:

```typescript
// In-memory (testing, prototyping)
const store = createSmallstore({ preset: "memory" });

// Local JSON files on disk
const store = createSmallstore({ preset: "local" });

// SQLite with full-text search
const store = createSmallstore({ preset: "local-sqlite" });

// Cloud storage via Upstash + R2 (reads env vars)
const store = createSmallstore({ preset: "cloud" });

// Local primary with cloud backup
const store = createSmallstore({ preset: "hybrid" });
```

## Adapters

Each adapter wraps a different storage backend behind the same interface.

### Local adapters

| Adapter | Description |
|---------|-------------|
| Memory | In-memory store. No persistence. Useful for testing and caching. |
| SQLite | Local database with FTS5 full-text search support. |
| Structured SQLite | Typed SQL tables with column definitions and indexes. |
| Local JSON | Reads and writes JSON files to disk. |
| Local File | Raw binary and blob storage on the local filesystem. |
| Deno FS | Maps a real directory tree as a key-value store. |

### Cloud adapters

| Adapter | Description |
|---------|-------------|
| Upstash | Redis-compatible key-value store. Serverless-friendly. |
| Airtable | Structured records with a spreadsheet UI. |
| Notion | Database pages with typed properties (text, email, etc.). |
| Google Sheets | Spreadsheet storage via the Sheetlog proxy. |
| Cloudflare KV | Edge-distributed key-value with eventual consistency. |
| Cloudflare D1 | Edge SQL database. |
| Cloudflare DO | Durable Objects with strong consistency. |
| Cloudflare R2 | S3-compatible object storage. |
| R2 Direct | R2 access via AWS SDK with presigned URL support. |
| F2-R2 | R2 access via the F2 proxy service. |
| Unstorage | Wraps any [unstorage](https://unstorage.unjs.io/) driver. |

### Composite adapters

| Adapter | Description |
|---------|-------------|
| Overlay | Copy-on-write layer over another adapter. Changes are local until committed. |

### Example: multiple adapters

```typescript
import {
  createSmallstore,
  createMemoryAdapter,
  createUpstashAdapter,
  createR2DirectAdapter,
} from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: {
    cache: createMemoryAdapter(),
    kv: createUpstashAdapter({
      url: Deno.env.get("UPSTASH_URL"),
      token: Deno.env.get("UPSTASH_TOKEN"),
    }),
    files: createR2DirectAdapter({
      accountId: Deno.env.get("R2_ACCOUNT_ID"),
      accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID"),
      secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY"),
      bucketName: "my-bucket",
    }),
  },
  defaultAdapter: "kv",
});
```

## Path-based routing

The `mounts` option routes keys to specific adapters based on their prefix:

```typescript
const store = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    sqlite: createSQLiteAdapter({ path: "./data/main.db" }),
    r2: createR2DirectAdapter({ /* ... */ }),
  },
  defaultAdapter: "memory",
  mounts: {
    "users/*": "sqlite",
    "uploads/*": "r2",
    "cache/*": "memory",
  },
});

await store.set("users/alice", data);       // routed to sqlite
await store.set("uploads/photo.jpg", blob); // routed to r2
await store.set("cache/temp", value);       // routed to memory
```

## Search

Smallstore includes pluggable search providers for full-text and vector search.

### BM25 full-text search

```typescript
import { MemoryBm25SearchProvider } from "@yawnxyz/smallstore";

const search = new MemoryBm25SearchProvider();
await search.index("doc1", { title: "Quantum Computing", body: "Qubits are..." });
await search.index("doc2", { title: "Classical Physics", body: "Newton's laws..." });

const results = await search.search("quantum");
// [{ key: "doc1", score: 0.82, ... }]
```

### Vector similarity search

```typescript
import { MemoryVectorSearchProvider } from "@yawnxyz/smallstore";

const search = new MemoryVectorSearchProvider({
  dimensions: 384,
  embed: myEmbedFunction,
});

await search.index("doc1", { text: "Machine learning fundamentals" });
const similar = await search.search("deep learning basics");
```

## Graph store

The graph module stores nodes and edges in any Smallstore adapter, enabling relationship queries and traversal.

```typescript
import { createGraphStore } from "@yawnxyz/smallstore";

const graph = createGraphStore(store);

await graph.addNode({ id: "alice", type: "person", data: { name: "Alice" } });
await graph.addNode({ id: "bob", type: "person", data: { name: "Bob" } });
await graph.addEdge({ source: "alice", target: "bob", type: "knows" });

const friends = await graph.query({ from: "alice", edge: "knows" });
```

## Episodic memory

Time-aware storage with importance decay and recall strategies.

```typescript
import { createEpisodicStore } from "@yawnxyz/smallstore";

const episodes = createEpisodicStore(store);

await episodes.record({
  type: "conversation",
  data: { topic: "project planning" },
  tags: ["work"],
  importance: 0.8,
});

const recalled = await episodes.recall({
  tags: ["work"],
  minImportance: 0.5,
  limit: 10,
});
```

## HTTP API

Expose any store as REST endpoints using Hono:

```typescript
import { Hono } from "hono";
import { createSmallstore, createMemoryAdapter, createHonoRouter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

const app = new Hono();
app.route("/api/store", createHonoRouter(store));
Deno.serve(app.fetch);
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:key` | Retrieve a value |
| `PUT` | `/:key` | Set a value |
| `DELETE` | `/:key` | Delete a value |
| `GET` | `/` | List all collections |

## Materializers

Export data in multiple output formats:

```typescript
import { materializeCsv, materializeMarkdown, materializeJson } from "@yawnxyz/smallstore";

const csv = materializeCsv(data);
const md = materializeMarkdown(data);
const json = materializeJson(data, { pretty: true });
```

Supported formats: JSON, CSV, Markdown, YAML, plain text.

## VFS (Virtual Filesystem)

A bash-like interface for programmatic or agent-driven access:

```typescript
import { vfs } from "@yawnxyz/smallstore";

const state = vfs.init(store);

await vfs.exec(state, "mkdir users");
await vfs.exec(state, "echo '{\"name\":\"Alice\"}' > users/alice");
await vfs.exec(state, "ls users/");
await vfs.exec(state, "cat users/alice");
await vfs.exec(state, "grep name users/");
```

## Examples

The repository includes runnable examples:

| Command | Description |
|---------|-------------|
| `deno task clipper` | Data clipper with validation checks |
| `deno task crm` | Mini CRM application |
| `deno task gallery` | Media gallery with simulated mode |
| `deno task paste` | Markdown paste bin (requires R2 credentials) |
| `deno task auth` | Authentication system with sessions |
| `deno task api` | HTTP API server on port 8787 |
| `deno task cli` | CLI with VFS commands |

## Testing

```bash
# Offline tests (no credentials required)
deno test --no-check --allow-all tests/*.test.ts

# Live adapter tests (requires .env credentials)
deno test --no-check --allow-all tests/live-adapters.test.ts

# Type checking
deno check mod.ts
```

See `.env.example` for the required environment variables.

## Publishing

```bash
# JSR (Deno)
deno publish --no-check --allow-slow-types

# npm
deno task build:npm && cd dist && npm publish
```

## License

[MIT](./LICENSE)
