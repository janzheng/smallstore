# Sheetlog - Universal Google Sheets Client

A unified Sheetlog driver that provides a consistent API for interacting with Google Sheets via Sheetlog Apps Script proxy.

## Overview

This is the core Sheetlog client used in smallstore. It's based on the [@yawnxyz/sheetlog](https://www.npmjs.com/package/@yawnxyz/sheetlog) npm package and provides:

- ✅ Universal compatibility (Deno, Node.js, browsers)
- ✅ Full CRUD operations
- ✅ Dynamic schema (automatic column creation)
- ✅ Batch operations (upsert, update, delete)
- ✅ Advanced features (pagination, aggregation, export)
- ✅ TypeScript support

## Usage

### Basic Setup

```ts
import { Sheetlog } from '../../shared/sheetlog/mod.ts";

const client = new Sheetlog({
  sheetUrl: "https://script.google.com/macros/s/.../exec",
  sheet: "Demo"
});
```

### CRUD Operations

```ts
// Get all rows
const data = await client.get();

// Get single row
const row = await client.get(5);

// Add row
await client.post({ name: "John", age: 30 });

// Update row
await client.put(5, { age: 31 });

// Delete row
await client.delete(5);
```

### Advanced Operations

```ts
// Upsert (insert or update)
await client.upsert("email", "john@example.com", {
  name: "John",
  email: "john@example.com"
});

// Batch upsert
await client.batchUpsert("id", [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" }
]);

// Dynamic post (auto-creates columns)
await client.dynamicPost({ newField: "value" });

// Find rows
const matches = await client.find("email", "john@example.com", true);

// Pagination
const page = await client.paginatedGet({
  cursor: 1,
  limit: 20,
  sortBy: "name",
  sortDir: "asc"
});

// Aggregation
const result = await client.aggregate("age", "avg");

// Export
const csv = await client.export({ format: "csv" });
```

## Integration

### In Modules

See `modules/sheetlog/v3/sheetlog.ts` for function-based wrappers:

```ts
import { Sheetlog } from '../../../shared/sheetlog/mod.ts";

const logger = new Sheetlog({ sheetUrl, sheet });
return await logger.log(payload, { method: 'GET' });
```

### In Storage Adapters

See `shared/smallstore/adapters/sheetlog.ts` for storage adapter implementation:

```ts
import { Sheetlog } from '../../sheetlog/mod.ts";

class SheetlogAdapter implements StorageAdapter {
  private client: Sheetlog;
  
  constructor(config: SheetlogConfig) {
    this.client = new Sheetlog(config);
  }
}
```

## Related Files

- **Core Client**: `shared/sheetlog/client.ts`
- **Module Functions**: `modules/sheetlog/v3/sheetlog.ts`
- **Storage Adapter**: `shared/smallstore/adapters/sheetlog.ts`
- **Apps Script**: `_REFERENCES_ONLY/sheetlog/sheetlog.js`
- **npm Package**: [@yawnxyz/sheetlog](https://www.npmjs.com/package/@yawnxyz/sheetlog)

## Methods

### Core Methods

- `get(id?, options?)` - Fetch row(s)
- `list(options?)` - Get all rows
- `post(payload, options?)` - Create row
- `put(id, payload, options?)` - Update row
- `delete(id, options?)` - Delete row

### Advanced Methods

- `upsert(idColumn, id, payload, options?)` - Insert or update
- `batchUpsert(idColumn, payload, options?)` - Batch upsert
- `find(idColumn, id, returnAll?, options?)` - Search rows
- `dynamicPost(payload, options?)` - Auto-create columns
- `bulkDelete(ids, options?)` - Delete multiple rows

### Column Management

- `addColumn(name, options?)` - Add column
- `editColumn(oldName, newName, options?)` - Rename column
- `removeColumn(name, options?)` - Delete column

### Data Operations

- `getRows(options?)` - Get row range
- `getColumns(options?)` - Get column range
- `getAllCells(options?)` - Get raw cell data
- `getRange(options?)` - Get flexible range
- `getDataBlock(options?)` - Find data block
- `rangeUpdate(data, options?)` - Update range

### Utility Methods

- `paginatedGet(options?)` - Paginated results
- `aggregate(column, op, options?)` - Aggregations
- `export(options?)` - Export data
- `getSheets(options?)` - List sheets
- `getCsv(options?)` - Get CSV

## Configuration

```ts
interface SheetlogConfig {
  sheetUrl?: string;      // Apps Script URL
  sheet?: string;         // Sheet name (default: "Logs")
  method?: string;        // Default method (default: "POST")
  logPayload?: boolean;   // Log requests (default: false)
  key?: string;          // Auth key (optional)
}
```

## Environment Variables

The client can load configuration from environment:

```bash
# .env
SHEET_URL=https://script.google.com/macros/s/.../exec
```

Works with:
- Deno: `Deno.env.get('SHEET_URL')`
- Node: `process.env.SHEET_URL`

## TypeScript

Full TypeScript support with types for all methods and options:

```ts
import type { SheetlogConfig, SheetlogOptions } from '../../shared/sheetlog/mod.ts";
```

## License

MIT - Based on [@yawnxyz/sheetlog](https://www.npmjs.com/package/@yawnxyz/sheetlog)

