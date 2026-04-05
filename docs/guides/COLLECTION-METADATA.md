# Collection-Level Metadata 🏷️

**Status**: ✅ COMPLETE  
**Date**: November 20, 2025  
**Phase**: 3.6i (Collection Organization)

## 🎯 Overview

Store arbitrary metadata on collections for organization, workflow context, and "folder prompts". Perfect for adding instructions, tags, notes, and any custom metadata to your data collections.

## ✨ Key Features

### 1. **Adapter Configuration** - One-Line Setup

**The Killer Feature**: Specify which adapter (Notion, Airtable, R2, etc.) a collection should use.

```typescript
await storage.setCollectionMetadata('research/papers', {
  name: 'Research Papers',
  adapter: {
    type: 'notion',
    location: '8aec500b9c8f4bd28411da2680848f65'  // Just paste your Notion database ID!
  }
});

// Now all inserts to this collection automatically go to Notion:
await storage.insert('research/papers', { title: 'New Paper', year: 2025 });
// ↑ No need to specify adapter: "notion" - it's automatic!
```

**Supported Formats**:
- **Notion**: Database ID (with/without dashes), full URL (auto-cleaned)
- **Airtable**: Base ID + table name + optional view
- **R2/F2**: Bucket name or connection string
- **Postgres**: Connection string or database name

### 2. **User-Defined Metadata** - Store Anything

```typescript
await storage.setCollectionMetadata('research/ai-agents', {
  name: 'AI Agents Research',
  description: 'Papers about AI agents and agentic workflows',
  prompt: 'All items in this collection are for AI agent research.',
  tags: ['ai', 'agents', 'research'],
  workflow: 'research-pipeline',
  // ... any other fields you want
});
```

### 3. **Folder Prompts** - Workflow Instructions

```typescript
// Add context to a collection that AI tools can use
await storage.setCollectionMetadata('podcasts/episode-42', {
  name: 'Episode 42: AI Safety',
  prompt: 'This episode focuses on AI safety. Guest talking points: alignment, RLHF, interpretability. Editing notes: Cut technical jargon.',
  guest: 'Dr. Jane Smith',
  status: 'in-production'
});

// Later, retrieve and use in AI prompts
const metadata = await storage.getCollectionMetadata('podcasts/episode-42');
// Use metadata.prompt in your AI workflow
```

### 4. **Merge Semantics** - Non-Destructive

```typescript
// Initial metadata
await storage.setCollectionMetadata('projects/website', {
  name: 'Website Project',
  status: 'active'
});

// Add more metadata (merges, doesn't overwrite)
await storage.setCollectionMetadata('projects/website', {
  client: 'ACME Corp',
  deadline: '2025-12-31'
});

// Result: { name, status, client, deadline, created, updated }
```

### 5. **Works with Empty Collections**

```typescript
// Set metadata before adding any data
await storage.setCollectionMetadata('future/collection', {
  name: 'Planned Collection',
  notes: 'Will add data here later',
  planned_date: '2025-12-01'
});

// Collection doesn't need to have data yet!
```

## 📊 Metadata Schema

### Core Fields (Suggested)

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable collection name |
| `description` | string | Collection description |
| `prompt` | string | Workflow instructions/"folder prompt" |
| `tags` | string[] | Tags for organization |
| `workflow` | string | Associated workflow/pipeline |
| `notes` | string | Free-form notes |

### System Fields (Auto-Tracked)

| Field | Type | Description |
|-------|------|-------------|
| `created` | string | ISO timestamp (auto) |
| `updated` | string | ISO timestamp (auto) |
| `totalSize` | string | Total size (auto) |
| `itemCount` | number | Number of items (auto) |

### Custom Fields

**Any other fields you want!** The schema is completely open - add whatever makes sense for your use case.

## 🎬 Usage

### Direct API

```typescript
// Set metadata
await storage.setCollectionMetadata(collection, metadata);

// Get metadata
const metadata = await storage.getCollectionMetadata(collection);
```

### Module/Pipeline Usage

```typescript
// Set metadata in a workflow
{
  module: "smallstore/setMetadata",
  input: {
    collection: "research/ai-papers",
    metadata: {
      name: "AI Research Papers",
      prompt: "Focus on agentic workflows",
      tags: ["ai", "research"]
    }
  }
}

// Get metadata
{
  module: "smallstore/getMetadata",
  input: {
    collection: "research/ai-papers"
  }
}
// Access with $step1.metadata
```

## 🎯 Use Cases

### 1. Folder Prompts for AI Workflows

```typescript
await storage.setCollectionMetadata('customer-support/tickets', {
  prompt: 'These are customer support tickets. Prioritize urgent issues. Use empathetic language. Always include ticket ID in responses.'
});

// Later, in AI call
const metadata = await storage.getCollectionMetadata('customer-support/tickets');
const prompt = `${metadata.prompt}\n\nTickets: ${tickets}`;
```

### 2. Project Organization

```typescript
await storage.setCollectionMetadata('projects/acme-website', {
  name: 'ACME Corp Website Redesign',
  client: 'ACME Corp',
  deadline: '2025-12-31',
  budget: '$50,000',
  status: 'in-progress',
  team: ['designer-1', 'dev-1', 'pm-1'],
  notes: 'Client prefers minimalist design. Primary color: #0066cc.'
});
```

### 3. Podcast/Video Production

