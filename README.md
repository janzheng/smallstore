# Smallstore 🗄️

**Big surface area for small pockets of data storage**

Smallstore is a "data mesh" / "messy desk" storage abstraction that lets you throw heterogeneous data into collections and figure out organization later. It's like having a desk where you can toss bookmarks, notes, images, and research papers into one pile, then clean up and organize when you're ready.

## The "Messy Desk" Philosophy 📚

```typescript
// Just throw stuff on your desk! Zero friction.
await storage.set("my-desk", "Random idea about AI agents");
await storage.set("my-desk", { url: "https://...", title: "Cool article" });
await storage.set("my-desk", [image1, image2]);
await storage.set("my-desk", { podcast: "...", timestamp: 120 });

// Get everything later
const everything = await storage.get("my-desk");
// → Array of 4 items (string, object, array, object)

// Clean up your desk with views (Phase 2)
// await storage.view("my-desk", { filter: { type: "bookmark" } });
```

### Key Principles

1. **Append by default** - Just throw data in, don't think about structure
2. **Heterogeneous** - Mix strings, objects, arrays, blobs in one collection
3. **Smart routing** - Data automatically goes to the right storage backend
4. **Organize later** - Use views/lenses to filter and query (Phase 2+)
5. **Crash-proof** - Auto-retry, auto-cleanup, graceful 404s (production-ready!)

---

## Quick Start

```typescript
import { createSmallstore } from '@smallstore/core';

// One-liner with preset
const store = createSmallstore({ preset: 'local-sqlite' });

// Store data
await store.set("favorites", { url: "https://example.com", title: "Article" });
await store.set("favorites", { song: "Great tune", spotify: "..." });

// Get data
const favorites = await store.get("favorites");

// Full-text search (SQLite FTS5)
const results = await store.search("favorites", "great tune");

// Structured query
const filtered = await store.query("favorites", {
  filters: [{ field: "url", op: "contains", value: "example" }],
});

// 404s never crash - just return null
const missing = await store.get("does-not-exist");
// → null (clean 404)
```

### Presets

| Preset | Default Adapter | Adapters | Best For |
|--------|----------------|----------|----------|
| `memory` | memory | memory | Testing, ephemeral |
| `local` | local-json | memory + local-json + files | Dev, JSON files on disk |
| `local-sqlite` | sqlite | memory + sqlite + files | Dev/prod, queryable |
| `cloud` | upstash | memory + upstash + R2 (env) | Production, serverless |
| `hybrid` | sqlite | memory + sqlite + files + upstash | Full-featured |
| `structured` | structured-sqlite | memory + structured + files | Typed SQL tables |

```typescript
// Preset with overrides
const store = createSmallstore({
  preset: 'local-sqlite',
  mounts: { 'archive/*': 'sqlite-archive' },
  adapters: { 'sqlite-archive': createSQLiteAdapter({ path: './data/archive.db' }) },
});
```

