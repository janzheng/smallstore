# Smallstore

Active work. See `TASKS.done.md` for shipped work; `TASKS-MAP.md`, `TASKS-DESIGN.md`, `TASKS-AUDIT.md`, `TASKS-TESTS.md`, `TASKS-MESSAGING.md` for area backlogs.

## Current

- [!] Messaging plugin family (Inbox + Channel + later Outbox) — design done, ready to build `-> .brief/messaging-plugins.md` `-> TASKS-MESSAGING.md` #messaging #area

## Later

- [ ] Publish to npm (`deno task build:npm && cd dist && npm publish`) #npm-publish
- [ ] Test and validate npm build works in Node.js projects #npm-validate
- [ ] Migrate coverflow-workers into smallstore-owned worker `-> foxfire .brief/smallstore-workers-takeover.md` #infra
- [*] **Sheetlog adapter `set()` is destructive — added non-destructive `append()` path** #sheetlog #bug 2026-04-21
    - Added `append?(items)` to `StorageAdapter` interface
    - Implemented `SheetlogAdapter.append(items)` — direct wrap of `client.dynamicPost()`, bypasses the destructive `set()` bulkDelete
    - Added `Smallstore.append(collectionPath, items)` router method with append-specific mount resolution (bare collection paths match `pattern/*` mounts, unlike routeData which requires trailing segment)
    - Added `POST /api/:collection/append` HTTP handler (`handleAppend`) — returns 501 if adapter doesn't implement native append
    - Added `sm_append` MCP tool (new MCP tool registration requires client restart)
    - Tested end-to-end against the faves yawnxyz sheet: test row landed, existing rows preserved
    - Docs remaining: update `examples/.smallstore.json.sheetlog-docs.md` and the MCP `SKILL.md` to reference `sm_append` / `/append` endpoint for sheetlog writes; mark the old "per-row keys for append-style logging" advice as deprecated (it doesn't actually work). **This is a doc-only TODO.**
- [ ] ~~Sheetlog adapter original TODO (superseded above)~~
    - Discovered 2026-04-21 during faves `/faves:add` work: `sm_write("yawnxyz", key, data)` → `sheetlog.set()` at `src/adapters/sheetlog.ts:131` calls `bulkDelete(ids)` on every existing row, then inserts. The `key` arg is documented as `@param key - Storage key (ignored)` — so callers can't scope the wipe. A single `sm_write` destroys the entire sheet.
    - Worse: `examples/.smallstore.json.sheetlog-docs.md` and the smallstore agent-skill `SKILL.md` both say "use per-row keys for append-style logging" — that's incorrect for this adapter. Callers following the docs would lose data.
    - Workaround users currently need: bypass smallstore, hit the Apps Script webapp directly with `{method: DYNAMIC_POST, sheet, payload: [...]}`. See `__resources/collections/faves/_tools/add-to-sheet.ts` for a working example.
    - Proposed fix (in order of preference):
        1. Add an `append(items)` method to the sheetlog adapter that wraps `client.dynamicPost(items)` directly (no wipe). Expose via a new MCP tool `sm_append` — clean separation from `sm_write`'s current "replace whole sheet" semantics.
        2. Update `set(key, value)` to differentiate: if `value` is a single object, append; if array, replace. Keeps MCP surface area small but changes semantics of existing `sm_write` calls.
        3. At minimum: fix the misleading docs. The current "per-row keys for append-style logging" pattern is not supported. Note the sheet-as-single-collection reality in the user-facing docs.
    - Scope: small. The sheetlog client (`src/clients/sheetlog/client.ts`) already has a `dynamicPost()` primitive — the fix is plumbing.
    - **Additional findings from 2026-04-21 pilot test — status update:**
        - **Bug #2 (DYNAMIC_POST silent-accept without `_id`): PATCHED upstream** in sheetlog.js (`/Users/janzheng/Desktop/Projects/__active/sheetlog/sheetlog.js`) — `handlePost` and `handleDynamicPost` now auto-generate `_id` when the column exists and the payload omits it. Response now includes the generated id(s) as `{_id: 123}` or `{_ids: [...]}`. **Awaiting GAS redeploy** to take effect.
        - **Bug #3 (UPSERT with `idColumn: "url"` doesn't match): NOT REPRODUCED cleanly**, possibly a timing artifact from the pilot test. Deferred pending a clean repro.
        - **Bug #4 (BULK_DELETE/DELETE by `_id` value vs row-number): PATCHED upstream** in sheetlog.js — `handleDelete` and `handleBulkDelete` now accept a `byId: true` flag to treat the id/ids as `_id` column values (resolved to row numbers via `findRowIndexById`). Default behavior unchanged (row-numbers). **Awaiting GAS redeploy.** Smallstore client types should be updated to reflect the new `byId` parameter once the deploy is confirmed.
- [*] LLM/agent features → see [TASKS-MAP.md Phase 8](./TASKS-MAP.md) (rerank, context window, RAG pipeline, semantic recall, working memory, etc.)

## Validation Holes

Pre-existing gaps from the 0.1.0 publish validation — none blocking, just need credentials to flip:

- [ ] `deno task interview:serve` — needs `GROQ_API_KEY` or `OPENAI_API_KEY`
- [ ] `deno task auth:airtable` — needs Airtable env vars
- [*] `deno task paste` — `.env` loading bug (pre-existing, not a publish blocker)
- [*] Cloudflare DO live test — DO binding not active on deployed worker (12/13 live adapter tests green)

## Dependency Notes

- [*] **Zod 4 migration shipped in coverflow on 2026-04-20** (`coverflow-v3` commits `2b9f8c04` + `c37d9722` + `36546951`). Smallstore is unaffected — grep confirms zero zod imports in `src/`. The "smallstore Zod schemas need updating too" note from the original v3-vs-v4 standoff turned out to be moot.
- [*] **Notion v5 cleanup learnings from coverflow** (cross-reference `/Users/janzheng/Desktop/Projects/_deno/coverflow/coverflow-v3` Archive section in TASKS.md):
  - The SDK v5 `after` param on `blocks.children.append` is `@deprecated` in types but still accepts at runtime. Coverflow added `position` support alongside `after` — same change applied here on 2026-04-21
  - Coverflow had a dead `shared/notion/api/` wrapper directory (13 files, zero imports) that hard-coded a v4-only `databases.query` call. Worth a periodic grep here for similar abandoned wrappers — they'd silently break a future bump
  - Coverflow's `notionModern.queryDatabase()` uses dataSources.query exclusively. Smallstore's version is more sophisticated — has SDK v4 fallback + raw HTTP fallback for older API versions. Keep the smallstore approach
- [*] @notionhq/client v5 and @modelcontextprotocol/sdk v1.29 both accept zod ^3.25 || ^4.0 — no forced upgrade if smallstore ever does add zod schemas
