# Smallstore Adapter Architecture

## Two-Layer Design

Smallstore uses a **two-layer architecture** for storage operations:

```
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Router & Composition (Universal)              │
│  - upsertByKey(), insert(), merge()                     │
│  - Works with ALL adapters                              │
│  - Implemented once, runs everywhere                    │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Adapters (Platform-Specific)                  │
│  - get(), set(), delete(), has(), keys(), clear()       │
│  - Optional: upsert(), insert(), query(), list()        │
│  - Platform-specific optimizations                      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Storage Backends                                        │
│  Memory | Upstash | R2 | Notion | Airtable              │
└─────────────────────────────────────────────────────────┘
```

## Layer 1: Adapters

### Required Methods (All Adapters)

Every adapter MUST implement the `StorageAdapter` interface:

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

These 6 methods are the **minimum contract** for a Smallstore adapter.

### Optional Methods (Platform-Specific)

Some adapters implement **additional methods** that leverage native platform features:

**Notion & Airtable:**
- `upsert(data, options)` - Native insert/update by ID
- `insert(data, options)` - Smart insert with auto-ID detection
- `merge()` - Throws error (not applicable to record-based storage)
- `query(params)` - Native platform queries (Notion filters, Airtable formulas)
- `list(options)` - Native pagination

**Why?**
- **Performance**: Single API call instead of multiple `get`/`set`
- **Features**: Access to native filters, sorts, pagination
- **Semantics**: Operations that match the platform's data model

## Layer 2: Router & Composition

### Router Methods (Core Smallstore)

The router provides **universal operations** that work with **any adapter**:

```typescript
class SmallstoreRouter {
  // Phase 3.5: Smart upsert
  async upsertByKey(
    collection: string,
    data: any | any[],
    options?: { idField?: string; keyGenerator?: (obj: any) => string }
  ): Promise<void>;
  
  // Phase 2: Set with modes
  async set(
    collectionPath: string,
    data: any,
    options?: { mode?: 'overwrite' | 'append' | 'merge' }
  ): Promise<void>;
  
  // ... other methods
}
```

### Composition Functions

High-level, pipeline-ready functions in `modules/compositions/smallstore`:

- `smallstore/insert` - Universal smart insert (uses `upsertByKey`)
- `smallstore/upsert` - Universal upsert (wraps `upsertByKey`)
- `smallstore/merge` - Array deduplication (works with KV adapters)
- `smallstore/inspect` - Browse collections
- `smallstore/search` - BM25 search

## When to Use What?

### Use Router Methods When:
- ✅ You want **adapter-agnostic** code
- ✅ You're working with **any adapter** (Memory, Upstash, R2, etc.)
- ✅ You need **consistent behavior** across platforms
- ✅ You're building **reusable modules**

```typescript
// Works with ALL adapters
const storage = createSmallstore({ ... });
await storage.upsertByKey('users', userData, { idField: 'email' });
```

### Use Adapter Methods When:
- ✅ You need **platform-specific features** (Notion filters, Airtable formulas)
- ✅ You want **maximum performance** (single API call)
- ✅ You're **locked to one adapter** (e.g., Notion-specific app)
- ✅ You need **native pagination** or sorting

```typescript
// Notion-specific, uses native query API
const notionAdapter = storage.getAdapter('notion') as NotionDatabaseAdapter;
const results = await notionAdapter.query({
  filter: {
    property: 'Status',
    select: { equals: 'Active' }
  }
});
```

## Example: `upsert` Operation

### Via Router (Universal)

```typescript
// Works with Memory, Upstash, R2, Notion, Airtable
const storage = createSmallstore({
  adapters: {
    'memory': createMemoryAdapter(),
    'upstash': createUpstashAdapter({ ... }),
    'notion': createNotionAdapter({ ... })
  }
});

// Same code, any adapter
await storage.upsertByKey('users', [
  { id: '1', name: 'Alice' },
  { id: '2', name: 'Bob' }
], { idField: 'id' });
```

**How it works:**
1. Router extracts ID from each object (`idField: 'id'`)
2. Constructs keys: `users/1`, `users/2`
3. Calls adapter's `set()` for each key
4. Works identically regardless of adapter

### Via Adapter (Notion-Native)

```typescript
// Notion-specific, uses native Notion API
const notionAdapter = createNotionAdapter({
  databaseId: '...',
  mappings: [...]
});

await notionAdapter.upsert([
  { id: '1', name: 'Alice' },
  { id: '2', name: 'Bob' }
], { idField: 'id' });
```

**How it works:**
1. Notion adapter transforms objects to Notion properties
2. Uses Notion's `pages.create` or `pages.update` API
3. Single batched API call (if Notion supports batching)
4. Leverages Notion-specific features (property types, relations, etc.)

## Why This Design?

### Flexibility
- Simple adapters only need 6 methods
- Complex adapters can add native optimizations
- No breaking changes when adding features

### Performance
- Router provides "good enough" performance for all adapters
- Native implementations can be 10-100x faster for specific operations
- Developers choose the tradeoff

### Portability
- Code using router methods is **adapter-agnostic**
- Easy to swap backends (Memory → Upstash → R2)
- No vendor lock-in

### Best of Both Worlds
- Use router for **flexibility**
- Use adapters for **performance**
- Mix and match as needed

## Adding Operations to Adapters

### Should I add this to the adapter?

Ask:
1. **Does the platform have a native feature for this?** (Yes → Adapter)
2. **Is there a significant performance benefit?** (Yes → Adapter)
3. **Does it work differently than the router?** (Yes → Adapter)

If all answers are "No", implement in the router instead.

### Example: `query()`

**Notion/Airtable**: ✅ Add to adapter
- Native filter/sort APIs
- 10-100x faster than `keys() + filter in memory`
- Platform-specific syntax

**Memory/Upstash**: ❌ Don't add to adapter
- No native query features
- Router can do `keys() + get() + filter`
- No performance benefit

### Example: `upsert()`

**Notion/Airtable**: ✅ Add to adapter
- Native "create or update page" semantics
- Handles schema mapping automatically
- Better error messages

**Memory/Upstash**: ❌ Don't add to adapter
- Just `set()` with a key
- Router's `upsertByKey()` already does this
- No additional value

## Summary

| Aspect | Router (Layer 2) | Adapters (Layer 1) |
|--------|------------------|---------------------|
| **Scope** | Universal | Platform-specific |
| **Implementation** | Once | Per adapter |
| **Performance** | Good | Best (when native) |
| **Portability** | High | Low |
| **Complexity** | Higher-level | Lower-level |
| **Example** | `upsertByKey()`, `insert()` | `get()`, `set()`, `query()` |

**Bottom Line**: Router for flexibility, Adapters for performance. Use both!

