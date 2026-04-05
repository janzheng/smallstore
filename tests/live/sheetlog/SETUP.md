# Sheetlog (Google Sheets) Live Test

## What This Tests

CRUD operations against a real Google Sheet via the Sheetlog Apps Script:
- **Create** rows with `dynamicPost()` (auto-creates columns)
- **Read** all rows back
- **Find** a specific row by column value
- **Upsert** (update or insert) a row

## Prerequisites

You need a Google Sheet with the [Sheetlog Apps Script](https://github.com/yawnxyz/sheetlog) deployed.

## Setup Steps

### 1. Create a Google Sheet

Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.

### 2. Deploy the Sheetlog Apps Script

1. In your sheet, go to **Extensions > Apps Script**
2. Replace the default code with the Sheetlog script from: https://github.com/yawnxyz/sheetlog
3. Click **Deploy > New deployment**
4. Choose **Web app**
5. Set **Execute as**: Me
6. Set **Who has access**: Anyone
7. Click **Deploy** and copy the URL (looks like `https://script.google.com/macros/s/AKfycb.../exec`)

### 3. Create a Test Tab with Column Headers

In your Google Sheet, create a tab/sheet named **SmallstoreTest**.

**Important**: You must add column headers in Row 1 before running the test.
Sheetlog requires at least 1 column to exist — an empty sheet returns a 400 error
("The number of columns in the range must be at least 1").

Add these headers in Row 1:

| A | B | C | D |
|---|---|---|---|
| Name | Email | Notes | Score |

### 4. Set Environment Variables

Add to your `.env` (project root):

```bash
SM_SHEET_URL=https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
SM_SHEET_NAME=SmallstoreTest
```

## Run

```bash
deno task live:sheets
```

## What Happens

1. Creates 3 test rows (Alice, Bob, Carol) with Name, Email, Notes, Score
2. Reads all rows back (response includes `_id` row numbers)
3. Finds Alice by name
4. Upserts Alice with an updated score (99)
5. Data is left in the sheet so you can inspect it

## Known Behaviors

- **Upsert replaces the full row**: When you upsert, any fields not included in the
  payload get blanked. For example, upserting `{ Name, Score, Notes }` without `Email`
  will clear the Email column. Include all fields in upsert calls to avoid data loss.
- **`_id` field**: Sheetlog returns a `_id` field with the row number (1-indexed,
  starting from row 2 since row 1 is headers).
- **`dynamicPost` auto-creates columns**: If you POST data with a field that doesn't
  have a column yet, Sheetlog creates the column header automatically. But the sheet
  must have at least one column header to start.

## Env Vars Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SM_SHEET_URL` | Yes | — | Sheetlog Apps Script deployment URL |
| `SM_SHEET_NAME` | No | `SmallstoreTest` | Tab/sheet name to write to |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `"The number of columns in the range must be at least 1"` | Empty sheet tab, no headers | Add column headers in Row 1 |
| `status: 401` | Apps Script not deployed as "Anyone" | Re-deploy with access: Anyone |
| `status: 404` | Wrong script URL | Check `SM_SHEET_URL` matches your deployment |
| Upsert blanks fields | Fields missing from upsert payload | Include all fields in upsert data |
