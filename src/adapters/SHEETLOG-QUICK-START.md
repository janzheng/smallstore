# Sheetlog Quick Start Guide 🚀

Turn Google Sheets into a database in 5 minutes!

> **Heads up — `storage.set()` / `adapter.set()` is disabled on sheetlog.** It
> used to silently wipe the entire tab because the `key` arg was ignored.
> Use `adapter.append(items)` for adding rows, `adapter.upsert(items, { idField })`
> for keyed updates, and `adapter.replace(items)` if you really mean "replace
> the whole tab." The examples below that show `storage.set('...', [...])`
> predate the fix — replace them with `adapter.append` or `adapter.replace`
> on newer deploys.

## Setup

### 1. Deploy Sheetlog Apps Script

1. Open your Google Sheet
2. Go to **Extensions → Apps Script**
3. Copy the code from [`_REFERENCES_ONLY/sheetlog/sheetlog.js`](../../../../_REFERENCES_ONLY/sheetlog/sheetlog.js)
4. **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (or as needed)
5. Copy the deployment URL

### 2. Install Smallstore (if needed)

Already included in this project! No installation needed.

### 3. Create Adapter

```typescript
import { createSmallstore, createSheetlogAdapter } from './shared/smallstore/mod.ts';

const storage = createSmallstore({
  adapters: {
    sheetlog: createSheetlogAdapter({
      sheetUrl: "https://script.google.com/macros/s/.../exec",  // Your deployment URL
      sheet: "Demo",  // Sheet tab name
    }),
  },
  defaultAdapter: 'sheetlog',
});
```

## Basic Usage

### Store Data

```typescript
// Store array in sheet
const movies = [
  { title: 'Inception', year: 2010, rating: 8.8 },
  { title: 'Interstellar', year: 2014, rating: 8.6 },
  { title: 'The Dark Knight', year: 2008, rating: 9.0 },
];

await storage.set('movies', movies);
```

### Retrieve Data

```typescript
// Get entire sheet
const allMovies = await storage.get('movies');
console.log(allMovies);
// [
//   { title: 'Inception', year: 2010, rating: 8.8 },
//   { title: 'Interstellar', year: 2014, rating: 8.6 },
//   { title: 'The Dark Knight', year: 2008, rating: 9.0 },
// ]
```

### Update Data

```typescript
// Upsert (auto-detects 'title' as ID from first column)
await storage.upsertByKey('movies', [
  { title: 'Inception', year: 2010, rating: 8.9 },  // Updates rating
]);
```

### Add New Data

```typescript
// Add new movie
await storage.upsertByKey('movies', [
  { title: 'Tenet', year: 2020, rating: 7.3 },
]);
```

## Common Patterns

### Pattern 1: Logging

```typescript
const storage = createSmallstore({
  adapters: {
    logs: createSheetlogAdapter({
      sheetUrl: process.env.SHEET_URL!,
      sheet: 'AppLogs',
    }),
  },
  defaultAdapter: 'logs',
});

// Append logs
const existingLogs = await storage.get('logs') || [];
const newLog = {
  timestamp: new Date().toISOString(),
  level: 'info',
  message: 'User logged in',
  userId: 'user123',
};

await storage.set('logs', [...existingLogs, newLog]);
```

### Pattern 2: Product Catalog

```typescript
const storage = createSmallstore({
  adapters: {
    products: createSheetlogAdapter({
      sheetUrl: process.env.SHEET_URL!,
      sheet: 'Products',
    }),
  },
  defaultAdapter: 'products',
});

// Initial products
await storage.set('products', [
  { sku: 'WIDGET-001', name: 'Widget', price: 10, stock: 100 },
  { sku: 'GADGET-002', name: 'Gadget', price: 20, stock: 50 },
]);

// Update stock
await storage.upsertByKey('products', [
  { sku: 'WIDGET-001', name: 'Widget', price: 10, stock: 75 },  // Sold 25 units
]);
```

### Pattern 3: Research Papers

```typescript
const storage = createSmallstore({
  adapters: {
    papers: createSheetlogAdapter({
      sheetUrl: process.env.SHEET_URL!,
      sheet: 'Papers',
    }),
  },
  defaultAdapter: 'papers',
});

// Add papers
await storage.upsertByKey('papers', [
  { pmid: '12345', title: 'Attention Is All You Need', year: 2017 },
  { pmid: '67890', title: 'BERT', year: 2018 },
]);

// Get all papers
const papers = await storage.get('papers');

// Query papers from 2017
const papers2017 = papers?.filter(p => p.year === 2017);
```

### Pattern 4: Multiple Sheets