```typescript
await storage.setCollectionMetadata('podcasts/episode-1', {
  name: 'Episode 1: Getting Started',
  prompt: 'Beginner-friendly content. Focus on practical examples.',
  guest: 'John Doe',
  recording_date: '2025-11-15',
  status: 'editing',
  notes: 'Cut section at 15:30, add intro music'
});
```

### 4. Research Collections

```typescript
await storage.setCollectionMetadata('research/quantum-computing', {
  name: 'Quantum Computing Papers',
  description: 'Papers about quantum algorithms and implementations',
  prompt: 'Focus on practical applications and recent breakthroughs.',
  quality: 'high',
  last_reviewed: '2025-11-20',
  tags: ['quantum', 'computing', 'algorithms', 'physics']
});
```

### 5. Dynamic Workflow Metadata

```typescript
// In a cron job that syncs Notion → Smallstore
{
  flow: [
    { module: "notion/queryDatabase", input: { database_id: "abc123" } },
    { module: "smallstore/store", input: {
      collection: "notion-sync/tasks",
      data: "$step1.results"
    }},
    { module: "smallstore/setMetadata", input: {
      collection: "notion-sync/tasks",
      metadata: {
        last_sync: "$now",
        source: "Notion Database",
        source_id: "abc123",
        item_count: "$step1.results.length",
        sync_status: "success"
      }
    }}
  ]
}
```

### 6. Tagging System

```typescript
await storage.setCollectionMetadata('media/tutorial-videos', {
  tags: ['video', 'tutorial', 'education'],
  visibility: 'public',
  categories: ['technology', 'programming'],
  language: 'en',
  license: 'CC-BY-4.0'
});
```

### 7. Version/Stage Tracking

```typescript
await storage.setCollectionMetadata('datasets/ml-training-v2', {
  name: 'ML Training Dataset v2',
  version: '2.0.0',
  stage: 'production',
  previous_version: 'datasets/ml-training-v1',
  changelog: 'Added 10K new samples, fixed label errors',
  validated: true
});
```

### 8. Bookmark Context

```typescript
await storage.setCollectionMetadata('bookmarks/deno-resources', {
  name: 'Deno Learning Resources',
  description: 'Curated resources for learning Deno',
  prompt: 'Prioritize official docs and practical examples.',
  quality: 'high',
  last_reviewed: '2025-11-20',
  tags: ['deno', 'typescript', 'learning']
});
```

## 🔧 API Reference

### `setCollectionMetadata(collection, metadata)`

Set or merge metadata on a collection.

**Parameters**:
- `collection` (string): Collection name
- `metadata` (object): Metadata to set/merge

**Returns**: `Promise<void>`

**Example**:
```typescript
await storage.setCollectionMetadata('my-collection', {
  name: 'My Collection',
  tags: ['tag1', 'tag2']
});
```

### `getCollectionMetadata(collection)`

Get metadata from a collection (user-defined + system).

**Parameters**:
- `collection` (string): Collection name

**Returns**: `Promise<Record<string, any>>`

**Example**:
```typescript
const metadata = await storage.getCollectionMetadata('my-collection');
// { name, tags, created, updated, ... }
```

## ✅ Module Functions

### `smallstore/setMetadata`

**Input**:
```typescript
{
  collection: string;
  metadata: Record<string, any>;
}
```

**Output**:
```typescript
{
  success: boolean;
  collection: string;
  metadata: Record<string, any>;
}
```

**Example**:
```typescript
{
  module: "smallstore/setMetadata",
  input: {
    collection: "research/papers",
    metadata: {
      name: "Research Papers",
      prompt: "Focus on recent publications"
    }
  }
}
```

### `smallstore/getMetadata`

**Input**:
```typescript
{
  collection: string;
}
```

**Output**:
```typescript
{
  collection: string;
  metadata: Record<string, any>;
}
```

**Example**:
```typescript
{
  module: "smallstore/getMetadata",
  input: {
    collection: "research/papers"
  }
}
```

## 📊 Integration with Other Features

### Works With:
- ✅ **Introspection** - Metadata visible in `smallstore/introspect`
- ✅ **Empty Collections** - Can set metadata before adding data
- ✅ **All Adapters** - Stored in metadata adapter (usually Upstash/Memory)
- ✅ **Pipelines** - Full module support for workflows
- ✅ **Views** - Can query metadata when creating materialized views

### Combines Well With:
- **Views** - Add prompts to view definitions
- **Search** - Tag collections for better organization
- **F2/R2 Storage** - Add metadata to file collections
- **External Sources** - Document external data sources

## 🧪 Testing

**5 comprehensive tests** (`tests/test-collection-metadata.ts`):

1. ✅ Set and get basic metadata
2. ✅ Folder prompts
3. ✅ Merge with existing
4. ✅ Arbitrary keys
5. ✅ Empty collection (no data yet)

```bash
$ deno test tests/test-collection-metadata.ts

ok | 5 passed | 0 failed (3ms)
```

## 🎉 Benefits

1. **Organization** - Add human-readable names and descriptions
2. **Context** - Folder prompts provide workflow instructions
3. **Automation** - Track sync status, timestamps, source info
4. **Search** - Tag collections for better discovery
5. **AI Integration** - Use prompts in AI workflows
6. **Documentation** - Notes and descriptions for future you
7. **Flexibility** - Store any metadata you need

## 📖 Example Flows

See [metadata.examples.ts](./modules/compositions/smallstore/v3/examples/metadata.examples.ts) for 8 complete, real-world examples.

---

**"Organize your data with context, not just structure."** 🏷️

