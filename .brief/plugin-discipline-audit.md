# Plugin discipline audit — readying smallstore for more plugins

**Status:** in-progress (started 2026-04-24)
**Unblocks:** `.brief/mailroom-pipeline.md` (mailroom implementation is the EOD goal today)
**From:** 2026-04-24 conversation after messaging audit surfaced a dependency leak

## Why now

User wants the option to add several new plugin families — messaging (in progress), obsidian (adapter + channel), rss (channel), webhook (channel, for agentic feeders dumping data), possibly tigerflare (adapter). These are **motivating examples, not this pass's work.** Before adding them, check the existing plugin shape holds up.

The concern is the "plugin-N tax": if the pattern is sloppy, each new plugin compounds the problem. Plugin #2 costs more than #1, #3 costs more than #2, etc. User's aspirational shape is `pi-mono`'s coding-agent — 4 built-in tools, everything else is an extension, core stays tiny. Smallstore is architected this way already (sub-entry points per plugin family in `package.json` exports), but discipline can erode without anyone noticing.

The work is preventative: make sure "plugin in/out easily" is actually true, document how to keep it true, then stop. Don't ship new plugins in this pass.

## The 4 invariants

A plugin is genuinely removable (= genuinely a plugin, not a hidden feature) when:

1. **Core never imports the plugin.** `src/adapters/*` has zero refs to `src/messaging/*`, `src/search/*`, etc. One-way dep: plugin → core, never reverse.
2. **Heavy deps are optional/peer, not core.** A plugin's unique npm dependencies should be in `peerDependencies` with `peerDependenciesMeta: { optional: true }`, and imported lazily inside the plugin's hot paths. Consumers who don't use the plugin don't pay.
3. **Each sub-entry point is self-contained.** `@yawnxyz/smallstore/messaging` imports from core only, never from `/search` or `/graph` or any other sibling plugin. No cross-plugin coupling.
4. **Plugin is deletable.** You can `rm -rf src/<plugin>/` and run `deno task build:npm && deno test` on core without errors. Root `mod.ts` must not re-export plugin internals.

## What's already done (2026-04-24)

Messaging family audited against the 4 invariants:

| # | Invariant | Result |
|---|---|---|
| 1 | Core never imports messaging | ✅ Zero refs from `src/adapters/` to `src/messaging/` |
| 2 | Heavy deps optional | ⚠️ **Failed** — `postal-mime` leaked into core `dependencies` |
| 3 | Sub-entry self-contained | ✅ Messaging imports only from `./messaging/*`, `@std/yaml`, `postal-mime` |
| 4 | Deletable | ✅ Neither `mod.ts` nor `presets.ts` references messaging |

