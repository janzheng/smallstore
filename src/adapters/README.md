# Smallstore Adapters

Storage adapters for Smallstore, providing pluggable backends for different storage systems.

## Available Adapters

### Core Adapters
- **Memory** (`memory.ts`) - In-memory storage (fast, ephemeral)
- **Upstash** (`upstash.ts`) - Redis-compatible KV store (persistent, fast)

### Structured Storage Adapters
- **Notion** (`notion.ts`) - Notion databases (structured, collaborative)
- **Airtable** (`airtable.ts`) - Airtable tables (structured, relational)
- **Sheetlog** (`sheetlog.ts`) - Google Sheets as database (flexible, manual editing)

### Blob Storage Adapters
- **R2** (`r2.ts`) - Cloudflare R2 (blob storage, CDN-ready)
- **F2-R2** (`f2-r2.ts`) - R2 via FuzzyFile service (with metadata tracking)

### Unstorage Integration
- **Unstorage** (`unstorage.ts`) - Access to 20+ unstorage drivers
- **Cloudflare KV** (`cloudflare-kv.ts`) - Via unstorage driver

## Adapter Interface

All adapters implement the `StorageAdapter` interface:

```typescript
interface StorageAdapter {
  readonly capabilities: AdapterCapabilities;
  
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
}
```

## Schema Management (Phase 3.6b-c) 🆕

Notion and Airtable adapters support advanced schema management:

### Zero-Config Setup (Phase 3.6b)
```typescript
// No mappings needed! Schema auto-detected
const adapter = createNotionAdapter({
  databaseId: '...',
  introspectSchema: true  // ✨ Just works!
});
```

### Schema Update Methods (Phase 3.6c)
```typescript
// Refresh schema from platform
await adapter.syncSchema();

// Add/remove/modify mappings
await adapter.updateSchema({
  add: [{ notionProperty: 'Department', sourcePath: 'dept', notionType: 'select' }],
  remove: ['Obsolete Field'],
  modify: { 'Name': { required: true } }
});

// Detect changes
const changes = await adapter.introspectAndUpdate({ mode: 'merge' });
console.log(`Added: ${changes.added.length}, Removed: ${changes.removed.length}`);

// Inspect current schema
const info = adapter.getSchemaInfo();
console.log(`Properties: ${info.propertyCount}`);
```

See:
- `examples/schema-introspection.examples.ts` - Zero-config setup
- `examples/schema-updates.examples.ts` - Runtime updates
- `PHASE-3.6b-COMPLETE.md` - Introspection details
- `PHASE-3.6c-COMPLETE.md` - Update methods details

## High-Level Operations (Structured Adapters)

Notion and Airtable adapters support additional composition-compatible operations:

### `upsert(data, options)` ✅
Insert or update objects by ID field.

```typescript
await notionAdapter.upsert(
  [{ id: '123', name: 'Alice' }, { id: '456', name: 'Bob' }],
  { idField: 'id' }
);
```

### `insert(data, options)` ✅
Smart insert with auto-ID detection.

```typescript
await notionAdapter.insert([
  { pmid: '123', title: 'Paper 1' },
  { pmid: '456', title: 'Paper 2' }
]); // Auto-detects 'pmid'
```

### `merge()` ❌
**NOT SUPPORTED** - Throws helpful error.

Notion and Airtable store individual records, not arrays. Use `insert()` or `upsert()` instead.

### `query(params)` ✅
Native platform queries.

```typescript
// Notion
await notionAdapter.query({
  filter: {
    property: 'Status',
    select: { equals: 'Active' }
  }
});

// Airtable
await airtableAdapter.query({
  filterByFormula: '{Status} = "Active"'
});
```

### `list(options)` ✅
List all items with pagination.

```typescript
const items = await notionAdapter.list({ limit: 10 });
```

## Error Framework

All adapters use a standardized error framework (`errors.ts`):