```typescript
const storage = createSmallstore({
  adapters: {
    moviesSheet: createSheetlogAdapter({
      sheetUrl: process.env.SHEET_URL!,
      sheet: 'Movies',
    }),
    booksSheet: createSheetlogAdapter({
      sheetUrl: process.env.SHEET_URL!,
      sheet: 'Books',
    }),
  },
  defaultAdapter: 'moviesSheet',
});

// Configure collections
await storage.setCollectionMetadata('movies', {
  adapter: { type: 'moviesSheet' },
});

await storage.setCollectionMetadata('books', {
  adapter: { type: 'booksSheet' },
});

// Use different sheets
await storage.set('movies', [...]);  // → Movies sheet
await storage.set('books', [...]);   // → Books sheet
```

## Features

### ✅ Auto ID Detection

```typescript
// Auto-detects 'email' as ID (first column)
const users = [
  { email: 'alice@example.com', name: 'Alice', age: 30 },
  { email: 'bob@example.com', name: 'Bob', age: 25 },
];

await storage.upsertByKey('users', users);
// Uses 'email' as unique identifier automatically
```

### ✅ Dynamic Columns

```typescript
// Day 1: Basic fields
await storage.set('users', [
  { email: 'alice@example.com', name: 'Alice' },
]);
// Columns: email, name

// Day 2: Add age field → creates column automatically!
await storage.upsertByKey('users', [
  { email: 'alice@example.com', name: 'Alice', age: 30 },
]);
// Columns: email, name, age (age column created automatically!)
```

### ✅ Merge with Deduplication

```typescript
const existingPapers = await storage.get('papers') || [];
const newPapers = [
  { pmid: '12345', title: 'Paper A' },  // Duplicate
  { pmid: '99999', title: 'Paper B' },  // New
];

await storage.merge('papers', newPapers, {
  strategy: 'id',
  idField: 'pmid',
});
// Only Paper B is added (Paper A is skipped as duplicate)
```

## Environment Variables

```bash
# .env file
SHEET_URL=https://script.google.com/macros/s/.../exec
```

```typescript
// Load in code
import "jsr:@std/dotenv/load";  // For Deno

const storage = createSmallstore({
  adapters: {
    sheetlog: createSheetlogAdapter({
      sheetUrl: Deno.env.get('SHEET_URL')!,
      sheet: 'Demo',
    }),
  },
  defaultAdapter: 'sheetlog',
});
```

## Examples

Run the examples to see Sheetlog in action:

```bash
export SHEET_URL="https://script.google.com/macros/s/.../exec"

# Basic examples
deno run --allow-net --allow-env shared/smallstore/adapters/examples/sheetlog-basic.examples.ts

# Advanced examples
deno run --allow-net --allow-env shared/smallstore/adapters/examples/sheetlog-advanced.examples.ts

# Module integration
deno run --allow-net --allow-env modules/compositions/smallstore/v3/examples/sheetlog-modules.examples.ts
```

## When to Use Sheetlog

### ✅ Perfect For
- **Prototypes and MVPs** - Get up and running in minutes
- **Manual data management** - Edit in Sheets UI
- **Logging and tracking** - Append-only logs
- **Small datasets** - <10k rows
- **Team collaboration** - Share access via Google Sheets

### ❌ Not For
- **High-traffic apps** - Use Upstash or other KV stores
- **Large datasets** - Use Postgres or dedicated DB
- **Low latency** - Sheetlog has ~200-500ms latency
- **Real-time updates** - No webhooks yet

## Troubleshooting

### Error: "Sheetlog request failed"
- Check that `sheetUrl` is correct
- Verify Apps Script is deployed as web app
- Check "Who has access" permissions

### Error: "Could not auto-detect ID field"
- Specify `idField` explicitly:
  ```typescript
  await storage.upsertByKey('collection', data, { idField: 'myId' });
  ```

### Slow performance
- Sheetlog has ~200-500ms latency (normal)
- Consider batching operations
- Use pagination for large datasets

### Columns not created
- Verify using `dynamicPost` (default in adapter)
- Check Sheet permissions (must have write access)

## Next Steps

- 📖 [Full Documentation](./SHEETLOG-INTEGRATION-COMPLETE.md)
- 📝 [Basic Examples](./examples/sheetlog-basic.examples.ts)
- 🚀 [Advanced Examples](./examples/sheetlog-advanced.examples.ts)
- 🎯 [Module Integration](../../modules/compositions/smallstore/v3/examples/sheetlog-modules.examples.ts)
- ⚡ [FunctionFlow Pipelines](../../modules/compositions/smallstore/v3/examples/sheetlog-pipelines.examples.ts) **NEW!**
  - 21 production-ready pipeline examples
  - API workflows, ETL, research, e-commerce, logging
- 🔗 [Sheetlog GitHub](https://github.com/janzheng/sheetlog)

## Support

- Check existing examples for patterns
- Review [SHEETLOG-INTEGRATION-COMPLETE.md](./SHEETLOG-INTEGRATION-COMPLETE.md) for details
- See [Smallstore README](../README.md) for general usage

---

Happy sheeting! 📊✨

