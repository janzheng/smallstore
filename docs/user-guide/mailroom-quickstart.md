# Mailroom + Peers — Quickstart

Practical recipes for using the deployed `smallstore.labspace.ai` — curate newsletters, register external data sources, use the proxy surface.

**Prereq:** you have the `SMALLSTORE_TOKEN` bearer token (the same token the Worker has as a secret). Everything behind `/api/*`, `/inbox/*`, `/admin/*`, `/peers/*` requires `Authorization: Bearer $TOKEN`.

```bash
export TOKEN="<your-smallstore-token>"
export BASE="https://smallstore.labspace.ai"
```

---

## What's where

```
smallstore.labspace.ai
  /health                          — public probe
  /                                — public landing page (endpoint index)
  /api/*                           — universal smallstore CRUD (any collection)
  /inbox/:name                     — messaging surface (list/query/export/rules)
  /admin/inboxes                   — runtime inbox CRUD
  /peers                           — peer registry (atlas of external data sources)
```

Default inbox: `mailroom`. Default CF Email routing: `mailroom*@labspace.ai` → this Worker (subaddressing enabled, so `mailroom+anything@labspace.ai` also works).

---

## Part 1 — Mailroom: receiving + curating mail

### 1.1 Subscribe to a newsletter with `mailroom@labspace.ai`

Just use `mailroom@labspace.ai` as your subscribe address. Future issues land in the inbox with automatic `newsletter` label (via `List-Unsubscribe` header detection).

### 1.2 Forward a cool email from Gmail

Forward from any Gmail account on your `SELF_ADDRESSES` whitelist:

```
To: mailroom+bookmark@labspace.ai
    (or +archive, +read-later, +star, +snooze, +inbox)
    (or plain mailroom@ — forward-detect still fires but no intent label)
```

What you get automatically:
- `forwarded` + `manual` labels (forward-detection recognizes you forwarded)
- `bookmark` label (plus-addressing intent, or whitelist rule if present)
- Original-message extraction from the forwarded body:
  - `fields.original_from_email` + `fields.original_from_addr` + `fields.original_subject`
  - `fields.original_sent_at` — when the upstream sender actually sent it (parses Gmail/Outlook/RFC-5322/ISO date headers); enables chronological reading list (§ 1.13).
  - `fields.original_message_id` + `fields.original_reply_to` — for cross-mailbox threading.
  - `fields.newsletter_slug` — derived from the display name (`X at Y` → `y`, `X by Z` → `x`, slugified). Groups forwards from the same publisher into a single newsletter profile (§ 1.13).
- Anything you typed before the forwarded block is captured as `fields.forward_note` — that becomes your aggregate notes per newsletter.
- Plus any classifier labels (`newsletter`, `list`, `bounce`, etc.) based on headers

### 1.3 List what's in the inbox

```bash
# Everything newest-first
curl -H "Authorization: Bearer $TOKEN" "$BASE/inbox/mailroom?limit=10"

# Just bookmarks
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"labels":["bookmark"]}' \
  "$BASE/inbox/mailroom/query"

# Main view (excludes archived + quarantined)
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"exclude_labels":["archived","quarantined"]}' \
  "$BASE/inbox/mailroom/query"
```

### 1.4 Read one item (with full body inflation)

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/items/<id>?full=true"
```

### 1.5 Download newsletters as JSONL (for LLM processing)

```bash
# All bookmarks, body inlined, streaming JSONL
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/export?filter=%7B%22labels%22%3A%5B%22bookmark%22%5D%7D&include=body&format=jsonl" \
  > bookmarks.jsonl

# Stream into an LLM
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/export?filter=%7B%22labels%22%3A%5B%22newsletter%22%5D%7D&include=body&format=jsonl&limit=20" \
  | jq -c '{subject: .summary, from: .fields.from_addr, body: .body}' \
  | your-llm-summarizer
