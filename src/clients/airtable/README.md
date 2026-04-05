# Airtable API Client

Complete TypeScript wrapper for the Airtable REST API with full type safety and organized by API endpoints.

## Structure

```
src/clients/airtable/
├── index.ts      # Main entry point, unified API
├── client.ts     # Low-level HTTP client
├── bases.ts      # Bases API (list, schema, create)
├── tables.ts     # Tables API (create, update)
├── fields.ts     # Fields API (create, update)
├── records.ts    # Records API (CRUD)
└── types.ts      # Shared types
```

## Quick Start

```typescript
import { createAirtable } from './airtable/index.ts";

const airtable = createAirtable({
  apiKey: 'patYourPersonalAccessToken...',
});

// List all bases
const bases = await airtable.bases.list();

// Get base schema
const schema = await airtable.bases.getSchema('appXXXXXXXXXXXXXX');

// Create a table
const table = await airtable.tables.create('appXXXXXXXXXXXXXX', {
  name: 'My Table',
  fields: [
    { name: 'Name', type: 'singleLineText' },
    { name: 'Email', type: 'email' },
  ],
});

// Create a field
const field = await airtable.fields.create(
  'appXXXXXXXXXXXXXX',
  'tblXXXXXXXXXXXXXX',
  {
    name: 'Phone',
    type: 'phoneNumber',
  }
);

// List records
const records = await airtable.records.list(
  'appXXXXXXXXXXXXXX',
  'My Table', // Can use name or ID
  {
    maxRecords: 10,
    view: 'Grid view',
  }
);

// Create a record
const record = await airtable.records.createOne(
  'appXXXXXXXXXXXXXX',
  'tblXXXXXXXXXXXXXX',
  {
    Name: 'John Doe',
    Email: 'john@example.com',
  }
);
```

## API Coverage

### ✅ Bases API (Meta API)

All operations available on **all plans** (Free, Plus, Pro, Enterprise).

| Endpoint | Method | Description | Scope Required |
|----------|--------|-------------|----------------|
| `/meta/bases` | GET | List bases | `schema.bases:read` |
| `/meta/bases/{baseId}/tables` | GET | Get base schema | `schema.bases:read` |
| `/meta/bases` | POST | Create base | `schema.bases:write` |

```typescript
// List bases
const { bases, offset } = await airtable.bases.list();

// Get base schema (all tables, fields, views)
const { tables } = await airtable.bases.getSchema('appXXX');

// Create base
const newBase = await airtable.bases.create({
  name: 'My New Base',
  workspaceId: 'wspXXX',
  tables: [
    {
      name: 'Contacts',
      fields: [
        { name: 'Name', type: 'singleLineText' },
      ],
    },
  ],
});
```

### ✅ Tables API (Meta API)

| Endpoint | Method | Description | Scope Required |
|----------|--------|-------------|----------------|
| `/meta/bases/{baseId}/tables` | POST | Create table | `schema.bases:write` |
| `/meta/bases/{baseId}/tables/{tableId}` | PATCH | Update table | `schema.bases:write` |

```typescript
// Create table
const table = await airtable.tables.create('appXXX', {
  name: 'Projects',
  description: 'Project tracking table',
  fields: [
    { name: 'Name', type: 'singleLineText' },
    { name: 'Status', type: 'singleSelect', options: { choices: [...] } },
  ],
});

// Update table
const updated = await airtable.tables.update('appXXX', 'tblXXX', {
  name: 'Active Projects',
  description: 'Updated description',
});
```

### ✅ Fields API (Meta API)

| Endpoint | Method | Description | Scope Required |
|----------|--------|-------------|----------------|
| `/meta/bases/{baseId}/tables/{tableId}/fields` | POST | Create field | `schema.bases:write` |
| `/meta/bases/{baseId}/tables/{tableId}/fields/{fieldId}` | PATCH | Update field | `schema.bases:write` |

```typescript
// Create field
const field = await airtable.fields.create('appXXX', 'tblXXX', {
  name: 'Priority',
  type: 'singleSelect',
  options: {
    choices: [
      { name: 'High', color: 'red' },
      { name: 'Low', color: 'green' },
    ],
  },
});

// Update field
const updated = await airtable.fields.update('appXXX', 'tblXXX', 'fldXXX', {
  name: 'Priority Level',
  description: 'Task priority',
});
```

### ✅ Records API (Data API)

All operations available on **all plans**. Works with API keys OR Personal Access Tokens.

| Endpoint | Method | Description | Scope Required |
|----------|--------|-------------|----------------|
| `/{baseId}/{tableIdOrName}` | GET | List records | `data.records:read` |
| `/{baseId}/{tableIdOrName}/{recordId}` | GET | Get record | `data.records:read` |
| `/{baseId}/{tableIdOrName}` | POST | Create records | `data.records:write` |
| `/{baseId}/{tableIdOrName}` | PATCH | Update records | `data.records:write` |
| `/{baseId}/{tableIdOrName}` | PUT | Replace records | `data.records:write` |
| `/{baseId}/{tableIdOrName}` | DELETE | Delete records | `data.records:write` |

