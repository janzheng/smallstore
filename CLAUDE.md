# smallstore — session notes

Deployed Worker lives at `https://smallstore.labspace.ai`. Code ships via `deno task build:npm && cd deploy && yarn deploy`.

> **Just here to triage email?** Start sessions in `mailroom-inbox/` instead — that workspace has its own CLAUDE.md focused on inbox operations (read, confirm, delete, archive, manage auto-confirm patterns). This root is for *building* the Worker.

## Hitting the deployed Worker

The bearer token is stored in `deploy/.env` as `SMALLSTORE_TOKEN` (gitignored — never copy the value into repo files). To query any authed route from a shell:

```sh
set -a && source deploy/.env && set +a
curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" "https://smallstore.labspace.ai/inbox/mailroom?limit=20" | jq
```

Routes behind auth: `/api/*`, `/inbox/*`, `/admin/*`, `/peers/*`. `/health` and `/` are open.

## Mailroom triage — always surface `needs-confirm` first

When asked "what's in the mailroom" / "did anything land" / "check my inbox", **always run a `needs-confirm` sweep before summarizing**. Double-opt-in confirmations get buried and block future newsletter delivery — the user needs to see them as their own line.

```sh
curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" \
  -X POST "https://smallstore.labspace.ai/inbox/mailroom/query" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"labels":["needs-confirm"]},"limit":50}' \
  | jq '{pending: (.items | length), items: [.items[] | {id, from: .fields.from_email, subject: .fields.subject, confirm_url: .fields.confirm_url}]}'
```

If any items come back, surface them as a separate callout (not buried in the general list). Offer to batch-confirm via the endpoint or the `sm_inbox_confirm` MCP tool. For manual clicks: show the URL first so the user stays in the loop.

**Auto-confirm is active for allowlisted senders.** Patterns are stored in D1 (`mailroom_auto_confirm` table) and editable at runtime via `/admin/auto-confirm/senders` or the `sm_auto_confirm_*` MCP tools — no redeploy needed. The `AUTO_CONFIRM_SENDERS` env var in `wrangler.toml` (currently `*@substack.com`, `*@substackmail.com`, `*@convertkit.com`, `*@beehiiv.com`, `*@mailerlite.com`, `*@emailoctopus.com`, `*@uxdesign.cc`, `*@every.to`) seeds the store on first ever boot only — patterns deleted via the API stay deleted (sentinel-tracked).

```sh
# List active patterns
curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" "https://smallstore.labspace.ai/admin/auto-confirm/senders" | jq

# Add a new platform at runtime (effective within ~30s — hook caches the allowlist briefly)
curl -sS -X POST -H "Authorization: Bearer $SMALLSTORE_TOKEN" -H "Content-Type: application/json" \
  "https://smallstore.labspace.ai/admin/auto-confirm/senders" \
  -d '{"pattern":"*@newplatform.com","notes":"why this was added"}'

# Remove a pattern (delete-wins — survives cold starts even if the env var still lists it)
curl -sS -X DELETE -H "Authorization: Bearer $SMALLSTORE_TOKEN" \
  "https://smallstore.labspace.ai/admin/auto-confirm/senders/$(printf '*@x.com' | jq -sRr @uri)"
```

Items confirmed automatically carry the `auto-confirmed` label (not `needs-confirm`). Query `labels: ["auto-confirmed"]` to see recent auto-clicks. Single-item manual confirm (mutates): `POST /inbox/mailroom/confirm/:id`. Add `?dry-run=true` to preview the URL.

## MCP tools (`sm_inbox_*`, `sm_peers_*`, `sm_*`)

Registered against prod as of 2026-04-24 — `claude mcp get smallstore` should show `SMALLSTORE_URL=https://smallstore.labspace.ai`. If MCP tool calls return 404, the config has drifted back to localhost; re-register with:

```sh
set -a && source deploy/.env && set +a
claude mcp remove smallstore -s user
claude mcp add smallstore -s user \
  -e "SMALLSTORE_URL=https://smallstore.labspace.ai" \
  -e "SMALLSTORE_TOKEN=$SMALLSTORE_TOKEN" \
  -- deno run --allow-net --allow-read --allow-env \
     /Users/janzheng/Desktop/Projects/_deno/apps/smallstore/src/mcp-server.ts
```

**MCP caveat:** tools load at Claude Code startup. Re-registering does not update the current session — restart Claude Code for the new config to take effect.

## Build + deploy

- Rebuild npm dist before every deploy: `deno task build:npm` (produces `dist/` consumed by `deploy/` via `file:../dist`)
- `cd deploy && yarn deploy` runs predeploy (rebuild) + `wrangler deploy`
- Tests: `deno test --allow-all tests/messaging-*.test.ts` (412+ green as of annotation-layer ship)
- `deno check mod.ts` is the production typecheck gate; some tests have pre-existing type errors that are not blocking

### ⚠️ Deploy gotcha — yarn won't refresh `file:../dist` automatically

**TL;DR — when shipping unreleased smallstore code, always wipe + reinstall before deploy:**

```sh
deno task build:npm
cd deploy
rm -rf node_modules/@yawnxyz   # force yarn to repopulate from the freshly-built dist/
yarn install --check-files
yarn deploy
```

**Why:** `yarn install` dedupes by version, not content. Since `dist/`'s package.json never changes versions, yarn happily reuses whatever copy of `@yawnxyz/smallstore` is already in `deploy/node_modules/` — even if `dist/` was just rebuilt seconds ago. The `predeploy` hook rebuilds `dist/` but doesn't reinstall, so wrangler then uploads stale code.

**How to spot it:** New routes return 404, new fields don't populate, hooks behave like the old version. Check the wrangler "Total Upload" line — if it didn't grow when you expected it to, the install didn't take. Also can grep `deploy/node_modules/@yawnxyz/smallstore/esm/src/messaging/http-routes.js` for a known new symbol; if it's missing, force-reinstall.

**First seen:** 2026-04-26 deploy of webhook channel + forward-notes Phase 1/2/3 — first attempt shipped the Apr 24 build; wipe-and-reinstall fixed it.

## Env vars on the Worker

Set in `deploy/wrangler.toml [vars]`:
- `SELF_ADDRESSES` — comma-separated forward-whitelist for forward-detect hook
- `SENDER_ALIASES` — `pattern:name,...` glob map for sender-aliases hook
- `SMALLSTORE_TOKEN` — secret, set via `wrangler secret put` (NOT in wrangler.toml)