```

Format options:
- `format=jsonl` — streaming, one JSON item per line (constant memory)
- `format=json` — single array (small exports only)

Include options:
- `include=body` — fetches body_ref from blobs adapter, inlines the full body
- Without `include=body`, items list has `body_ref` (you'd need a second fetch per item)

Filter options:
- URL-encoded JSON matching `InboxFilter`: `labels`, `exclude_labels`, `fields`, `fields_regex`, `text`, `text_regex`, `headers`, `since`, `until`, `source`

### 1.6 Create rules — auto-archive, auto-bookmark

**Archive a sender going forward:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"match":{"fields":{"from_email":"noreply@noisynewsletter.com"}},"action":"archive"}' \
  "$BASE/inbox/mailroom/rules"
```

**Archive + retroactively tag existing items from that sender:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"match":{"fields":{"from_email":"noreply@noisynewsletter.com"}},"action":"archive"}' \
  "$BASE/inbox/mailroom/rules?apply_retroactive=true"
# → { "created": {...}, "retroactive": { "affected": N } }
```

**Whitelist multiple addresses → auto-bookmark:**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "match": {
      "fields": {
        "from_email": ["alice@trusted.com", "bob@curator.com", "you@self.com"]
      }
    },
    "action": "bookmark",
    "priority": 50,
    "notes": "Auto-bookmark forwards from trusted whitelist"
  }' \
  "$BASE/inbox/mailroom/rules?apply_retroactive=true"
```

**Regex match (needs `fields_regex` instead of `fields`):**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "match": { "fields_regex": { "from_email": "@(substack|beehiiv)\\.com$" } },
    "action": "tag",
    "action_args": { "tag": "platform-newsletter" }
  }' \
  "$BASE/inbox/mailroom/rules"
```

**Rule actions:**
- `archive` — tag `archived` (main view hides it; dedicated view via `?labels=archived`)
- `bookmark` — tag `bookmark`
- `tag` — tag with whatever you put in `action_args.tag`
- `drop` — item reaches worker, gets parsed, but **not stored** (use for runtime-editable blocklist)
- `quarantine` — store + tag `quarantined` (hidden from main view, recoverable)

Semantics: tag-style actions (archive/bookmark/tag) **stack** from every matching rule. Terminal actions (drop/quarantine) use **first-match by priority** (lower wins; ties broken by oldest `created_at`).

### 1.7 Manage rules

```bash
# List
curl -H "Authorization: Bearer $TOKEN" "$BASE/inbox/mailroom/rules"

# Get one
curl -H "Authorization: Bearer $TOKEN" "$BASE/inbox/mailroom/rules/<id>"

# Update (partial patch)
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"disabled":true}' \
  "$BASE/inbox/mailroom/rules/<id>"

# Delete
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/inbox/mailroom/rules/<id>"

# Retroactive apply on-demand
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/rules/<id>/apply-retroactive"
# → { "affected": N }
```

### 1.8 Manual tagging (override auto-labels per-item)

```bash
# Add labels
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"add":["read-later","important"]}' \
  "$BASE/inbox/mailroom/items/<id>/tag"

# Remove labels (e.g. if a rule over-tagged something)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"remove":["archived"]}' \
  "$BASE/inbox/mailroom/items/<id>/tag"

# Both at once
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"add":["bookmark"],"remove":["read-later"]}' \
  "$BASE/inbox/mailroom/items/<id>/tag"
```

### 1.9 Unsubscribe from a sender

RFC 8058 one-click if the original mail had `List-Unsubscribe` header with an HTTPS URL; mailto passthrough otherwise. Always tags the sender `unsubscribed` in the sender-index.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"address":"newsletter@annoying.com"}' \
  "$BASE/inbox/mailroom/unsubscribe"
```

### 1.10 Quarantine / restore

```bash
# List quarantined items
curl -H "Authorization: Bearer $TOKEN" "$BASE/inbox/mailroom/quarantine"

# Restore one (removes 'quarantined' label; other labels preserved)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/restore/<id>"
```

