---
title: Blob Middleware
description: Automatically upload binary data to object storage.
---

# Blob Middleware

Blob middleware intercepts binary fields in your data, uploads them to object storage (R2), and replaces them with URLs. This lets you store rich data (with images, files, etc.) in any adapter — even ones that don't support blobs.

## The Problem

Airtable and Notion don't store raw binary data. Upstash has a 1MB limit. You want to store a user profile with a photo:

```typescript
// This won't work with most adapters
await store.set("users/jan", {
  name: "Jan",
  avatar: new Uint8Array([...]),  // 2MB photo
});
```

## The Solution

Wrap your store with `withBlobs`:

```typescript
import { createSmallstore, withBlobs } from '@smallstore/core';

const store = createSmallstore({ preset: 'cloud' });

const blobStore = withBlobs(store, {
  backend: {
    type: 'r2-direct',
    accountId: Deno.env.get('SM_R2_ACCOUNT_ID'),
    accessKeyId: Deno.env.get('SM_R2_ACCESS_KEY_ID'),
    secretAccessKey: Deno.env.get('SM_R2_SECRET_ACCESS_KEY'),
    bucketName: Deno.env.get('SM_R2_BUCKET_NAME'),
  },
});

// Now binary fields are auto-uploaded to R2
await blobStore.set("users/jan", {
  name: "Jan",
  avatar: new Uint8Array([...]),  // Uploaded to R2, replaced with URL
});

// What's actually stored:
// {
//   name: "Jan",
//   avatar: "https://your-r2-bucket.../users/jan/avatar.bin"
// }
```

## How It Works

1. **Detect** — Scans your data for binary fields (`Uint8Array`, `ArrayBuffer`, `Blob`)
2. **Upload** — Sends each binary field to R2 (or F2)
3. **Replace** — Swaps binary data with the public URL
4. **Store** — Passes the URL-ified data to the underlying adapter

## Platform-Specific Formats

Blob middleware can format URLs for specific platforms:

```typescript
// Airtable attachments
const airtableStore = withBlobs(store, {
  backend: { type: 'r2-direct', ... },
  targetFormat: 'airtable',  // Wraps URLs as { url, filename } objects
});

// Notion file blocks
const notionStore = withBlobs(store, {
  backend: { type: 'r2-direct', ... },
  targetFormat: 'notion',  // Wraps URLs as Notion file objects
});
```

## Resolving Blob URLs

Use `BlobResolver` to turn stored URLs back into binary data:

```typescript
import { BlobResolver } from '@smallstore/core';

const resolver = new BlobResolver();
const data = await resolver.resolve("https://your-r2-bucket.../avatar.bin");
// Returns Uint8Array
```

## Backend Options

### R2 Direct

Best for most use cases. S3-compatible, cheap, direct access.

```typescript
backend: {
  type: 'r2-direct',
  accountId: '...',
  accessKeyId: '...',
  secretAccessKey: '...',
  bucketName: '...',
}
```

### F2-R2 (Fuzzyfile)

CDN upload via presigned URLs. Write-only.

```typescript
backend: {
  type: 'f2-r2',
  f2Url: 'https://f2.phage.directory',
  scope: 'my-app',
}
```
