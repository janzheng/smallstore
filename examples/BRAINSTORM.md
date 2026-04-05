# Example Apps — Brainstorm

Test apps to validate smallstore as a standalone package. Each app is a single `.ts` file that exercises real-world patterns directly via `createSmallstore()` and/or the API server.

Goal: prove smallstore works for real use cases, stress-test presets, and **hit every feature** at least once across the example suite.

---

## Smallstore Feature Inventory

### Core CRUD
- [ ] `set()` — store data (append mode)
- [ ] `set(_, _, { mode: 'overwrite' })` — replace data
- [ ] `get()` — retrieve data
- [ ] `patch()` — merge/update fields
- [ ] `delete()` — remove data
- [ ] `has()` — check existence
- [ ] `keys()` — list keys in collection
- [ ] `clear()` — wipe collection

### Search & Query
- [ ] `search()` — FTS5 full-text search
- [ ] `query()` — structured filters (eq, contains, gt, lt, etc.)
- [ ] `listCollections()` — list all collections (with glob pattern)

### Views & Retrieval
- [ ] `view()` — named retrieval pipelines (saved queries)
- [ ] ViewManager — create/update/delete/list views
- [ ] Retrievers — filter, slice, text, structured, metadata, flatten

### Namespace & Tree
- [ ] `tree()` — hierarchical tree view
- [ ] `getNamespace()` — get all data under a path
- [ ] `copy()` — copy between paths
- [ ] `move()` — move between paths

### Content Export (Materializers)
- [ ] JSON export
- [ ] CSV export
- [ ] Markdown export
- [ ] YAML export
- [ ] Text export

### Graph Store
- [ ] `addNode()` / `getNode()` / `removeNode()`
- [ ] `addEdge()` / `getEdge()` / `removeEdge()`
- [ ] `getRelated()` — find connected nodes
- [ ] `findPath()` — shortest path
- [ ] Query builder — from/traverse/where/depth
- [ ] `listNodes()` / `listEdges()` — enumerate
- [ ] `export()` / `import()` — graph serialization

### Episodic Memory
- [ ] `addEpisode()` — store time-stamped memories
- [ ] `recall()` — retrieve with time decay
- [ ] `getTimeline()` — chronological episodes
- [ ] Decay functions — exponential, linear, step

### File Explorer
- [ ] `browse()` — list files in namespace
- [ ] File metadata — size, mime type, dates

### API-Specific
- [ ] REST CRUD (POST/GET/PUT/PATCH/DELETE /store/:path)
- [ ] Webhooks (POST /hooks/:col — auto-timestamped)
- [ ] Search endpoint (GET /store/:col/_search?q=)
- [ ] Query endpoint (POST /store/:col/_query)
- [ ] Auth (Bearer token)
- [ ] CORS
- [ ] Collections listing

### Adapters & Presets
- [ ] `memory` preset
- [ ] `local-sqlite` preset (FTS5 + queries)
- [ ] `structured` preset (typed SQL tables)
- [ ] Type routing (object vs blob vs kv)
- [ ] Mount routing (pattern-based adapter selection)
- [ ] Config file (`.smallstore.json`)

---

## The Apps (3 deep apps, 100% feature coverage)

### 1. Web Clipper (Bookmarks + Notes + Files)

Personal web clipper / second brain. Save URLs, write notes, attach files — all searchable. Like a personal Notion + Pinboard + Readwise.

**Collections:**
- `clips/bookmarks` — saved URLs with metadata
- `clips/notes` — freeform text notes (markdown)
- `clips/files` — file metadata + references
- `clips/tags` — tag index for fast lookups

**Data shapes:**
```json
// Bookmark
{
  "type": "bookmark",
  "url": "https://...",
  "title": "How Transformers Work",
  "excerpt": "First 200 chars of page content...",
  "tags": "ai,transformers,explainer",
  "notes": "Great visual explanation of attention",
  "source": "manual",
  "saved": "2024-03-15T..."
}

// Note
{
  "type": "note",
  "title": "Meeting Notes — Project Alpha",
  "content": "## Summary\n\nDiscussed timeline for Q2...",
  "tags": "meeting,project-alpha",
  "created": "2024-03-15T...",
  "updated": "2024-03-15T..."
}

// File reference
{
  "type": "file",
  "filename": "architecture-diagram.png",
  "mimeType": "image/png",
  "sizeBytes": 45000,
  "tags": "diagram,architecture",
  "notes": "System architecture as of March 2024"
}
```

**Features exercised:**
- CRUD: set, get, patch, delete, has, keys, clear
- Search: FTS5 across titles + notes + content + excerpts
- Query: filter by type, tags, date range, source
- Views: "unread bookmarks", "recent notes", "all tagged:ai"
- Tree: browse `clips/bookmarks/`, `clips/notes/`, `clips/files/`
- Namespace: `getNamespace('clips')` for everything, `copy`/`move` to reorganize
- Materializers: export bookmarks as CSV, notes as Markdown, everything as JSON
- File Explorer: browse files with metadata
- Presets: `local-sqlite` (primary), `memory` (test mode)
- Type routing: objects vs blobs

---

### 2. Mini CRM (Contacts + Deals + Graph + Episodic Memory)

Contact/deal tracker with relationship graph and interaction memory.

**Collections:**
- `crm/contacts` — people
- `crm/companies` — organizations
- `crm/deals` — opportunities
- `crm/interactions` — meeting notes, emails, calls