**Production-ready**: Auto-retry on network errors, auto-cleanup stale keys, crash-proof 404 handling. See [Graceful Degradation](#graceful-degradation--error-handling-️) for details.

---

## Project Structure

```
smallstore/
├── mod.ts              # Entry point (re-exports from src/)
├── types.ts            # Shim: export * from './src/types.ts'
├── serve.ts            # Standalone server (config-file driven)
├── presets.ts          # Storage presets (memory, local, sqlite, cloud, hybrid)
├── config.ts           # Config loader (.smallstore.json / env)
├── deno.json           # Package config + tasks
├── src/                # Library internals
│   ├── router.ts       # Smart router (routing, mounts, type routing)
│   ├── types.ts        # All type definitions
│   ├── detector.ts     # Data type detection
│   ├── adapters/       # 18+ storage adapters
│   ├── http/           # HTTP handlers + Hono/Express integrations
│   ├── utils/          # Utilities (path, size, glob, env, etc.)
│   ├── keyindex/       # Key index management
│   ├── views/          # View system (saved retrieval pipelines)
│   ├── retrievers/     # Data retrievers (filter, slice, text, etc.)
│   ├── materializers/  # Content exporters (JSON, CSV, MD, YAML)
│   ├── namespace/      # Namespace operations (copy, move, tree)
│   ├── validation/     # Input validation & filtering
│   ├── explorer/       # File explorer API
│   ├── disclosure/     # Progressive disclosure
│   ├── episodic/       # Episodic memory
│   └── graph/          # Graph store
├── apps/               # Applications
│   ├── cli/            # CLI tool (deno task cli)
│   └── api/            # REST API server (deno task api)
├── tests/              # All tests (183+ core tests)
├── examples/           # Example scripts
├── docs/               # Documentation
└── data/               # Runtime data (gitignored)
```

---

## CLI App

Interactive command-line tool for testing and exploring smallstore.

```bash
# Run via deno task
deno task cli <command> [args] [--preset=local-sqlite] [--json]

# Commands
deno task cli get <path>                              # Get data
deno task cli set <path> <json|@file>                 # Store data
deno task cli delete <path>                           # Delete data
deno task cli keys [collection] [--prefix=PREFIX]     # List keys
deno task cli search <collection> <query> [--limit=N] # Full-text search
deno task cli query <collection> [--where=F:op:V]     # Structured query
deno task cli collections [--pattern=GLOB]            # List collections
deno task cli tree [--depth=N]                        # Tree view
```

```bash
# Examples
deno task cli set inbox/msg1 '{"from":"email","subject":"Hello"}'
deno task cli get inbox/msg1
deno task cli keys inbox
deno task cli search inbox "Hello"
deno task cli collections
deno task cli tree --json
```

---

## API App

Simple REST API for the "micro-app shared storage" use case. Any small app can POST/GET data to a shared smallstore over HTTP.

```bash
deno task api                          # Start on port 8787 (local-sqlite)
deno task api --preset=memory          # Memory-only mode
deno task api --port=3000              # Custom port
deno task api --api-key=SECRET         # Require Bearer token auth
```

### Endpoints

```
GET    /                           Server info + collection list
GET    /health                     Health check
GET    /collections                List collections
GET    /store/:path                Get data
POST   /store/:path                Set data (JSON body)
PUT    /store/:path                Overwrite data
PATCH  /store/:path                Merge/patch data
DELETE /store/:path                Delete data
GET    /store/:col/_keys           List keys
GET    /store/:col/_search?q=      Full-text search
POST   /store/:col/_query          Structured query
POST   /hooks/:col                 Webhook (auto-timestamped append)
```

```bash
# Examples
curl -X POST localhost:8787/store/inbox -d '{"from":"email","subject":"test"}'
curl localhost:8787/store/inbox
curl localhost:8787/store/inbox/_keys
curl localhost:8787/store/inbox/_search?q=test
curl -X POST localhost:8787/hooks/events -d '{"event":"signup","user":"alice"}'
curl localhost:8787/collections
```

### Micro-App Vision

Any small app can share storage through smallstore:
- **Email interceptor** - forward emails to `POST /hooks/inbox`
- **Google Sheets bridge** - read/write data via API
- **Webhook receiver** - auto-timestamped event logging
- **Cron jobs** - store results for later retrieval
- **AI agents** - shared memory across micro-services

---

## Core Concepts

### 1. Ultra-Simple Types

Smallstore has just **3 data types**:

| Type | Description | Examples |
|------|-------------|----------|
| `object` | ANY JSON-serializable data | `{ name: "test" }`, `[1, 2, 3]`, `[{}, {}]` |
| `blob` | Binary data | Images, audio, PDFs, large text |
| `kv` | Simple primitives | `"string"`, `42`, `true`, `null` |

**No more "array" vs "array-large" or "json" vs "structured"!** Everything is either an object, a blob, or a primitive.

### 2. Append Mode (Default!)

```typescript
// First call
await storage.set("notes", "Idea 1");
// Stored as: ["Idea 1"]

// Second call (appends!)
await storage.set("notes", "Idea 2");
// Stored as: ["Idea 1", "Idea 2"]

// Third call (array becomes item 3!)
await storage.set("notes", ["Link 1", "Link 2"]);
// Stored as: ["Idea 1", "Idea 2", ["Link 1", "Link 2"]]
```

### 3. Heterogeneous Collections

Collections can contain **mixed data types**, like a folder of files:

```typescript
await storage.set("research", {
  papers: [{ title: "Paper 1" }, { title: "Paper 2" }],
  notes: "Some thoughts on the topic",
  images: blobData,
}, { mode: 'overwrite' });

// Smallstore automatically splits this into sub-paths:
// research/papers → Array of objects
// research/notes → String
// research/images → Blob

// Get individual sub-paths
const papers = await storage.get("research/papers");
const notes = await storage.get("research/notes");
const images = await storage.get("research/images");
```

### 4. Smart Routing

Smallstore analyzes your data and routes it to the best storage backend:

- **object** → Memory (Phase 1) / Postgres (future)
- **blob** → Memory (Phase 1) / R2/S3 (future)
- **kv** → Upstash (if available) / Memory

You never think about this - it just works!

---

## API Reference

### Factory Function

```typescript
function createSmallstore(config: SmallstoreConfig): UniversalStorage
```

```typescript
interface SmallstoreConfig {
  adapters: Record<string, StorageAdapter>;
  defaultAdapter: string;
  metadataAdapter?: string; // Defaults to 'memory'
}
```

### Core Methods

#### `set(path, data, options?)`

Store data at a collection path.

```typescript
await storage.set("collection/path", data, {
  mode?: 'append' | 'overwrite' | 'merge',  // Default: 'append'
  ttl?: number,                               // Seconds
  adapter?: string,                           // Force specific adapter
});
```

**Modes:**
- `append` (default): Add to collection (creates array)
- `overwrite`: Replace existing data
- `merge`: Merge objects (or append if not mergeable)

#### `get(path, options?)`

Retrieve data from a collection path.

```typescript
const data = await storage.get("collection/path", {
  filter?: (item) => boolean,  // Phase 1: Not implemented
  sort?: string | Function,     // Phase 1: Not implemented
  limit?: number,               // Phase 1: Not implemented
});
```

Returns `null` if path doesn't exist.

#### `delete(path)`

Delete data at a collection path.

```typescript
await storage.delete("collection/path");
```

#### `deleteFromArray(path, options)` ✨ Phase 3.6e

Delete specific items from an array by filter.

```typescript
// Delete by ID
await storage.deleteFromArray("research/papers", {
  filter: { pmid: "12345" }
});

// Delete by function
await storage.deleteFromArray("research/papers", {
  filter: (paper) => paper.year < 2020,
  returnDeleted: true  // Get deleted items back
});
// → { deleted: 15, items: [...] }
```

**Options:**
- `filter`: Object matcher or function `(item) => boolean`
- `returnDeleted`: Return deleted items (default: `false`)

#### `deleteProperty(path, property)` ✨ Phase 3.6e

Delete properties from an object.

```typescript
// Delete single property
await storage.deleteProperty("user/profile", "oldField");

// Delete multiple properties
await storage.deleteProperty("user/profile", ["field1", "field2"]);
```

#### `resyncMetadata(collection, options?)` ✨ Phase 3.6e

Resync metadata with actual adapter state (fixes stale metadata after UI changes).

```typescript
// User deleted records in Notion/Airtable UI...
const result = await storage.resyncMetadata("research/papers");
console.log(`Added: ${result.changes.added.length}`);
console.log(`Removed: ${result.changes.removed.length}`);
```

**Options:**
- `resyncKeys`: Resync key index (default: `true`)
- `resyncSchema`: Resync schema (default: `true`)
- `verbose`: Verbose logging (default: `false`)

**Returns:**
```typescript
{
  before: { keyCount: 100 },
  after: { keyCount: 95 },
  changes: {
    added: string[],
    removed: string[]
  }
}
```

#### `validateMetadata(collection)` ✨ Phase 3.6e

Check metadata consistency without fixing.

```typescript
const validation = await storage.validateMetadata("research/papers");

if (!validation.valid) {
  console.log(`Found ${validation.issues.length} issues`);
  // Fix them
  await storage.resyncMetadata("research/papers");
}
```

**Returns:**
```typescript
{
  valid: boolean,
  issues: Array<{
    type: 'missing_key' | 'stale_key' | 'schema_mismatch',
    key: string,
    details: string
  }>
}
```

#### `has(path)`

Check if data exists at a collection path.

```typescript
const exists = await storage.has("collection/path");
// → true | false
```

#### `keys(collectionPath, prefix?)`

List keys in a collection.

```typescript
const keys = await storage.keys("favorites");
// → ["bookmarks", "notes", "images"]

const subKeys = await storage.keys("favorites", "book");
// → ["bookmarks"]
```

#### `getSchema(collection)`

Get collection metadata (what's stored where).

```typescript
const schema = await storage.getSchema("favorites");
// → {
//     collection: "favorites",
//     paths: {
//       "bookmarks": { adapter: "memory", dataType: "object", ... },
//       "notes": { adapter: "memory", dataType: "kv", ... },
//     },
//     metadata: { created: "...", updated: "..." }
//   }
```

---

## Phase 2: Retrieval Adapters 🔍

**NEW in Phase 2!** Flexible data retrieval with composable adapters.

Retrievers transform and filter data on read without changing stored data. Like views in databases, but composable and flexible.

### Basic Retrievers

#### Metadata Retriever

Get collection info WITHOUT loading all data:

```typescript
const meta = await storage.get("collection", { 
  retriever: "metadata",
  analyzeTypes: true,
  includeSizes: true
});
// → {
//   itemCount: 100,
//   dataType: "array",
//   isEmpty: false,
//   types: { object: 100 },
//   sizes: { min: 50, max: 500, avg: 200 }
// }
```

#### Slice Retriever

Pagination and sampling:

```typescript
// Get first 10 items
const first = await storage.get("collection", {
  retriever: "slice",
  mode: "head",
  take: 10
});

// Get last 5 items
const last = await storage.get("collection", {
  retriever: "slice",
  mode: "tail",
  take: 5
});

// Random sampling (with seed for reproducibility)
const random = await storage.get("collection", {
  retriever: "slice",
  mode: "random",
  take: 20,
  seed: 12345
});

// Range-based pagination
const page2 = await storage.get("collection", {
  retriever: "slice",
  mode: "range",
  skip: 10,
  take: 10
});
```

#### Filter Retriever

Simple field matching with operators:

```typescript
// Exact match
const aiPosts = await storage.get("posts", {
  retriever: "filter",
  where: { topic: "AI" }
});

// Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $contains
const popular = await storage.get("posts", {
  retriever: "filter",
  where: { 
    views: { $gt: 100 },
    topic: { $in: ["AI", "ML"] }
  }
});

// AND conditions
const filtered = await storage.get("posts", {
  retriever: "filter",
  and: [
    { topic: "AI" },
    { views: { $gt: 100 } }
  ]
});

// OR conditions
const either = await storage.get("posts", {
  retriever: "filter",
  or: [
    { author: "Alice" },
    { author: "Bob" }
  ]
});
```

### Transform Retrievers

#### Structured Retriever

Normalize heterogeneous data to consistent format:

```typescript
// Wrap primitives in objects
const normalized = await storage.get("mixed-data", {
  retriever: "structured",
  wrapPrimitives: true,
  valueKey: "value",
  addIndex: true
});
// ["hello", 42, {name: "Alice"}]
// → [
//   { value: "hello", _type: "string", _index: 0 },
//   { value: 42, _type: "number", _index: 1 },
//   { name: "Alice", _index: 2 }
// ]
```

#### Text Retriever

Convert everything to text strings (perfect for LLMs):

```typescript
// Default JSON format
const text = await storage.get("posts", {
  retriever: "text"
});

// Custom formatter
const summary = await storage.get("posts", {
  retriever: "text",
  formatter: (item) => `${item.title}: ${item.content}`,
  separator: "\n\n",
  includeIndices: true
});
// → "[0] Post 1: Content...\n\n[1] Post 2: Content..."
```

#### Flatten Retriever

Flatten nested objects to flat key-value pairs:

```typescript
const flat = await storage.get("nested-data", {
  retriever: "flatten",
  separator: ".",
  maxDepth: 10
});
// { user: { name: "Alice", address: { city: "NYC" } } }
// → { "user.name": "Alice", "user.address.city": "NYC" }

// Flatten arrays too
const flatArrays = await storage.get("data", {
  retriever: "flatten",
  arrays: "flatten"
});
// { tags: ["ai", "ml", "nlp"] }
// → { "tags.0": "ai", "tags.1": "ml", "tags.2": "nlp" }
```

### Composable Pipelines 🔗

Chain multiple retrievers together:

```typescript
// Filter → Slice → Text
const summary = await storage.get("posts", {
  retrievers: [
    { type: "filter", options: { where: { topic: "AI" } } },
    { type: "slice", options: { mode: "head", take: 5 } },
    { type: "text", options: { 
      formatter: (item) => `${item.title} (${item.views} views)`,
      separator: "\n"
    }}
  ]
});
// → "Post 1 (150 views)\nPost 2 (200 views)..."

// Structured → Filter → Slice
const normalized = await storage.get("mixed-data", {
  retrievers: [
    { type: "structured", options: { wrapPrimitives: true } },
    { type: "filter", options: { where: { _type: "object" } } },
    { type: "slice", options: { mode: "head", take: 10 } }
  ]
});
```

### Real-World Examples

#### Example 1: API Pagination

```typescript
// Page 1
const page1 = await storage.get("products", {
  retrievers: [
    { type: "filter", options: { where: { inStock: true } } },
    { type: "slice", options: { mode: "range", skip: 0, take: 20 } }
  ]
});

// Page 2
const page2 = await storage.get("products", {
  retrievers: [
    { type: "filter", options: { where: { inStock: true } } },
    { type: "slice", options: { mode: "range", skip: 20, take: 20 } }
  ]
});
```

#### Example 2: LLM Context Preparation

```typescript
// Get recent posts as text for LLM
const context = await storage.get("posts", {
  retrievers: [
    { type: "filter", options: { where: { published: true } } },
    { type: "slice", options: { mode: "tail", take: 10 } },
    { type: "text", options: {
      formatter: (post) => `Title: ${post.title}\nContent: ${post.content}\n---`,
      separator: "\n\n"
    }}
  ]
});

// Feed to LLM
const response = await llm.complete(context);
```

#### Example 3: Analytics Dashboard

```typescript
// Get collection stats
const stats = await storage.get("events", {
  retriever: "metadata",
  analyzeTypes: true,
  includeSizes: true
});

// Get top events
const topEvents = await storage.get("events", {
  retrievers: [
    { type: "filter", options: { where: { count: { $gt: 100 } } } },
    { type: "slice", options: { mode: "head", take: 10 } }
  ]
});
```

---

## Phase 2.5: Views & Namespace Operations 🗂️

**NEW in Phase 2.5!** Organize data with views (saved retrieval pipelines) and namespace operations (folder-like organization).

### Views: Saved Retrieval Pipelines

Views are named retrieval pipelines that persist across restarts. They act like database views but are more flexible.

#### Creating Views

Views use the `.view` suffix to distinguish them from collections:

```typescript
// Global view (accessible from anywhere)
await storage.createView("hn-bookmarks.view", {
  source: "favorites/bookmarks",
  retrievers: [
    { type: "filter", options: { where: { source: "hackernews" } } }
  ],
  description: "Bookmarks from Hacker News"
});

// Namespace-scoped view (stored under favorites/)
await storage.createView("favorites/recent.view", {
  source: "favorites/bookmarks",
  retrievers: [
    { type: "slice", options: { mode: "tail", take: 20 } }
  ]
});
```

#### Using Views

Views work just like collections:

```typescript
// Execute a view
const hnBookmarks = await storage.getView("hn-bookmarks.view");
const recent = await storage.getView("favorites/recent.view");

// List all views
const allViews = await storage.listViews();
// → ["hn-bookmarks.view", "favorites/recent.view", ...]

// List views by namespace
const favViews = await storage.listViews("favorites");
// → ["favorites/recent.view"]
```

#### Managing Views

```typescript
// Update view definition
await storage.updateView("hn-bookmarks.view", {
  source: "favorites/bookmarks",
  retrievers: [
    { type: "filter", options: { where: { source: "hackernews" } } },
    { type: "slice", options: { mode: "head", take: 10 } }
  ]
});

// Delete view
await storage.deleteView("old-view.view");
```

### Namespace Operations

Organize data in folder-like namespaces and perform bulk operations.

#### Tree Visualization

See your data structure as a tree:

```typescript
const tree = await storage.tree("favorites");
// → {
//   path: "favorites",
//   type: "folder",
//   children: {
//     bookmarks: { type: "collection", itemCount: 100, dataType: "array" },
//     notes: { type: "collection", itemCount: 50, dataType: "array" },
//     "recent.view": { type: "view", source: "favorites/bookmarks", ... }
//   }
// }
```

#### Get All Data Under Namespace

Retrieve everything under a namespace at once:

```typescript
const allFavorites = await storage.getNamespace("favorites");
// → {
//   bookmarks: [...],
//   notes: [...],
// }

// Non-recursive (only direct children)
const directChildren = await storage.getNamespace("favorites", {
  recursive: false
});
```

#### Copy, Move, and Organize

```typescript
// Copy single collection
await storage.copy("favorites/bookmarks", "work/reference");

// Move data
await storage.move("old-location", "new-location");

// Copy entire namespace
await storage.copyNamespace("favorites", "favorites-backup");

// Copy with overwrite
await storage.copyNamespace("source", "dest", {
  overwrite: true
});
```

### Real-World Use Cases

#### Example 1: Project Organization

```typescript
// Store project data
await storage.set("projects/ai-agent/notes", notes);
await storage.set("projects/ai-agent/code", codeSnippets);
await storage.set("projects/ai-agent/research", papers);

// Create views for different perspectives
await storage.createView("projects/ai-agent/recent.view", {
  source: "projects/ai-agent/notes",
  retrievers: [
    { type: "slice", options: { mode: "tail", take: 10 } }
  ]
});

// Visualize project structure
const projectTree = await storage.tree("projects/ai-agent");

// Archive old project
await storage.copyNamespace("projects/ai-agent", "archives/ai-agent-2024");
```

#### Example 2: Content Filtering

```typescript
// Store all bookmarks in one collection
await storage.set("bookmarks", allBookmarks);

// Create views for different sources
await storage.createView("bookmarks-hn.view", {
  source: "bookmarks",
  retrievers: [
    { type: "filter", options: { where: { source: "hackernews" } } }
  ]
});

await storage.createView("bookmarks-twitter.view", {
  source: "bookmarks",
  retrievers: [
    { type: "filter", options: { where: { source: "twitter" } } }
  ]
});

await storage.createView("bookmarks-popular.view", {
  source: "bookmarks",
  retrievers: [
    { type: "filter", options: { where: { views: { $gt: 100 } } } },
    { type: "slice", options: { mode: "head", take: 20 } }
  ]
});

// Use views
const hn = await storage.getView("bookmarks-hn.view");
const popular = await storage.getView("bookmarks-popular.view");
```

#### Example 3: Data Migration

```typescript
// Reorganize data structure
await storage.copyNamespace("old-structure", "new-structure");

// Create views to maintain compatibility
await storage.createView("old-api.view", {
  source: "new-structure/data",
  retrievers: [
    { type: "structured", options: { addIndex: true } }
  ]
});

// Gradually migrate clients to new structure
// Old: storage.get("old-structure/data")
// New: storage.getView("old-api.view")
```

### View vs Collection: When to Use Which

**Use Collections when:**
- You're storing raw data
- You need append/overwrite/merge modes
- Data changes frequently

**Use Views when:**
- You want multiple filtered perspectives of the same data
- You want to save common retrieval patterns
- You need backward compatibility after refactoring

**Mental Model:**
- Collections = Physical files on disk
- Views = Symlinks or smart folders
- Namespaces = Directories

---

## Adapters

### Memory Adapter

In-memory storage for development and testing.

```typescript
import { createMemoryAdapter } from '@smallstore/core';

const adapter = createMemoryAdapter();
```

**Capabilities:**
- ✅ Supports all types (`object`, `blob`, `kv`)
- ✅ No size limits
- ✅ TTL support
- ✅ Free
- ⚠️ Ephemeral (clears on restart)

### Upstash Adapter

Redis-based persistent storage.

```typescript
import { createUpstashAdapter } from '@smallstore/core';

const adapter = createUpstashAdapter({
  url: "https://your-upstash-url.upstash.io",
  token: "your-token",
  namespace: "myapp",  // Optional prefix
});
```

**Capabilities:**
- ✅ Supports `object` and `kv` types
- ✅ TTL support (native Redis TTL)
- ✅ 1MB per item limit
- ✅ Persistent
- ✅ Cheap ($0.20/GB)
- ❌ NOT for `blob` (use R2/S3)

**Configuration:**

Config-first with env fallback for portability:

```typescript
// Explicit config (portable, testable)
const adapter = createUpstashAdapter({
  url: "https://your-redis.upstash.io",
  token: "your-token"
});

// Or use env vars (convenient for production)
const adapter = createUpstashAdapter();
// Uses UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
```

### Sheetlog Adapter

Google Sheets as database via Sheetlog (Apps Script proxy).

**Perfect for:** Small datasets, manual data management, logging, prototyping, MVPs

```typescript
import { createSheetlogAdapter } from '@smallstore/core';

const adapter = createSheetlogAdapter({
  sheetUrl: "https://script.google.com/macros/s/.../exec",
  sheet: "Demo",  // Sheet tab name
});
```

**Capabilities:**
- ✅ Supports `object` and `kv` types
- ✅ **Hybrid storage pattern** (Sheet as array OR per-row upserts)
- ✅ **Auto ID detection** (first column/key)
- ✅ **Dynamic schema** (automatic column creation)
- ✅ Persistent (Google Sheets backend)
- ✅ Free (within Google API limits)
- ✅ **Manual editing** (edit directly in Sheets UI)
- ⚠️ High latency (~200-500ms via Apps Script)
- ⚠️ Rate limited (Google Sheets API constraints)
- ❌ TTL not supported
- ❌ Not for large datasets (>10k rows)

**Configuration:**

```typescript
// Basic setup
const adapter = createSheetlogAdapter({
  sheetUrl: "https://script.google.com/macros/s/.../exec",
  sheet: "Movies",
});

// Multiple sheets as collections
const storage = createSmallstore({
  adapters: {
    moviesSheet: createSheetlogAdapter({
      sheetUrl: Deno.env.get('SHEET_URL')!,
      sheet: 'Movies',
    }),
    booksSheet: createSheetlogAdapter({
      sheetUrl: Deno.env.get('SHEET_URL')!,
      sheet: 'Books',
    }),
  },
  defaultAdapter: 'moviesSheet',
});

// Configure via collection metadata
await storage.setCollectionMetadata('movies', {
  adapter: {
    type: 'moviesSheet',
    location: 'https://script.google.com/macros/s/.../exec',
    sheet: 'Movies',
  },
  name: 'My Movie Collection',
});
```

**Hybrid Storage Pattern:**

Sheetlog supports two patterns:

1. **Sheet as Array** (default, recommended):
```typescript
// Entire sheet = one collection (array)
const movies = [
  { title: 'Inception', year: 2010, rating: 8.8 },
  { title: 'Interstellar', year: 2014, rating: 8.6 },
];

await storage.set('movies', movies);  // Overwrites entire sheet
const all = await storage.get('movies');  // Returns entire sheet
```

2. **Per-Row Upsert** (optional):
```typescript
// Upsert individual rows by ID (auto-detected from first column)
await storage.upsertByKey('movies', {
  title: 'Inception',  // First column = auto ID
  year: 2010,
  rating: 8.8,
});
```

**Auto ID Detection:**

Sheetlog automatically detects ID fields:
- **Priority 1**: First column/key in object
- **Priority 2**: Common ID fields (`id`, `_id`, `title`, `name`, etc.)

```typescript
// Auto-detects 'sku' as ID (first key)
const products = [
  { sku: 'WIDGET-001', name: 'Widget', price: 10 },
  { sku: 'GADGET-002', name: 'Gadget', price: 20 },
];

await adapter.insert(products);
// Detected ID field: 'sku'
```

**Dynamic Schema:**

Sheetlog automatically creates new columns:

```typescript
// Day 1: Basic fields
await storage.set('users', [
  { email: 'alice@example.com', name: 'Alice' },
]);
// Columns: email, name

// Day 2: Add age field (creates column automatically!)
await storage.upsertByKey('users', [
  { email: 'alice@example.com', name: 'Alice', age: 30 },
]);
// Columns: email, name, age

// Day 3: Add more fields
await storage.upsertByKey('users', [
  { email: 'alice@example.com', name: 'Alice', age: 30, role: 'Engineer' },
]);
// Columns: email, name, age, role
```

**Setup Instructions:**

1. Create a Google Sheet
2. Deploy Sheetlog Apps Script (see [Sheetlog README](https://github.com/janzheng/sheetlog))
3. Get deployment URL
4. Use with Smallstore!

**Use Cases:**
- ✅ Logging and tracking
- ✅ Manual data curation (edit in Sheets UI)
- ✅ Prototypes and MVPs
- ✅ Small datasets (<10k rows)
- ✅ Team collaboration (shared Sheet access)
- ❌ High-traffic applications
- ❌ Large datasets (>10k rows)
- ❌ Low-latency requirements

**Examples:**
- [Basic Usage](./adapters/examples/sheetlog-basic.examples.ts)
- [Advanced Patterns](./adapters/examples/sheetlog-advanced.examples.ts)
- [Module Integration](../../modules/compositions/smallstore/v3/examples/sheetlog-modules.examples.ts)

---

### F2-R2 Adapter (Phase 3.4)

Cloudflare R2 blob storage via F2 (Fuzzyfile) service.

**Perfect for:** Images, audio, video, PDFs, large files (>1MB)

```typescript
import { createF2R2Adapter } from '@smallstore/core';

const adapter = createF2R2Adapter({
  f2Url: "https://f2.phage.directory",  // Optional, uses F2_DEFAULT_URL env
  defaultScope: "smallstore",            // Optional default scope
});
```

**Capabilities:**
- ✅ Supports all types (`object`, `blob`, `kv`)
- ✅ **Automatic JSON serialization** for objects (Phase 3.6g)
- ✅ **No size limits** (R2 can handle huge files)
- ✅ Persistent (Cloudflare R2)
- ✅ Cheap ($0.015/GB storage, $0.36/million reads)
- ✅ CDN-backed (fast global delivery)
- ✅ Automatic MIME type detection from file extensions
- ⚠️ Medium latency (~50-100ms via F2 proxy)
- ❌ TTL not supported (use R2 lifecycle rules instead)

**Configuration:**

```typescript
// Explicit config
const adapter = createF2R2Adapter({
  f2Url: "https://f2.example.com",
  token: "optional-auth-token",
  defaultScope: "myapp"
});

// Or use env fallback
const adapter = createF2R2Adapter();
// Uses F2_DEFAULT_URL env var
```

**Key Namespace Structure:**

F2-R2 adapter parses Smallstore keys into F2 scope/filename format:

```typescript
// Smallstore key → F2 mapping
"smallstore:generated/image-123.png" → { scope: "generated", filename: "image-123.png" }
"generated/image-123.png"            → { scope: "generated", filename: "image-123.png" }
"image.png"                          → { scope: "smallstore", filename: "image.png" }
```

**MIME Type Detection:**

Automatically detects content type from file extensions:

```typescript
await storage.set("photos", "vacation.jpg", jpegBlob);
// Stored with Content-Type: image/jpeg

await storage.set("docs", "report.pdf", pdfBlob);
// Stored with Content-Type: application/pdf

await storage.set("audio", "track.mp3", audioBlob);
// Stored with Content-Type: audio/mpeg
```

**JSON Object Storage (Phase 3.6g):**

F2-R2 adapter also supports storing JSON objects directly:

```typescript
// Store large dataset to R2
const dataset = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  value: Math.random(),
  timestamp: Date.now()
}));

await storage.set("analytics/daily-metrics.json", dataset, {
  adapter: 'f2'  // Explicitly use R2 for large JSON
});

// Retrieve - automatically parsed back to objects
const data = await storage.get("analytics/daily-metrics.json");
console.log(data.length);  // 10000

// Use cases:
// - Large datasets (> 1MB, exceeding Upstash limit)
// - Configuration files with CDN delivery
// - Cache storage for API responses
// - Analytics data / metrics storage
// - JSON backups stored cheaply in R2
```

**How it works:**
- On `set()`: Detects objects → JSON.stringify() → stores with `application/json` content-type
- On `get()`: Detects `application/json` → automatically JSON.parse() → returns objects

See `adapters/examples/f2-r2-objects.examples.ts` for 6 detailed examples!

**Mixed Storage Example:**

Combine Upstash (fast, small data) with F2/R2 (large blobs):

```typescript
const storage = createSmallstore({
  adapters: {
    upstash: createUpstashAdapter(),
    f2: createF2R2Adapter(),
  },
  defaultAdapter: 'upstash',
  metadataAdapter: 'upstash',  // Fast metadata access
  
  // Automatic routing by data type
  typeRouting: {
    kv: 'upstash',       // Small primitives → Upstash
    object: 'upstash',   // JSON objects → Upstash
    blob: 'f2',          // Blobs → R2 via F2
  },
});

// Store mixed data - automatically routed!
await storage.set("project", "config.json", { theme: "dark" });  // → Upstash
await storage.set("project", "image.png", pngBlob);              // → R2
await storage.set("project", "video.mp4", videoBlob);            // → R2

// Smallstore tracks everything in KeyIndex
const schema = await storage.getSchema("project");
// Shows which adapter stores each key
```

**File-Like Organization:**

Store files with natural names and extensions:

```typescript
// Organize like a file system
await storage.set("assets", "images/photo1.jpg", jpegBlob);
await storage.set("assets", "images/photo2.jpg", jpegBlob);
await storage.set("assets", "audio/track.mp3", mp3Blob);
await storage.set("assets", "docs/report.pdf", pdfBlob);

// Retrieve by path
const photo = await storage.get("assets", "images/photo1.jpg");
const audio = await storage.get("assets", "audio/track.mp3");
```

**Large File Support:**

R2 handles files that exceed Upstash's 1MB limit:

```typescript
// 5MB image (too large for Upstash)
const largeImage = new Uint8Array(5 * 1024 * 1024);
await storage.set("gallery", "high-res-photo.jpg", largeImage);
// → Automatically routed to R2, tracked in Upstash KeyIndex

// Generated audio file
const audioFile = await generateAudio();
await storage.set("podcasts", "episode-01.mp3", audioFile);
// → R2 storage, instant CDN delivery
```

---

## Real-World Examples

### Example 1: Bookmarking Service

```typescript
// Day 1: Random idea
await storage.set("favorites", "Check out that podcast on AI");

// Day 2: Web bookmark
await storage.set("favorites", {
  type: "bookmark",
  url: "https://example.com/article",
  title: "Great article",
  tags: ["AI", "research"],
});

// Day 3: Research papers
await storage.set("favorites", [
  { type: "paper", title: "Paper 1", url: "..." },
  { type: "paper", title: "Paper 2", url: "..." },
]);

// Day 4: Podcast episode
await storage.set("favorites", {
  type: "podcast",
  title: "AI episode",
  url: "spotify:...",
});

// Get everything
const allFavorites = await storage.get("favorites");
// → Array of 4 items (mixed types!)

// Future: Filter by type (Phase 2)
// const bookmarks = await storage.view("favorites", {
//   filter: (item) => item.type === "bookmark"
// });
```

### Example 2: Research Collection

```typescript
// Store heterogeneous research data
await storage.set("research-2024", {
  papers: [
    { title: "Paper 1", pdf: pdfBlob1 },
    { title: "Paper 2", pdf: pdfBlob2 },
  ],
  notes: "Key findings: ...",
  images: [screenshot1, screenshot2],
  metadata: { created: "2024-11-17", tags: ["AI", "ML"] },
}, { mode: 'overwrite' });

// Access sub-collections
const papers = await storage.get("research-2024/papers");
const notes = await storage.get("research-2024/notes");
const images = await storage.get("research-2024/images");
```

### Example 3: Append Pattern

```typescript
// Collect data over time
const collectionId = "podcast-transcripts";

for (const episode of episodes) {
  await storage.set(collectionId, {
    title: episode.title,
    transcript: episode.transcript,
    timestamp: Date.now(),
  });
}

// Get all transcripts
const transcripts = await storage.get(collectionId);
// → Array of all episode transcripts
```

---

## Collection Paths & Addressing

Collections use **folder-like paths**:

```
collection/
  ├─ path1/
  │   └─ subpath
  └─ path2
```

Examples:
- `"api-cache"` - Top-level collection
- `"favorites/bookmarks"` - Nested path
- `"research/papers/2024"` - Deep nesting

**Storage keys** (internal):
- Collection: `smallstore:favorites`
- Path: `smallstore:favorites:bookmarks`
- Metadata: `smallstore:meta:favorites`

---

## Implementation Phases

### ✅ Phase 1 (Complete)

- ✅ Ultra-simple 3-type system
- ✅ Append-first pattern
- ✅ Heterogeneous collections
- ✅ Smart routing
- ✅ Collection metadata
- ✅ Memory + Upstash adapters
- ✅ TTL support

### ✅ Phase 2 (Complete)

- ✅ **Retrieval Adapters** - Metadata, Slice, Filter, Structured, Text, Flatten
- ✅ **Composable Pipelines** - Chain multiple retrievers together
- ✅ **Transform on Read** - Convert data without changing storage
- ✅ **Flexible Filtering** - Field matching with operators ($gt, $in, etc.)
- ✅ **Pagination & Sampling** - Head, tail, range, random modes

### ✅ Phase 2.5 (Complete)

- ✅ **Views** - Named retrieval pipelines (like database views)
- ✅ **Namespace Operations** - Copy, move, getNamespace for bulk operations
- ✅ **Tree Visualization** - Folder structure with collections and views
- ✅ **View Management** - Create, update, delete, list views
- ✅ **Global & Namespace-Scoped Views** - Flexible organization

### ✅ Phase 3+ (Complete)

- ✅ **Search** - FTS5 full-text search (BM25 ranking)
- ✅ **SQLite Adapter** - Local queryable storage
- ✅ **Structured SQLite** - Real SQL tables with typed columns
- ✅ **R2 Direct Adapter** - S3-compatible blob storage
- ✅ **Local File Adapter** - Raw binary/blob on disk
- ✅ **Config-Based Routing** - Pattern, type, mount routing
- ✅ **Presets** - One-liner configurations (memory, local, sqlite, cloud, hybrid, structured)
- ✅ **Content Negotiation** - JSON, CSV, Markdown, YAML, Text export
- ✅ **File Explorer** - Browse storage like a filesystem
- ✅ **Graph Store** - Nodes, edges, traversal
- ✅ **Episodic Memory** - Time-decaying episodes with recall
- ✅ **Progressive Disclosure** - Relevance-scored data access
- ✅ **HTTP API** - Hono/Express integrations
- ✅ **CLI App** - Interactive command-line tool
- ✅ **API App** - REST server for micro-app shared storage

---

## Architecture

### Layers

```
┌─────────────────────────────────────┐
│  Smallstore API (Messy Desk!)       │
│  - set(), get(), delete()           │
│  - Append by default                │
└──────────────┬──────────────────────┘
               │
┌──────────────┴──────────────────────┐
│  Smart Router                        │
│  - Data type detection              │
│  - Adapter selection                │
│  - Heterogeneous splitting          │
└──────────────┬──────────────────────┘
               │
     ┌─────────┴─────────┐
     │                   │
┌────▼────┐      ┌──────▼──────┐
│ Memory  │      │  Upstash    │
│ Adapter │      │  Adapter    │
└─────────┘      └─────────────┘
```

### Key Components

1. **Data Type Detector** - Analyzes data (object, blob, kv)
2. **Path Parser** - Parses collection paths
3. **Smart Router** - Routes data to best adapter
4. **Adapters** - Backend storage implementations
5. **Collection Metadata** - Tracks what's stored where

---

## Testing

```bash
# All tests (183+ tests)
deno task test

# Core tests (SQLite, batch, glob, patch, presets, search, views, etc.)
deno task test:core

# Unit tests (graph, episodic, disclosure)
deno task test:unit

# Live adapter tests (requires env vars)
deno task test:live

# Specific test file
deno test --no-check --allow-all tests/sqlite.test.ts
```

**183+ tests** covering: adapters (memory, SQLite, local-json, local-file, upstash), presets, routing, search (FTS5), views, queries, batch operations, glob patterns, graph store, episodic memory, progressive disclosure, content negotiation, and more.

---

## Design Decisions

### Why "Append by Default"?

Most real-world use cases involve **collecting data over time**, not replacing it. The "messy desk" pattern matches how people actually work:

1. Throw stuff on your desk (append)
2. Let it pile up
3. Organize later (views/filters)

### Why Only 3 Types?

Complexity kills adoption. By simplifying to `object`, `blob`, and `kv`, we:

- Remove decision paralysis ("Is this an array or array-large?")
- Make routing decisions automatic
- Allow data to grow without migration

### Why Heterogeneous Collections?

Real data is messy! A "research" collection might contain:
- Papers (array of objects)
- Notes (strings)
- Images (blobs)
- Metadata (objects)

Forcing everything into one type is unnatural.

### Why Smart Routing?

You shouldn't need to think about whether your data goes to:
- Redis (fast, small)
- Postgres (structured, queryable)
- R2 (cheap, large blobs)

The router decides based on data characteristics.

---

## Phase 2.6: Input Validation & Filtering 🧹

**NEW in Phase 2.6!** Clean and validate data **before** storage, complementing Phase 2's output filtering (views/retrievers).

### Why Input Validation?

Phase 2 gave us output filtering (views), but we need input filtering too:

```typescript
// Problem: AI generates messy data
const aiData = await llm.generate("Create product listings");
// → Mix of valid and invalid items

// Solution 1: Filter after storage (Phase 2 views)
await storage.set("products", aiData);  // Stores everything
const clean = await storage.getView("products/valid.view");  // Filter on read

// Solution 2: Filter before storage (Phase 2.6!)
await storage.set("products", aiData, {
  inputValidation: { schema, mode: 'sieve' }  // Only store valid items
});
```

### Input Validation

Validate data before storing using JSON Schema or Zod:

```typescript
const userSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 }
  },
  required: ['name', 'email']
};

// Strict mode: Throw error on invalid data
await storage.set("users", userData, {
  inputValidation: {
    schema: userSchema,
    mode: 'strict'  // Throws if any item is invalid
  }
});

// Sieve mode: Keep valid, drop invalid (silent filtering)
await storage.set("users", messyUserData, {
  inputValidation: {
    schema: userSchema,
    mode: 'sieve',  // Keeps only valid items
    onInvalid: (item, error) => {
      console.log('Dropped invalid user:', item);
    }
  }
});
```

### Input Transformation

Transform and filter data before storage:

#### 1. Pick Fields (whitelist)

```typescript
// Pick only specific fields
await storage.set("bookmarks", scrapedData, {
  inputTransform: {
    pick: ['url', 'title', 'description']  // Only these fields
  }
});
```

#### 2. Omit Fields (blacklist)

```typescript
// Remove sensitive/internal fields
await storage.set("products", apiData, {
  inputTransform: {
    omit: ['internalId', 'debugInfo', 'privateNotes']
  }
});
```

#### 3. Where Filter (query-style filtering)

```typescript
// Filter items using field conditions
await storage.set("bookmarks", allBookmarks, {
  inputTransform: {
    where: {
      url: { $contains: 'github.com' }  // Only GitHub links
    }
  }
});

// Supported operators: $eq, $ne, $gt, $gte, $lt, $lte, $contains, $startsWith, $endsWith, $in, $nin
await storage.set("products", products, {
  inputTransform: {
    where: {
      price: { $gte: 10, $lt: 100 },  // Between $10 and $100
      inStock: { $eq: true }           // In stock only
    }
  }
});
```

#### 4. Custom Transform Function

```typescript
// Apply custom transformation
await storage.set("students", rawScores, {
  inputTransform: {
    transform: (item) => ({
      ...item,
      grade: item.score >= 90 ? 'A' : item.score >= 80 ? 'B' : 'C',
      processedAt: Date.now()
    })
  }
});
```

### Combined: Validation + Transform

The real power is combining validation and transformation:

```typescript
const bookmarkSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'url' },
    title: { type: 'string' },
    tags: { type: 'array' }
  },
  required: ['url', 'title']
};

// 1. Validate (sieve invalid)
// 2. Pick fields
// 3. Add timestamp
await storage.set("bookmarks", scrapedData, {
  inputValidation: {
    schema: bookmarkSchema,
    mode: 'sieve'  // Drop invalid items
  },
  inputTransform: {
    pick: ['url', 'title', 'tags'],  // Remove junk fields
    transform: (item) => ({
      ...item,
      savedAt: Date.now(),
      source: 'web-scraper'
    })
  }
});
```

### Real-World Use Cases

#### Use Case 1: AI-Generated Data

```typescript
// AI generates products, some are invalid
const aiProducts = await llm.generate("Create 10 products");

await storage.set("products", aiProducts, {
  inputValidation: {
    schema: productSchema,
    mode: 'sieve'  // Keep only valid products
  },
  inputTransform: {
    pick: ['name', 'price', 'category'],  // Remove AI hallucinations
    transform: (item) => ({
      ...item,
      addedAt: Date.now(),
      source: 'ai-generated'
    })
  }
});
```

#### Use Case 2: Web Scraping

```typescript
// Scraped data is messy with ads, tracking, etc.
const scrapedArticles = await scraper.scrape(url);

await storage.set("articles", scrapedArticles, {
  inputTransform: {
    pick: ['title', 'url', 'author', 'publishedDate'],  // Only content fields
    where: {
      title: { $ne: null },              // Must have title
      url: { $contains: 'http' }         // Valid URL
    },
    transform: (item) => ({
      ...item,
      scrapedAt: Date.now()
    })
  }
});
```

#### Use Case 3: API Integration

```typescript
// Third-party API returns inconsistent data
const apiResponse = await fetch('https://api.example.com/data');

await storage.set("api-data", apiResponse, {
  inputValidation: {
    schema: apiSchema,
    mode: 'sieve',
    onInvalid: (item, err) => logger.warn('Invalid API data', err)
  },
  inputTransform: {
    omit: ['_internal', '_metadata', '_debug']  // Remove API internals
  }
});
```

### Input vs Output Filtering

| Feature | Input Filtering (Phase 2.6) | Output Filtering (Phase 2 Views) |
|---------|------------------------------|-----------------------------------|
| When | Before storage | After storage, on read |
| Purpose | Clean data at write time | Query/filter on demand |
| Storage | Only valid data stored | All data stored |
| Performance | One-time cost at write | Cost on every read |
| Use Case | Permanent filtering | Temporary queries |

**Best Practice:** Use both!
- Input filtering for permanent cleanup (invalid data)
- Output filtering for dynamic queries (recent items, specific tags)

```typescript
// Input: Clean and validate before storage
await storage.set("bookmarks", scrapedData, {
  inputValidation: { schema, mode: 'sieve' },
  inputTransform: { pick: ['url', 'title', 'tags'] }
});

// Output: Query on demand with views
await storage.createView("recent-github.view", {
  source: "bookmarks",
  retrievers: [
    { type: "filter", options: { where: { url: { $contains: "github" } } } },
    { type: "slice", options: { mode: "tail", take: 20 } }
  ]
});

const recentGithub = await storage.getView("recent-github.view");
```

### Unified Filter Syntax

**Good news!** Input filtering and output filtering (views) use the **same filter syntax** for consistency:

```typescript
// SAME FILTER SYNTAX for both!
const githubFilter = {
  url: { $contains: 'github.com' }
};

// Use at WRITE time (input filtering)
await storage.set("bookmarks", data, {
  inputTransform: {
    where: githubFilter  // ← Same syntax!
  }
});

// Use at READ time (output filtering)
await storage.createView("github-bookmarks.view", {
  source: "bookmarks",
  retrievers: [
    { type: "filter", options: { where: githubFilter } }  // ← Same syntax!
  ]
});
```

**Shared Features:**
- ✅ Same operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`
- ✅ Nested field access: `user.address.city` works in both!
- ✅ Array and string `$contains`: Both support arrays and strings

**Example with nested fields:**

```typescript
const userData = [
  { user: { profile: { age: 25 } }, tags: ['developer'] },
  { user: { profile: { age: 30 } }, tags: ['designer'] },
  { user: { profile: { age: 35 } }, tags: ['developer', 'manager'] }
];

// Input filtering with nested fields
await storage.set("users", userData, {
  inputTransform: {
    where: {
      'user.profile.age': { $gte: 30 },          // Nested field!
      'tags': { $contains: 'developer' }          // Array contains!
    }
  }
});
// Stores only 1 item: { user: { profile: { age: 35 } }, tags: ['developer', 'manager'] }

// Output filtering with nested fields (same syntax!)
await storage.createView("senior-devs.view", {
  source: "users",
  retrievers: [
    { 
      type: "filter", 
      options: { 
        where: {
          'user.profile.age': { $gte: 30 },      // Same nested syntax!
          'tags': { $contains: 'developer' }      // Same array syntax!
        }
      }
    }
  ]
});
```

---

## Phase 3.1: Config-Based Routing 🎯

**NEW in Phase 3.1!** Take control of data routing with explicit configuration. Smart routing is now optional!

### The New Priority System

Phase 3.1 introduces a **5-priority routing system**:

1. **Explicit Adapter Option** - Direct control per `set()` call
2. **Type-Based Routing** - Route by data type (`blob` → R2, `object` → Upstash, etc.)
3. **Pattern-Based Routing** - Route by collection path patterns (`cache:*` → Upstash, `temp:*` → Memory)
4. **Smart Routing** - (Optional) Automatic routing based on cost/performance
5. **Default Adapter** - Final fallback

### Why Config Routing?

```typescript
// ❌ Old way: Smart routing decided everything
// You hope it picks the right adapter...
await storage.set('cache:user123', data);  // Where did it go? 🤷

// ✅ New way: YOU decide
await storage.set('cache:user123', data);  // → Upstash (pattern match!)
await storage.set('temp:scratch', data);   // → Memory (pattern match!)
await storage.set('videos/big', blob);     // → R2 (type routing!)
```

### Example: Complete Routing Configuration

```typescript
import { 
  createSmallstore, 
  createMemoryAdapter,
  createUnstorageAdapter 
} from '@smallstore/core';

const storage = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    upstash: createUnstorageAdapter('upstash'),  // Auto env vars!
    r2: createUnstorageAdapter('cloudflare-r2', { 
      binding: env.MY_R2_BUCKET 
    }),
  },
  
  // Default adapter (fallback)
  defaultAdapter: 'memory',
  
  // Type-based routing (data type → adapter)
  typeRouting: {
    blob: 'r2',       // All blobs → R2
    object: 'upstash', // All objects → Upstash
    kv: 'memory',     // Primitives → Memory
  },
  
  // Pattern-based routing (path pattern → adapter)
  routing: {
    'cache:*': { adapter: 'upstash' },      // API cache
    'videos:*': { adapter: 'r2' },          // Large files
    'temp:*': { adapter: 'memory' },        // Temporary
    'session:*': { adapter: 'upstash' },    // User sessions
  },
  
  // Smart routing disabled by default (opt-in)
  smartRouting: false,  // Default: false
});

// ============================================================================
// Routing in Action
// ============================================================================

// Example 1: Pattern routing
await storage.set('cache:api-results', { data: [...] });
// → Routes to Upstash (matched 'cache:*' pattern)

// Example 2: Type routing (no pattern match)
await storage.set('random-data', largeBlobData);
// → Routes to R2 (matched 'blob' type)

// Example 3: Explicit override (highest priority)
await storage.set('cache:user', data, { adapter: 'memory' });
// → Routes to Memory (explicit override beats pattern!)

// Example 4: Default fallback
await storage.set('misc:stuff', 'hello');
// → Routes to Memory (no patterns, default adapter)
```

### Unstorage Adapter Integration

Phase 3.1 wraps [unstorage](https://unstorage.unjs.io/) drivers as Smallstore adapters:

```typescript
// Upstash (auto env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)
const upstash = createUnstorageAdapter('upstash');

// Upstash (explicit credentials)
const upstash = createUnstorageAdapter('upstash', {
  url: 'https://...',
  token: '...'
});

// Cloudflare KV (requires binding)
const kv = createUnstorageAdapter('cloudflare-kv', {
  binding: env.MY_KV_NAMESPACE
});

// Cloudflare R2 (requires binding)
const r2 = createUnstorageAdapter('cloudflare-r2', {
  binding: env.MY_R2_BUCKET
});
```

### Pattern Matching

Patterns support simple glob matching:

| Pattern | Matches |
|---------|---------|
| `'*'` | Everything (catch-all) |
| `'cache:*'` | Starts with `cache:` |
| `'*:temp'` | Ends with `:temp` |
| `'cache:*:temp'` | Starts with `cache:` AND ends with `:temp` |

**First match wins!** Order matters in your `routing` config.

### Smart Routing (Optional)

Smart routing is now **opt-in**:

```typescript
const storage = createSmallstore({
  adapters: { /* ... */ },
  defaultAdapter: 'memory',
  smartRouting: true,  // Enable smart routing (priority 4)
});

// With smart routing enabled, data is analyzed and scored
await storage.set('data', something);
// → Analyzes size, type, cost, performance
// → Picks best adapter automatically
```

### Adapter Validation

Phase 3.1 validates routing decisions:

```typescript
const storage = createSmallstore({
  adapters: {
    upstash: createUnstorageAdapter('upstash'),  // 1MB limit
  },
  defaultAdapter: 'upstash',
});

// ❌ This will throw: data too large for Upstash (1MB limit)
await storage.set('big-data', reallyBigObject);

// Error: Adapter "upstash" cannot handle data size 5242880 bytes.
//        Maximum size: 1048576 bytes
```

### Migration from Phase 3

Existing code continues to work! The default behavior is now config-routing instead of smart-routing:

```typescript
// Phase 3 (smart routing by default)
const storage = createSmallstore({
  adapters: { /* ... */ },
  defaultAdapter: 'memory',
});
// → Used smart routing

// Phase 3.1 (config routing by default)
const storage = createSmallstore({
  adapters: { /* ... */ },
  defaultAdapter: 'memory',
});
// → Uses default adapter (not smart routing)

// Phase 3.1 (opt-in to smart routing)
const storage = createSmallstore({
  adapters: { /* ... */ },
  defaultAdapter: 'memory',
  smartRouting: true,  // Restore Phase 3 behavior
});
// → Uses smart routing
```

---

## Phase 3.2: Universal File Explorer & Content Negotiation 🗂️

**Treat Smallstore like a filesystem with content negotiation**

Phase 3.2 adds file-oriented views and content negotiation, letting you browse storage like a filesystem and export collections in multiple formats.

### The Realization 🤯

With `KeyIndex` tracking adapter location + data type + size for every key, and multi-adapter routing storing blobs, objects, and KV values, **Smallstore accidentally became a Universal File Explorer** - a virtual filesystem across multiple storage providers.

### StorageFileResponse Format

**⚠️ BREAKING CHANGE**: `storage.get()` now returns `StorageFileResponse` instead of raw data.

```typescript
const response = await storage.get("documents/report.pdf");

// Response structure (compatible with file-transport.ts)
{
  reference: {
    key: "documents/report.pdf",
    name: "report.pdf",
    type: "application/pdf",  // MIME type from extension
    size: 1024000,
    source: "storage",
    storage: "r2",
    createdAt: 1700000000000
  },
  content: Uint8Array([...]),  // Actual data
  adapter: "r2",
  dataType: "blob",
  url: "https://..."  // Optional direct URL
}

// Access content directly
const data = response.content;
```

### File Explorer API

Browse and inspect storage like a filesystem:

```typescript
import { FileExplorer } from '@smallstore/core';

const storage = createSmallstore({...});
const explorer = new FileExplorer(storage);

// Browse namespace (like `ls -la`)
const files = await explorer.browse("my-workspace");
for (const file of files) {
  console.log(`${file.filename} - ${file.sizeFormatted} (${file.mimeType})`);
}
// Output:
//   report.pdf - 1.0 MB (application/pdf)
//   notes.txt - 2.5 KB (text/plain)
//   metadata - 256 bytes (application/json)

// Get file metadata (like `stat`)
const meta = await explorer.metadata("documents/report.pdf");
console.log(meta);
// → {
//     filename: "report.pdf",
//     type: "blob",
//     mimeType: "application/pdf",
//     size: 1024000,
//     sizeFormatted: "1.0 MB",
//     adapter: "r2",
//     created: "2025-11-18T...",
//     ...
//   }

// Tree structure (like `tree`)
const tree = await explorer.tree("my-workspace");
// → {
//     "my-workspace": {
//       "documents": { "_files": ["report.pdf", "notes.txt"] },
//       "images": { "_files": ["photo.jpg"] }
//     }
//   }

// Direct URL (adapter-dependent)
const url = await explorer.getFileUrl("images/photo.jpg");
// → "https://r2.cloudflare.com/bucket/images/photo.jpg"
```

### Content Negotiation

Export collections in multiple formats (inspired by Discourse API):

#### 1. JSON - Structured data with metadata

```typescript
const json = await storage.getAsJson("bookmarks/tech");
console.log(json);
// → {
//     collection: "bookmarks/tech",
//     count: 42,
//     items: [
//       { key: "article1", type: "object", data: {...}, size: 256, adapter: "upstash" },
//       { key: "article2", type: "object", data: {...}, size: 512, adapter: "upstash" }
//     ],
//     metadata: {
//       adapters: { upstash: 42 },
//       totalSize: "10.2 KB",
//       totalSizeBytes: 10240,
//       updated: "2025-11-18T..."
//     }
//   }
```

#### 2. Markdown - Human-readable docs

```typescript
const md = await storage.getAsMarkdown("project/docs");
// → # project/docs
//   
//   **Collection:** project/docs
//   **Items:** 3
//   **Total Size:** 5.2 KB
//   
//   ## readme.md (kv)
//   **Adapter:** memory
//   **Size:** 2.1 KB
//   ```
//   # Project Documentation...
//   ```
```

#### 3. CSV - Spreadsheet exports

```typescript
const csv = await storage.getAsCsv("users");
// → key,type,adapter,size,name,email,age
//   alice,object,upstash,256,Alice,alice@example.com,30
//   bob,object,upstash,245,Bob,bob@example.com,25
```

#### 4. Plain Text - Simple viewing

```typescript
const text = await storage.getAsText("settings");
// → settings
//   Items: 3
//   Total Size: 128 bytes
//   
//   theme: "dark"
//   language: "en"
//   notifications: true
```

#### 5. YAML - Configuration exports

```typescript
const yaml = await storage.getAsYaml("config/app");
// → collection: config/app
//   items: 2
//   data:
//     database:
//       host: localhost
//       port: 5432
//     cache:
//       enabled: true
```

### File-Like Storage with Extensions

Store data with natural filenames and automatic MIME type detection:

```typescript
// Store with extensions
await storage.set("documents/report.pdf", pdfBlob);
await storage.set("images/photo.jpg", jpegBlob);
await storage.set("data/config.json", { version: "1.0.0" });
await storage.set("notes/readme.md", "# Project Notes");

// MIME types detected automatically
const pdf = await storage.get("documents/report.pdf");
console.log(pdf.reference.type);  // → "application/pdf"

const photo = await storage.get("images/photo.jpg");
console.log(photo.reference.type);  // → "image/jpeg"
```

### Supported MIME Types

60+ file types with automatic detection:
- **Documents**: PDF, DOC, XLS, PPT, TXT, MD, CSV
- **Images**: JPEG, PNG, GIF, WebP, SVG
- **Audio**: MP3, WAV, OGG, FLAC
- **Video**: MP4, WebM, MOV, AVI
- **Archives**: ZIP, TAR, GZ, 7Z
- **Code**: JS, TS, PY, GO, RS, and more

### Use Cases

**1. Mixed Media Library**
```typescript
// Store various file types
await storage.set("library/books/novel.pdf", pdfBlob);
await storage.set("library/books/metadata", { title: "...", author: "..." });
await storage.set("library/audio/podcast.mp3", audioBlob);
await storage.set("library/images/cover.jpg", imageBlob);

// Browse all files
const allFiles = await explorer.browse("library");
// Export catalog
const catalog = await storage.getAsJson("library");
const readme = await storage.getAsMarkdown("library");
```

**2. Project Documentation**
```typescript
// Store project files
await storage.set("project/README.md", readmeContent);
await storage.set("project/package.json", pkgJson);
await storage.set("project/LICENSE", licenseText);

// Generate docs site
const projectDocs = await storage.getAsMarkdown("project");
const projectData = await storage.getAsJson("project");
```

**3. Data Export Pipeline**
```typescript
// Collect data
await storage.set("exports/users", usersData);
await storage.set("exports/orders", ordersData);
await storage.set("exports/products", productsData);

// Export in multiple formats
const csvExport = await storage.getAsCsv("exports");  // For Excel
const yamlExport = await storage.getAsYaml("exports"); // For configs
const jsonExport = await storage.getAsJson("exports"); // For APIs
```

### API Integration

Phase 3.2 is designed to work seamlessly with file serving APIs:

```typescript
// Hono API example
app.get('/storage/*', async (c) => {
  const path = c.req.param('*');
  const response = await storage.get(path);
  
  if (!response) {
    return c.notFound();
  }
  
  // StorageFileResponse is file-transport.ts compatible
  return c.body(response.content, {
    headers: {
      'Content-Type': response.reference.type,
      'Content-Length': String(response.reference.size),
    },
  });
});

// Content negotiation endpoints
app.get('/api/collections/:path.json', async (c) => {
  const json = await storage.getAsJson(c.req.param('path'));
  return c.json(json);
});

app.get('/api/collections/:path.md', async (c) => {
  const md = await storage.getAsMarkdown(c.req.param('path'));
  return c.text(md, { headers: { 'Content-Type': 'text/markdown' } });
});

app.get('/api/collections/:path.csv', async (c) => {
  const csv = await storage.getAsCsv(c.req.param('path'));
  return c.text(csv, { headers: { 'Content-Type': 'text/csv' } });
});
```

### Benefits

✅ **Universal File Explorer** - Browse storage like a filesystem  
✅ **MIME Type Detection** - Automatic content type from extensions  
✅ **Content Negotiation** - Export in JSON, MD, CSV, Text, YAML  
✅ **File-Transport Compatible** - Drop-in response format  
✅ **Multi-Format Export** - One collection, many representations  
✅ **Human-Readable Metadata** - Rich file information

### Learn More

- 📖 [Phase 3.2 Design Document](./PHASE-3.2-DESIGN.md)
- 📖 [Phase 3.2 Completion Report](./PHASE-3.2-COMPLETE.md)
- 🧪 [Phase 3.2 Tests](./tests/test-phase-3.2.ts)
- 📝 [File Explorer Example](./examples/file-explorer-example.ts)

---

## Phase 3.5: Smart Upsert (`upsertByKey`) 🔑

**NEW in Phase 3.5!** Automatic key-based upserts - just specify which field to use as the key!

### The Problem

Before Phase 3.5, you had to manually construct keys:

```typescript
// Manual key construction 😓
const user = { id: "abc-123", name: "Alice", age: 25 };
await storage.set(`users/${user.id}`, user, { mode: 'overwrite' });
```

### The Solution: `upsertByKey()`

Now you can upsert objects automatically using any field as the key:

```typescript
// Automatic upsert! 🎉
await storage.upsertByKey("users", {
  id: "abc-123",
  name: "Alice",
  age: 25
});
// Stores as: users/abc-123
```

### Basic Usage

**Default ID field (`id`)**:
```typescript
// Single object
await storage.upsertByKey("users", { 
  id: "user-123", 
  name: "Alice", 
  email: "alice@example.com" 
});

// Batch upsert
await storage.upsertByKey("products", [
  { id: "prod-1", name: "Widget", price: 10 },
  { id: "prod-2", name: "Gadget", price: 20 },
  { id: "prod-3", name: "Doodad", price: 30 }
]);
```

**Custom ID field**:
```typescript
// Use email as key
await storage.upsertByKey("contacts", {
  email: "alice@example.com",
  name: "Alice",
  company: "Acme Corp"
}, { idField: 'email' });
// Stores as: contacts/alice@example.com
```

**Custom key generator**:
```typescript
// Composite keys
await storage.upsertByKey("employees", {
  firstName: "Alice",
  lastName: "Smith",
  dept: "Engineering"
}, {
  keyGenerator: (obj) => `${obj.lastName}-${obj.firstName}`.toLowerCase()
});
// Stores as: employees/smith-alice
```

### Use Cases

- **Database-style updates**: Insert if new, update if exists
- **External API sync**: Automatically deduplicate by ID
- **Batch imports**: Import CSVs with unique IDs
- **Airtable/Notion**: Work with `_id` fields naturally

### Documentation

- 📖 [Phase 3.5 Completion Report](./PHASE-3.5-COMPLETE.md)
- 🧪 [Phase 3.5 Tests](./tests/test-phase-3.5.ts)

---

## Collection-Level Metadata 🏷️

Store arbitrary metadata on collections for organization, workflow context, and "folder prompts".

### 🎯 The Killer Feature: One-Line Adapter Setup

**No more configuration hell!** Just paste your Notion database ID or Airtable base ID, and all inserts go there automatically.

```typescript
// Setup: Paste your Notion database ID (any format works)
await storage.setCollectionMetadata('research/papers', {
  adapter: {
    type: 'notion',
    location: '8aec500b9c8f4bd28411da2680848f65'  // Database ID
    // OR: 'https://notion.so/8aec500b9c8f4bd28411da2680848f65' (full URL)
    // OR: '8aec500b-9c8f-4bd2-8411-da2680848f65' (with dashes)
  }
});

// Now insert data - no adapter specified, it just works!
await storage.insert('research/papers', {
  title: 'Attention Is All You Need',
  year: 2017,
  citations: 50000
});
// ↑ Automatically goes to Notion! 🎉
```

**Airtable Example**:

```typescript
await storage.setCollectionMetadata('contacts/customers', {
  adapter: {
    type: 'airtable',
    location: 'appXYZ123',    // Base ID
    table: 'Customers',       // Table name
    view: 'All Customers'     // Optional view
  }
});

await storage.insert('contacts/customers', { Name: 'John Doe', Email: 'john@example.com' });
// ↑ Goes straight to Airtable!
```

### Folder Prompts - Add Workflow Instructions

```typescript
// Add context to a collection that AI tools can use
await storage.setCollectionMetadata('research/ai-agents', {
  name: 'AI Agents Research',
  description: 'Papers about AI agents and agentic workflows',
  prompt: 'All items in this collection are for AI agent research. Focus on: tool use, planning, memory systems.',
  tags: ['ai', 'agents', 'research'],
  workflow: 'research-pipeline'
});

// Later, retrieve and use in AI prompts
const metadata = await storage.getCollectionMetadata('research/ai-agents');
// Use metadata.prompt in your AI workflow
```

### Any Metadata You Want

```typescript
// Project organization
await storage.setCollectionMetadata('projects/acme-website', {
  client: 'ACME Corp',
  deadline: '2025-12-31',
  budget: '$50,000',
  status: 'in-progress',
  notes: 'Client prefers minimalist design'
});

// Podcast production
await storage.setCollectionMetadata('podcasts/episode-42', {
  guest: 'Dr. Jane Smith',
  recording_date: '2025-11-15',
  status: 'editing',
  notes: 'Cut section at 15:30'
});

// Dynamic workflow tracking
await storage.setCollectionMetadata('notion-sync/tasks', {
  last_sync: new Date().toISOString(),
  source: 'Notion Database',
  item_count: 150
});
```

### Module Usage (Pipelines)

```typescript
// In a workflow
{
  module: "smallstore/setMetadata",
  input: {
    collection: "research/papers",
    metadata: {
      name: "Research Papers",
      prompt: "Focus on recent publications",
      tags: ["research", "papers"]
    }
  }
}
```

**Perfect for**: Folder prompts, project tracking, tagging, workflow notes, AI context, and any custom metadata you need!

### Documentation

- 📖 [Collection Metadata Guide](./COLLECTION-METADATA.md)
- 🎬 [8 Real-World Examples](./modules/compositions/smallstore/v3/examples/metadata.examples.ts)

---

## Graceful Degradation & Error Handling 🛡️

Smallstore is **production-ready** with automatic cleanup, intelligent retries, and crash-proof 404 handling.

### 404 Handling - Never Crashes ✅

```typescript
// File deleted from R2/F2 or TTL expired
const file = await storage.get('photos/deleted.jpg');

// Returns: null (clean 404, no crash)
if (!file) {
  return c.json({ error: 'Not Found' }, 404);
}
```

**All adapters return `null` for missing keys** - no exceptions, no crashes, clean 404s.

### Auto-Cleanup - Removes Stale Keys ✅

```typescript
// Scenario: File deleted directly in R2 (bypassing Smallstore)

const result = await storage.get('photos/deleted.jpg');
// Returns: null
// Side effect: Automatically removes stale key from KeyIndex
```

**Automatic metadata cleanup on every access** - no manual intervention needed.

### Retry Logic - Handles Transient Failures ✅

```typescript
// Network hiccup or rate limit? No problem.
await storage.set('data/file', content);

// Behind the scenes:
// Attempt 1: FAIL (network error) → Retry in 1s
// Attempt 2: FAIL (network error) → Retry in 2s  
// Attempt 3: SUCCESS ✅
```

**Automatic retry with exponential backoff**:
- **Max Retries**: 3 attempts
- **Backoff**: 1s → 2s → 4s
- **Retryable**: Network errors, rate limits, 5xx
- **Non-Retryable**: 404s, validation errors

### Error Scenarios

| Scenario | Behavior | Crashes? | Auto-Fix? |
|----------|----------|----------|-----------|
| File deleted | Returns `null` | ❌ No | ✅ Yes (auto-cleanup) |
| TTL expired | Returns `null` | ❌ No | ✅ Yes (auto-cleanup) |
| Network error | Retries 3x | ❌ No | ✅ Yes (retry) |
| Rate limit | Retries 3x | ❌ No | ✅ Yes (retry) |
| Validation error | Throws immediately | ⚠️ Yes | ❌ No (user error) |

### Manual Metadata Operations

For scheduled maintenance:

```typescript
// Validate metadata (check for orphaned keys)
const issues = await storage.validateMetadata('photos');
// Returns: { orphanedKeys: [...], missingMetadata: [...] }

// Resync metadata (remove orphaned keys)
const result = await storage.resyncMetadata('photos');
// Returns: { keysScanned: 100, keysRemoved: 5 }

// Reconstruct from scratch
await storage.reconstructMetadata('photos');
```

### Scheduled Validation Example

```typescript
// Run every 6 hours
Deno.cron('validate smallstore', '0 */6 * * *', async () => {
  const collections = ['photos', 'documents', 'audio'];
  
  for (const collection of collections) {
    const issues = await storage.validateMetadata(collection);
    
    if (issues.orphanedKeys.length > 0) {
      console.log(`Cleaning ${issues.orphanedKeys.length} stale keys`);
      await storage.resyncMetadata(collection);
    }
  }
});
```

**Result**: Self-healing, crash-proof file system with zero manual intervention required! 🚀

### Documentation

- 📖 [Graceful Degradation Guide](./GRACEFUL-DEGRADATION.md)
- 🧪 [Degradation Tests](./tests/test-graceful-degradation.ts)

---

## Contributing

Smallstore is designed to be extended. To add a new adapter:

1. Implement the `StorageAdapter` interface
2. Declare `capabilities` (supported types, limits, cost)
3. Export a factory function

Example:

```typescript
export class PostgresAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'postgres',
    supportedTypes: ['object'],
    cost: { tier: 'moderate' },
    performance: { readLatency: 'medium', writeLatency: 'medium' },
    features: { query: true, transactions: true },
  };
  
  async get(key: string): Promise<any> { /* ... */ }
  async set(key: string, value: any, ttl?: number): Promise<void> { /* ... */ }
  async delete(key: string): Promise<void> { /* ... */ }
  async has(key: string): Promise<boolean> { /* ... */ }
  async keys(prefix?: string): Promise<string[]> { /* ... */ }
  async clear(prefix?: string): Promise<void> { /* ... */ }
}
```

---

## License

Part of the Coverflow project. See main LICENSE file.

---

## Credits

Inspired by:
- **Google Maps** - "Data mesh" / location-based addressing
- **DuckDB** - Heterogeneous data, smart query planning
- **Notion** - Mix-and-match content types
- **The messy desk on my actual desk** 📚

---

**"Throw data in. Figure it out later."** 🎯
