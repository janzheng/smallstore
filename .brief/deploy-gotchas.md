# Deploy gotchas — smallstore Worker

Operational hazards that have actually bitten us when shipping `smallstore.labspace.ai`. New entries get appended; nothing here gets removed unless we've structurally fixed the underlying cause (in which case write the fix and link the commit).

The canonical deploy command is `deno task build:npm && cd deploy && yarn deploy`. The list below is everything that command *won't* do for you.

---

## 1. yarn won't refresh `file:../dist` on rebuild — first seen 2026-04-26, FIXED same day

**Status: structurally fixed.** `deploy/package.json` switched from `"file:../dist"` → `"link:../dist"` (verified 2026-04-26, deploy `96fd9c9f-88cf-4ba8-8be2-6aa5b15ca6c4`). Section preserved as the canonical record because the trap is sneaky and someone might revert the dep spec without realizing why.

**Symptom (when it bit us):** Deploy succeeds, wrangler reports "Uploaded smallstore", new routes return 404, new fields don't populate. `dist/` on disk is fresh but the Worker is still serving the previous version.

**Why it happened:** `yarn install` (yarn 1) dedupes `file:` deps by `package.json` version, not file contents. `dist/package.json` declares a stable version (`dnt` writes the same string on every build), so yarn treats the already-installed copy in `deploy/node_modules/@yawnxyz/smallstore/` as up-to-date and skips reinstall. The Apr 24 copy got reused through three Apr 26 deploys before the staleness was caught. `link:` doesn't have this problem — yarn replaces the directory with a symlink to the source path, so any rebuild is visible instantly with zero install step.

**Why we don't normally see this:** npm-registry deps have unique versions per publish, yarn/pnpm workspaces symlink already, fresh CI checkouts have empty `node_modules`, and most CF Worker projects bundle source directly without a separate `dist/` step. The `deno → dnt → file:.. → wrangler` pipeline is the unusual seam.

**If someone reverts the dep spec:** symptom is fast — wrangler "Total Upload" doesn't grow when a meaningful code change should bump it. Quick checks:
```sh
# Should be a symlink. If it's a directory, the dep got reverted to file:.
ls -la deploy/node_modules/@yawnxyz/smallstore

# Smoke test — append a marker, rebuild, expect zero matches:
echo "// MARKER" >> dist/esm/src/messaging/http-routes.js
deno task build:npm
grep MARKER deploy/node_modules/@yawnxyz/smallstore/esm/src/messaging/http-routes.js  # should print nothing
```

**Three other fixes that would also work** (if `link:` ever proves insufficient):
1. Bump a synthetic content-hash version in `dist/package.json` on every `build-npm.ts` run.
2. Have predeploy `rm -rf node_modules/@yawnxyz` before install.
3. Switch the whole project to pnpm or bun (both content-hash local deps).

**MCP caveat (related but separate):** new MCP tool changes need a Claude Code restart before they're callable — see CLAUDE.md "MCP caveat".

---

## 2. MCP tool changes need a Claude Code restart — known, documented in CLAUDE.md

Re-registering an MCP server (`claude mcp add ... -s user`) doesn't update the current session. New tools won't appear until Claude Code is restarted. Same applies to the `mcp__smallstore__*` tool list when the Worker ships new tools — the MCP server registers them, but the client-side schema cache only refreshes on session start.

---

## 3. Wrangler env-var changes need a redeploy — by design, but flag for triage

`deploy/wrangler.toml [vars]` are baked into the Worker bundle at deploy time. Changing `SELF_ADDRESSES` / `SENDER_ALIASES` / `AUTO_CONFIRM_SENDERS` requires `yarn deploy`.

But: `AUTO_CONFIRM_SENDERS` is *seed-only* — once the D1 `mailroom_auto_confirm` table exists, the env var is ignored on subsequent boots. If you edit the env var expecting a behavior change, you have to also call `/admin/auto-confirm/senders` (the runtime API) to make it stick. This is intentional (delete-wins, sentinel-tracked) but easy to forget.

---

## Adding to this file

Three entry conditions:
1. Something that should have worked, didn't.
2. The fix is non-obvious.
3. Future-you (or a future agent) would re-discover it the slow way.

Don't add tutorials, working procedures, or things already documented in the operational docs. This file is *just* for traps.
