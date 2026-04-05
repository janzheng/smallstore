---
title: Views & Materializers
description: Export data as CSV, Markdown, JSON, and create saved views.
---

# Views & Materializers

## Materializers

Transform stored data into different output formats.

```typescript
import {
  materializeCsv,
  materializeMarkdown,
  materializeJson,
  materializeYaml,
  materializeText,
} from '@smallstore/core';

const data = [
  { name: "Jan", role: "Engineer", score: 95 },
  { name: "Alex", role: "Designer", score: 88 },
  { name: "Sam", role: "PM", score: 92 },
];

// CSV
const csv = materializeCsv(data);
// name,role,score
// Jan,Engineer,95
// Alex,Designer,88
// Sam,PM,92

// Markdown table
const md = materializeMarkdown(data);
// | name | role | score |
// |------|------|-------|
// | Jan | Engineer | 95 |
// ...

// Pretty JSON
const json = materializeJson(data);

// YAML
const yaml = materializeYaml(data);

// Plain text
const text = materializeText(data);
```

### Single Item Materializers

For individual records:

```typescript
const item = { name: "Jan", role: "Engineer", bio: "Builds things" };

const md = materializeMarkdownItem(item);
// ## Jan
// - **role**: Engineer
// - **bio**: Builds things

const csv = materializeCsvItem(item);
// name,role,bio
// Jan,Engineer,Builds things
```

## Views

ViewManager creates named, saved views of your data — like database views or saved filters.

```typescript
import { createSmallstore, ViewManager } from '@smallstore/core';

const store = createSmallstore({ preset: 'local-sqlite' });
const views = new ViewManager(store);

// Define a view
await views.define('top-engineers', {
  source: 'team/*',
  filter: (item) => item.role === 'Engineer' && item.score > 90,
  sort: (a, b) => b.score - a.score,
  limit: 10,
  format: 'markdown',  // Auto-materialize on access
});

// Execute the view
const result = await views.execute('top-engineers');
```

## File Explorer

Browse your data like a filesystem:

```typescript
import { createSmallstore, FileExplorer } from '@smallstore/core';

const store = createSmallstore({ preset: 'local' });
const explorer = new FileExplorer(store);

// Browse a namespace
const files = await explorer.browse("users");

// Get a tree view
const tree = await explorer.tree("project");
// {
//   "project": {
//     "src": { "main": ..., "lib": ... },
//     "docs": { "readme": ... }
//   }
// }

// Get file metadata
const meta = await explorer.metadata("users/jan");
// { key, collection, adapter, sizeFormatted, ... }
```

## Namespace Operations

Organize data across namespaces:

```typescript
import { buildTree, copyOp, moveOp } from '@smallstore/core';

// Build a tree from all keys
const tree = buildTree(allKeys);

// Copy data between paths
await copyOp(store, "drafts/post-1", "published/post-1");

// Move (copy + delete source)
await moveOp(store, "inbox/item-1", "archive/item-1");
```
