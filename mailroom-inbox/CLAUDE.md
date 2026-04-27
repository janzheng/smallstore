# mailroom-inbox — triage workspace

Start Claude Code sessions here when you're **operating the mailroom inbox** — reading, confirming subscriptions, deleting spent codes, bookmarking, archiving, managing auto-confirm patterns.

For **developing the smallstore Worker** (code, build, deploy, tests), `cd ..` and use the project-root `CLAUDE.md` instead. Different UX, different workspace.

## Hitting the deployed Worker

The Worker is at `https://smallstore.labspace.ai`. The bearer token lives in `../deploy/.env` as `SMALLSTORE_TOKEN` (gitignored — never copy the value into repo files). Sessions started from this folder should use the relative path:

```sh
set -a && source ../deploy/.env && set +a
curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" "https://smallstore.labspace.ai/inbox/mailroom?limit=20" | jq
```

Routes behind auth: `/api/*`, `/inbox/*`, `/admin/*`, `/peers/*`. `/health` and `/` are open.

## Always surface `needs-confirm` first

When asked "what's in the mailroom" / "did anything land" / "check my inbox", **always run a `needs-confirm` sweep before summarizing**. Double-opt-in confirmations get buried and block future newsletter delivery — surface them as their own line.

```sh
curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" \
  -X POST "https://smallstore.labspace.ai/inbox/mailroom/query" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"labels":["needs-confirm"]},"limit":50}' \
  | jq '{pending: (.items | length), items: [.items[] | {id, from: .fields.from_email, subject: .fields.subject, confirm_url: .fields.confirm_url}]}'
```

If any items come back, surface them as a separate callout (not buried in the general list). Offer to batch-confirm via the endpoint or the `sm_inbox_confirm` MCP tool. For manual clicks: show the URL first so the user stays in the loop.

## Common triage flows (MCP tools)

| Goal | Tool |
|---|---|
| List recent items | `sm_inbox_list` (pass `order_by: original_sent_at` to sort by upstream send date instead of when it landed) |
| Filter by labels/sender/date | `sm_inbox_query` |
| Read full item | `sm_inbox_read` |
| Click a confirm link | `sm_inbox_confirm` |
| Hard-delete (spent codes, spam) | `sm_inbox_delete` |
| Bookmark | `sm_inbox_tag` with `add: ["bookmark"]` |
| Add/update a note on a past forward | `sm_inbox_set_note` with `note` (or `mode: "append"` to stack thoughts; `mode: "edit"` + `find`/`replace` for surgical line edits like marking a single todo done) |
| Archive (soft, queryable) | `sm_inbox_tag` with `add: ["archived"]` |
| Mark read / unread | `sm_inbox_mark_read` / `sm_inbox_mark_unread` |
| Unsubscribe | `sm_inbox_unsubscribe` |
| List quarantine | `sm_inbox_quarantine_list` |
| Restore from quarantine | `sm_inbox_restore` |
| Export | `sm_inbox_export` |
| List/create/edit rules | `sm_inbox_rules_*` |

## Newsletter views — chronological + per-publisher notes

Forwards are auto-grouped by `fields.newsletter_slug` (derived from sender display name). Use these when the user wants to read a publisher in order or pull aggregate notes.

| Goal | Tool |
|---|---|
| What newsletters have I forwarded? | `sm_newsletters_list` |
| Profile for one publisher (count, first/last seen, notes count) | `sm_newsletter_get` with `slug` |
| Read a publisher in chronological order (by upstream send date, NOT forward date) | `sm_newsletter_items` with `slug, order: "oldest"` (default) or `"newest"` |
| Pull all my notes for one publisher (slim shape, LLM-ready) | `sm_newsletter_notes` with `slug` |
| What action items did I write into my notes? | `sm_inbox_todos` (optionally `slug` to scope, `since` to filter by forward date) — surfaces lines like "remind me to...", `- [ ] ...`, "TODO: ...", "sub me to..." |
| Show / search all my notes across newsletters | `sm_inbox_notes` (optionally `text` for substring match on note text only, `slug` to scope) |

Slugs are visible via `sm_newsletters_list` — common ones today: `internet-pipes`, `sidebar-io`. Fields populated on every forward: `original_sent_at`, `original_message_id`, `newsletter_slug`, `forward_note` (anything the user typed before the forwarded block).

## Backfill new fields onto historical items (rare, admin-side)

If the Worker just shipped a new forward-detect field and existing items don't have it yet, use `sm_inbox_replay_hook` — generalized retroactive backfill. **Always dry-run first.**

```
sm_inbox_replay_hook {
  inbox: "mailroom",
  hook: "forward-detect",
  filter: {fields_regex: {subject: "IP Digest|Pipes "}},
  dry_run: true
}
// → {scanned, matched, samples: [{id, item, added_fields}, ...]}

// If samples look right, drop dry_run for the real run.
```

Hooks registered for replay on `mailroom`: `forward-detect`, `sender-aliases`, `plus-addr`, `newsletter-name`. Preserves identity + index entry; only shallow-merges new `fields`.

## Auto-confirm allowlist (runtime ops)

Patterns are stored in D1 and editable at runtime — no redeploy needed. Items confirmed automatically carry the `auto-confirmed` label (not `needs-confirm`).

| Goal | MCP tool | curl |
|---|---|---|
| List active patterns | `sm_auto_confirm_list` | `GET /admin/auto-confirm/senders` |
| Add a pattern | `sm_auto_confirm_add` | `POST /admin/auto-confirm/senders` |
| Remove a pattern | `sm_auto_confirm_remove` | `DELETE /admin/auto-confirm/senders/<urlencoded-pattern>` |

Currently seeded patterns: `*@substack.com`, `*@substackmail.com`, `*@convertkit.com`, `*@beehiiv.com`, `*@mailerlite.com`, `*@emailoctopus.com`, `*@uxdesign.cc`, `*@every.to`. New env patterns seed on cold start; runtime deletes survive (sentinel-tracked).

## When things break

If MCP tools return 404, the Worker is down, or auto-confirm isn't firing — that's a development task. `cd ..` and follow the project-root `CLAUDE.md` (build, deploy, test, diagnose). Common pointer: rebuild + deploy with `deno task build:npm && cd deploy && yarn deploy`.

## Peer registry (other data sources)

If you need data outside the mailroom — Notion, Airtable, Sheets, Tigerflare, other smallstores — the `sm_peers_*` family browses/queries registered peers. Run `sm_peers_list` to see what's wired up.