### Error Types
- `UnsupportedOperationError` - Operation not supported (with suggested alternative)
- `ValidationError` - Input validation failures
- `UnsupportedDataTypeError` - Data type not supported
- `RateLimitError` - Rate limit exceeded
- `SizeLimitError` - Size limit exceeded
- `AdapterConfigError` - Configuration errors

### Example

```typescript
import {
  isUnsupportedOperation,
  formatAdapterError
} from './errors.ts';

try {
  await notionAdapter.merge('test', [{ foo: 'bar' }]);
} catch (error) {
  if (isUnsupportedOperation(error)) {
    console.log('💡 Use:', error.suggestedAlternative);
  }
  console.error(formatAdapterError(error));
}
```

## Operation Support Matrix

### Adapter Methods (Direct Implementation)

| Operation | Notion | Airtable | Upstash | Memory | R2 | F2-R2 | Notes |
|-----------|--------|----------|---------|--------|----|-------|-------|
| **Basic CRUD** |
| `get()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `set()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `delete()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `has()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `keys()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `clear()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| **High-Level Operations** |
| `upsert()` | ✅ Native | ✅ Native | ✅ | ✅ | 🔜 | 🔜 | All adapters! |
| `insert()` | ✅ Native | ✅ Native | ✅ | ✅ | 🔜 | 🔜 | All adapters! |
| `merge()` | ❌ Error | ❌ Error | ✅ | ✅ | 🔜 | 🔜 | Not for records |
| `query()` | ✅ Native | ✅ Native | ✅ Basic | ✅ Basic | 🔜 | 🔜 | Native vs basic filtering |
| `list()` | ✅ Native | ✅ Native | ✅ | ✅ | 🔜 | 🔜 | All adapters! |

**Legend:**
- ✅ **Implemented** - Available on adapter
- ✅ **Native** - Uses platform-specific features (Notion filters, Airtable formulas)
- ✅ **Basic** - Generic implementation (in-memory filtering)
- ❌ **Error** - Throws helpful error (use router instead)
- 🔜 **Coming Soon** - Planned for R2/F2-R2

### Router Methods (Universal - All Adapters)

| Operation | Where | Works With | Notes |
|-----------|-------|------------|-------|
| `storage.upsertByKey()` | Router | All adapters | ID-based upsert |
| `smallstore/insert` | Composition | All adapters | Smart insert with auto-ID |
| `smallstore/upsert` | Composition | All adapters | Wraps `upsertByKey()` |
| `smallstore/merge` | Composition | Memory, Upstash, R2, F2-R2 | Array deduplication |
| `smallstore/inspect` | Composition | All adapters | Browse collections |

**Key Point:** All high-level operations work with **all adapters** through the router. Notion/Airtable get additional native implementations for better performance.

## Capabilities

Each adapter declares its capabilities:

```typescript
interface AdapterCapabilities {
  name: string;
  supportedTypes: DataType[];  // 'object', 'blob', 'kv'
  maxItemSize?: number;        // Bytes, undefined = unlimited
  cost?: {
    tier: 'free' | 'cheap' | 'moderate' | 'expensive';
    perOperation?: string;
    perGB?: string;
  };
  performance?: {
    readLatency: 'low' | 'medium' | 'high';
    writeLatency: 'low' | 'medium' | 'high';
    throughput: 'low' | 'medium' | 'high';
  };
  features?: {
    query?: boolean;     // Supports advanced queries
    ttl?: boolean;       // Supports TTL
    atomic?: boolean;    // Supports atomic operations
  };
}
```

## Creating a Custom Adapter

To create a custom adapter:

1. **Implement the `StorageAdapter` interface**
2. **Declare capabilities**
3. **Handle CRUD operations**
4. **Use the error framework**

Example:

```typescript
import type { StorageAdapter, AdapterCapabilities } from './adapter.ts';
import { throwUnsupportedOperation } from './errors.ts';

export class MyCustomAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'my-custom-adapter',
    supportedTypes: ['object', 'kv'],
    maxItemSize: 10 * 1024 * 1024, // 10MB
    cost: {
      tier: 'cheap',
      perOperation: '$0.0001 per 1000 ops'
    },
    performance: {
      readLatency: 'low',
      writeLatency: 'low',
      throughput: 'high'
    }
  };
  
  async get(key: string): Promise<any> {
    // Implementation
  }
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    // Implementation
  }
  
  // ... other methods
}
```

## Examples

See the `examples/` directory for usage examples:
- `notion-operations.examples.ts` - Notion adapter operations
- `airtable-operations.examples.ts` - Airtable adapter operations

## Sheetlog Adapter (Google Sheets as Database) 📊

The **Sheetlog adapter** turns Google Sheets into a database via Apps Script proxy.

### Key Features
- ✅ **Hybrid storage**: Sheet as array OR per-row upserts
- ✅ **Auto ID detection**: First column/key automatically detected
- ✅ **Dynamic schema**: Columns created automatically
- ✅ **Manual editing**: Edit directly in Sheets UI (no drift!)
- ✅ **Free**: Within Google API limits
- ⚠️ **High latency**: ~200-500ms via Apps Script
- ⚠️ **Rate limited**: Google Sheets API constraints

### Quick Start

```typescript
import { createSheetlogAdapter } from './sheetlog.ts';

const adapter = createSheetlogAdapter({
  sheetUrl: "https://script.google.com/macros/s/.../exec",
  sheet: "Movies",  // Sheet tab name
});

// Store array (default pattern)
const movies = [
  { title: 'Inception', year: 2010, rating: 8.8 },
  { title: 'Interstellar', year: 2014, rating: 8.6 },
];
await adapter.set('movies', movies);

// Retrieve entire sheet
const all = await adapter.get('movies');

// Upsert individual rows (auto-detects 'title' as ID)
await adapter.upsert([
  { title: 'Inception', year: 2010, rating: 8.9 },  // Updates
], { idField: 'title' });
```

### Setup Instructions

1. **Deploy Sheetlog Apps Script** to your Google Sheet
   - See [Sheetlog GitHub](https://github.com/janzheng/sheetlog)
   - Copy `sheetlog.js` to Apps Script editor
   - Deploy as web app
   - Get deployment URL

2. **Create Smallstore adapter**
   ```typescript
   const adapter = createSheetlogAdapter({
     sheetUrl: "YOUR_DEPLOYMENT_URL",
     sheet: "YOUR_SHEET_NAME",
   });
   ```

3. **Use with Smallstore**
   ```typescript
   const storage = createSmallstore({
     adapters: {
       sheetlog: adapter,
     },
     defaultAdapter: 'sheetlog',
   });
   ```

### Examples

- [Basic Usage](./examples/sheetlog-basic.examples.ts) - CRUD, auto ID, pagination
- [Advanced Patterns](./examples/sheetlog-advanced.examples.ts) - Batch upsert, dynamic columns, multi-sheet
- [Module Integration](../../modules/compositions/smallstore/v3/examples/sheetlog-modules.examples.ts) - Workflow patterns

### Use Cases

✅ **Perfect for:**
- Logging and tracking
- Manual data curation
- Prototypes and MVPs
- Small datasets (<10k rows)
- Team collaboration (shared Sheet access)

❌ **Not for:**
- High-traffic applications
- Large datasets (>10k rows)
- Low-latency requirements (<100ms)
- Complex queries (use in-memory filtering)

---

## Documentation

- [Adapter Operations](./ADAPTER-OPERATIONS.md) - Comprehensive guide to high-level operations
- [Error Framework](./errors.ts) - Error types and utilities
- [Phase 3.5 Complete](../PHASE-3.5-COMPLETE.md) - Smart upsert and adapter operations

## See Also

- [Smallstore Main README](../README.md)
- [Universal Storage Architecture](../UNIVERSAL-STORAGE-ARCHITECTURE.md)
- [Phase 3 Complete](../PHASE-3-COMPLETE.md) - Persistent metadata and multi-adapter routing

