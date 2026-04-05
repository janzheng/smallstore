# Materialized Reports Live Test (Sheetlog)

## What This Tests

Store project tasks, filter into views, export as different formats:

- **Store tasks** with status, priority, assignee, due date
- **FilterRetriever**: high-priority tasks, tasks by assignee
- **materializeCsv**: export as CSV
- **materializeMarkdown**: export as Markdown table
- **materializeJson**: export as structured JSON

## Prerequisites

None — this test uses the memory adapter for fast materialization.

## Run

```bash
deno task live:sheetlog-views
```

## Architecture

- Tasks stored in memory adapter (no external service needed)
- Materializers are pure functions: `materializeCsv(store, collectionPath)`
- FilterRetriever applies field-level filters before materialization
