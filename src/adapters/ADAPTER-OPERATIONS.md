# Adapter High-Level Operations

This document describes the high-level, composition-compatible operations available on Smallstore adapters, specifically for structured storage adapters like Notion and Airtable.

## Overview

While all Smallstore adapters implement the core `StorageAdapter` interface (get, set, delete, has, keys, clear), some adapters also support **high-level composition operations** that align with the semantics of their underlying platforms.

These operations are:
- **Type-safe**: Only available on adapters that support them
- **Composition-friendly**: Match the APIs of Smallstore composition functions
- **Error-aware**: Use a standardized error framework to provide helpful feedback

## Two-Layer Architecture

Smallstore has a **two-layer architecture** for operations:

### Layer 1: Adapter Methods (Adapter-Specific)
Methods implemented directly on the adapter class, leveraging native platform features.

### Layer 2: Router Methods (Universal)
Methods implemented in Smallstore's router that work across **all** adapters.

## Operation Support Matrix

| Operation | Where Implemented | Notion | Airtable | Upstash | Memory | R2 | Notes |
|-----------|-------------------|--------|----------|---------|--------|----|-------|
| **Basic CRUD** | | | | | | | |
| `get()` | Adapter | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `set()` | Adapter | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `delete()` | Adapter | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `has()` | Adapter | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `keys()` | Adapter | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| `clear()` | Adapter | ✅ | ✅ | ✅ | ✅ | ✅ | All adapters |
| **High-Level (Adapter)** | | | | | | | |
| `upsert()` | Adapter | ✅ Native | ✅ Native | ❌ | ❌ | ❌ | Platform-specific optimization |
| `insert()` | Adapter | ✅ Native | ✅ Native | ❌ | ❌ | ❌ | Auto-ID detection |
| `merge()` | Adapter | ❌ Error | ❌ Error | ❌ | ❌ | ❌ | Not applicable to record stores |
| `query()` | Adapter | ✅ Native | ✅ Native | ❌ | ❌ | ❌ | Platform-specific filters |
| `list()` | Adapter | ✅ Native | ✅ Native | ❌ | ❌ | ❌ | Platform-specific pagination |
| **High-Level (Router)** | | | | | | | |
| `upsertByKey()` | Router | ✅ | ✅ | ✅ | ✅ | ✅ | Works with all adapters |
| `smallstore/insert` | Composition | ✅ | ✅ | ✅ | ✅ | ✅ | Uses `upsertByKey()` |
| `smallstore/merge` | Composition | ❌ | ❌ | ✅ | ✅ | ✅ | Array deduplication |
| `smallstore/upsert` | Composition | ✅ | ✅ | ✅ | ✅ | ✅ | Wraps `upsertByKey()` |

**Key Insight:**
- ✅ **All operations work with all adapters** through Smallstore's router/composition layer
- ✅ **Notion/Airtable get native optimizations** via adapter-specific implementations
- ❌ **`merge()` throws helpful errors** on Notion/Airtable adapters (use router instead)

### Why This Design?

**Adapter-Native Operations (Notion/Airtable):**
- Leverage platform-specific features (Notion filters, Airtable formulas)
- Better performance (single API call vs multiple `get`/`set`)
- Native pagination and sorting

**Router-Universal Operations:**
- Work consistently across all adapters
- No platform lock-in
- Simpler adapter implementation

### Usage Examples

**Option 1: Use Router (Works Everywhere)**
```typescript
// Works with Memory, Upstash, R2, Notion, Airtable
const storage = createSmallstore({ ... });
await storage.upsertByKey('users', userData, { idField: 'email' });
```

**Option 2: Use Adapter Directly (Notion/Airtable Only)**
```typescript
// Only works with Notion/Airtable - uses native features
const notionAdapter = getAdapter('notion');
await notionAdapter.upsert(userData, { idField: 'email' });
```

---

## Notion Adapter Operations

### `upsert(data, options)`

Upsert objects into a Notion database. Each object becomes a page, keyed by a unique identifier.

