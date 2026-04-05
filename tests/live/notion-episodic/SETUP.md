# Episodic Research Journal Live Test (Notion)

## What This Tests

Time-based episodic memory with decay, inspired by human memory:

- **Remember** research findings with timestamps and importance
- **Recall** by tags, by importance, by recency
- **Recall boost**: accessing a memory strengthens it
- **Timeline**: chronological view of all episodes
- **Decay**: old, unaccessed memories lose importance

## Prerequisites

Same as `deno task live:notion`.

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_NOTION_SECRET` | Yes | Notion integration token |
| `SM_NOTION_DATABASE_ID` | Yes | Database ID |

## Run

```bash
deno task live:notion-episodic
```

## Architecture

- Episodes stored in memory (episodic store internals)
- Uses `collectionPrefix` to namespace data per test run
- Decay is time-based: importance = initial * e^(-decay_rate * hours_elapsed)