### 1.11 Hard delete (gone forever)

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/items/<id>"
```

### 1.12 The 6 ways to "remove"

| Level | When to use |
|---|---|
| CF Email Routing → Drop rule (dashboard) | Never want this domain again, ever |
| Rule `action: drop` | Same, but runtime-toggleable |
| Rule `action: quarantine` | Probably unwanted but want to review |
| Rule `action: archive` | I like it, just not in my main view — **back-burner keep** |
| Tag remove | A specific item got mislabeled |
| Hard delete | One-off cleanup |

### 1.13 Browse newsletters chronologically + extract notes per newsletter

Forwards land grouped under `fields.newsletter_slug` (auto-derived from sender display name). Four read-only routes turn that into a real reading-list / notes-per-publisher view — useful when you've forwarded a batch of issues out of order, or want to dump everything you've ever said about a publisher into an LLM.

**List all newsletters you've ever forwarded:**

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/inbox/mailroom/newsletters" | jq
# → {"newsletters": [{slug, count, latest_at, display}, ...]} (latest-first)
```

**Profile dashboard for one newsletter** (count, first/last seen, notes count, latest note):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/newsletters/internet-pipes" | jq
```

**Read it in order** — chronological by `original_sent_at` (when the publisher actually sent it, NOT when you forwarded it):

```bash
# Default oldest-first
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/newsletters/internet-pipes/items?limit=30" | jq

# Newest-first if you want the freshest issue
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/newsletters/internet-pipes/items?order=newest" | jq
```

**Pull all your notes for one newsletter** — slim shape `{id, original_sent_at, received_at, subject, from, note}` so you can pipe straight into an LLM:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/newsletters/internet-pipes/notes" \
  | jq '.notes' \
  | your-llm-summarizer
```

**Sort any inbox query by original send date** — `order_by=received_at|sent_at|original_sent_at` works on `GET /inbox/:name` and `POST /inbox/:name/query`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom?order_by=original_sent_at&limit=50" | jq
```

Items missing the chosen sort field always tail. Cursor pagination is disabled in non-default sort modes (use `limit` alone). For inboxes < ~10K items the in-memory sort is fine; the scaling cliff is the same `_index` blob caveat tracked in TASKS-MESSAGING.

### 1.14 Add or revise a note after the fact

When a forward landed without a note, or you want to revise an existing one. Pairs with § 1.13 — the note immediately surfaces in `/inbox/:name/newsletters/:slug/notes`.

```bash
# Replace (default) — overwrites whatever was there
curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H "Content-Type: application/json" \
  -d '{"note":"This issue made me rethink supply chain ops."}' \
  "$BASE/inbox/mailroom/items/<id>/note"

# Append — joins to the existing note via a thematic break (good for multiple
# thoughts over time, e.g. "I came back to this a month later and noticed...")
curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H "Content-Type: application/json" \
  -d '{"note":"Followup thought.","mode":"append"}' \
  "$BASE/inbox/mailroom/items/<id>/note"

# Clear — pass empty string
curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H "Content-Type: application/json" \
  -d '{"note":""}' \
  "$BASE/inbox/mailroom/items/<id>/note"
```

Identity (id, received_at, source, summary, body, labels) and the inbox index entry are preserved — the annotation only touches `fields.forward_note` and stamps `fields.note_updated_at`. So a late annotation never re-orders your inbox or duplicates the item.

### 1.15 Backfill a new field across existing items (hook replay)

When a new forward-detect field ships (e.g. you start extracting `original_sent_at` after some items already exist without it), run the hook over the historical items via `POST /admin/inboxes/:name/replay`. This is the generalized form of `apply_retroactive` for rules.

**Always dry-run first** — returns up to 10 sample diffs without writing:

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "hook": "forward-detect",
    "filter": {"fields_regex": {"subject": "IP Digest|Pipes "}},
    "dry_run": true,
    "limit": 50
  }' \
  "$BASE/admin/inboxes/mailroom/replay" | jq
# → {scanned, matched, samples: [{id, item, added_fields}, ...]}
```

**Then live-run** (drop `dry_run`):

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H "Content-Type: application/json" \
  -d '{"hook": "forward-detect", "filter": {"fields_regex": {"subject": "IP Digest|Pipes "}}}' \
  "$BASE/admin/inboxes/mailroom/replay" | jq