**Parameters:**
- `data`: Single object or array of objects to upsert
- `options`:
  - `idField` (string, default: `'id'`): Field to use as the key
  - `keyGenerator` (function): Custom function to generate key from object
  - `ttl` (number): TTL in seconds (not supported by Notion, will warn)

**Returns:** `{ count: number; keys: string[] }`

**Example:**

```typescript
const result = await notionAdapter.upsert(
  [
    { id: '123', name: 'Alice' },
    { id: '456', name: 'Bob' }
  ],
  { idField: 'id' }
);
// { count: 2, keys: ['123', '456'] }
```

---

### `insert(data, options)`

Like `upsert()`, but with smart ID field auto-detection.

**Parameters:**
- `data`: Single object or array of objects
- `options`:
  - `idField` (string): Explicit ID field
  - `keyGenerator` (function): Custom key generator
  - `autoDetect` (boolean, default: `true`): Auto-detect ID field

**Returns:** `{ count: number; keys: string[]; idField?: string }`

**Example:**

```typescript
// Auto-detects 'pmid' as the ID field
const result = await notionAdapter.insert([
  { pmid: '123', title: 'Paper 1' },
  { pmid: '456', title: 'Paper 2' }
]);
// { count: 2, keys: ['123', '456'], idField: 'pmid' }
```

**Auto-detection priority:**
1. Common ID fields: `id`, `_id`, `pmid`, `doi`, `uuid`, `key`, `uid`, `recordId`, `userId`, `email`, `objectId`, `entityId`
2. Checks for uniqueness across first 5 items
3. Falls back to error if no suitable field found

---

### `merge()` - NOT SUPPORTED

Throws `UnsupportedOperationError`:

```typescript
try {
  await notionAdapter.merge('test', [{ foo: 'bar' }]);
} catch (error) {
  // [notion-database] merge: Notion databases store individual pages (records), not arrays. Try insert() or upsert() instead.
}
```

---

### `query(params)`

Query the Notion database using Notion's native filtering and sorting.

