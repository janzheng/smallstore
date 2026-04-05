# Adapter Shortcuts: One-Line Setup 🚀

**The Problem**: Setting up Notion/Airtable/R2 adapters requires configuration, environment variables, and knowing which adapter to use.

**The Solution**: Just paste your database ID/base ID into collection metadata. Done!

---

## 🎯 Quick Start

### Notion Database

```typescript
// Just paste your Notion database ID (any format works!)
await storage.setCollectionMetadata('research/papers', {
  adapter: {
    type: 'notion',
    location: '8aec500b9c8f4bd28411da2680848f65'
  }
});

// Now insert - adapter auto-selected!
await storage.insert('research/papers', { title: 'New Paper' });
```

### Airtable Base

```typescript
await storage.setCollectionMetadata('contacts/customers', {
  adapter: {
    type: 'airtable',
    location: 'appXYZ123',
    table: 'Customers'
  }
});

await storage.insert('contacts/customers', { Name: 'John' });
```

### R2 Bucket

```typescript
await storage.setCollectionMetadata('files/images', {
  adapter: {
    type: 'r2',
    location: 'my-bucket'
  }
});

await storage.set('files/images/photo.jpg', imageBlob);
```

---

## 📖 Supported Adapters

### Notion

**Config**:
```typescript
{
  type: 'notion',
  location: '<database-id>'  // Any format works!
}
```

**Supported Location Formats**:
- `8aec500b9c8f4bd28411da2680848f65` (clean ID)
- `8aec500b-9c8f-4bd2-8411-da2680848f65` (with dashes)
- `https://notion.so/8aec500b9c8f4bd28411da2680848f65` (full URL)
- `https://phagedirectory.notion.site/8aec500b9c8f4bd28411da2680848f65?v=...` (URL with params)

**Auto-Cleaning**: Notion IDs are automatically cleaned by `NotionModernClient` - just paste!

### Airtable

**Config**:
```typescript
{
  type: 'airtable',
  location: '<base-id>',     // appXYZ123
  table: '<table-name>',     // Required
  view: '<view-name>'        // Optional
}
```

**Example**:
```typescript
{
  type: 'airtable',
  location: 'appABC123',
  table: 'Customers',
  view: 'All Customers'  // Optional
}
```

### R2 (Direct)

**Config**:
```typescript
{
  type: 'r2',
  location: '<bucket-name>'
}
```

**Example**:
```typescript
{
  type: 'r2',
  location: 'filofax'  // Your R2 bucket
}
```

### F2 (Fuzzyfile + R2)

**Config**:
```typescript
{
  type: 'f2',
  location: '<bucket-name>'  // Optional, defaults to env
}
```

**Example**:
```typescript
{
  type: 'f2',
  location: 'filofax'
}
```

### Memory

**Config**:
```typescript
{
  type: 'memory'
  // No location needed
}
```

### Upstash

**Config**:
```typescript
{
  type: 'upstash'
  // Uses env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
}
```

---

## 🔄 How It Works

### Routing Priority

When you call `storage.set()` or `storage.insert()`, Smallstore routes data using this priority:

1. **Explicit `adapter` option** (highest priority)
   ```typescript
   await storage.insert('collection', data, { adapter: 'notion' });
   ```

2. **Collection metadata adapter config** ⭐ **NEW!**
   ```typescript
   // Collection has adapter.type = 'notion' in metadata
   await storage.insert('collection', data);  // Auto-routes to Notion!
   ```

3. **Type-based routing**
   ```typescript
   // Config: typeRouting: { blob: 'r2' }
   await storage.set('collection', imageBlob);  // Auto-routes to R2
   ```

4. **Pattern-based routing**
   ```typescript
   // Config: routing: { 'cache:*': { adapter: 'upstash' } }
   await storage.set('cache:users', data);  // Auto-routes to Upstash
   ```

5. **Smart routing** (if enabled)
6. **Default adapter** (lowest priority)

### Auto-Detection

Smallstore automatically:
- ✅ Cleans Notion IDs (strips dashes, extracts from URLs)
- ✅ Validates adapter exists in config
- ✅ Falls back gracefully if adapter not available
- ✅ Logs which adapter was selected

---

## 🎬 Complete Examples

### Example 1: Fetch from API → Store in Notion

