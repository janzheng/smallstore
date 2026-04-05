# Smallstore Publishing Guide

## Package Names

| Registry | Package Name | Command |
|----------|-------------|---------|
| JSR | `@smallstore/core` | `deno publish` |
| npm | `smallstore` | `cd dist && npm publish` |

## Pre-Publish Checklist

Before publishing, fix these known issues:

### JSR (`deno publish`)

- [ ] Add `"license": "MIT"` to `deno.json`
- [ ] Add `LICENSE` file
- [ ] Fix missing version constraints in source files:
  - `src/adapters/unstorage.ts` — `npm:unstorage` → `npm:unstorage@^1.17.0`
  - `src/adapters/unstorage.ts` — `npm:unstorage/drivers/upstash` → `npm:unstorage@^1.17.0/drivers/upstash`
  - `src/adapters/unstorage.ts` — `npm:unstorage/drivers/cloudflare-kv-binding` → add version
  - `src/adapters/unstorage.ts` — `npm:unstorage/drivers/cloudflare-r2-binding` → add version
  - `src/clients/notion/notionModern.ts` — bare `npm:@notionhq/client/...` → add version
  - `src/utils/env.ts` — `jsr:@std/dotenv/load` → add version
- [ ] Fix slow type issues (global augments in cloudflare adapters):
  - `src/adapters/cloudflare-kv.ts` — remove `declare global { interface KVNamespace }` (move to types file)
  - Or use `--allow-slow-types` flag (ok for now, not ideal)
- [ ] Fix type errors:
  - `src/adapters/f2-r2.ts:284` — cast `binaryData as BodyInit`
  - `src/clients/notion/notionModern.ts:31` — `QueryDataSourceResponse` doesn't exist in SDK v2

### npm (`deno task build:npm`)

- [ ] Run `deno task build:npm` to generate `dist/`
- [ ] Test: `cd dist && node -e "const s = require('./script/mod.js'); console.log(Object.keys(s))"`
- [ ] Test: `cd dist && node --input-type=module -e "import * as s from './esm/mod.js'; console.log(Object.keys(s))"`
- [ ] Verify `dist/package.json` has correct metadata
- [ ] `cd dist && npm publish --dry-run`

### Deno-only adapters (won't work in npm)

These adapters use Deno-specific APIs and won't work in Node.js:

| Adapter | Deno API Used | npm Alternative |
|---------|--------------|-----------------|
| SQLite | `jsr:@db/sqlite` | Use `better-sqlite3` |
| Structured SQLite | `jsr:@db/sqlite` | Use `better-sqlite3` |
| Local JSON | `Deno.readTextFile` / `Deno.writeTextFile` | Use `fs/promises` |
| Local File | `Deno.readFile` / `Deno.writeFile` | Use `fs/promises` |

Cloud adapters (Upstash, Airtable, Notion, Sheetlog, R2, CF KV/D1/DO, F2) use only `fetch` and work everywhere.

## Quick Commands

```bash
# Dry-run JSR publish
deno publish --dry-run --no-check --allow-slow-types

# Build npm package
deno task build:npm

# Dry-run npm publish
cd dist && npm publish --dry-run

# Actual publish (when ready)
deno publish                    # → JSR
cd dist && npm publish          # → npm
```

## Subpath Exports

Both JSR and npm support tree-shakeable subpath imports:

```typescript
// Full bundle (everything)
import { createSmallstore, createUpstashAdapter } from 'smallstore';

// Individual adapter (smaller bundle)
import { createUpstashAdapter } from 'smallstore/adapters/upstash';

// Individual module
import { createGraphStore } from 'smallstore/graph';
import { createEpisodicStore } from 'smallstore/episodic';
```
