# Plugin Authoring

How to add a new plugin family (messaging, search, graph, etc.) or adapter to smallstore without causing sprawl.

**Read this before adding any new plugin family, adapter, channel, sink, or processor.**

Canonical case study: the `postal-mime` lazy-load fix (commit `d4a74a9`) — 4-invariant audit found one leak in the messaging family's deps, fixed via lazy dynamic import. Use that as your template.

## The 4 invariants

A plugin is genuinely a plugin (= genuinely removable, = doesn't tax other consumers) when all four hold:

### 1. Core never imports the plugin

One-way dependency: plugin → core, never reverse. `src/adapters/*` and `src/router.ts` must have zero references to your plugin's directory.

**Check:**
```sh
grep -rln "from ['\"]\.\./<plugin>\|from ['\"]\.\./\.\./<plugin>" src/adapters/ src/router.ts
# Expected: no output
```

**If it fails:** you have coupling backwards. Either (a) extract the shared primitive into `src/utils/` or `src/types.ts`, (b) invert the dependency so the adapter passes a callback, or (c) accept that your "plugin" is actually a core module (like `views`, `materializers`, `search`) — but then stop calling it a plugin.

### 2. Heavy dependencies are optional peers, not core

Any npm dep used only by your plugin belongs in `peerDependencies` + `peerDependenciesMeta: { optional: true }`, and must be loaded lazily inside the plugin (not at module top level).

**Check:**
```sh
# For each root-level dep in package.json, find who uses it:
grep -rln "from ['\"]<dep-name>" src/
# If the answer is "one plugin dir," it's a leak.
```

**If it fails:** apply the lazy-load recipe (see below).

### 3. Sub-entry points are self-contained

Your plugin imports only from your own directory, `src/` core (types, adapter interface, router, utils), and approved external deps. Never from sibling plugins (`src/search`, `src/graph`, etc.).

**Check:**
```sh
grep -rnE "from ['\"]\.\./(search|graph|episodic|disclosure|views|materializers|blob-middleware|http|sync|messaging)" src/<plugin>/
# Expected: no output
```

**If it fails:** you have cross-plugin coupling. Either (a) extract the shared piece to core, (b) make the consumed plugin a direct peer-optional dependency, or (c) rethink the boundary.

### 4. Plugin is deletable

You can `rm -rf src/<plugin>/` and `deno test` + `deno task build:npm` still succeed for core. Root `mod.ts` must not re-export from your plugin directly.

**Check:**
```sh
# Reverse grep — does anyone outside the plugin import from it?
grep -rln "from ['\"]\.\./<plugin>\|from ['\"]\./<plugin>" src/ | grep -v "^src/<plugin>/"
# Expected: no output (or only intentional cross-plugin deps that you've reviewed)
```

**If it fails:** your plugin is really a core module, not a plugin. That's fine — but stop treating it as optional.

## The lazy-load recipe (invariant 2)

When your plugin needs a heavy dep that shouldn't be forced on all smallstore consumers:

**Step 1.** Remove the top-level import. Replace:

```ts
import HeavyDep from 'heavy-dep';

export class MyChannel {
  async parse(input) {
    const parsed = HeavyDep.parse(input);
    // ...
  }
}
```

with a lazy loader:

```ts
let _HeavyDep: any | undefined;
async function loadHeavyDep() {
  if (_HeavyDep) return _HeavyDep;
  try {
    const mod = await import('heavy-dep');
    _HeavyDep = mod.default ?? mod;
    return _HeavyDep;
  } catch (err) {
    throw new Error(
      "This plugin requires 'heavy-dep'. Install it:\n" +
      "  npm install heavy-dep\n" +
      "  (or add to deno.json imports: \"heavy-dep\": \"npm:heavy-dep@^X.Y.Z\")\n" +
      `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

export class MyChannel {
  async parse(input) {
    const HeavyDep = await loadHeavyDep();
    const parsed = HeavyDep.parse(input);
    // ...
  }
}
```

**Step 2.** In `scripts/build-npm.ts`, move the dep out of `dependencies` and into `peerDependencies` + `peerDependenciesMeta`:

```ts
peerDependencies: {
  "hono": ">=4.0.0",
  "postal-mime": ">=2.0.0",     // ← added
},
peerDependenciesMeta: {
  "hono": { optional: true },
  "postal-mime": { optional: true },   // ← added
},
```

And in the `postBuild()` cleanup, strip it from the generated `dependencies`:

```ts
delete pkg.dependencies?.["postal-mime"];
```

**Step 3.** Verify. Run tests. Run `deno task build:npm`. Check the output `dist/package.json` — your dep should appear only in `peerDependencies`, not in `dependencies`.

## Sub-entry-point convention

New plugin families get their own sub-entry-point in `deno.json` exports + `package.json` exports (via `build-npm.ts`).

### Adding a sub-entry-point

**`deno.json` `exports`:**

```json
"./your-plugin": "./src/your-plugin/mod.ts",
"./your-plugin/types": "./src/your-plugin/types.ts"
```

**`jsr.json` `exports`:** mirror the same paths.

**`scripts/build-npm.ts` `entryPoints`:**

```ts
entryPoints: [
  // ... existing ...
  { name: "./your-plugin", path: "./src/your-plugin/mod.ts" },
  { name: "./your-plugin/types", path: "./src/your-plugin/types.ts" },
],
```

This makes:
```ts
import { ... } from '@yawnxyz/smallstore/your-plugin';
```
a valid import path that tree-shakes cleanly without pulling other plugins.

### What NOT to do

Do **not** re-export your plugin from the root `mod.ts` barrel. Root should stay minimal — types + core factory + the tiny default adapters (memory). Re-exporting plugins via root barrel defeats tree-shaking and violates invariant 4.

If consumers want "all of smallstore," they can write several imports. If they want "one plugin," they get exactly that plugin.

## Role decision tree

When adding integration for a new backend (Obsidian, Tigerflare, Slack, RSS, etc.), decide which role it plays. Same backend can play multiple — they're orthogonal, pick what you need when you need it.

| Role | Shape | Example |
|---|---|---|
| **Adapter** | `StorageAdapter` — `get/set/delete/query/list` over some backend | `obsidianAdapter({ vault: '~/docs' })` — read/write `.md` files as KV |
| **Channel** | `Channel<Input>` — `parse(raw) → InboxItem`, plus push/pull/hybrid shape | `obsidianChannel({ vault, watch: 'inbox/' })` — new notes → items |
| **Sink** | `(item, ctx) => Promise<SinkResult>` — pipeline destination | `obsidianSink({ vault, template })` — pipeline writes → `.md` files |
| **Processor** | `(item) => Promise<item>` — transform in pipeline | summarizer, classifier, entity extractor |

### Worked examples

**Obsidian** — all four roles meaningfully apply:
- Adapter: read/write vault as KV (frontmatter-aware)
- Channel: watch vault folder for new notes, emit as items
- Sink: pipeline writes to vault with a template
- Processor: N/A (obsidian doesn't transform)

**Tigerflare** — two roles:
- Adapter: HTTP-backed KV (wraps `tf_read`/`tf_write`/`tf_query`)
- Sink: pipeline POSTs to tigerflare paths

**Email (cf-email)** — two roles:
- Channel: parse incoming .eml into InboxItem (input side)
- Sink: via cf-email-out, send outbound (output side)

**RSS** — one role:
- Channel: poll feed, dedup by `<guid>`, emit items

### Deciding

- **Is it a storage backend you'll read/write keyed data against?** → Adapter.
- **Does it deliver events you want to ingest?** → Channel.
- **Do you want pipeline output to land there?** → Sink.
- **Does it transform items?** → Processor.
- **Multiple of the above?** Implement each separately. They live in different directories and compose at runtime.

## Checklist for a new plugin family

Use this as a PR-review / self-review checklist:

- [ ] Plugin lives in `src/<plugin>/`, has `mod.ts` as public entry
- [ ] Invariant 1: no imports from `src/<plugin>` in `src/adapters/` or `src/router.ts`
- [ ] Invariant 2: any new npm dep is in `peerDependencies` + `peerDependenciesMeta.optional = true` in `build-npm.ts`, and lazy-loaded in the plugin
- [ ] Invariant 3: plugin imports only from `./<plugin>/*`, `../types.ts`, `../adapters/adapter.ts`, `../utils/*`, and approved external
- [ ] Invariant 4: plugin deletable — root `mod.ts` doesn't re-export from it; `rm -rf src/<plugin>/ && deno test && deno task build:npm` passes for core
- [ ] Sub-entry-point added to `deno.json` + `jsr.json` + `build-npm.ts` `entryPoints`
- [ ] Tests live in `tests/<plugin>-*.test.ts`, imported via the sub-entry-point where possible
- [ ] Role documented — which of adapter/channel/sink/processor does it implement?
- [ ] `postal-mime` recipe applied for heavy deps (see "Lazy-load recipe" above)

## Known exceptions (2026-04-24 audit)

Some existing subdirectories of `src/` look like plugins but are actually core modules. They're documented here so you don't try to "fix" them:

- `src/views/` — used by `src/router.ts` (core routing depends on it)
- `src/materializers/` — used by `src/router.ts` (same)
- `src/search/` — used by 7 adapters for BM25 indexing; adapters depend on it
- `src/utils/`, `src/validation/`, `src/types.ts` — core utility modules, always core
- `src/namespace/`, `src/keyindex/`, `src/explorer/` — core router helpers

These are not targets for plugin discipline — they're part of the core module.

**Real plugin families** (pass invariant 4, deletable): `graph`, `episodic`, `blob-middleware`, `messaging`, `disclosure`, `http`, `vault-graph`.

## Known sprawl surfaces (to address in follow-up)

Known invariant-2 leaks in root `dependencies` that would be nice to clean up (deferred as their own tasks — not a blocker for the EOD 2026-04-24 mailroom goal):

- `@notionhq/client` — only used by notion adapter, should be optional peer with lazy-load
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — used by r2-direct adapter + blob-middleware resolver, should be optional peer
- `unstorage` — only used by unstorage adapter, should be optional peer

**Mitigation today:** `factory-slim.ts` exists as the "skip the adapter barrel" escape hatch for production. Consumers doing tree-shaking should use `factory-slim` + per-adapter imports instead of the root barrel. This keeps bundle size sane even with the leaks.

Fixing these properly requires removing adapter re-exports from root `mod.ts` (breaking change for existing users who import `createNotionAdapter` from root), or lazy-loading each adapter's SDK individually. Track as follow-up tasks under `TASKS.md § Plugin discipline audit`.

## See also

- Canonical example commit: `d4a74a9` (postal-mime lazy-load)
- Audit brief: `.brief/plugin-discipline-audit.md`
- Messaging plugin brief: `.brief/messaging-plugins.md`
- Mailroom pipeline brief: `.brief/mailroom-pipeline.md` (uses this recipe)
- Inspiration: pi-mono's simple-core-plus-extensions architecture (`__resources/github-repos/pi-mono/notes.md`)
