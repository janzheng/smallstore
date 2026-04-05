---
title: Adapters
description: All 17 storage adapters with configuration examples.
---

# Adapters

Every adapter implements the same `StorageAdapter` interface: `get`, `set`, `delete`, `has`, `keys`, `clear`. Some adapters add extra capabilities like TTL, SQL queries, or blob URLs.

## Local Adapters

### Memory

In-memory storage. Fast, ephemeral, no setup.

```typescript
import { createMemoryAdapter } from '@smallstore/core';

const adapter = createMemoryAdapter();
```

| Property | Value |
|----------|-------|
| Persistence | None (process lifetime) |
| Size limit | Available RAM |
| Best for | Caching, testing, ephemeral data |

### Local JSON

Stores each key as a JSON file on disk.

```typescript
import { createLocalJsonAdapter } from '@smallstore/core';

const adapter = createLocalJsonAdapter({
  baseDir: './data',  // Directory for JSON files
});
```

| Property | Value |
|----------|-------|
| Persistence | Disk |
| Size limit | Disk space |
| Best for | Local dev, prototyping, config storage |

### Local File

Raw file storage on disk. Good for binary data.

```typescript
import { createLocalFileAdapter } from '@smallstore/core';

const adapter = createLocalFileAdapter({
  baseDir: './data/files',
});
```

### SQLite

Full SQLite with KV interface, plus optional FTS5 full-text search.

```typescript
import { createSQLiteAdapter } from '@smallstore/core';

const adapter = createSQLiteAdapter({
  path: './data/store.db',
});
```

| Property | Value |
|----------|-------|
| Persistence | Disk |
| Size limit | Disk space |
| Features | SQL queries, FTS5 search, transactions |
| Best for | Local apps needing queries or search |

### Structured SQLite

Real SQL tables with typed columns. Define your schema upfront.

```typescript
import { createStructuredSQLiteAdapter } from '@smallstore/core';

const adapter = createStructuredSQLiteAdapter({
  path: './data/app.db',
  schema: {
    users: {
      columns: [
        { name: 'name', type: 'TEXT', notNull: true },
        { name: 'email', type: 'TEXT', unique: true },
        { name: 'age', type: 'INTEGER' },
      ],
    },
  },
});
```

---

## Cloud KV Adapters

### Upstash Redis

Redis via REST API. Low latency, TTL support, generous free tier.

```typescript
import { createUpstashAdapter } from '@smallstore/core';

const adapter = createUpstashAdapter({
  url: Deno.env.get('UPSTASH_REDIS_REST_URL'),
  token: Deno.env.get('UPSTASH_REDIS_REST_TOKEN'),
});
```

| Property | Value |
|----------|-------|
| Latency | ~10-50ms |
| Size limit | 1MB per value |
| TTL | Native support |
| Cost | Free tier: 10k commands/day |
| Best for | Sessions, caching, rate limiting, small KV |

**Environment variables:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `SM_UPSTASH_URL`, `SM_UPSTASH_TOKEN`)

### Cloudflare KV

Edge-distributed KV. Fast reads globally, eventually consistent writes.

```typescript
import { createCloudflareKVAdapter } from '@smallstore/core';

// HTTP mode (from any runtime)
const adapter = createCloudflareKVAdapter({
  baseUrl: Deno.env.get('SM_WORKERS_URL'),
  namespace: 'my-app',
});

// Native mode (inside Cloudflare Workers)
const adapter = createCloudflareKVAdapter({
  binding: env.SM_KV,
  namespace: 'my-app',
});
```

| Property | Value |
|----------|-------|
| Latency | ~10-20ms (edge) |
| Size limit | 25MB per value |
| TTL | Native support |
| Consistency | Eventually consistent |
| Best for | Global config, edge caching, feature flags |

### Cloudflare D1

SQLite database in the cloud via Cloudflare.

```typescript
import { createCloudflareD1Adapter } from '@smallstore/core';

// HTTP mode
const adapter = createCloudflareD1Adapter({
  baseUrl: Deno.env.get('SM_WORKERS_URL'),
  table: 'my_collection',
});

// Native mode (inside Workers)
const adapter = createCloudflareD1Adapter({
  binding: env.SM_D1,
  table: 'my_collection',
});
```

| Property | Value |
|----------|-------|
| Latency | ~20-50ms |
| Size limit | 1MB per row |
| Features | SQL queries, transactions |
| Best for | Structured cloud data, relational queries |

### Cloudflare Durable Objects

Strongly consistent, per-instance storage. Each instance is isolated.

```typescript
import { createCloudflareDOAdapter } from '@smallstore/core';

// HTTP mode
const adapter = createCloudflareDOAdapter({
  baseUrl: Deno.env.get('SM_WORKERS_URL'),
  instanceId: 'user-123',
});
```

| Property | Value |
|----------|-------|
| Latency | ~10-30ms |
| Consistency | Strong (per-instance) |
| Best for | Coordination, real-time state, per-user storage |

---

## Structured Data Adapters

These adapters work with services that have their own UI for browsing/editing data.

### Airtable

Spreadsheet-database hybrid. Auto-creates columns from your data.

