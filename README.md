# Smallstore

Universal storage layer — one API, 17+ backends.

Store JSON, blobs, arrays, and vectors across Memory, SQLite, Upstash, Airtable, Notion, Google Sheets, Cloudflare KV/D1/DO/R2, and more. Includes full-text search, graph relationships, episodic memory, views, and an HTTP API.

## Install

```bash
# Deno
deno add jsr:@yawnxyz/smallstore

# npm
npm install smallstore
```

## Quick Start

```typescript
import { createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

// Set and get data
await store.set("users/alice", { name: "Alice", role: "admin" });
const alice = await store.get("users/alice");

// List keys by prefix
const userKeys = await store.keys("users/");

// Delete
await store.delete("users/alice");
```

## Presets

Skip manual configuration with built-in presets:

```typescript
import { createSmallstore } from "@yawnxyz/smallstore";

// In-memory (testing, prototyping)
const store = createSmallstore({ preset: "memory" });

// Local JSON files on disk
const store = createSmallstore({ preset: "local" });

// SQLite for structured/queryable storage
const store = createSmallstore({ preset: "local-sqlite" });

// Cloud: Upstash + R2 (reads env vars automatically)
const store = createSmallstore({ preset: "cloud" });

// Hybrid: local primary + cloud backup
const store = createSmallstore({ preset: "hybrid" });
```

## Adapters

| Adapter | Type | Best For |
|---------|------|----------|
| **Memory** | Built-in | Testing, caching, prototyping |
| **SQLite** | Local | Structured queries, FTS, local persistence |
| **Structured SQLite** | Local | Typed SQL tables with column definitions |
| **Local JSON** | Local | Simple file-based persistence |
| **Local File** | Local | Raw binary/blob storage on disk |
| **Deno FS** | Local | Real directory as a store |
| **Upstash** | Cloud | Redis-style KV, serverless-friendly |
| **Airtable** | Cloud | Structured data with a spreadsheet UI |
| **Notion** | Cloud | Database pages with rich properties |
| **Google Sheets** | Cloud | Spreadsheet storage via Sheetlog |
| **Cloudflare KV** | Cloud | Edge-distributed key-value |
| **Cloudflare D1** | Cloud | Edge SQL database |
| **Cloudflare DO** | Cloud | Durable Objects (strong consistency) |
| **Cloudflare R2** | Cloud | S3-compatible object storage |
| **R2 Direct** | Cloud | R2 via AWS SDK (presigned URLs) |
| **F2-R2** | Cloud | R2 via F2 proxy service |
| **Unstorage** | Cloud | Any unstorage driver (Redis, S3, etc.) |
| **Overlay** | Composite | Copy-on-write read-through layer |

### Using Cloud Adapters

```typescript
import {
  createSmallstore,
  createUpstashAdapter,
  createAirtableAdapter,
  createNotionAdapter,
  createCloudflareKVAdapter,
  createR2DirectAdapter,
} from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: {
    cache: createUpstashAdapter({
      url: Deno.env.get("UPSTASH_URL")!,
      token: Deno.env.get("UPSTASH_TOKEN")!,
    }),
    contacts: createAirtableAdapter({
      apiKey: Deno.env.get("AIRTABLE_API_KEY")!,
      baseId: Deno.env.get("AIRTABLE_BASE_ID")!,
      tableName: "Contacts",
    }),
    docs: createNotionAdapter({
      secret: Deno.env.get("NOTION_SECRET")!,
      databaseId: Deno.env.get("NOTION_DATABASE_ID")!,
    }),
    kv: createCloudflareKVAdapter({
      baseUrl: Deno.env.get("CF_WORKERS_URL")!,
    }),
    files: createR2DirectAdapter({
      accountId: Deno.env.get("R2_ACCOUNT_ID")!,
      accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
      bucketName: "my-bucket",
    }),
  },
  defaultAdapter: "cache",
});
```

## Path-Based Routing (Mounts)

