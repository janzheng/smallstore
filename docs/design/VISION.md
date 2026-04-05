# Smallstore Vision

## What Smallstore Is

Smallstore is a **universal data store** — a single interface for storing, querying, and retrieving any kind of data across any backend. It's the storage primitive that makes everything else possible.

At its core it does CRUD. But its power comes from treating *all data as the same problem*: schemaless notes, structured databases, images, KV caches, agent memories — they're all just data that needs a place to live, a way to be found, and a way to make sense of it.

## The "Generic CRUD for Memories" Vision

Everything an app or agent works with is a form of memory:

- **Unstructured thoughts** — markdown notes, freeform text, ideas, journal entries
- **Structured data** — schema-based records that support search, filter, sort
- **Files and media** — images from upload tools, PDFs, audio, video
- **KV cache** — ephemeral key-value pairs for indexing and performance
- **Agent memory** — episodic recall with decay, importance weighting, context
- **Relationships** — graph-based connections between any of the above

Smallstore can serve all of these through one API. The "messy desk" append-first model means you can throw anything in and organize later with views, queries, and progressive disclosure.

## Use Cases

- **Personal knowledge base** — notes, bookmarks, highlights, all searchable
- **Agent skill/tool** — MCP tool for any agent to read/write/query shared memory
- **Cross-app data sharing** — Dropbox-like: multiple apps read/write through one store
- **Memory layer for AI apps** — episodic + graph + progressive disclosure = smart context
- **Schemaless-to-schema evolution** — start unstructured, progressively add schemas as patterns emerge
- **Image/file uploads** — blob routing to R2/local storage
- **KV caching** — API response caching via Upstash
- **API endpoints** — RESTful access to all collections via HTTP

## Architecture: Two Layers

### Layer 1: Universal CRUD (existing)
The low-level developer-facing API. Collections, adapters, smart routing, materializers.
- `set()`, `get()`, `delete()`, `query()`, `keys()`
- Smart routing: data type + size → best adapter
- 27 storage adapters (Memory, Upstash, R2, Airtable, Notion, Cloudflare KV/D1/DO, etc.)
- Views, namespaces, materializers (JSON/CSV/Markdown/YAML)
- HTTP layer (framework-agnostic, Hono routes included)

### Layer 2: Memory/Knowledge API (existing, evolving)
The high-level agent/app-facing API. Memory, recall, relationships, disclosure.
- **Episodic memory** — time-based storage with importance decay and recall strategies
- **Graph store** — nodes, edges, relationships, traversal (BFS/DFS/shortest path)
- **Progressive disclosure** — skill-based access levels (summary → overview → detailed → full)
- **Future: Vector search** — semantic similarity for retrieval
- **Future: Schema evolution** — detect patterns in schemaless data, suggest/enforce schemas

## What Makes Smallstore Special

1. **"Messy desk" philosophy** — append by default, organize later
2. **One interface, 27 backends** — Memory, Redis, R2, Airtable, Notion, Cloudflare, local files...
3. **Smart routing** — analyze data type/size, route to best adapter automatically
4. **Heterogeneous collections** — mix JSON, blobs, KV in one namespace
5. **Agent-native features** — episodic memory with decay, graph relationships, progressive disclosure
6. **Materializers** — same data rendered as JSON, CSV, Markdown, YAML, plain text
7. **Zero external dependencies** on host project — fully standalone
8. **Extensible** — add adapters, retrievers, materializers without touching core