# → {scanned, matched, applied, errors: []}
```

**Hooks registered as replayable for `mailroom`:** `forward-detect`, `sender-aliases`, `plus-addr`, `newsletter-name`. Adding a new replayable hook is one line in `deploy/src/index.ts → replayHookFor()`.

**What it preserves:** identity (`id`, `received_at`, `source`, `source_version`), index entry, blobs/refs. It only shallow-merges new `fields` keys (existing values win on collision unless the hook explicitly overwrites) and unions `labels`. Drop / quarantine actions during replay are skipped (replays add fields, they don't curate).

Real precedent: 2026-04-26 backfilled 24/26 IP Digest forwards with `newsletter_slug` + `original_sent_at`, enabling § 1.13's chronological view against historical data.

Mental model: **archive is aspirational keeping, CF-drop is declared non-existence.**

---

## Part 2 — Peer registry: the data atlas

### 2.1 What's a peer?

A peer is a data source smallstore **knows about** but doesn't own — tigerflare, random Google Sheetlogs, other smallstore deployments, eventually webdav. Register them runtime (no redeploy) via HTTP; smallstore acts as an authenticated proxy.

Key distinction:
- **Adapters** own data and are library-imported at deploy-time
- **Peers** know about data and are runtime-registered

### 2.2 Register a peer

Secrets live in Worker env (via `wrangler secret put`). Peer rows reference them by name (`token_env: 'TF_TOKEN'`).

**Tigerflare** (bearer auth):

```bash
# First set the secret on the Worker
cd deploy
echo "<your-tigerflare-bearer-token>" | npx wrangler secret put TF_TOKEN

# Then register the peer
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "tigerflare-prod",
    "type": "tigerflare",
    "url": "https://tigerflare.labspace.ai",
    "auth": { "kind": "bearer", "token_env": "TF_TOKEN" },
    "description": "primary tigerflare — mac/erko/sparkie sync",
    "tags": ["prod", "personal"]
  }' \
  "$BASE/peers"
```

**Sheetlog** (query-param auth):

```bash
echo "<apps-script-api-key>" | npx wrangler secret put SHEETLOG_KEY

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "faves-sheetlog",
    "type": "sheetlog",
    "url": "https://script.google.com/macros/s/AKfycb...xyz/exec",
    "auth": { "kind": "query", "name": "key", "value_env": "SHEETLOG_KEY" },
    "tags": ["personal"]
  }' \
  "$BASE/peers"
```

**Another smallstore** (bearer auth):

```bash
echo "<other-smallstore-token>" | npx wrangler secret put V2_TOKEN

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "smallstore-v2",
    "type": "smallstore",
    "url": "https://smallstore-v2.workers.dev",
    "auth": { "kind": "bearer", "token_env": "V2_TOKEN" }
  }' \
  "$BASE/peers"
```

**Generic HTTP endpoint** (no auth):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "hn-best",
    "type": "http-json",
    "url": "https://hacker-news.firebaseio.com/v0",
    "auth": { "kind": "none" }
  }' \
  "$BASE/peers"
```

### 2.3 List + filter peers

```bash
# All of them
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers"

# By tag (AND semantics — all listed tags must be present)
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers?tags=prod,personal"

# By type
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers?type=tigerflare"

# Name substring (case-insensitive)
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers?name=tiger"

# Include disabled peers
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers?include_disabled=true"
```

### 2.4 Probe health

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers/tigerflare-prod/health"
# → { "peer": "tigerflare-prod", "ok": true, "status": 200, "latency_ms": 42 }
```

Missing env var surfaces cleanly:
```
{ "ok": false, "status": 0, "error": "env var TF_TOKEN is not set", "latency_ms": 0 }
```

### 2.5 Proxy-fetch — one bearer token, many peers

```bash
# GET — the `path` query param is URL-encoded and appended to peer.url
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/peers/tigerflare-prod/fetch?path=%2Finbox%2F"
# → proxies to https://tigerflare.labspace.ai/inbox/
#   with Authorization: Bearer ${env.TF_TOKEN}

