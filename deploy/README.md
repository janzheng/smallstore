# smallstore (Cloudflare Worker)

The deployed smallstore. Owns `smallstore.labspace.ai`. Hosts the universal `/api/*` CRUD surface, the messaging plugin family (`/inbox/*`, `/admin/*`, plus CF Email Routing `email()` handler), **and** the peer registry (`/peers/*`).

```
client → smallstore.labspace.ai (this Worker)
          ├─ /health                   health check
          ├─ /                         endpoint index (public)
          ├─ /api/*                    smallstore CRUD (collections, search, query, ...)
          ├─ /inbox/:name/*            messaging — list, read, query, cursor, export,
          │                            rules, tag, unsubscribe, quarantine, restore
          ├─ /admin/inboxes/*          runtime inbox CRUD
          ├─ /peers/*                  peer registry — CRUD + health + fetch/query proxy
          └─ email(msg)                CF Email Routing → mailroom inbox

mailroom storage (single MAILROOM_D1 binding, four tables):
   mailroom_items      ← InboxItem rows + _index (messaging mode)
   mailroom_senders    ← per-sender aggregates (count, first_seen, unsubscribe url, tags)
   mailroom_rules      ← runtime-editable curation rules (archive/bookmark/tag/drop/quarantine)
   peers               ← peer registry (external data source metadata)

mailroom R2 (mailroom bucket):
   raw/<id>.eml, html/<id>.html, attachments/<id>/...
```

## Using the deployed Worker

**→ [`docs/user-guide/mailroom-quickstart.md`](../docs/user-guide/mailroom-quickstart.md)** — practical recipes for every workflow: forward a bookmark, create rules, download as JSONL, register peers, proxy-fetch, the 6 removal levels, common gotchas.

**Design briefs** for when you want the why:
- Messaging primitives: [`.brief/messaging-plugins.md`](../.brief/messaging-plugins.md)
- Pipeline architecture: [`.brief/mailroom-pipeline.md`](../.brief/mailroom-pipeline.md)
- Curation (bookmarks + auto-archive): [`.brief/mailroom-curation.md`](../.brief/mailroom-curation.md)
- Peer registry: [`.brief/peer-registry.md`](../.brief/peer-registry.md)

**Sprint narratives** (chronological build log):
- [`.brief/2026-04-24-mailroom-sprint.md`](../.brief/2026-04-24-mailroom-sprint.md) — pipeline foundation
- [`.brief/2026-04-25-curation-sprint.md`](../.brief/2026-04-25-curation-sprint.md) — bookmarks + rules + removal taxonomy
- [`.brief/2026-04-25-peer-registry-sprint.md`](../.brief/2026-04-25-peer-registry-sprint.md) — peers level 2

Build plan: [`TASKS-MESSAGING.md`](../TASKS-MESSAGING.md) (messaging-scoped) + [`TASKS.md`](../TASKS.md) (whole-smallstore).

## First-time setup

### 1. Install

```sh
cd deploy
yarn install   # or npm install
```

### 2. Build the npm package

The Worker imports smallstore from `file:../dist`, which is produced by Deno's `dnt` build:

```sh
cd ..              # back to smallstore root
deno task build:npm
```

This is also wired as `predeploy` in `deploy/package.json`, so `yarn deploy` rebuilds first.

### 3. Create the D1 database

```sh
cd deploy
yarn d1:create     # wrangler d1 create mailroom
```

Wrangler prints the new database id. **Paste it into `wrangler.toml`** at `database_id`.

### 4. Create the R2 bucket

```sh
yarn r2:create     # wrangler r2 bucket create mailroom
```

(No id to copy — bucket name is the binding key.)

### 5. Set secrets + vars

**Required — auth secret:**

```sh
yarn secret:set    # wrangler secret put SMALLSTORE_TOKEN
```

Pick something long and random. All `/api`, `/inbox`, `/admin`, `/peers` routes require:

```
Authorization: Bearer <SMALLSTORE_TOKEN>
```

If you skip this step, the deployed Worker is **open**. Only do that for a throwaway test deploy.

**Optional — self-addresses (for forward-detection):**

Add to `wrangler.toml` under `[vars]`:

```toml
[vars]
SELF_ADDRESSES = "you@gmail.com,trusted-curator@gmail.com"
```

