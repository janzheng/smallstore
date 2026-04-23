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

## What's left in this pass

### 1. Audit every other plugin family against the 4 invariants

Apply the same grep pattern (plus a core dep scan) to:
- `src/search/`
- `src/graph/`
- `src/episodic/`
- `src/blob-middleware/`
- `src/disclosure/`
- `src/views/`
- `src/materializers/`
- `src/http/`
- `src/sync/`

Likely to find leaks similar to `postal-mime`. Candidates I'd bet are real:
- `@notionhq/client` in core `dependencies` but only used by notion adapter
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` in core but only used by r2/s3 adapters
- Possibly others in search/graph/episodic that I haven't looked at yet

Output: either a clean bill of health per family, OR a list of concrete leak-fixes (lazy-load + move to optional peer, same recipe as postal-mime).

### 2. Audit root `package.json` dependencies line-by-line

For each entry in `dependencies` + `optionalDependencies`, answer:
- Which plugin family (or families) uses this?
- Is it used by core or only one plugin?
- If only one plugin, is it in that plugin's peer list with lazy-load?

This is a mechanical read of `package.json` + grep. <30 min.

Note: adapters in `src/adapters/` are themselves plugin-like — each adapter lives in its own file and is imported directly by consumers, not auto-registered. So the same discipline applies: if `@notionhq/client` is core-dep, switching a user from a notion-less deploy pulls it anyway.

### 3. Write `docs/plugin-authoring.md`

One-page how-to. Contents:
- The 4 invariants (with one sentence each)
- How to add a new sub-entry point (deno.json exports + package.json exports + build-npm.ts)
- Lazy-load pattern for heavy deps (the `loadPostalMime()` recipe as the canonical example)
- Peer dep convention (`peerDependencies` + `peerDependenciesMeta.optional`)
- Test convention (tests under `tests/<family>-*.test.ts`, not inside `src/<family>/`)
- Deletion test as the final honest check

Frame it so an agent could add a new plugin family by following the doc + grepping an existing one (probably messaging post-fix) as the template.

### 4. Write the role decision tree

Short explainer: a backend can play multiple roles. A contributor asking "where does Obsidian go?" should find this in 30 seconds.

```
| Role      | Shape                                 | Example                                              |
|-----------|---------------------------------------|------------------------------------------------------|
| Adapter   | StorageAdapter (get/set/delete/query) | obsidianAdapter({ vault: '~/docs' }) — .md as KV      |
| Channel   | Channel<Input>: parse → InboxItem     | obsidianChannel({ vault, watch: 'inbox/' }) — events  |
| Sink      | (item, ctx) => Promise<SinkResult>    | obsidianSink({ vault, template }) — pipeline → file   |
| Processor | (item) => Promise<item>               | summarizer / classifier / entity extractor           |
```

Include Obsidian (all three + processor-able), Tigerflare (adapter + sink), Email (channel + sink, via cf-email and cf-email-out), RSS (channel only) as worked examples. Emphasize: **roles are orthogonal. Same backend, different interfaces, pick what you need when you need it.**

This doc probably belongs next to `docs/plugin-authoring.md` or as a section within it.

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
