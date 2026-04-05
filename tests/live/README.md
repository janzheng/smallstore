# Live Adapter Tests

Interactive tests that require real backend credentials. These are NOT run
automatically — you run them manually when setting up or debugging adapters.

Each adapter has its own folder with a `SETUP.md` containing full setup instructions.

## Structure

```
tests/live/
├── sheetlog/        # Google Sheets via Sheetlog
│   ├── SETUP.md     # Setup instructions + gotchas
│   └── test.ts      # Test script
├── airtable/        # Airtable adapter
│   ├── SETUP.md
│   └── test.ts
├── r2/              # Cloudflare R2 direct
│   ├── SETUP.md
│   └── test.ts
├── notion/          # Notion adapter
│   ├── SETUP.md
│   └── test.ts
└── blobs/           # Blob middleware (R2 + F2)
    ├── SETUP.md
    └── test.ts
```

## Running

```bash
deno task live:sheets      # Google Sheets
deno task live:airtable    # Airtable
deno task live:r2          # Cloudflare R2
deno task live:notion      # Notion
deno task live:blobs       # Blob middleware
```

Each script checks for required env vars and exits with setup instructions if missing.

## Quick Env Reference

```bash
# Google Sheets (Sheetlog)
SM_SHEET_URL=https://script.google.com/macros/s/.../exec
SM_SHEET_NAME=SmallstoreTest

# Airtable
SM_AIRTABLE_API_KEY=pat...
SM_AIRTABLE_BASE_ID=appXXXXX
SM_AIRTABLE_TABLE_NAME=SmallstoreTest

# Cloudflare R2
SM_R2_ACCOUNT_ID=...
SM_R2_ACCESS_KEY_ID=...
SM_R2_SECRET_ACCESS_KEY=...
SM_R2_BUCKET_NAME=smallstore-test

# Notion
SM_NOTION_SECRET=secret_...
SM_NOTION_DATABASE_ID=...

# F2 (Fuzzyfile proxy to R2)
F2_URL=https://f2.phage.directory
F2_TOKEN=...
```