**Parameters:**
- `filter`: Notion filter object (see [Notion API docs](https://developers.notion.com/reference/post-database-query-filter))
- `sorts`: Array of sort objects
- `pageSize`: Number of results per page (max 100)
- `startCursor`: Pagination cursor

**Returns:** Array of transformed objects

**Example:**

```typescript
const activeUsers = await notionAdapter.query({
  filter: {
    property: 'Status',
    select: { equals: 'Active' }
  },
  sorts: [
    { property: 'Name', direction: 'ascending' }
  ]
});
```

---

### `list(options)`

List all items in the database with optional pagination.

**Parameters:**
- `limit`: Maximum number of items to return
- `startCursor`: Pagination cursor

**Returns:** Array of transformed objects

**Example:**

```typescript
const first10 = await notionAdapter.list({ limit: 10 });
```

---

## Airtable Adapter Operations

The Airtable adapter supports the same operations as Notion, with minor differences in query syntax.

### `upsert(data, options)`

Same as Notion's `upsert()`.

---

### `insert(data, options)`

Same as Notion's `insert()`.

**Auto-detection priority for Airtable:**
1. Common ID fields: `id`, `_id`, `recordId`, `uuid`, `key`, `uid`, `userId`, `email`, `objectId`, `entityId`

---

### `merge()` - NOT SUPPORTED

Throws `UnsupportedOperationError`:

```typescript
try {
  await airtableAdapter.merge('test', [{ foo: 'bar' }]);
} catch (error) {
  // [airtable] merge: Airtable tables store individual records, not arrays. Try insert() or upsert() instead.
}
```

---

### `query(params)`

Query the Airtable table using Airtable's formula-based filtering.

**Parameters:**
- `filterByFormula`: Airtable formula string (see [Airtable API docs](https://support.airtable.com/hc/en-us/articles/203255215-Formula-field-reference))
- `sort`: Array of `{ field, direction }` objects
- `maxRecords`: Maximum number of records to return
- `pageSize`: Number of records per page
- `offset`: Pagination offset

**Returns:** Array of transformed objects

**Example:**

```typescript
const activeContacts = await airtableAdapter.query({
  filterByFormula: '{Status} = "Active"',
  sort: [{ field: 'Name', direction: 'asc' }]
});
```

---

### `list(options)`

List all items in the table with optional pagination.

**Parameters:**
- `limit`: Maximum number of items to return
- `offset`: Pagination offset (Airtable uses offset strings)

**Returns:** Array of transformed objects

---

## Error Framework

All adapter operations use a standardized error framework for consistent error handling and helpful feedback.

### Error Types

#### `UnsupportedOperationError`

Thrown when an operation is not supported by the adapter.

```typescript
throw new UnsupportedOperationError(
  'notion',
  'merge',
  'Notion databases store individual pages (records), not arrays.',
  'insert() or upsert()'  // Suggested alternative
);
```

**Fields:**
- `adapterName`: Name of the adapter
- `operation`: Operation that was attempted
- `suggestedAlternative`: Recommended operation to use instead

---

#### `ValidationError`

Thrown when input data fails validation.

```typescript
throw new ValidationError(
  'notion',
  'upsert',
  'Missing required field "id" in object',
  { item: {...}, idField: 'id' }
);
```

**Fields:**
- `details`: Additional context about the validation failure

---

#### `UnsupportedDataTypeError`

Thrown when data type is not supported by the adapter.

```typescript
throw new UnsupportedDataTypeError(
  'notion',
  'set',
  'blob',
  'Notion only supports object (structured) data.'
);
```

---

#### `RateLimitError`

Thrown when rate limit is exceeded.

```typescript
throw new RateLimitError(
  'notion',
  'set',
  5,      // requests per second
  1000    // retry after ms (optional)
);
```

---

#### `SizeLimitError`

Thrown when data size exceeds adapter limits.

```typescript
throw new SizeLimitError(
  'upstash',
  'set',
  2 * 1024 * 1024,  // actual size
  1 * 1024 * 1024   // max size
);
```

---

### Error Handling Utilities

```typescript
import {
  isAdapterError,
  isUnsupportedOperation,
  formatAdapterError
} from './adapters/errors.ts';

try {
  await notionAdapter.merge('test', [{ foo: 'bar' }]);
} catch (error) {
  if (isUnsupportedOperation(error)) {
    console.log('💡 Suggestion:', error.suggestedAlternative);
  }
  
  // Pretty-print the error
  console.error(formatAdapterError(error));
}
```

---

## Usage in Composition Modules

The high-level adapter operations can be called directly from composition modules:

```typescript
// Inside a composition module function
export async function storeToNotion(context: FunctionContext) {
  const { collection, data } = context.params;
  
  // Get the Notion adapter for this collection
  const adapter = getAdapterForCollection(collection);
  
  if (adapter instanceof NotionDatabaseAdapter) {
    // Call the high-level operation directly
    const result = await adapter.insert(data, { autoDetect: true });
    return result;
  }
  
  // Fallback to standard Smallstore operation
  await storage.set(collection, data);
}
```

---

## Design Principles

1. **Adapter-Specific Semantics**: Operations match the natural semantics of the underlying platform (e.g., Notion pages, Airtable records).

2. **Fail Loudly with Helpful Errors**: If an operation doesn't make sense for an adapter, throw a clear error with a suggested alternative.

3. **Composition-Friendly**: Match the APIs of Smallstore composition functions (`smallstore/upsert`, `smallstore/insert`, `smallstore/merge`).

4. **Type-Safe**: TypeScript types ensure operations are only called on adapters that support them.

5. **No Silent Fallbacks**: Never silently fall back to a different behavior. Always throw an error or warn the user.

---

## Future Extensions

Potential future operations:
- **`batch()`**: Optimized batch operations for adapters that support them
- **`transaction()`**: Transactional updates (for adapters that support ACID)
- **`subscribe()`**: Real-time updates (for adapters like Firebase, Supabase)
- **`archive()`**: Soft delete (for Notion, Airtable)

---

## See Also

- [Notion Adapter README](./notion.ts)
- [Airtable Adapter README](./airtable.ts)
- [Error Framework](./errors.ts)
- [Phase 3.5 Complete](../PHASE-3.5-COMPLETE.md)