# Other client query params are preserved + forwarded:
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/peers/tigerflare-prod/fetch?path=%2Finbox%2F&limit=10&grep=foo"
# → GET https://tigerflare.labspace.ai/inbox/?limit=10&grep=foo
```

### 2.6 Proxy-POST — query / write via proxy

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"filter":{"labels":["bookmark"]}}' \
  "$BASE/peers/smallstore-v2/query?path=/inbox/mailroom/query"
# → POST https://smallstore-v2.workers.dev/inbox/mailroom/query
#   with Authorization: Bearer ${env.V2_TOKEN}
#   and the body forwarded verbatim
```

### 2.7 Update / disable / rename / delete

```bash
# Patch any subset of fields
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"disabled":true}' \
  "$BASE/peers/tigerflare-prod"

# Rename — id stays stable, slug changes
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"tf-primary"}' \
  "$BASE/peers/tigerflare-prod"

# Delete
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/peers/tigerflare-prod"
```

### 2.8 Auth kinds reference

```jsonc
// No auth
{ "kind": "none" }

// Bearer token
{ "kind": "bearer", "token_env": "TF_TOKEN" }
// → adds Authorization: Bearer ${env.TF_TOKEN}

// Custom header
{ "kind": "header", "name": "X-API-Key", "value_env": "SOME_KEY" }
// → adds X-API-Key: ${env.SOME_KEY}

// Query string param (Sheetlog/Apps Script style)
{ "kind": "query", "name": "key", "value_env": "SHEETLOG_KEY" }
// → appends ?key=${env.SHEETLOG_KEY} to the outbound URL

// HTTP Basic (webdav-style)
{ "kind": "basic", "user_env": "DAV_USER", "pass_env": "DAV_PASS" }
// → adds Authorization: Basic base64(${env.DAV_USER}:${env.DAV_PASS})
```

### 2.9 Peer types

| Type | Health probe | Notes |
|---|---|---|
| `smallstore` | `GET /health` | Other smallstore deployments |
| `tigerflare` | `GET /health` | Tigerflare Workers |
| `sheetlog` | `HEAD /` | Apps Script web apps (query-auth typical) |
| `rss` | n/a | RSS / Atom feed source — `metadata.feed_config.target_inbox` names the inbox; in-Worker pull-runner polls on cron |
| `webhook` | n/a | Inbound HTTP webhook target — see § 2.10 |
| `webdav` | `OPTIONS /` | WebDAV servers (basic-auth typical; level-3 adapter future) |
| `http-json` | `HEAD /` | Generic JSON APIs |
| `generic` | `HEAD /` | Catch-all |

Type is metadata + a health-probe method hint. MVP uses the same proxy path for all types; type-specific smarts come in level 3.

### 2.10 Webhook ingest — turn any HMAC'd webhook into an InboxItem

Register a webhook peer to give an external service (GitHub, Stripe, Linear, Slack, custom poller) a structured ingest target with HMAC verification and JSON-path field mapping. The receiving URL is `POST /webhook/<peer-name>`.

**Flow:**

1. Register a peer with `type: 'webhook'` and a `metadata.webhook_config`.
2. Set the peer's HMAC secret via `wrangler secret put <ENV_NAME>` (or your host's equivalent).
3. Point the upstream service at `https://<your-host>/webhook/<peer-name>`.
4. When a webhook lands, smallstore verifies HMAC, parses the JSON body, extracts mapped fields, and ingests into `target_inbox`.

**`webhook_config` fields:**

