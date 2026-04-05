# Smallstore Adapter Implementation Guide

This guide explains how to create custom adapters for Smallstore, including adapters for structured data sources like Airtable, Notion Databases, and Google Sheets.

## Table of Contents

1. [Core Adapter Interface](#core-adapter-interface)
2. [Adapter Capabilities](#adapter-capabilities)
3. [Type Mapping System](#type-mapping-system)
4. [Structured Data Adapters](#structured-data-adapters)
5. [Implementation Patterns](#implementation-patterns)
6. [Testing Your Adapter](#testing-your-adapter)

---

## Core Adapter Interface

Every Smallstore adapter must implement the `StorageAdapter` interface:

```typescript
interface StorageAdapter {
  // Adapter metadata
  readonly capabilities: AdapterCapabilities;
  
  // CRUD operations
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  
  // Listing operations (Phase 3: Required for metadata reconstruction)
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
}
```

### Required Operations

| Operation | Description | Must Handle |
|-----------|-------------|-------------|
| `get(key)` | Retrieve data by key | Return `null` if not found |
| `set(key, value, ttl?)` | Store data | Support optional TTL |
| `delete(key)` | Remove data | Succeed even if key doesn't exist |
| `has(key)` | Check existence | Return boolean |
| `keys(prefix?)` | List all keys (with optional prefix) | Return empty array if none found |
| `clear(prefix?)` | Delete all keys (with optional prefix) | Support prefix filtering |

---

## Adapter Capabilities

Adapters declare their capabilities to help Smallstore route data appropriately:

```typescript
interface AdapterCapabilities {
  /** Unique adapter name */
  name: string;
  
  /** Which data types can this adapter handle? */
  supportedTypes: DataType[];  // 'object' | 'blob' | 'kv'
  
  /** Maximum item size in bytes (undefined = unlimited) */
  maxItemSize?: number;
  
  /** Maximum total storage in bytes (undefined = unlimited) */
  maxTotalSize?: number;
  
  /** Cost characteristics */
  cost?: {
    perGB?: string;
    perOperation?: string;
    tier: 'free' | 'cheap' | 'moderate' | 'expensive';
  };
  
  /** Performance characteristics */
  performance?: {
    readLatency: 'low' | 'medium' | 'high';
    writeLatency: 'low' | 'medium' | 'high';
    throughput: 'low' | 'medium' | 'high';
  };
  
  /** Special features */
  features?: {
    ttl?: boolean;
    transactions?: boolean;
    query?: boolean;
    search?: boolean;
    vectorSearch?: boolean;
  };
}
```

### Example: Basic Memory Adapter Capabilities

```typescript
readonly capabilities: AdapterCapabilities = {
  name: 'memory',
  supportedTypes: ['object', 'blob', 'kv'],  // Supports everything
  maxItemSize: undefined,  // No size limit
  maxTotalSize: undefined,  // No total limit
  cost: {
    tier: 'free',
  },
  performance: {
    readLatency: 'low',
    writeLatency: 'low',
    throughput: 'high',
  },
  features: {
    ttl: true,  // Supports TTL
  },
};
```

---

## Type Mapping System

Smallstore uses a **3-type system**:

| Smallstore Type | Description | Maps To |
|-----------------|-------------|---------|
| `object` | JSON-serializable data (objects, arrays, nested) | Most structured stores |
| `blob` | Binary data (images, PDFs, large text) | File storage, CDNs |
| `kv` | Primitives (string, number, boolean, null) | Simple key-value |

### Type Detection

Smallstore automatically detects types based on data characteristics:

```typescript
// Type detection logic (from analyzeData in router.ts)
function detectType(data: any): DataType {
  // Blob: ArrayBuffer, Uint8Array, Blob, File
  if (data instanceof ArrayBuffer || data instanceof Uint8Array ||
      data instanceof Blob || (typeof File !== 'undefined' && data instanceof File)) {
    return 'blob';
  }
  
  // KV: Primitives (string, number, boolean, null)
  if (data === null || 
      typeof data === 'string' || 
      typeof data === 'number' || 
      typeof data === 'boolean') {
    return 'kv';
  }
  
  // Object: Everything else (objects, arrays, nested structures)
  return 'object';
}
```

### Adapter Type Support

Declare what your adapter can handle:

```typescript
// Simple key-value store (Redis, Memcached)
supportedTypes: ['kv', 'object']  // No blobs

// Object storage (S3, R2)
supportedTypes: ['blob', 'object']  // Everything

// Document database (MongoDB, Firestore)
supportedTypes: ['object']  // Only structured data

// Relational database (PostgreSQL, MySQL)
supportedTypes: ['object']  // Structured data only
```

---

## Structured Data Adapters

Structured data sources like Airtable, Notion, and Google Sheets require **schema mapping** and **field transformation**.

### The Challenge

```typescript
// What Smallstore stores (schemaless)
await storage.set('users/alice', {
  name: 'Alice',
  age: 30,
  tags: ['developer', 'designer'],
  metadata: { created: '2025-01-01' }
});

// What Notion/Airtable expects (structured schema)
{
  properties: {
    Name: { title: [{ text: { content: 'Alice' } }] },
    Age: { number: 30 },
    Tags: { multi_select: [{ name: 'developer' }, { name: 'designer' }] },
    Created: { date: { start: '2025-01-01' } }
  }
}
```

### Solution: Schema Mapping Layer

Create a **mapping configuration** that bridges Smallstore data to your structured store:

```typescript
interface SchemaMapping {
  /** Target field name in structured store */
  targetField: string;
  
  /** Source field path in Smallstore data (dot notation) */
  sourcePath: string;
  
  /** Target field type in structured store */
  targetType: string;
  
  /** Optional transformation function */
  transform?: (value: any) => any;
  
  /** Is this field required? */
  required?: boolean;
  
  /** Default value if source is missing */
  defaultValue?: any;
}

interface StructuredAdapterConfig {
  /** Schema mappings for this adapter */
  mappings: SchemaMapping[];
  
  /** How to handle unmapped fields */
  unmappedStrategy: 'ignore' | 'error' | 'store-as-json';
  
  /** Primary key field (for identifying records) */
  primaryKey?: string;
}
```

### Example: Notion Database Adapter

```typescript
class NotionDatabaseAdapter implements StorageAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: 'notion-database',
    supportedTypes: ['object'],  // Only structured data
    maxItemSize: 2000,  // Notion's limit per property
    cost: { tier: 'free' },
    performance: {
      readLatency: 'medium',
      writeLatency: 'medium',
      throughput: 'low',
    },
    features: {
      query: true,  // Notion supports queries
    },
  };
  
  private client: any;  // Notion SDK client
  private databaseId: string;
  private mappings: SchemaMapping[];
  
  constructor(config: {
    databaseId: string;
    apiKey: string;
    mappings: SchemaMapping[];
  }) {
    this.databaseId = config.databaseId;
    this.mappings = config.mappings;
    // Initialize Notion client...
  }
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    // Transform Smallstore data → Notion properties
    const properties = this.transformToNotion(value);
    
    // Check if record exists (using key as title or custom field)
    const existing = await this.findByKey(key);
    
    if (existing) {
      // Update existing page
      await this.client.pages.update({
        page_id: existing.id,
        properties,
      });
    } else {
      // Create new page
      await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties: {
          ...properties,
          _smallstore_key: { rich_text: [{ text: { content: key } }] },
        },
      });
    }
  }
  
  async get(key: string): Promise<any> {
    const page = await this.findByKey(key);
    if (!page) return null;
    
    // Transform Notion properties → Smallstore data
    return this.transformFromNotion(page.properties);
  }
  
  async delete(key: string): Promise<void> {
    const page = await this.findByKey(key);
    if (!page) return;
    
    // Archive page (Notion doesn't support hard delete)
    await this.client.pages.update({
      page_id: page.id,
      archived: true,
    });
  }
  
  async has(key: string): Promise<boolean> {
    const page = await this.findByKey(key);
    return !!page;
  }
  
  async keys(prefix?: string): Promise<string[]> {
    // Query database for all pages
    const response = await this.client.databases.query({
      database_id: this.databaseId,
    });
    
    // Extract keys from _smallstore_key field
    const keys = response.results
      .map((page: any) => this.extractKey(page))
      .filter((key: string | null) => key !== null)
      .filter((key: string) => !prefix || key.startsWith(prefix));
    
    return keys;
  }
  
  async clear(prefix?: string): Promise<void> {
    const keys = await this.keys(prefix);
    await Promise.all(keys.map(key => this.delete(key)));
  }
  
  // ============================================================================
  // Schema Mapping Helpers
  // ============================================================================
  
  private transformToNotion(data: any): any {
    const properties: any = {};
    
    for (const mapping of this.mappings) {
      // Extract value from source data using dot notation
      const value = this.getValueByPath(data, mapping.sourcePath);
      
      if (value === undefined) {
        if (mapping.required) {
          throw new Error(`Required field "${mapping.sourcePath}" is missing`);
        }
        continue;
      }
      
      // Transform value to Notion property format
      const transformed = mapping.transform 
        ? mapping.transform(value) 
        : this.autoTransformToNotion(value, mapping.targetType);
      
      properties[mapping.targetField] = transformed;
    }
    
    return properties;
  }
  
  private transformFromNotion(properties: any): any {
    const data: any = {};
    
    for (const mapping of this.mappings) {
      const notionValue = properties[mapping.targetField];
      if (!notionValue) continue;
      
      // Extract value from Notion property
      const value = this.extractNotionValue(notionValue, mapping.targetType);
      
      // Set value using dot notation path
      this.setValueByPath(data, mapping.sourcePath, value);
    }
    
    return data;
  }
  
  private autoTransformToNotion(value: any, targetType: string): any {
    // Auto-transform based on Notion property type
    switch (targetType) {
      case 'title':
      case 'rich_text':
        return { rich_text: [{ text: { content: String(value) } }] };
      
      case 'number':
        return { number: Number(value) };
      
      case 'checkbox':
        return { checkbox: Boolean(value) };
      
      case 'select':
        return { select: { name: String(value) } };
      
      case 'multi_select':
        const items = Array.isArray(value) ? value : [value];
        return { multi_select: items.map(v => ({ name: String(v) })) };
      
      case 'date':
        return { date: { start: String(value) } };
      
      case 'url':
        return { url: String(value) };
      
      case 'email':
        return { email: String(value) };
      
      case 'phone_number':
        return { phone_number: String(value) };
      
      default:
        throw new Error(`Unsupported Notion type: ${targetType}`);
    }
  }
  
  private extractNotionValue(property: any, targetType: string): any {
    // Extract value from Notion property based on type
    switch (targetType) {
      case 'title':
        return property.title?.[0]?.text?.content || '';
      
      case 'rich_text':
        return property.rich_text?.[0]?.text?.content || '';
      
      case 'number':
        return property.number;
      
      case 'checkbox':
        return property.checkbox;
      
      case 'select':
        return property.select?.name;
      
      case 'multi_select':
        return property.multi_select?.map((item: any) => item.name) || [];
      
      case 'date':
        return property.date?.start;
      
      case 'url':
        return property.url;
      
      case 'email':
        return property.email;
      
      case 'phone_number':
        return property.phone_number;
      
      default:
        return null;
    }
  }
  
  // Helper: Get nested value using dot notation
  private getValueByPath(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  // Helper: Set nested value using dot notation
  private setValueByPath(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
      if (!(key in current)) current[key] = {};
      return current[key];
    }, obj);
    target[lastKey] = value;
  }
  
  // Helper: Find page by Smallstore key
  private async findByKey(key: string): Promise<any> {
    const response = await this.client.databases.query({
      database_id: this.databaseId,
      filter: {
        property: '_smallstore_key',
        rich_text: { equals: key },
      },
    });
    
    return response.results[0] || null;
  }
  
  // Helper: Extract key from page
  private extractKey(page: any): string | null {
    return page.properties._smallstore_key?.rich_text?.[0]?.text?.content || null;
  }
}

// ============================================================================
// Usage Example
// ============================================================================

const notionAdapter = new NotionDatabaseAdapter({
  databaseId: 'your-database-id',
  apiKey: Deno.env.get('NOTION_API_KEY')!,
  mappings: [
    {
      targetField: 'Name',
      sourcePath: 'name',
      targetType: 'title',
      required: true,
    },
    {
      targetField: 'Age',
      sourcePath: 'age',
      targetType: 'number',
    },
    {
      targetField: 'Tags',
      sourcePath: 'tags',
      targetType: 'multi_select',
    },
    {
      targetField: 'Email',
      sourcePath: 'contact.email',  // Nested path!
      targetType: 'email',
    },
    {
      targetField: 'Created',
      sourcePath: 'metadata.created',
      targetType: 'date',
    },
  ],
});

const storage = createSmallstore({
  adapters: {
    notion: notionAdapter,
  },
  defaultAdapter: 'notion',
});

// Use Smallstore's simple API
await storage.set('users/alice', {
  name: 'Alice',
  age: 30,
  tags: ['developer', 'designer'],
  contact: { email: 'alice@example.com' },
  metadata: { created: '2025-01-01' },
});

// Data is automatically transformed and stored in Notion!
```

---

## Implementation Patterns

### Pattern 1: Simple Key-Value Store (Redis, Memcached)

**Characteristics:**
- Direct key-value mapping
- No schema required
- Fast operations

```typescript
class RedisAdapter implements StorageAdapter {
  readonly capabilities = {
    name: 'redis',
    supportedTypes: ['kv', 'object'],
    maxItemSize: 512 * 1024 * 1024,  // 512MB
    // ...
  };
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttl) {
      await this.client.setex(key, ttl, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }
  
  async get(key: string): Promise<any> {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
  }
  
  // ... other methods
}
```

### Pattern 2: Object Storage (S3, R2)

**Characteristics:**
- Binary-friendly
- Large file support
- Key = object path

```typescript
class S3Adapter implements StorageAdapter {
  readonly capabilities = {
    name: 's3',
    supportedTypes: ['blob', 'object'],
    maxItemSize: 5 * 1024 * 1024 * 1024,  // 5GB
    // ...
  };
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const body = value instanceof Uint8Array 
      ? value 
      : new TextEncoder().encode(JSON.stringify(value));
    
    await this.client.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      // Add metadata for TTL if needed
      Metadata: ttl ? { expires: String(Date.now() + ttl * 1000) } : {},
    });
  }
  
  async get(key: string): Promise<any> {
    try {
      const response = await this.client.getObject({
        Bucket: this.bucket,
        Key: key,
      });
      
      // Check TTL from metadata
      if (this.isExpired(response.Metadata)) {
        await this.delete(key);
        return null;
      }
      
      // Return body (handle both binary and JSON)
      const body = await response.Body.transformToByteArray();
      
      // Try to parse as JSON
      try {
        const text = new TextDecoder().decode(body);
        return JSON.parse(text);
      } catch {
        return body;  // Return as binary
      }
    } catch (error) {
      if (error.Code === 'NoSuchKey') return null;
      throw error;
    }
  }
  
  // ... other methods
}
```

### Pattern 3: Table-Based Store (Airtable, Google Sheets)

**Characteristics:**
- Row = record
- Columns = fields
- Schema required

```typescript
class AirtableAdapter implements StorageAdapter {
  readonly capabilities = {
    name: 'airtable',
    supportedTypes: ['object'],
    maxItemSize: 100 * 1024,  // 100KB per cell
    // ...
  };
  
  private base: any;
  private tableId: string;
  private mappings: SchemaMapping[];
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    // Transform data to Airtable fields
    const fields = this.transformToAirtable(value);
    fields._smallstore_key = key;  // Store key in special field
    
    // Find existing record
    const records = await this.base(this.tableId)
      .select({
        filterByFormula: `{_smallstore_key} = '${key}'`,
        maxRecords: 1,
      })
      .firstPage();
    
    if (records.length > 0) {
      // Update
      await this.base(this.tableId).update(records[0].id, fields);
    } else {
      // Create
      await this.base(this.tableId).create([{ fields }]);
    }
  }
  
  async get(key: string): Promise<any> {
    const records = await this.base(this.tableId)
      .select({
        filterByFormula: `{_smallstore_key} = '${key}'`,
        maxRecords: 1,
      })
      .firstPage();
    
    if (records.length === 0) return null;
    
    // Transform Airtable fields → Smallstore data
    return this.transformFromAirtable(records[0].fields);
  }
  
  private transformToAirtable(data: any): any {
    const fields: any = {};
    
    for (const mapping of this.mappings) {
      const value = this.getValueByPath(data, mapping.sourcePath);
      if (value === undefined) continue;
      
      // Airtable field type conversion
      switch (mapping.targetType) {
        case 'singleLineText':
        case 'multilineText':
          fields[mapping.targetField] = String(value);
          break;
        
        case 'number':
          fields[mapping.targetField] = Number(value);
          break;
        
        case 'checkbox':
          fields[mapping.targetField] = Boolean(value);
          break;
        
        case 'singleSelect':
          fields[mapping.targetField] = String(value);
          break;
        
        case 'multipleSelects':
          fields[mapping.targetField] = Array.isArray(value) 
            ? value.map(String) 
            : [String(value)];
          break;
        
        case 'date':
        case 'dateTime':
          fields[mapping.targetField] = new Date(value).toISOString();
          break;
        
        case 'url':
          fields[mapping.targetField] = String(value);
          break;
        
        case 'email':
          fields[mapping.targetField] = String(value);
          break;
        
        case 'phoneNumber':
          fields[mapping.targetField] = String(value);
          break;
        
        default:
          // For complex types, store as JSON string
          fields[mapping.targetField] = JSON.stringify(value);
      }
    }
    
    return fields;
  }
  
  private transformFromAirtable(fields: any): any {
    const data: any = {};
    
    for (const mapping of this.mappings) {
      const value = fields[mapping.targetField];
      if (value === undefined) continue;
      
      // Parse JSON strings back to objects if needed
      const parsedValue = typeof value === 'string' && mapping.targetType === 'json'
        ? JSON.parse(value)
        : value;
      
      this.setValueByPath(data, mapping.sourcePath, parsedValue);
    }
    
    return data;
  }
  
  // ... helper methods
}
```

### Pattern 4: Document Database (MongoDB, Firestore)

**Characteristics:**
- Document = record
- Flexible schema
- Query support

```typescript
class MongoDBAdapter implements StorageAdapter {
  readonly capabilities = {
    name: 'mongodb',
    supportedTypes: ['object'],
    maxItemSize: 16 * 1024 * 1024,  // 16MB
    features: {
      query: true,
      transactions: true,
    },
    // ...
  };
  
  private collection: any;
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const document = {
      _smallstore_key: key,
      data: value,
      createdAt: new Date(),
      ...(ttl ? { expiresAt: new Date(Date.now() + ttl * 1000) } : {}),
    };
    
    await this.collection.updateOne(
      { _smallstore_key: key },
      { $set: document },
      { upsert: true }
    );
  }
  
  async get(key: string): Promise<any> {
    const doc = await this.collection.findOne({ _smallstore_key: key });
    
    if (!doc) return null;
    
    // Check TTL
    if (doc.expiresAt && doc.expiresAt < new Date()) {
      await this.delete(key);
      return null;
    }
    
    return doc.data;
  }
  
  async keys(prefix?: string): Promise<string[]> {
    const query = prefix
      ? { _smallstore_key: { $regex: `^${prefix}` } }
      : {};
    
    const docs = await this.collection
      .find(query)
      .project({ _smallstore_key: 1 })
      .toArray();
    
    return docs.map((doc: any) => doc._smallstore_key);
  }
  
  // ... other methods
}
```

---

## Testing Your Adapter

Create a test suite for your adapter:

```typescript
import { assertEquals, assert } from "jsr:@std/assert";

Deno.test("YourAdapter: set and get", async () => {
  const adapter = new YourAdapter(/* config */);
  
  await adapter.set('test/key', { data: 'value' });
  const result = await adapter.get('test/key');
  
  assert(result, 'Should retrieve data');
  assertEquals(result.data, 'value');
});

Deno.test("YourAdapter: delete", async () => {
  const adapter = new YourAdapter(/* config */);
  
  await adapter.set('test/key', { data: 'value' });
  await adapter.delete('test/key');
  
  const result = await adapter.get('test/key');
  assertEquals(result, null, 'Should return null after delete');
});

Deno.test("YourAdapter: has", async () => {
  const adapter = new YourAdapter(/* config */);
  
  await adapter.set('test/key', { data: 'value' });
  
  const exists = await adapter.has('test/key');
  assert(exists, 'Should return true for existing key');
  
  await adapter.delete('test/key');
  
  const notExists = await adapter.has('test/key');
  assert(!notExists, 'Should return false after delete');
});

Deno.test("YourAdapter: keys with prefix", async () => {
  const adapter = new YourAdapter(/* config */);
  
  await adapter.set('users/alice', { name: 'Alice' });
  await adapter.set('users/bob', { name: 'Bob' });
  await adapter.set('posts/123', { title: 'Post' });
  
  const userKeys = await adapter.keys('users/');
  
  assertEquals(userKeys.length, 2);
  assert(userKeys.includes('users/alice'));
  assert(userKeys.includes('users/bob'));
  assert(!userKeys.includes('posts/123'));
});

Deno.test("YourAdapter: TTL support", async () => {
  const adapter = new YourAdapter(/* config */);
  
  // Set with 1 second TTL
  await adapter.set('test/expire', { data: 'value' }, 1);
  
  // Should exist immediately
  const immediate = await adapter.get('test/expire');
  assert(immediate, 'Should exist immediately');
  
  // Wait 2 seconds
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Should be expired
  const expired = await adapter.get('test/expire');
  assertEquals(expired, null, 'Should be null after TTL expires');
});

Deno.test("YourAdapter: clear with prefix", async () => {
  const adapter = new YourAdapter(/* config */);
  
  await adapter.set('users/alice', { name: 'Alice' });
  await adapter.set('users/bob', { name: 'Bob' });
  await adapter.set('posts/123', { title: 'Post' });
  
  await adapter.clear('users/');
  
  const userKeys = await adapter.keys('users/');
  const postKeys = await adapter.keys('posts/');
  
  assertEquals(userKeys.length, 0, 'User keys should be cleared');
  assertEquals(postKeys.length, 1, 'Post keys should remain');
});
```

---

## Quick Reference: Adapter Checklist

✅ **Core Interface**
- [ ] Implements `StorageAdapter` interface
- [ ] All 6 methods implemented (`get`, `set`, `delete`, `has`, `keys`, `clear`)
- [ ] Returns `null` from `get()` when key doesn't exist
- [ ] Returns empty array from `keys()` when no keys match

✅ **Capabilities**
- [ ] Declares `capabilities` object
- [ ] Lists supported data types
- [ ] Specifies size limits (if any)
- [ ] Includes cost and performance info

✅ **Error Handling**
- [ ] Handles missing keys gracefully
- [ ] Validates data before storing
- [ ] Provides clear error messages
- [ ] Doesn't throw on delete of non-existent key

✅ **Testing**
- [ ] Basic CRUD tests
- [ ] Prefix filtering tests
- [ ] TTL tests (if supported)
- [ ] Error handling tests

✅ **Documentation**
- [ ] Usage examples
- [ ] Configuration options
- [ ] Schema mapping (for structured stores)
- [ ] Limitations and constraints

---

## Production-Ready Adapters

Smallstore includes **production-ready adapters** for structured data sources:

### Notion Database Adapter

**File:** `shared/smallstore/adapters/notion.ts`

Full CRUD adapter using your existing `NotionModernClient` and transformation system!

```typescript
import { createNotionAdapter } from 'smallstore';

const notion = createNotionAdapter({
  databaseId: 'your-database-id',
  mappings: [
    {
      notionProperty: 'Name',
      sourcePath: 'name',
      notionType: 'title',
      required: true,
    },
    {
      notionProperty: 'Email',
      sourcePath: 'contact.email',  // Nested!
      notionType: 'email',
    },
    {
      notionProperty: 'Tags',
      sourcePath: 'tags',
      notionType: 'multi_select',  // Array → multi_select
    },
  ],
});
```

**Features:**
- ✅ Uses your `NotionModernClient` and `notionTransformers`
- ✅ Automatic property type transformation
- ✅ Nested field support (dot notation)
- ✅ Full CRUD operations
- ✅ Query support

**Example:** `shared/smallstore/examples/notion-adapter-example.ts`

### Airtable Adapter

**File:** `shared/smallstore/adapters/airtable.ts`

Full CRUD adapter using your existing `AirtableClient`!

```typescript
import { createAirtableAdapter } from 'smallstore';

const airtable = createAirtableAdapter({
  baseId: 'appXXXXXXXXXXXXXX',
  tableIdOrName: 'Contacts',
  mappings: [
    {
      airtableField: 'Name',
      sourcePath: 'name',
      airtableType: 'singleLineText',
      required: true,
    },
    {
      airtableField: 'Email',
      sourcePath: 'contact.email',  // Nested!
      airtableType: 'email',
    },
    {
      airtableField: 'Tags',
      sourcePath: 'tags',
      airtableType: 'multipleSelects',  // Array → multiple selects
    },
  ],
});
```

**Features:**
- ✅ Uses your `AirtableClient` with rate limiting
- ✅ Automatic field type transformation
- ✅ Nested field support (dot notation)
- ✅ Full CRUD operations
- ✅ Formula-based queries

**Example:** `shared/smallstore/examples/airtable-adapter-example.ts`

### Using with Smallstore

```typescript
import { 
  createSmallstore,
  createNotionAdapter,
  createAirtableAdapter,
} from 'smallstore';

const storage = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    notion: createNotionAdapter({ /* ... */ }),
    airtable: createAirtableAdapter({ /* ... */ }),
  },
  defaultAdapter: 'memory',
  
  // Route different data to different adapters
  routing: {
    'users:*': { adapter: 'notion' },
    'contacts:*': { adapter: 'airtable' },
  },
});

// Simple API, complex routing!
await storage.set('users/alice', { name: 'Alice', age: 30 });    // → Notion
await storage.set('contacts/bob', { name: 'Bob', email: '...' }); // → Airtable
await storage.set('temp/cache', { data: '...' });                 // → Memory
```

---

## Need Help?

- Check existing adapters in `shared/smallstore/adapters/`
  - `notion.ts` - Production-ready Notion adapter
  - `airtable.ts` - Production-ready Airtable adapter
  - `unstorage.ts` - Unstorage driver wrapper
  - `memory.ts`, `upstash.ts`, `r2.ts` - Reference implementations
- Review `PHASE-3-COMPLETE.md` for metadata requirements
- See `README.md` for usage examples
- Check `examples/` for working examples
- Run `deno test` to validate your adapter

Happy adapter building! 🚀