```typescript
// List records with filtering
const { records, offset } = await airtable.records.list('appXXX', 'tblXXX', {
  filterByFormula: '{Status} = "Active"',
  sort: [{ field: 'Name', direction: 'asc' }],
  maxRecords: 100,
});

// Get single record
const record = await airtable.records.get('appXXX', 'tblXXX', 'recXXX');

// Create multiple records (up to 10)
const created = await airtable.records.create('appXXX', 'tblXXX', {
  records: [
    { fields: { Name: 'Task 1' } },
    { fields: { Name: 'Task 2' } },
  ],
});

// Create single record (convenience)
const one = await airtable.records.createOne('appXXX', 'tblXXX', {
  Name: 'New Task',
  Status: 'Todo',
});

// Update records
const updated = await airtable.records.update('appXXX', 'tblXXX', {
  records: [
    { id: 'recXXX', fields: { Status: 'Done' } },
  ],
});

// Delete records
const deleted = await airtable.records.delete('appXXX', 'tblXXX', ['recXXX']);
```

## Authentication

### Personal Access Token (Recommended)

PATs provide fine-grained access control with explicit scopes:

```typescript
const airtable = createAirtable({
  apiKey: 'patYourToken...', // Starts with "pat"
});
```

**Create a PAT**: https://airtable.com/create/tokens

**Required Scopes**:
- `data.records:read` - Read records
- `data.records:write` - Create/update/delete records
- `schema.bases:read` - Read schemas (for table name → ID resolution)
- `schema.bases:write` - Create/modify tables and fields

### API Key (Being Deprecated)

```typescript
const airtable = createAirtable({
  apiKey: 'keyYourKey...', // Starts with "key"
});
```

**⚠️ Limitations**:
- Cannot use Meta API (schema operations)
- Only works for Records API
- Being deprecated by Airtable

## Key Differences: Table Names vs Table IDs

### Data API (Records)
✅ **Accepts both table names AND table IDs**

```typescript
// Both work!
await airtable.records.list('appXXX', 'My Table');     // Name
await airtable.records.list('appXXX', 'tblXXXXXXXXX'); // ID
```

### Meta API (Schema Operations)
⚠️ **Requires table IDs for field/table modification**

```typescript
// ❌ This will fail
await airtable.fields.create('appXXX', 'My Table', {...});

// ✅ This works
await airtable.fields.create('appXXX', 'tblXXXXXXXXX', {...});
```

**Finding Table IDs**:
1. Open your table in Airtable
2. Check the URL: `https://airtable.com/appXXX/tblYYY/...`
3. `tblYYY` is your table ID

**Or use the API**:
```typescript
const { tables } = await airtable.bases.getSchema('appXXX');
tables.forEach(t => console.log(`${t.name} → ${t.id}`));
```

## Error Handling

```typescript
import { AirtableApiError } from './airtable/index.ts";

try {
  const record = await airtable.records.get('appXXX', 'tblXXX', 'recXXX');
} catch (error) {
  if (error instanceof AirtableApiError) {
    console.log('Error type:', error.type);
    console.log('Status code:', error.statusCode);
    console.log('Response:', error.response);
  }
}
```

## Rate Limiting

The client automatically handles rate limiting:

```typescript
const client = createAirtable({
  apiKey: 'patXXX',
  timeout: 60000, // 60 second timeout for slow requests
});

// Check rate limit status
const rateLimitInfo = client.client.getRateLimitInfo();
console.log('Remaining requests:', rateLimitInfo?.remaining);
```

## Integration with Smallstore

The Smallstore Airtable adapter uses this client internally:

```typescript
import { createAirtableAdapter } from '../smallstore/adapters/airtable.ts";

const adapter = createAirtableAdapter({
  apiKey: 'patXXX',
  baseId: 'appXXX',
  tableIdOrName: 'tblXXX', // ✅ Use table ID for best performance
  unmappedStrategy: 'auto-create', // Automatically creates fields
});
```

## Comparison with Existing Tools

### vs. Cytosis (airfetch)

**Cytosis** (in `airfetch`):
- ✅ Great for **reading** data
- ✅ Works with table names
- ✅ Batch loading of multiple tables
- ❌ No schema manipulation
- ❌ No field creation

**This client**:
- ✅ Complete API coverage
- ✅ Schema operations (create tables/fields)
- ✅ Full CRUD operations
- ✅ Type-safe TypeScript API
- ✅ Works with both names and IDs

**Use Cytosis when**: You just need to read data and prefer the batch-loading API

**Use this client when**: You need schema operations, field creation, or prefer a REST-style API

## Examples

See `examples/` directory for complete working examples:
- `create-base-example.ts` - Creating a new base with tables
- `dynamic-fields-example.ts` - Adding fields to existing tables
- `records-crud-example.ts` - Full CRUD operations
- `batch-operations-example.ts` - Bulk record operations

## Related Documentation

- [Airtable REST API](https://airtable.com/developers/web/api/introduction)
- [Field Types Reference](https://airtable.com/developers/web/api/field-model)
- [Personal Access Tokens](https://support.airtable.com/docs/creating-and-using-api-keys-and-access-tokens)
- [Smallstore Integration](../smallstore/docs/AIRTABLE-AUTH-FIX.md)
