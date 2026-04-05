# Live Test Scenarios

Realistic, multi-feature live tests that combine adapters with higher-level
smallstore systems (graph, disclosure, episodic, views, etc.).

Each scenario is a self-contained test that demonstrates a real use case.

---

## 1. Graph CRM (Notion) — DONE

**Features**: Graph + Notion adapter
**Folder**: `tests/live/notion-graph-crm/`
**Task**: `deno task live:notion-graph-crm`

A personal CRM where contacts, companies, and introductions form a relationship
graph backed by Notion.

**What it does:**
- Store people and companies as graph nodes in Notion
- Create edges: `works_at`, `knows`, `introduced_by`
- Traverse: "Who does Alice know?"
- Path finding: "How is Alice connected to Dan?" (shortest path)
- Graph stats: node count, edge count, relationship types

---

## 2. Progressive Notes / Second Brain (Sheetlog) — DONE

**Features**: Disclosure + Sheetlog adapter
**Folder**: `tests/live/sheetlog-disclosure/`
**Task**: `deno task live:sheetlog-disclosure`

A personal knowledge base where notes are stored in Google Sheets with progressive
disclosure — ask a question, get relevant notes at increasing detail levels.

**What it does:**
- Store notes across topics (research, recipes, bookmarks) in Sheets
- Register disclosure skills: "research-explorer", "recipe-finder", "bookmark-search"
- `discoverRelevant("AI papers")` → finds matching skills
- Progressive depth: summary → overview → detailed → full

---

## 3. Episodic Research Journal (Notion) — DONE

**Features**: Episodic + Notion adapter
**Folder**: `tests/live/notion-episodic/`
**Task**: `deno task live:notion-episodic`

A research journal where findings are stored as episodes with timestamps,
importance, and natural decay — older, less-accessed memories fade unless recalled.

**What it does:**
- `remember(finding, { source, tags, importance })`
- `recall({ tags: ['ml'], limit: 5 })` → recent ML findings
- `getTimeline({ limit: 20 })` → chronological research history
- `applyDecay({ threshold: 0.1 })` → archive stale findings
- Recall boost: accessing a memory increases its importance

---

## 4. Multi-Adapter Network (Notion + Sheetlog) — DONE

**Features**: Graph + Namespace + Notion + Sheetlog adapters
**Folder**: `tests/live/multi-adapter-network/`
**Task**: `deno task live:multi-adapter`

Contacts live in Notion, meeting notes live in Sheets, and a graph connects them.

**What it does:**
- People records in Notion, meeting notes in Sheetlog
- Graph edges: `alice --attended--> standup`
- Cross-adapter query: "What meetings did Alice attend?"
- List keys from both stores

---

## 5. Blob CRM (Airtable + R2) — DONE

**Features**: Blob middleware + Airtable + R2 adapters
**Folder**: `tests/live/airtable-blobs/`
**Task**: `deno task live:airtable-blobs`

Contacts in Airtable with profile photos and documents stored in R2. The blob
middleware intercepts file fields, uploads to R2, and formats URLs for Airtable's
attachment format.

---

## 6. Materialized Reports (Sheetlog) — DONE

**Features**: Materializers + FilterRetriever + Sheetlog adapter
**Folder**: `tests/live/sheetlog-views/`
**Task**: `deno task live:sheetlog-views`

Store project tasks, filter into views, export as CSV/Markdown/JSON.

**What it does:**
- Store 10 tasks with varied status/priority/assignee
- Filter with FilterRetriever (high-priority, by-assignee)
- Materialize as CSV, Markdown, JSON
- Verify output format

---

## 7. Hierarchical Wiki (Notion + Namespace) — DONE

**Features**: Namespace + Retrievers + Notion adapter
**Folder**: `tests/live/notion-wiki/`
**Task**: `deno task live:notion-wiki`

A hierarchical wiki where pages are organized in namespaces and retrievable
with different strategies (full text, metadata only, filtered).

**What it does:**
- Create pages across namespaces: engineering, product, onboarding
- `buildTree()` → full hierarchy
- MetadataRetriever → titles and paths
- TextRetriever → extract text content
- FilterRetriever → pages matching criteria (e.g., "spec" tag)

---

## Running Tests

```bash
# Individual scenarios
deno task live:notion-graph-crm
deno task live:notion-episodic
deno task live:notion-wiki
deno task live:sheetlog-disclosure
deno task live:sheetlog-views
deno task live:multi-adapter
deno task live:airtable-blobs

# Adapter-level tests
deno task live:airtable
deno task live:notion
deno task live:sheets
deno task live:r2

# Cleanup
deno task live:cleanup         # Dry run
deno task live:cleanup:confirm # Actually delete stale rows
```

## Notes

- All tests leave data in the backend so you can visually inspect it
- Each test is runnable independently with its own SETUP.md
- Tests create unique IDs (timestamp-based) to avoid collisions
- Tests print clear step-by-step output like the existing adapter tests