| Field | Required | Purpose |
|---|---|---|
| `target_inbox` | yes | Inbox name to ingest into. |
| `default_labels` | no | Labels every webhook item gets at ingest. |
| `source` | no | Override `InboxItem.source` (e.g. `"github"`). Default `"webhook"`. |
| `source_version` | no | Override `InboxItem.source_version` (e.g. `"github-pr/v1"`). Default `"webhook/v1"`. |
| `fields.id` | no but recommended | Dotted path to a stable upstream id. When set, dedup uses `sha256(peer_name + ':' + extracted_id)` so retries land on the same InboxItem. |
| `fields.summary` | no | Path to a short title / event line. |
| `fields.body` | no | Path to body / description. |
| `fields.sent_at` | no | Path to a timestamp (ISO string or unix seconds/ms). |
| `fields.thread_id` | no | Path to a thread / conversation id. |
| `hmac.header` | yes (if `hmac` set) | Signature header name (e.g. `X-Hub-Signature-256`). |
| `hmac.algorithm` | no | `sha256` (default) or `sha1`. |
| `hmac.prefix` | no | Prefix to strip from header value (e.g. `sha256=`). |
| `hmac.secret_env` | yes (if `hmac` set) | Env var name holding the secret. Resolved at request time. |

**Authentication note:** `POST /webhook/:peer` does NOT require the smallstore bearer token — HMAC IS the authentication mechanism. Peers without an `hmac` block have unauthenticated webhook URLs by your choice; document the trade-off in your peer setup. Registering / managing peers themselves still requires the bearer.

#### Example — GitHub PR webhook

```bash
# 1. Register a webhook peer
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "github-prs",
    "type": "webhook",
    "url": "https://smallstore.labspace.ai/webhook/github-prs",
    "description": "GitHub PR events from the foo/bar repo",
    "metadata": {
      "webhook_config": {
        "target_inbox": "github",
        "default_labels": ["github", "pr"],
        "source": "github",
        "source_version": "github-pr/v1",
        "fields": {
          "id": "pull_request.id",
          "summary": "pull_request.title",
          "body": "pull_request.body",
          "sent_at": "pull_request.created_at",
          "thread_id": "pull_request.id"
        },
        "hmac": {
          "header": "X-Hub-Signature-256",
          "algorithm": "sha256",
          "prefix": "sha256=",
          "secret_env": "GITHUB_WEBHOOK_SECRET"
        }
      }
    }
  }' \
  "$BASE/peers"

# 2. Set the secret on the Worker
wrangler secret put GITHUB_WEBHOOK_SECRET

# 3. Configure GitHub: Settings → Webhooks → Add webhook
#    Payload URL:  https://smallstore.labspace.ai/webhook/github-prs
#    Content type: application/json
#    Secret:       (the value you just set)
#    Events:       Pull requests

# 4. Verify by opening a PR, then querying the inbox
curl -H "Authorization: Bearer $TOKEN" "$BASE/inbox/github?limit=5" | jq
```

**Same shape works for:**
- **Stripe** — `header: "Stripe-Signature"`, no prefix, parse webhook signing secret. (Stripe's signature format is `t=...,v1=...`; current channel handles a single hex signature; use Stripe's `whsec_*` directly with prefix-trimming via your own pre-handler if you want strict Stripe parity. Plain hex HMAC works for most Stripe-style emitters.)
- **Linear / Slack / Discord** — sha256 HMAC with vendor-specific headers.
- **Custom pollers** — your own scripts can sign and POST; gives you a structured target with retry-safe dedup and label routing.

**Idempotency:** when `fields.id` resolves, retries / duplicate deliveries dedup to the same `InboxItem.id` via `sha256(peer_name + ':' + extracted_id)`. Without `fields.id`, dedup falls back to a canonical-JSON hash of the whole payload (replay-safe but drift-sensitive).

**Disable a webhook** — `PUT /peers/<name>` with `{"disabled": true}`. The route 404s while disabled; re-enable when ready.

---

## Part 3 — Common workflows

### 3.1 Bookmark a cool newsletter from Gmail

```
1. Forward from Gmail → mailroom+bookmark@labspace.ai
2. Wait a few seconds for CF Email Routing + ingestion pipeline
3. curl -H "Authorization: Bearer $TOKEN" \
     "$BASE/inbox/mailroom?limit=1"
   # Should show the new item with labels ['forwarded', 'manual', 'bookmark', ...]
```

### 3.2 LLM-summarize all bookmarked newsletters this week

