# Cloudflare Workers Smallstore Examples

This directory contains **TypeScript code examples** for using Cloudflare Workers adapters (KV, D1, R2, DO) with Smallstore.

## 📁 File Organization

### TypeScript Examples (this directory - `/shared/smallstore/adapters/examples/`)
- **`cloudflare-typescript.examples.ts`** - Direct TypeScript usage of adapters with R2 image uploads
- **`cloudflare-env.examples.ts`** - Environment configuration examples
- **`cloudflare-workers.examples.ts`** - Basic worker integration examples

### FunctionFlow Pipeline Examples (`/modules/compositions/smallstore/v3/examples/`)
- **`cloudflare-kv.examples.ts`** - KV pipeline examples (cache, sessions, config)
- **`cloudflare-d1.examples.ts`** - D1 pipeline examples (SQL queries, structured data)
- **`cloudflare-r2.examples.ts`** - R2 pipeline examples (images, files, backups)
- **`cloudflare-pipelines.examples.ts`** - Complete multi-service pipelines

## 🚀 Quick Start

### 1. Environment Setup

Create `.env` in your project root:

```bash
SM_WORKERS_URL=https://your-workers.your-subdomain.workers.dev
```

### 2. TypeScript Usage

```typescript
import "jsr:@std/dotenv/load";
import { 
  createCloudflareKVAdapter,
  createCloudflareD1Adapter,
  createCloudflareR2Adapter,
  getCloudflareConfig 
} from '../mod.ts'; // or from 'smallstore'

// KV - Fast cache
const cache = createCloudflareKVAdapter({
  ...getCloudflareConfig(),
  namespace: 'cache',
});

// D1 - SQL database
const db = createCloudflareD1Adapter({
  ...getCloudflareConfig(),
  table: 'users',
});

// R2 - File storage
const storage = createCloudflareR2Adapter({
  ...getCloudflareConfig(),
  scope: 'images',
});

// Use them!
await cache.set('key', 'value');
await db.set('user:123', { name: 'Jan' });

// Upload image from URL
const response = await fetch('https://example.com/image.jpg');
const blob = await response.blob();
await storage.set('photo.jpg', blob);
```

### 3. FunctionFlow Pipeline Usage

For FunctionFlow pipelines, see the examples in `/modules/compositions/smallstore/v3/examples/`.

## 📚 Key Examples

### Upload Image to R2 (TypeScript)

```typescript
import { createCloudflareR2Adapter, getCloudflareConfig } from '../mod.ts';

const storage = createCloudflareR2Adapter({
  ...getCloudflareConfig(),
  scope: 'images',
});

// Fetch and upload
const response = await fetch('https://picsum.photos/800/600');
const imageBlob = await response.blob();
await storage.set(`photo-${Date.now()}.jpg`, imageBlob);
```

### Upload Image to R2 (FunctionFlow Pipeline)

```json
{
  "pipeline": [
    {
      "name": "data/fetch",
      "settings": {
        "url": "https://picsum.photos/800/600",
        "responseType": "blob"
      },
      "save": "imageBlob"
    },
    {
      "name": "smallstore/set",
      "settings": {
        "adapter": "cloudflare-r2",
        "scope": "images",
        "key": "photo-{{timestamp}}.jpg",
        "value": "{{imageBlob}}"
      }
    }
  ]
}
```

## 🗂️ Storage Patterns

### KV (Key-Value Store)
- ✅ Cache, sessions, config
- ✅ Fast global reads
- ✅ Eventually consistent
- ✅ TTL support

### D1 (SQL Database)
- ✅ Structured data
- ✅ SQL queries
- ✅ Strongly consistent
- ✅ Relations & joins

### R2 (Object Storage)
- ✅ Files, images, documents
- ✅ Large blobs
- ✅ S3-compatible
- ✅ No egress fees

### Hybrid Patterns
- **Cache + Database**: KV for hot data, D1 for source of truth
- **Files + Metadata**: R2 for files, D1 for searchable metadata
- **Sessions + Profiles**: KV for sessions, D1 for user data

## 📖 Full Example Files

### TypeScript Examples
- **`cloudflare-typescript.examples.ts`** - 10+ ready-to-use functions:
  1. Cache API responses
  2. Session management
  3. User data storage
  4. Image upload to R2
  5. Local file upload
  6. JSON data storage
  7. File listing
  8. Hybrid storage (metadata + files)
  9. Image download/transform
  10. Batch uploads

### Pipeline Examples
Check `/modules/compositions/smallstore/v3/examples/` for:
- **10 KV examples** - Cache, sessions, rate limiting
- **12 D1 examples** - SQL queries, relations, search
- **10 R2 examples** - Images, PDFs, backups
- **10 Complete pipelines** - Multi-service workflows

## 🔧 Testing Locally

1. Start worker locally:
```bash
cd your-workers-project
npm run dev
```

2. Update `.env`:
```bash
SM_WORKERS_URL=http://localhost:8787
```

3. Run examples:
```bash
deno run --allow-net --allow-env cloudflare-typescript.examples.ts
```

## 📝 Notes

- **TypeScript examples** (this directory) are for direct code usage
- **FunctionFlow examples** (modules directory) are JSON pipeline definitions
- All examples use environment variables for easy dev/prod switching
- R2 adapter auto-detects MIME types for images, JSON, PDFs, etc.
- D1 adapter automatically adds `createdAt` and `updatedAt` timestamps

## 🔗 Related Documentation

- **Adapter Source**: `src/adapters/cloudflare-*.ts`
- **Module Examples**: `src/adapters/examples/`

---

Happy coding! 🎉

