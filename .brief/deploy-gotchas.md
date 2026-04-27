# Deploy gotchas — smallstore Worker

Operational hazards that have actually bitten us when shipping `smallstore.labspace.ai`. New entries get appended; nothing here gets removed unless we've structurally fixed the underlying cause (in which case write the fix and link the commit).

The canonical deploy command is `deno task build:npm && cd deploy && yarn deploy`. The list below is everything that command *won't* do for you.

---

## 1. yarn won't refresh `file:../dist` on rebuild — first seen 2026-04-26

**Symptom:** Deploy succeeds, wrangler reports "Uploaded smallstore", new routes return 404, new fields don't populate. `dist/` on disk is fresh but the Worker is still serving the previous version.

**Why:** `yarn install` dedupes by `package.json` version, not file contents. `dist/package.json` declares a stable version (it's the same library on every build), so yarn treats the already-installed copy in `deploy/node_modules/@yawnxyz/smallstore/` as up-to-date and skips reinstall. The Apr 24 copy got reused through three Apr 26 deploys before the staleness was noticed.

**Detection:**
- Wrangler "Total Upload" line doesn't grow when it should (a meaningful code change should bump bytes).
- Grep the installed copy for a symbol you know is new:
  ```sh
  grep -l "<new-symbol-or-route>" deploy/node_modules/@yawnxyz/smallstore/esm/src/messaging/*.js
  ```
- Compare timestamps:
  ```sh
  ls -la dist/esm/src/messaging/http-routes.js \
        deploy/node_modules/@yawnxyz/smallstore/esm/src/messaging/http-routes.js
  ```
  If the installed one is older than the dist one, you're about to ship stale code.

**Fix (immediate):**
```sh
deno task build:npm
cd deploy
rm -rf node_modules/@yawnxyz
yarn install --check-files
yarn deploy
```

**Fix (long-term, not yet implemented):** make `predeploy` always wipe + reinstall the smallstore package before `wrangler deploy`, or bump a synthetic version in `dist/package.json` on every build so yarn invalidates.

**Verify after deploy:** hit a known new route immediately, confirm non-404. If new MCP tools were added, the Claude Code session needs to be restarted before they're callable (separate gotcha — see CLAUDE.md "MCP caveat").

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
