# Airtable Live Test

## What This Tests

CRUD operations against a real Airtable base via the direct adapter:
- **Create** records with auto-field-creation
- **Read** records back
- **Update** a record
- **List** all keys
- **Has** existence check

Uses `introspectSchema: true` + `unmappedStrategy: 'auto-create'` so the adapter
discovers existing fields and creates missing ones on the fly.

## Prerequisites

An Airtable account with a Personal Access Token.

## Setup Steps

### 1. Create an Airtable Base

Go to [airtable.com](https://airtable.com) and create a new base.

### 2. Create a Table

Add a table named **SmallstoreTest**. You only need the default **Name** column
to start — the adapter auto-creates the rest (`Email`, `Notes`, `Score`,
`_smallstore_key`) on the first `set()`.

If you want more control over field types, you can pre-create them:

| Column | Type |
|--------|------|
| Name | Single line text (default) |
| Email | Email |
| Notes | Long text |
| Score | Number |

### 3. Create a Personal Access Token

Go to [airtable.com/create/tokens](https://airtable.com/create/tokens) and create a token with scopes:
- `data.records:read`
- `data.records:write`
- `schema.bases:read` — required for schema introspection
- `schema.bases:write` — required for auto-creating fields

Grant access to your test base.

### 4. Get the Base ID

Open your base in Airtable. The URL looks like: `https://airtable.com/appXXXXXXXXXX/...`

The `appXXXXXXXXXX` part is your Base ID.

### 5. Set Environment Variables

Add to your `.env` (project root):

```bash
SM_AIRTABLE_API_KEY=patXXXXXXXX.XXXXXXXX
SM_AIRTABLE_BASE_ID=appXXXXXXXXXX
SM_AIRTABLE_TABLE_NAME=SmallstoreTest
```

## Run

```bash
deno task live:airtable
```

## What Happens

1. Introspects the table schema and auto-creates missing fields
2. Creates 3 test contacts (Alice, Bob, Carol) with Name, Email, Notes, Score
3. Reads each record back and verifies data
4. Updates Alice's score to 99
5. Lists all keys
6. Checks `has()` for existing and non-existing keys
7. Data is left in Airtable so you can inspect it

## Known Behaviors

- **Auto-field-creation**: The adapter creates missing fields via the Meta API on
  first `set()`. Number fields require `options: { precision: 0 }` — the adapter
  handles this automatically.
- **`_smallstore_key` field**: The adapter creates a hidden `_smallstore_key`
  column to store the Smallstore key (used for lookups). Don't delete it.
- **Field type inference**: The adapter infers types from values — strings become
  `singleLineText`, emails are detected as `email`, numbers become `number`.
- **Direct adapter mode**: This test uses the adapter directly (not via SmartRouter)
  to isolate adapter behavior. The SmartRouter adds metadata tracking on top.

## Env Vars Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SM_AIRTABLE_API_KEY` | Yes | — | Personal Access Token (`pat...`) |
| `SM_AIRTABLE_BASE_ID` | Yes | — | Base ID from URL (`app...`) |
| `SM_AIRTABLE_TABLE_NAME` | No | `SmallstoreTest` | Table name to write to |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `API key required` | Missing or wrong `SM_AIRTABLE_API_KEY` | Check `.env` has a valid `pat...` token |
| `table not found` | Wrong Base ID or table name | Verify `SM_AIRTABLE_BASE_ID` and table exists |
| `Failed to introspect schema` | Token missing `schema.bases:read` scope | Recreate token with required scopes |
| `Failed to create fields` | Token missing `schema.bases:write` scope | Add scope or pre-create fields manually |
| `INVALID_FIELD_TYPE_OPTIONS` | Field type needs options (e.g., number) | Fixed in adapter — update to latest |