```typescript
import { createAirtableAdapter } from '@smallstore/core';

const adapter = createAirtableAdapter({
  apiKey: Deno.env.get('SM_AIRTABLE_API_KEY'),
  baseId: Deno.env.get('SM_AIRTABLE_BASE_ID'),
  tableName: 'MyTable',
});
```

| Property | Value |
|----------|-------|
| Latency | ~200-500ms |
| Size limit | 100k records per base |
| UI | Full spreadsheet UI at airtable.com |
| Features | Auto-column creation, attachments, formulas |
| Best for | CRM, content management, data you want to browse/edit manually |

**Setup:** Your Airtable table needs a `_smallstore_key` column (singleLineText type) for key lookups. The adapter auto-creates other columns as needed.

### Notion

Rich document pages in a Notion database.

```typescript
import { createNotionAdapter } from '@smallstore/core';

const adapter = createNotionAdapter({
  secret: Deno.env.get('SM_NOTION_SECRET'),
  databaseId: Deno.env.get('SM_NOTION_DATABASE_ID'),
  contentProperty: 'body_content',  // Store large content in page body
});
```

| Property | Value |
|----------|-------|
| Latency | ~300-800ms |
| Size limit | 2000 chars per property (unlimited in page body) |
| UI | Full Notion UI |
| Features | Rich text, page body, wiki-style content |
| Best for | Documentation, wiki, notes, content that humans read/edit |

**Setup:** Create a Notion integration, share your database with it, use the **database ID** (not the page ID).

### Google Sheets (Sheetlog)

Store data in Google Sheets via a deployed Apps Script.

```typescript
import { createSheetlogAdapter } from '@smallstore/core';

const adapter = createSheetlogAdapter({
  sheetUrl: Deno.env.get('SM_SHEET_URL'),
  sheetName: 'MySheet',
});
```

| Property | Value |
|----------|-------|
| Latency | ~500-2000ms |
| UI | Google Sheets |
| Best for | Quick logging, data non-technical people need to see/edit |

**Setup:** Deploy the [Sheetlog Apps Script](https://github.com/yawnxyz/sheetlog) to your Google Sheet.

---

## Blob/Object Storage

### R2 Direct

Cloudflare R2 via S3-compatible API. Cheap blob storage.

```typescript
import { createR2DirectAdapter } from '@smallstore/core';

const adapter = createR2DirectAdapter({
  accountId: Deno.env.get('SM_R2_ACCOUNT_ID'),
  accessKeyId: Deno.env.get('SM_R2_ACCESS_KEY_ID'),
  secretAccessKey: Deno.env.get('SM_R2_SECRET_ACCESS_KEY'),
  bucketName: Deno.env.get('SM_R2_BUCKET_NAME'),
});
```

| Property | Value |
|----------|-------|
| Size limit | 5TB per object |
| Cost | $0.015/GB/month, free egress |
| Best for | Images, audio, video, PDFs, any binary data |

### F2-R2 (Fuzzyfile)

Cloudflare R2 via the F2 proxy service. Upload-only CDN with presigned URLs.

```typescript
import { createF2R2Adapter } from '@smallstore/core';

const adapter = createF2R2Adapter({
  f2Url: 'https://f2.phage.directory',
  defaultScope: 'my-app',
});
```

| Property | Value |
|----------|-------|
| Upload | Via presigned URLs |
| Read | CDN URLs (may require Cloudflare Access) |
| Delete | Not supported |
| Best for | Write-once assets, CDN uploads |

---

## Meta Adapters

### Unstorage

Wraps any [unstorage](https://unstorage.unjs.io/) driver as a Smallstore adapter.

```typescript
import { createUnstorageAdapter } from '@smallstore/core';

// Upstash driver
const adapter = createUnstorageAdapter('upstash', {
  url: Deno.env.get('SM_UPSTASH_URL'),
  token: Deno.env.get('SM_UPSTASH_TOKEN'),
  base: 'my-namespace',
});
```

Supported drivers: `upstash`, `cloudflare-kv`, `cloudflare-r2`.

---

## Adapter Comparison

| Adapter | Persistence | Latency | Size Limit | Cost | UI |
|---------|-------------|---------|------------|------|----|
| Memory | None | <1ms | RAM | Free | No |
| Local JSON | Disk | <5ms | Disk | Free | No |
| SQLite | Disk | <5ms | Disk | Free | No |
| Upstash | Cloud | ~30ms | 1MB | Cheap | Dashboard |
| CF KV | Edge | ~15ms | 25MB | Cheap | Dashboard |
| CF D1 | Cloud | ~30ms | 1MB/row | Cheap | Dashboard |
| CF DO | Cloud | ~20ms | Unlimited | Moderate | No |
| R2 Direct | Cloud | ~80ms | 5TB | Cheap | Dashboard |
| Airtable | Cloud | ~300ms | 100k rows | Free tier | Spreadsheet |
| Notion | Cloud | ~500ms | Unlimited | Free tier | Rich editor |
| Sheetlog | Cloud | ~1000ms | Sheet limits | Free | Google Sheets |
