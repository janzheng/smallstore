# smallstore — session notes

Deployed Worker lives at `https://smallstore.labspace.ai`. Code ships via `deno task build:npm && cd deploy && yarn deploy`.

## Hitting the deployed Worker

The bearer token is stored in `deploy/.env` as `SMALLSTORE_TOKEN` (gitignored — never copy the value into repo files). To query any authed route from a shell:

```sh
set -a && source deploy/.env && set +a
curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" "https://smallstore.labspace.ai/inbox/mailroom?limit=20" | jq
```

Routes behind auth: `/api/*`, `/inbox/*`, `/admin/*`, `/peers/*`. `/health` and `/` are open.

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
