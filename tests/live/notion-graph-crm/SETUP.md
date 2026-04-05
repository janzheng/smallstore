# Graph CRM Live Test (Notion)

## What This Tests

Graph-based CRM with people/company nodes and relationship edges, backed by Notion.

- **Create** people and company nodes
- **Add edges**: works_at, knows, introduced_by, founded
- **Traverse**: "Who does Alice know?"
- **Path finding**: Alice → Dan (via knows chain)
- **Stats**: Node count, edge count, relationship types

## Prerequisites

Same as `deno task live:notion` — a Notion database with an integration token.

## Setup

1. Follow the Notion adapter setup (see `tests/live/notion/SETUP.md`)
2. The test uses the same database — graph indexes stay in memory

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_NOTION_SECRET` | Yes | Notion integration token |
| `SM_NOTION_DATABASE_ID` | Yes | Database ID |

## Run

```bash
deno task live:notion-graph-crm
```

## Architecture

- **People/companies** → stored in Notion (visible in UI)
- **Graph indexes** → stored in memory (`_graph/*` mount)
- GraphStore wraps the Smallstore instance, adding traversal and path-finding
