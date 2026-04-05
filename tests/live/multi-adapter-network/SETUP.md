# Multi-Adapter Network Live Test (Notion + Sheetlog)

## What This Tests

Cross-adapter data with graph relationships:

- **People** stored in Notion
- **Meetings** stored in Sheetlog (Google Sheets)
- **Graph edges** connect people to meetings (attended)
- **Cross-store traversal**: "What meetings did Alice attend?" resolves from Sheetlog

## Prerequisites

- Working Notion adapter (run `deno task live:notion` first)
- Working Sheetlog adapter (run `deno task live:sheets` first)

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_NOTION_SECRET` | Yes | Notion integration token |
| `SM_NOTION_DATABASE_ID` | Yes | Database ID |
| `SM_SHEET_URL` | Yes | Sheetlog Apps Script URL |
| `SM_SHEET_NAME` | No | Sheet tab name (default: SmallstoreTest) |

## Run

```bash
deno task live:multi-adapter
```

## Architecture

- Two separate Smallstore instances (one for Notion, one for Sheetlog)
- GraphStore wraps the Notion store (graph indexes in memory)
- Meeting nodes store `metadata.sheetsKey` for cross-store lookup
- Traversal returns graph nodes; meeting details resolved from Sheetlog
