# smallstore — session notes

Deployed Worker lives at `https://smallstore.labspace.ai`. Code ships via `deno task build:npm && cd deploy && yarn deploy`.

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

**Auto-confirm is active for allowlisted senders.** `AUTO_CONFIRM_SENDERS` in `wrangler.toml` (currently `*@substack.com`, `*@substackmail.com`, `*@convertkit.com`, `*@beehiiv.com`, `*@mailerlite.com`, `*@emailoctopus.com`, `*@uxdesign.cc`) triggers auto-click at ingest — those items carry `auto-confirmed` (not `needs-confirm`). To see what was auto-confirmed recently, query `labels: ["auto-confirmed"]`. Adding a new platform to the allowlist requires editing `wrangler.toml` + redeploy.

Single-item manual confirm (mutates): `POST /inbox/mailroom/confirm/:id`. Add `?dry-run=true` to preview the URL.

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

## Env vars on the Worker

Set in `deploy/wrangler.toml [vars]`:
- `SELF_ADDRESSES` — comma-separated forward-whitelist for forward-detect hook
- `SENDER_ALIASES` — `pattern:name,...` glob map for sender-aliases hook
- `SMALLSTORE_TOKEN` — secret, set via `wrangler secret put` (NOT in wrangler.toml)
