# Notion Live Test

## What This Tests

CRUD operations against a real Notion database via the direct adapter:
- **Create** records with auto-field-creation
- **Read** records back
- **Update** a record
- **List** all keys
- **Has** existence check

Uses `introspectSchema: true` + `unmappedStrategy: 'auto-create'` so the adapter
discovers existing properties and creates missing ones on the fly.

## Prerequisites

A Notion account with an internal integration.

## Setup Steps

### 1. Create a Notion Integration

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and create a new integration:
- Type: **Internal**
- Capabilities: **Read content**, **Update content**, **Insert content**

Copy the **Internal Integration Secret** (`secret_...`).

### 2. Create a Database

In Notion, create a new **full-page database**. You only need the default **Name**
(title) column to start — the adapter auto-creates the rest (`Email`, `Notes`,
`Score`, `_smallstore_key`) on the first `set()`.

**Important**: Use a **full-page database**, not an inline database view. The
database ID in the URL is what you need.

If you want more control over property types, you can pre-create them:

| Property | Type |
|----------|------|
| Name | Title (default) |
| Email | Email |
| Notes | Text (rich text) |
| Score | Number |

### 3. Share the Database with Your Integration

**This is the most commonly missed step.**

1. Open the database in Notion
2. Click the **...** menu (top right)
3. Click **"Add connections"** (or **"Connect to"**)
4. Search for your integration name and add it
5. Confirm the connection

Without this step, the API returns `object_not_found` even if your secret is valid.

### 4. Get the Database ID

Open the database in a browser. The URL looks like:
`https://www.notion.so/YOUR_DATABASE_ID?v=...`

The 32-character hex string before `?v=` is your Database ID.

**Gotcha**: Make sure you're copying the **database** ID, not a page or container ID.
If you're inside a page that contains the database, click into the database itself
first — the URL should change to show the database's own ID.

### 5. Set Environment Variables

Add to your `.env` (project root):

```bash
SM_NOTION_SECRET=secret_XXXXXXXXXXXXXXXXXXXX
SM_NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Run

```bash
deno task live:notion
```

## What Happens

1. Introspects the database schema and auto-creates missing properties
2. Creates a `_smallstore_key` rich_text property for key lookups
3. Creates 3 test contacts (Alice, Bob, Carol) with Name, Email, Notes, Score
4. Reads each record back and verifies data
5. Updates Alice's score to 99
6. Lists all keys
7. Checks `has()` for existing and non-existing keys
8. Data is left in Notion so you can inspect it

## Known Behaviors

- **Auto-field-creation**: The adapter creates missing properties via the database
  update API on first `set()`. Type inference determines property types (strings →
  `rich_text`, emails → `email`, numbers → `number`).
- **`_smallstore_key` property**: The adapter creates a hidden `_smallstore_key`
  rich_text column to store the Smallstore key (used for lookups). Don't delete it.
- **Direct adapter mode**: This test uses the adapter directly (not via SmartRouter)
  to isolate adapter behavior.
- **API version**: The adapter uses Notion API version `2022-06-28` for compatibility
  with `@notionhq/client@2.x`. Newer API versions (v5+) moved properties to
  `data_sources` which the SDK doesn't fully support yet.

## Env Vars Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_NOTION_SECRET` | Yes | Integration secret (`secret_...`) |
| `SM_NOTION_DATABASE_ID` | Yes | 32-char hex database ID from URL |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `object_not_found` | Database not shared with integration | Open database → ... → Add connections → select your integration |
| `object_not_found` | Wrong ID (page ID instead of database ID) | Click into the database itself and get the ID from that URL |
| `Unauthorized` | Invalid or expired secret | Regenerate secret at notion.so/my-integrations |
| `_smallstore_key is not a property that exists` | API version mismatch | Ensure adapter uses `notionVersion: '2022-06-28'` |
| `Cannot convert undefined or null to object` | API v5 returns no properties | Adapter should use v4 API; check notionVersion setting |