```bash
SINCE="2026-04-18"
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/inbox/mailroom/export?filter=%7B%22labels%22%3A%5B%22bookmark%22%5D%2C%22since%22%3A%22$SINCE%22%7D&include=body&format=jsonl" \
  | jq -s '.' \
  | your-llm-summarizer
```

### 3.3 Auto-archive a noisy newsletter going forward + clean up existing

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "match": {"fields":{"from_email":"newsletter@noisy.com"}},
    "action": "archive"
  }' \
  "$BASE/inbox/mailroom/rules?apply_retroactive=true"
```

### 3.4 Federated query — "find X across all my peers"

```bash
# 1. List peers
curl -H "Authorization: Bearer $TOKEN" "$BASE/peers" | jq -r '.peers[].name' \
  | while read peer; do
      echo "=== $peer ==="
      curl -H "Authorization: Bearer $TOKEN" \
        "$BASE/peers/$peer/fetch?path=/inbox/?grep=X" 2>/dev/null
    done
```

(This is a primitive script — real federated search lives as `#peers-federated-search` in the parked list.)

### 3.5 Mirror mailroom to tigerflare via httpSink (requires code change)

Not yet configurable via HTTP — this would be a code change in `deploy/src/index.ts` to add a second sink to the mailroom registration alongside `inboxSink`. Parked as `#curation-httpsink-wire` (not tracked yet).

---

## Part 4 — Gotchas

- **Subaddressing** — CF Email Routing has "Enable subaddressing" toggled on, so `mailroom+anything@labspace.ai` already routes via the existing `mailroom@labspace.ai` rule. No per-suffix rule needed.
- **`from_email` is the raw address, `from_addr` includes the display name** — for rules that should match on "Sidebar.io" (display), match `from_addr`, not `from_email`. Example: `{"fields":{"from_addr":"Sidebar"}}`.
- **Rules are additive by default** — creating a rule doesn't retroactively tag existing items. Add `?apply_retroactive=true` to the POST, or call `POST /rules/:id/apply-retroactive` anytime.
- **Retroactive only works for tag-style actions** — dropping or quarantining already-stored items is not supported retroactively (use DELETE for that).
- **Main view hides archived + quarantined** — when querying "my inbox," pass `exclude_labels: ['archived', 'quarantined']` or use the `mainViewFilter` library helper on the code side.
- **Peer auth is env-resolved at request time** — changing a peer's `token_env` without also setting the referenced secret on the Worker will 502 on proxy.
- **Smallstore's token never forwards to a peer** — the proxy strips `Authorization` from client-forwarded headers and injects the peer's own auth fresh. Prevents credential leaks.
- **Response `content-encoding` is stripped** — fetch decodes gzip transparently, so the proxy strips that header to avoid confusing downstream consumers.

---

## Part 5 — Where to go deeper

- **Design briefs:**
  - `.brief/mailroom-pipeline.md` — Sink abstraction + hook pipeline + filter DSL foundation
  - `.brief/mailroom-curation.md` — bookmarks / archive / rules / removal taxonomy
  - `.brief/peer-registry.md` — peers as symlinks, auth model, L1/L2/L3 roadmap
  - `.brief/forward-notes-and-newsletter-profiles.md` — newsletter slug + chronological view + replay-hook system (§ 1.13 / 1.14)
  - `.brief/deploy-gotchas.md` — operational hazards (yarn `link:..` vs `file:..`, etc.)
- **Sprint narratives (if you want to see the how-we-got-here):**
  - `.brief/2026-04-24-mailroom-sprint.md`
  - `.brief/2026-04-25-curation-sprint.md`
  - `.brief/2026-04-25-peer-registry-sprint.md`
- **Plugin architecture:** `docs/design/PLUGIN-AUTHORING.md` — the 4 invariants that keep smallstore from sprawling, + role decision tree (adapter/channel/sink/processor)
- **Task queue:** top-level `TASKS.md` + `TASKS-MESSAGING.md`
- **Done archive:** `TASKS.done.md`
