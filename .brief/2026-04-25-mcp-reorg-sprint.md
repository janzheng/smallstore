# 2026-04-25 — MCP reorg + tool family expansion (late afternoon)

**Status:** shipped
**Prior sprints today:** `.brief/2026-04-25-curation-sprint.md` (morning) → `.brief/2026-04-25-peer-registry-sprint.md` (afternoon) → this one
**Deployed:** no redeploy needed (MCP server is a local Deno stdio process; users get it via sync to `~/.claude/skills/` + MCP restart)

## What shipped

Monolithic `src/mcp-server.ts` (505 LOC) split into `src/mcp/` with per-family tool files. Two new tool families added alongside the existing core. **33 MCP tools now live**: 10 core + 15 inbox + 8 peers. Canonical `skills/smallstore/SKILL.md` updated + synced through the hub to all installed-skills dirs. 1203/1203 tests green.

```
a798d1d  MCP reorg: src/mcp-server.ts → src/mcp/ + sm_inbox_* + sm_peers_* tool families
a6c3185b (mcp-hub) Refresh smallstore skill from project repo (237 LOC, 33 tools)
```

## The reorg pattern

Five-file structure that any future tool-family addition reuses:

```
src/mcp/
├── config.ts          env validation (SMALLSTORE_URL/TOKEN/MAX_RESPONSE_BYTES)
├── http.ts            shared HTTP forwarder + readCapped (size-capped body buffer)
├── server.ts          composition layer — registers TOOLS + dispatches by family
├── mod.ts             entry point (Deno run target)
└── tools/
    ├── types.ts       Tool / Args / HttpFn / HttpResult + shared validators
    │                  (requireString, validateName, formatHttpError,
    │                  encodeCollectionKey)
    ├── core.ts        10 tools (sm_read/write/delete/append/list/query/
    │                  sync/sync_status/sync_jobs/adapters)
    ├── inbox.ts       15 tools (sm_inbox_*) — mailroom curation
    └── peers.ts        8 tools (sm_peers_*) — peer registry
```

`src/mcp-server.ts` stays as a 3-line shim that imports `src/mcp/mod.ts` — preserves existing `~/.claude.json` configs that reference that exact path.

### Extension contract (documented in `server.ts`)

Adding a new tool family = **four touches**:

1. Create `src/mcp/tools/<family>.ts` exporting `X_TOOLS: Tool[]` + `handleXTool(name, args, http): Promise<unknown>`
2. Import both in `server.ts`
3. Add `X_TOOL_NAMES: ReadonlySet<string> = new Set(X_TOOLS.map(t => t.name))`
4. Append to `ALL_TOOLS` + add to the dispatch chain

That's it. No router config, no plugin registration, no lifecycle hook. Reflects the plugin discipline pattern from `docs/design/PLUGIN-AUTHORING.md`.

## Two parallel agents + me, ~90 minutes

**Me, sequential:**
- `types.ts` — shared helpers (Tool, Args, HttpFn, HttpResult, requireString, validateName, formatHttpError, encodeCollectionKey)
- `config.ts` — env validation extracted from old monolith
- `http.ts` — HTTP forwarder extracted + `createHttpFn(config)` factory pattern
- `server.ts` — composition layer
- `mod.ts` — entry point
- `tools/core.ts` — migrated the existing 10 tools verbatim