Comma-separated addresses the forward-detection hook treats as "user / trusted forwarder." When mail from these addresses hits `mailroom@labspace.ai`, it gets tagged `forwarded` + `manual` and the original sender is extracted from the forwarded body. Omit for header-only forward detection.

**Optional — peer-auth secrets (per peer registered):**

Each peer that needs auth references an env var by name (never stores the secret). For example, a tigerflare peer registered with `auth: { kind: 'bearer', token_env: 'TF_TOKEN' }` needs:

```sh
echo "<your-tigerflare-token>" | npx wrangler secret put TF_TOKEN
```

See `docs/user-guide/mailroom-quickstart.md § 2.2 Register a peer` for the full pattern per auth kind.

### 6. Confirm DNS

`smallstore.labspace.ai` must exist as a CNAME (orange-cloud / Proxied) in the `labspace.ai` zone before deploy. Target can be anything — the Worker route intercepts before the proxy path runs.

### 7. Deploy

```sh
yarn deploy
```

## Verify

```sh
# Health
curl -sS https://smallstore.labspace.ai/health
# {"status":"ok","service":"smallstore","version":"0.2.0"}

# Info — should list "mailroom" inbox
curl -sS https://smallstore.labspace.ai/

# Auth-required route (with token)
TOKEN=<your-smallstore-token>
curl -sS -H "Authorization: Bearer $TOKEN" https://smallstore.labspace.ai/admin/inboxes

# List the mailroom inbox (empty until first email arrives)
curl -sS -H "Authorization: Bearer $TOKEN" https://smallstore.labspace.ai/inbox/mailroom
```

## Wire CF Email Routing (Phase 5)

Once the Worker is up and you want real mail flowing in:

1. **CF Dashboard → Email → Routing → Routes** for `labspace.ai` (or whichever zone holds your inbox domain).
2. Add a **catch-all** rule (or specific addresses), action: **Send to a Worker**, target: `smallstore`.
3. Send a test email to your address. `wrangler tail` should show:

   ```
   [email] ingested {"inbox":"mailroom","id":"<32-hex>","from":"...","to":"..."}
   ```

4. Verify it landed:

   ```sh
   curl -sS -H "Authorization: Bearer $TOKEN" https://smallstore.labspace.ai/inbox/mailroom | jq
   ```

## Iteration

Local dev (against a local D1/R2 simulation):

```sh
yarn dev
# Worker on http://localhost:8787 — uses miniflare's local D1+R2.
```

Push a change:

```sh
yarn deploy
```

Tail logs:

```sh
yarn tail
```

## Updating the smallstore version

Whenever `src/messaging/` (or anything else in the smallstore root) changes, rebuild + redeploy:

```sh
cd ..
deno task build:npm
cd deploy
yarn deploy
```

`yarn deploy` runs `predeploy` (which is `cd .. && deno task build:npm`) automatically, so the one-liner is just `yarn deploy` from inside `deploy/`.

## Failure modes

- **`Cannot find module '@yawnxyz/smallstore'`** — run `deno task build:npm` from the smallstore root, then re-run `yarn install` in `deploy/` so the file: link picks up the new dist.
- **Email handler triggers but inbox stays empty** — `wrangler tail` for an `[email] ingest failed` line. Usually means the D1 or R2 binding name in `wrangler.toml` doesn't match the binding key in `src/index.ts` (both must say `MAILROOM_D1` / `MAILROOM_R2`).
- **`401 Unauthorized` on every request** — token mismatch. Re-run `yarn secret:set` and confirm the value the curl command sends matches.
- **`email()` handler not firing** — confirm Email Routing is configured in CF dashboard with action "Send to a Worker → smallstore". Routes (`smallstore.labspace.ai/*`) only handle HTTP fetch; email routing is a separate config.

## Related

- `../serve.ts` — local Deno server with the same routes (used for tests + local dev without wrangler).
- `../src/messaging/` — the channel + inbox + registry implementations this Worker wires together.
- `../scripts/build-npm.ts` — the dnt build that produces `../dist/` for `file:` consumption.
- `../../../coverflow/coverflow-v3/platform/deployments/cf-worker/` — the pattern this deploy mirrors.