Route keys to specific adapters by prefix:

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

// Automatically routed:
await store.set("users/alice", data);       // -> sqlite
await store.set("uploads/photo.jpg", blob); // -> r2
await store.set("cache/temp", value);       // -> memory
```

## Search

Built-in full-text search (BM25) and vector search:

```typescript
import {
  createSmallstore,
  createMemoryAdapter,
  MemoryBm25SearchProvider,
  MemoryVectorSearchProvider,
} from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

// BM25 text search
const bm25 = new MemoryBm25SearchProvider();
await bm25.index("doc1", { title: "Quantum Computing", body: "..." });
const results = await bm25.search("quantum");

// Vector search (with embedding function)
const vec = new MemoryVectorSearchProvider({
  dimensions: 384,
  embed: myEmbedFunction,
});
await vec.index("doc1", { text: "..." });
const similar = await vec.search("related query");
```

## Graph Store

Store and traverse relationships between entities:

```typescript
import { createGraphStore, createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

const graph = createGraphStore(store);

await graph.addNode({ id: "alice", type: "person", data: { name: "Alice" } });
await graph.addNode({ id: "bob", type: "person", data: { name: "Bob" } });
await graph.addEdge({ source: "alice", target: "bob", type: "knows", data: { since: 2024 } });

// Traverse
const friends = await graph.query({ from: "alice", edge: "knows" });
```

## Episodic Memory

Time-aware storage with decay, sequences, and recall:

```typescript
import { createEpisodicStore, createSmallstore, createMemoryAdapter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

const episodes = createEpisodicStore(store);

await episodes.record({
  type: "conversation",
  data: { topic: "project planning", summary: "..." },
  tags: ["work", "planning"],
  importance: 0.8,
});

// Recall recent important episodes
const recalled = await episodes.recall({
  tags: ["work"],
  minImportance: 0.5,
  limit: 10,
});
```

## HTTP API

Expose any store as an HTTP API with Hono:

```typescript
import { Hono } from "hono";
import { createSmallstore, createMemoryAdapter, createHonoRouter } from "@yawnxyz/smallstore";

const store = createSmallstore({
  adapters: { memory: createMemoryAdapter() },
  defaultAdapter: "memory",
});

const app = new Hono();
app.route("/api/store", createHonoRouter(store));

// GET    /api/store/:key
// PUT    /api/store/:key
// DELETE /api/store/:key
// GET    /api/store/ (list collections)

Deno.serve(app.fetch);
```

## Views & Materializers

Create computed views and export data in multiple formats:

```typescript
import { materializeCsv, materializeMarkdown, materializeJson } from "@yawnxyz/smallstore";

// Materialize data as CSV, JSON, Markdown, YAML, or plain text
const csv = materializeCsv(data);
const md = materializeMarkdown(data);
const json = materializeJson(data, { pretty: true });
```

## VFS (Virtual Filesystem)

Bash-like interface for agents and CLI tools:

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

Run examples with `deno task`:

| Task | Description |
|------|-------------|
| `deno task clipper` | Data clipper with 45 validation checks |
| `deno task crm` | Mini CRM with 51 validation checks |
| `deno task gallery` | Media gallery with simulated mode |
| `deno task paste` | Markdown paste bin (needs R2 credentials) |
| `deno task auth` | Auth system with sessions |
| `deno task api` | HTTP API server on :8787 |
| `deno task cli` | CLI tool with VFS commands |

## Testing

```bash
# Run all offline tests (no credentials needed)
deno test --no-check --allow-all tests/*.test.ts

# Run live adapter tests (needs .env with credentials)
deno test --no-check --allow-all tests/live-adapters.test.ts

# Type check
deno check mod.ts
```

Copy `.env.example` to `.env` and fill in credentials for live adapter tests.

## Publishing

```bash
# JSR
deno publish --no-check --allow-slow-types

# npm
deno task build:npm && cd dist && npm publish
```

## License

MIT
