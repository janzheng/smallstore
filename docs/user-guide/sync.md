---
title: Sync
description: Bidirectional sync between adapters.
---

# Adapter Sync

Sync data between two adapters with conflict resolution.

## Basic Sync

```typescript
import { createSmallstore, syncAdapters } from '@smallstore/core';

const store = createSmallstore({
  adapters: {
    notion: createNotionAdapter({ ... }),
    sqlite: createSQLiteAdapter({ ... }),
  },
  defaultAdapter: 'sqlite',
});

// Sync Notion → SQLite (one-way)
const result = await syncAdapters({
  source: store.getAdapter('notion'),
  target: store.getAdapter('sqlite'),
  mode: 'source-wins',
  prefix: 'wiki/',  // Only sync wiki namespace
});

console.log(`Synced: ${result.synced}, Conflicts: ${result.conflicts}`);
```

## Sync Modes

| Mode | Behavior |
|------|----------|
| `source-wins` | Source overwrites target on conflict |
| `target-wins` | Target kept on conflict |
| `newer-wins` | Most recently modified wins |
| `manual` | Calls your conflict resolver |

## Bidirectional Sync

Use a `syncId` to track changes since last sync:

```typescript
const result = await syncAdapters({
  source: notionAdapter,
  target: sqliteAdapter,
  mode: 'newer-wins',
  syncId: 'notion-sqlite-sync',  // Tracks last sync timestamp
  bidirectional: true,
});
```

## Use Cases

- **Notion → Local SQLite** — Edit in Notion, query locally
- **Obsidian → Notion** — Write in Obsidian, publish to Notion
- **Airtable → Cache** — Warm a fast cache from Airtable
- **Cross-cloud migration** — Move data between providers