**Agent A (inbox family, 508 LOC, 15 tools):**
- All mailroom curation ops: list/read/query/export/tag/delete, unsubscribe, quarantine_list/restore, rules CRUD + apply-retroactive
- Client-side arg validation mirrors server where cheap (`order` enum, `action` enum, "at-least-one-of add/remove" for tag)
- Snake-case MCP args mapped to camelCase at the server boundary (`skip_call` → `skipCall`, `timeout_ms` → `timeoutMs`)
- `sm_inbox_export` forces `format=json` (MCP can't stream JSONL — documented in description)

**Agent B (peers family, 378 LOC, 8 tools):**
- All peer-registry ops: list/get/create/update/delete, health, fetch, query
- Auth JSON schema kept permissive (object with required `kind` enum); server's runtime validator returns clean 400s for the deeper union shape — simpler than JSON Schema discriminators
- `client_query` on `sm_peers_fetch` merges with `path` via `URLSearchParams.append`
- Description calls out "secrets via `wrangler secret put` separately" footgun

**Zero merge conflicts.** File scopes disjoint by design (each family is a new file; only shared read is `types.ts` which I wrote before dispatching).

## Canonical skill alignment

User surfaced (correctly) that I'd edited only the smallstore repo's `skills/smallstore/SKILL.md` — the mcp-hub distribution copy was stale at 155 LOC while the canonical was 237 LOC with the new mailroom + peers sections.

Topology confirmed + memory-updated (`feedback_mcp_hub_skills_not_canonical.md`):

```
canonical  →  distribution  →  installed

_deno/apps/smallstore/skills/smallstore/SKILL.md      (edit here)
   ↓  (manual cp — no auto-pull)
mcp-hub/skills/smallstore/SKILL.md                    (build artifact)
   ↓  (mcp__deno-hub__hub_sync-skills)
~/.claude/skills/smallstore/SKILL.md                  (Claude Code)
~/.cursor/skills/smallstore/SKILL.md                  (Cursor)
~/.codex/skills/smallstore/SKILL.md                   (Codex)
~/.agents/skills/smallstore/SKILL.md                  (future tools)
```

Smallstore doesn't need a `skills-workshop/smallstore/` draft folder because smallstore IS its own project repo — the canonical sits there. Other skills without a project (chrome-cdp, etc.) live in `skills-workshop/` instead.

Synced as of `post-sync 2026-04-23T19-16-47Z` — verified in-session by the `smallstore` skill description appearing with the new "Canonical access surface for agents... sm_inbox_* ... sm_peers_*" language.

## End-state capabilities

Agents inside Claude Code (or Cursor, Codex) now have **33 tools** through a single bearer token — the canonical access surface:

**From the user's words earlier:** *"smallstore can 'know' about [other DBs]... plus add peers / new databases / new adapters into our canonical one, this is good."*

That's exactly what exists now:
- **Core** — any adapter (Notion / Airtable / Sheets / Upstash / R2 / SQLite / local / ...) through `sm_read/write/delete/list/query/append/sync/adapters`
- **Inbox** — mailroom curation (bookmarks / archive / rules / export / unsubscribe / quarantine / restore) through `sm_inbox_*`
- **Peers** — external data sources (tigerflare / sheetlogs / other smallstores / webdav) through `sm_peers_*`, all reachable via one auth

## Metrics

| Measure | Value |
|---|---|
| New tools | 23 (15 inbox + 8 peers) |
| Total MCP tools | 10 → 33 |
| LOC added | ~1250 net (505 LOC monolith replaced with distributed structure) |
| Tests | 1203/1203 green (updated tools/list expected from 10 → 33 entries) |
| Subagent dispatches | 2 parallel (inbox + peers) |
| Merge conflicts | 0 |
| Wall-clock | ~90 minutes |
| Live deploys | 0 (MCP is a local Deno stdio process; users get it via `hub:sync` + MCP restart) |

## What's queued (next)

- **Peers HTTP integration tests** — 8 routes are live-verified but have no unit coverage. `[?]` in `TASKS.md § Later → Peer registry`. Small polish, ~1 hour.
- **Raw + attachment inlining in inbox export** — `include=raw` base64s the .eml, `include=attachments` adds presigned URLs. `[?]`. Polish.
- **Level 3 compound peer adapter** — peer types implement `StorageAdapter`, `peer:name` routing targets. `[?]`. Weeks. Not needed until a real consumer demands it.

## Notable design decisions

1. **Backwards-compat shim at `src/mcp-server.ts`.** Any `~/.claude.json` registration referencing that exact path keeps working. New registrations can point at `src/mcp/mod.ts` directly.
2. **O(1) family dispatch via Sets.** `CORE_TOOL_NAMES`, `INBOX_TOOL_NAMES`, `PEERS_TOOL_NAMES` are `ReadonlySet<string>` — composed from each family's `X_TOOLS.map(t => t.name)`. Server checks `set.has(name)` to route.
3. **Shared `http: HttpFn` passed into every handler, never captured.** Keeps handlers pure-ish (inject dependencies) + makes them testable with a mock fetch.
4. **Canonical stays in project repo.** Skill lives at `_deno/apps/smallstore/skills/smallstore/SKILL.md` — NOT in mcp-hub (that's distribution) NOT in skills-workshop (smallstore has its own repo, doesn't need a draft). Memory updated so future agents don't drift again.
5. **Permissive JSON schemas, strict runtime validation.** Client-side schemas aren't worth the complexity for discriminated unions (peer auth `kind`, rule `action`); server's validators already return clean 400s.

## References

- Reorg commit: `a798d1d`
- Hub refresh commit: `a6c3185b` (in `mcp-hub` repo)
- Design precedents: `docs/design/PLUGIN-AUTHORING.md` (plugin invariants)
- Morning sprint: `.brief/2026-04-25-curation-sprint.md`
- Afternoon sprint: `.brief/2026-04-25-peer-registry-sprint.md`
- User-facing docs: `docs/user-guide/mailroom-quickstart.md` § Part 1 (mailroom) + Part 2 (peers)
- Canonical skill: `skills/smallstore/SKILL.md` in this repo (synced via mcp-hub to installed-skills dirs)