```typescript
{
  flow: [
    // Step 1: Configure collection to use Notion
    {
      module: "smallstore/setMetadata",
      input: {
        collection: "research/papers",
        metadata: {
          adapter: {
            type: "notion",
            location: "8aec500b9c8f4bd28411da2680848f65"
          }
        }
      }
    },
    
    // Step 2: Fetch from API
    {
      module: "http/get",
      input: {
        url: "https://api.example.com/papers"
      }
    },
    
    // Step 3: Insert into Notion (automatic!)
    {
      module: "smallstore/insert",
      input: {
        collection: "research/papers",
        data: "$step2.results"
        // No adapter specified - uses collection metadata!
      }
    }
  ]
}
```

### Example 2: CSV → Airtable

```typescript
{
  flow: [
    // Setup Airtable
    {
      module: "smallstore/setMetadata",
      input: {
        collection: "contacts/customers",
        metadata: {
          adapter: {
            type: "airtable",
            location: "appXYZ123",
            table: "Customers"
          }
        }
      }
    },
    
    // Parse CSV
    {
      module: "util/parseCsv",
      input: { csv: "$input.csvData" }
    },
    
    // Insert into Airtable (automatic!)
    {
      module: "smallstore/insert",
      input: {
        collection: "contacts/customers",
        data: "$step2.rows"
      }
    }
  ]
}
```

### Example 3: Multiple Collections, One Namespace

```typescript
// Setup multiple Notion databases under "research/"
await storage.setCollectionMetadata('research/papers', {
  adapter: { type: 'notion', location: 'database-id-1' }
});

await storage.setCollectionMetadata('research/notes', {
  adapter: { type: 'notion', location: 'database-id-2' }
});

// Each collection auto-routes to its database
await storage.insert('research/papers', { title: 'Paper 1' });  // → database-id-1
await storage.insert('research/notes', { content: 'Note 1' });   // → database-id-2
```

### Example 4: Override Adapter (Explicit Priority)

```typescript
// Collection is configured for Notion
await storage.setCollectionMetadata('data/mixed', {
  adapter: { type: 'notion', location: 'abc123' }
});

// But you can override per-call
await storage.insert('data/mixed', structuredData);  // → Goes to Notion
await storage.set('data/mixed/large.bin', blob, { adapter: 'r2' });  // → Override to R2
```

---

## 🧪 Testing

```typescript
// Test Notion connection
await storage.setCollectionMetadata('test/notion', {
  adapter: {
    type: 'notion',
    location: 'your-database-id'
  }
});

await storage.insert('test/notion', { title: 'Test', year: 2025 });

// Check if it worked
const metadata = await storage.getCollectionMetadata('test/notion');
console.log(metadata.adapter);  // { type: 'notion', location: '...' }

const items = await storage.query('test/notion');
console.log(items);  // Should show your test item
```

---

## 💡 Pro Tips

### 1. **Combine with Folder Prompts**

```typescript
await storage.setCollectionMetadata('research/papers', {
  // Adapter config
  adapter: {
    type: 'notion',
    location: '8aec500b9c8f4bd28411da2680848f65'
  },
  
  // Workflow context
  name: 'Research Papers',
  prompt: 'Focus on AI agents and agentic workflows',
  tags: ['ai', 'research']
});
```

### 2. **Use in Cron Jobs**

```typescript
// Scheduled sync: External API → Notion
{
  flow: [
    { module: "http/get", input: { url: "https://api.example.com/data" } },
    { module: "smallstore/insert", input: {
      collection: "sync/external-data",
      data: "$step1.results"
    }},
    { module: "smallstore/setMetadata", input: {
      collection: "sync/external-data",
      metadata: {
        last_sync: "$now",
        item_count: "$step1.results.length"
      }
    }}
  ]
}
```

### 3. **Dynamic Adapter Selection**

```typescript
// Choose adapter based on data type
const adapter = dataType === 'structured' ? 'notion' : 'r2';

await storage.setCollectionMetadata('data/mixed', {
  adapter: { type: adapter, location: 'your-id' }
});
```

### 4. **Inspect Adapter Config**

```typescript
// Get collection metadata to see which adapter is configured
const metadata = await storage.getCollectionMetadata('research/papers');
console.log(metadata.adapter);
// → { type: 'notion', location: '8aec500b9c8f4bd28411da2680848f65' }
```

---

## 📚 Documentation

- [Collection Metadata Guide](./COLLECTION-METADATA.md) - Full metadata documentation
- [Notion/Airtable Examples](./modules/compositions/smallstore/v3/examples/notion-airtable-storage.examples.ts) - 14 real-world examples
- [README](./README.md) - Main Smallstore docs

---

**"Configuration as metadata, not code."** 🏷️

With adapter shortcuts, setting up complex storage is as easy as pasting an ID. No config files, no routing rules, just works! 🚀