**Data shapes:**
```json
// Contact
{
  "name": "Alice Smith",
  "email": "alice@example.com",
  "company": "Acme Corp",
  "role": "CTO",
  "tags": "investor,warm-lead",
  "lastContact": "2024-03-01T..."
}

// Deal (structured preset)
{
  "name": "Series A — Acme Corp",
  "stage": "negotiation",
  "value": 500000,
  "closeDate": "2024-06-01",
  "owner": "Bob"
}

// Interaction (episodic)
{
  "contactId": "contact_abc",
  "type": "meeting",
  "notes": "Discussed Series A terms, interested in leading",
  "sentiment": "positive",
  "date": "2024-03-15T..."
}
```

**Features exercised:**
- CRUD + patch (update deal stages, contact info)
- Search: across notes, names, companies
- Query: filter by tag, stage, company, date range, sentiment
- listCollections: `listCollections('crm/*')`
- Graph: contact → company, contact → deal, deal → interaction
- Graph traversal: "who at Acme Corp is connected to our deals?"
- Graph query builder: from(contact).traverse('works_at').where({type: 'company'})
- Graph findPath: trace from deal back to original contact
- Graph listNodes / listEdges: enumerate the graph
- Graph export / import: snapshot and restore CRM state
- Episodic memory: interaction history with time decay (recent contacts surface first)
- Episodic recall: "what did we last discuss with Alice?"
- Episodic timeline: chronological view of all interactions
- Structured preset: typed `deals` table with columns (name, stage, value, close_date)
- Presets: `local-sqlite` (primary), `memory` (test mode)

---

### 3. Event Hub (Webhooks + Email Digest + Views)

Event ingestion from multiple sources with email processing, views, and content export. Fire-and-forget webhook receiver that also processes emails and creates digests.

**Collections:**
- `events/github` — GitHub webhooks
- `events/stripe` — payment events
- `events/custom` — arbitrary events
- `inbox/messages` — raw emails received via webhook
- `inbox/labels` — label definitions
- `inbox/digests` — daily summaries

**Data shapes:**
```json
// GitHub Event (via webhook)
{
  "event": "push",
  "repo": "acme/api",
  "branch": "main",
  "commits": 3,
  "author": "alice"
}

// Email (via webhook)
{
  "from": "alice@example.com",
  "subject": "Q2 Planning",
  "body": "Hi team, let's discuss the Q2 roadmap...",
  "read": false,
  "labels": "work,planning",
  "received": "2024-03-15T..."
}
```

**Features exercised:**
- Webhooks: `POST /hooks/events` with `X-Source` header for events
- Webhooks: `POST /hooks/inbox` for email ingestion
- Auto-timestamped keys
- CRUD: patch to add labels, mark emails read
- Search: FTS5 across all event collections + email subject/body
- Query: filter by source, event type, date range, sender, read status
- Keys: list timestamped entries
- Collections: `listCollections('events/*')` — discover event sources
- Views: "unread" view, "this week" view, "from:alice" view
- ViewManager: create/update/delete views programmatically
- Retrievers: filter (unread), slice (last 10), text (body only)
- Content export: events as CSV, email digest as Markdown, YAML export
- Mount routing: route `events/stripe/*` to a different adapter
- Config file: `.smallstore.json` with mount rules
- Auth: API key required for write endpoints
- Presets: `local-sqlite` (primary), `memory` (test mode)

---

## Feature Coverage Matrix

| Feature | Clipper | CRM | Event Hub |
|---------|:-------:|:---:|:---------:|
| **Core CRUD** | | | |
| set (append) | x | x | x |
| set (overwrite) | x | x | |
| get | x | x | x |
| patch | x | x | x |
| delete | x | x | |
| has | x | | |
| keys | x | | x |
| clear | x | | |
| **Search & Query** | | | |
| search (FTS5) | x | x | x |
| query (filters) | x | x | x |
| listCollections | | x | x |
| **Views** | | | |
| view() | x | | x |
| ViewManager | | | x |
| Retrievers | | | x |
| **Namespace** | | | |
| tree | x | | |
| getNamespace | x | | |
| copy / move | x | | |
| **Content Export** | | | |
| JSON | x | | |
| CSV | x | | x |
| Markdown | x | | x |
| YAML | | | x |
| Text | x | | |
| **Graph** | | | |
| Nodes + Edges | | x | |
| getRelated | | x | |
| findPath | | x | |
| Query builder | | x | |
| listNodes / listEdges | | x | |
| export / import | | x | |
| **Episodic** | | | |
| addEpisode | | x | |
| recall (decay) | | x | |
| timeline | | x | |
| **File Explorer** | | | |
| browse | x | | |
| file metadata | x | | |
| **API** | | | |
| REST CRUD | x | x | x |
| Webhooks | | | x |
| Auth (Bearer) | | | x |
| **Presets** | | | |
| memory | x | x | x |
| local-sqlite | x | x | x |
| structured | | x | |
| Type routing | x | | |
| Mount routing | | | x |
| Config file | | | x |

**Coverage**: Every feature is exercised by at least one app. Three apps → 100% of the feature surface.

---

## Priority Order

1. **Web Clipper** — widest feature coverage, most relatable use case
2. **Mini CRM** — graph, episodic, structured preset, complex queries
3. **Event Hub** — API, webhooks, auth, mounts, views, retrievers

---

## Implementation Plan

### Phase 1: Direct store scripts
Each app is a `<name>.ts` file:
1. Create store (`local-sqlite` preset)
2. Seed realistic data (20-50 records)
3. Exercise all listed features
4. Print results with assertions
5. Clean up SQLite DB

### Phase 2: API client scripts
Same apps as `<name>-api.ts`:
1. Expect API server running (`deno task api`)
2. All operations via `fetch()` to `localhost:8787`
3. Validate HTTP responses

### Phase 3: Stress tests
`<name>-stress.ts` files:
1. Bulk data (1000+ records)
2. Concurrent reads + writes
3. Measure latency percentiles
4. Report throughput
