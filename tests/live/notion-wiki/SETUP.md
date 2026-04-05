# Hierarchical Wiki Live Test (Notion)

## What This Tests

Wiki pages organized in namespaces with different retrieval strategies:

- **Namespace tree**: `wiki/engineering/`, `wiki/product/`, `wiki/onboarding/`
- **MetadataRetriever**: titles and paths only
- **TextRetriever**: extract text content
- **FilterRetriever**: pages matching tag criteria
- **buildTree**: hierarchical namespace visualization

## Prerequisites

Same as `deno task live:notion`.

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_NOTION_SECRET` | Yes | Notion integration token |
| `SM_NOTION_DATABASE_ID` | Yes | Database ID |

## Run

```bash
deno task live:notion-wiki
```

## Architecture

- Wiki pages stored in Notion with hierarchical key paths
- Retrievers are pure functions that transform stored data
- buildTree constructs a virtual filesystem view from flat keys
