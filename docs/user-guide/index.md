---
title: Smallstore
description: Universal storage layer for apps and experiments. One API, 17+ backends.
---

# Smallstore

Smallstore is a universal storage abstraction. Write `store.set(key, value)` once, swap backends without changing code.

**17 adapters** — Memory, SQLite, Upstash Redis, Airtable, Notion, Google Sheets, Cloudflare KV/D1/DO/R2, and more.

**Higher-level modules** — Graph relationships, episodic memory, blob middleware, views, materializers, full-text search.

**Zero lock-in** — Start with local JSON files, deploy to cloud with one config change.

## Quick Start

```typescript
import { createSmallstore } from '@smallstore/core';

// One-liner: local JSON files on disk
const store = createSmallstore({ preset: 'local' });

// Store anything
await store.set("users/jan", { name: "Jan", role: "admin" });
await store.set("notes/todo", "Buy milk");

// Retrieve
const user = await store.get("users/jan");

// List keys
const keys = await store.keys("users/");

// Delete
await store.delete("notes/todo");
```

## Why Smallstore?

| Problem | Smallstore Solution |
|---------|-------------------|
| Every backend has a different API | One `get`/`set`/`delete`/`keys` interface |
| Switching backends means rewriting code | Swap adapter in config, code stays the same |
| Blob storage needs separate handling | Blob middleware auto-uploads to R2 |
| No way to query across backends | Smart Router + mounts route by path/type |
| Setting up storage is too much boilerplate | Presets: one line for common patterns |

## Documentation

| Guide | What you'll learn |
|-------|------------------|
| [Getting Started](./getting-started.md) | Install, configure, basic CRUD |
| [Adapters](./adapters.md) | All 17 adapters with config examples |
| [Presets](./presets.md) | One-liner configurations for common patterns |
| [Routing](./routing.md) | Type routing, path mounts, smart routing |
| [Graph Store](./graph-store.md) | Relationships, traversal, queries |
| [Episodic Memory](./episodic-memory.md) | Agent memory with decay and recall |
| [Blob Middleware](./blob-middleware.md) | Auto-upload binaries, store URLs |
| [Views & Materializers](./views.md) | CSV, Markdown, JSON export |
| [HTTP API](./http-api.md) | REST endpoints with Hono |
| [Standalone Server](./standalone-server.md) | Run as a standalone API service |
| [Sync](./sync.md) | Bidirectional adapter sync |
| [Environment Variables](./env-vars.md) | All env var references |
