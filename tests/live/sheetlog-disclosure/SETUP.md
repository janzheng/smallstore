# Progressive Notes Live Test (Sheetlog)

## What This Tests

Progressive disclosure over notes stored in Google Sheets:

- **Store notes** across topics (research, recipes, bookmarks)
- **Register skills**: research-explorer, recipe-finder, bookmark-search
- **discoverRelevant**: find matching notes by query
- **disclose**: progressive depth (summary → overview → detailed → full)
- **Cross-topic query**: "ai" matches across research + bookmarks

## Prerequisites

Same as `deno task live:sheets` — a Google Sheet with Sheetlog Apps Script.

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_SHEET_URL` | Yes | Sheetlog Apps Script URL |
| `SM_SHEET_NAME` | No | Sheet tab name (default: SmallstoreTest) |

## Run

```bash
deno task live:sheetlog-disclosure
```

## Architecture

- Notes stored in Sheetlog (visible in Google Sheets)
- Disclosure skills and indexes stored in memory
- ProgressiveStore wraps Smallstore with skill matching + summarization