Fix shipped same day:
- `src/messaging/channels/cf-email.ts` — top-level `import PostalMime from 'postal-mime'` → lazy `loadPostalMime()` helper with clear error if module missing
- `scripts/build-npm.ts` — `postal-mime` moved from `dependencies` to `peerDependencies` + `peerDependenciesMeta: { optional: true }`, matching the `hono` pattern. `postBuild()` updated to strip it from generated `dependencies`
- Verified: 18/18 cf-email tests still green; `deploy/package.json` still has `postal-mime` as a direct dep (correct — the app uses the channel, the library doesn't)

## Findings — full audit results (2026-04-24 second pass)

### Plugin families scored against the 4 invariants

| Family | I1 Core-no-import | I2 Heavy deps optional | I3 Self-contained | I4 Deletable | Verdict |
|---|---|---|---|---|---|
| `messaging` | ✅ | ✅ (after postal-mime fix) | ✅ | ✅ | **Clean plugin** |
| `graph` | ✅ | ✅ (no heavy deps) | ✅ | ✅ | **Clean plugin** |
| `episodic` | ✅ | ✅ (no heavy deps) | ✅ | ✅ | **Clean plugin** |
| `blob-middleware` | ✅ | ⚠️ uses `@aws-sdk/*` from core deps | ✅ | ✅ | **Leaks aws-sdk** |
| `http` | ✅ | ✅ (hono peer-optional) | ✅ | ⚠️ used by messaging | Plugin (semi-coupled) |
| `disclosure` | ✅ | ✅ | ✅ | ⚠️ used by retrieval | Plugin (semi-coupled) |
| `vault-graph` | ✅ | ✅ (jsr deno-only deps) | ✅ | ✅ | **Clean plugin** |
| `views` | N/A (used by core) | ✅ | ✅ | ❌ used by router | **Core module, not plugin** |
| `materializers` | N/A (used by core) | ✅ | ✅ | ❌ used by router | **Core module, not plugin** |
| `search` | N/A (used by 7 adapters) | ✅ | ✅ | ❌ used by adapters | **Core module, not plugin** |

**Not targets for discipline** (always-core): `utils`, `validation`, `namespace`, `keyindex`, `explorer`.

### Real plugin families: 7 (messaging, graph, episodic, blob-middleware, http, disclosure, vault-graph)

Of these, **6 are clean** (or become clean after blob-middleware's aws-sdk is lazy-loaded). `http` and `disclosure` are semi-coupled to messaging/retrieval respectively but the coupling is intentional (messaging reuses http's route registration; retrieval composes disclosure).

### Root `package.json` `dependencies` audit

| Dep | Used by | In root deps today? | Recommendation |
|---|---|---|---|
| `@notionhq/client` | `src/adapters/notion.ts` + `src/clients/notion/*` | ✓ Yes | Should be optional peer (follow-up) |
| `@aws-sdk/client-s3` | `src/adapters/r2-direct.ts` + `src/blob-middleware/resolver.ts` | ✓ Yes | Should be optional peer (follow-up) |
| `@aws-sdk/s3-request-presigner` | Same | ✓ Yes | Same |
| `unstorage` | `src/adapters/unstorage.ts` | ✓ Yes | Should be optional peer (follow-up) |
| `@upstash/redis` | `src/adapters/upstash.ts` | Not in npm deps (deno-only via imports) | Fine |
| `@modelcontextprotocol/sdk` | `src/mcp-server.ts` (top-level, separate entry) | ? | Modularly separated — fine |
| `@db/sqlite` | `src/vault-graph/store.ts` + `src/adapters/sqlite.ts` | JSR/deno-only | Fine |
| `@std/yaml` | `src/vault-graph/*` + `src/messaging/filter-spec.ts` | JSR | Fine |
| `@zvec/zvec` | zvec search provider (optional) | Already optional peer ✓ | Good |

### The architectural root cause

Root `mod.ts` re-exports **all adapters**, including heavyweight ones (notion, unstorage, r2-direct). This forces every third-party SDK into core `dependencies` because the barrel must resolve at import time. That's why `@notionhq/client`, `@aws-sdk/*`, `unstorage` leaked into core.

Three mitigations already exist:

1. **`factory-slim.ts`** — purpose-built "skip the adapter barrel" entry. Already used by `deploy/src/index.ts`. This is how messaging-on-Workers avoids the sprawl today.
2. **Per-adapter sub-entry-points in `deno.json`** — each adapter has its own path like `"./adapters/notion": "./src/adapters/notion.ts"`. So `import createNotionAdapter from '@yawnxyz/smallstore/adapters/notion'` is a valid import surface for tree-shaking.
3. **BUT**: these sub-entry-points are NOT in `scripts/build-npm.ts` `entryPoints` for most adapters (only the 5 CF adapters are there). So on npm, consumers can't use them cleanly — they have to go through the barrel.

### Fix paths (deferred to follow-up)

Not shipping these today — mailroom EOD takes priority:

- **Option A (clean, breaking):** remove adapter re-exports from root `mod.ts`. Each adapter becomes sub-entry-point-only. SDKs become optional peers. Breaking change for existing users. ~2 hours.
- **Option B (additive):** add npm sub-entry-points for every adapter (mirror `deno.json`), lazy-load SDKs inside each adapter. Barrel keeps working. New consumers opt into tree-shaking. Non-breaking. ~2-3 hours.
- **Option C (docs-only, today's answer):** accept current shape; document `factory-slim` as the production pattern. Invariant 2 stays a known limitation with documented mitigation. `docs/design/PLUGIN-AUTHORING.md` § "Known sprawl surfaces" captures this. Zero code change. **Already done as part of this audit.**

Recommendation: **Option C now, Option B later** when it's painful enough to matter. For today's mailroom work, factory-slim is the already-proven escape hatch.

## What's done in this pass

All four audit tasks shipped:

1. ✅ **Audit every plugin family** — table above. Clean plugins: `messaging`, `graph`, `episodic`, `blob-middleware`, `http`, `disclosure`, `vault-graph`. Reclassified as core: `views`, `materializers`, `search` (these are used by core router/adapters, so they're core modules organized in folders, not plugins).
2. ✅ **Audit root dependencies** — `@notionhq/client`, `@aws-sdk/*`, `unstorage` leak into core. Mitigated in practice by `factory-slim.ts` (prod consumers skip the barrel). Fully fixing requires Option A or B above; deferred.
3. ✅ **`docs/design/PLUGIN-AUTHORING.md`** — one-page canonical doc. 4 invariants, lazy-load recipe with postal-mime as worked example, sub-entry-point convention, role decision tree, checklist, known exceptions, known sprawl surfaces. This IS the discipline now.
4. ✅ **Role decision tree** — table in `PLUGIN-AUTHORING.md § Role decision tree` with worked examples (Obsidian all roles, Tigerflare adapter+sink, Email channel+sink, RSS channel-only).

## Explicitly out of scope for this pass

**Not building any of these in this audit**, even though they're the motivating examples:

- **Obsidian adapter** — parked. Easy once the recipe is written; trivially ~100 LOC of frontmatter-aware `local-file`. Future task.
- **Obsidian channel** — parked. Needs a vault watcher; platform-specific. Future task.
- **RSS channel** — parked. Already queued in `TASKS-MESSAGING.md`.
- **Webhook channel** (for agentic feeders dumping data) — parked. Already queued in `TASKS-MESSAGING.md`. This is what agentic feeders will POST to once it ships.
- **Tigerflare adapter** — parked **and** questioned. User noted tigerflare is being used the *other* direction today (tigerflare writes to smallstore via the bridge, not smallstore reading from tigerflare). A tigerflare-as-smallstore-adapter is theoretically valid but backwards-facing; re-evaluate only when a concrete consumer appears.

Reason: shipping these before the discipline is tightened and documented just adds more sprawl surface. The audit is the investment; the plugins are returns.

## Success criteria

- Every plugin family passes all 4 invariants, OR has a documented exception with a rationale
- Root `package.json` `dependencies` contains only genuinely core deps (ones used by `src/adapters/adapter.ts` + `src/adapters/router.ts` or comparably core modules)
- `docs/plugin-authoring.md` exists, is one page, includes the 4 invariants + lazy-load recipe + sub-entry-point convention
- Role decision tree is written (in `docs/plugin-authoring.md` or adjacent)
- A developer or agent wanting to add a new plugin family has a single doc to follow, not tribal knowledge

## What unblocks after this

**Mailroom pipeline implementation — EOD 2026-04-24** (see `.brief/mailroom-pipeline.md`). With the audit done and doc written, mailroom's Sink abstraction + pipeline + rules + sender-index get built against a plugin pattern that's provably clean. No risk of sprawl starting with task #1 of the new plugin.

**Future plugins (obsidian, rss, webhook, etc.)** — each becomes 1-2 hours instead of a week, because the recipe is written and the existing plugin families serve as tested templates.

## References

- Messaging primitives brief: `.brief/messaging-plugins.md`
- Mailroom pipeline brief: `.brief/mailroom-pipeline.md` (implementation blocked on this audit)
- pi-mono inspiration: `__resources/github-repos/pi-mono/notes.md` (aspirational "simple core + extensions" shape)
- Current postal-mime fix commit: (to commit from working tree)
- Prior art comparison: `__resources/github-repos/cloudflare-agentic-inbox/notes.md` — different thesis, not a template for plugin discipline
