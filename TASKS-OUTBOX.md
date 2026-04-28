# Smallstore — Outbox (sending)

Area-backlog for the **outbound** side of the messaging subsystem. Mailroom + ingest/inbound work lives in `TASKS-MESSAGING.md`; this file is the parallel for sending.

**Status: parked.** Not a current need. Promote when a real reply / send / notification use case lands. The shape below is design-level only — no spike has run, no code exists.

> **Why a separate file?** TASKS-MESSAGING.md is the active mailroom backlog (90+ items, daily churn). Outbox is multi-session future work with zero code today. Splitting keeps the active file focused on current sprints + makes the outbox plan easier to find when it does come up.

## Promotion triggers

Move outbox work into `TASKS.md § Current` when ONE of these is true:
- A workflow needs to *reply* to inbox items (e.g. an LLM agent generating responses) — this is the `sm_messaging_respond` flow
- A workflow needs to *send* fresh mail (e.g. digest summaries to the user from a cron) — covered by `sm_outbox_send`
- A workflow needs *webhook notifications* (Slack/Discord/generic POST with retry) — covered by `cf-webhook-out`
- The user wants an offline mailroom→tigerflare→reply→email round-trip (the natural extension of the current notes/todos/mirror flow)

Until then: skip, don't pre-build.

## Open work (in priority order, but parked)

### Pre-implementation spike

- [ ] **Spike: queue substrate** — D1-table-as-queue + R2-as-payload-store vs CF Queues + DO alarms. Measure both for retry/backoff ergonomics, dead-letter shape, observability. Decide before building anything else. **Cost:** 1-2 hours; defers all downstream work until done. `#outbox #spike`

### Core plugin

- [ ] **`src/messaging/outbox.ts`** — Outbox plugin shape: `enqueue(draft)` (idempotent via `idempotency_key`), `status(id)`, `list({ filter, cursor, limit })`, `cancel(id)`, `history(id)` (per-attempt log). Reply linkage: drafts can carry `reply_to: { inbox, item_id }` so the system tracks which outbound mail responds to which inbound. `#outbox #impl #needs:queue-spike`
- [ ] Stub types (`Outbox`, `OutboxDraft`, `OutboxStatus`) — already shipped to `types.ts`. ✅

### Channels

- [ ] **`src/messaging/channels/cf-email-out.ts`** — first output channel. Wraps `env.EMAIL.send` (Cloudflare Email Sending public beta — verify availability + rate limits). Maps `OutboxDraft` → `EmailMessage` shape. `#outbox #channel-cf-email-out #needs:queue-spike`
- [ ] **`cf-webhook-out`** — generic POST with retry policy. Useful for Slack / Discord / generic webhooks. Reuses the same retry-fetch infra as the inbox webhook channel. `#outbox #channel-webhook-out #needs:queue-spike`
- [ ] Future: SMS (Twilio), push (FCM/APNs), Slack-native — slot into the channel registry once the cf-email-out + cf-webhook-out flow is proven.

### HTTP surface

- [ ] HTTP routes — `POST /outbox/:name/send`, `GET /outbox/:name`, `GET /outbox/:name/items/:id/history`, `POST /outbox/:name/items/:id/cancel`. Mirrors the `/inbox/:name/*` shape so MCP tooling generalizes. `#outbox #http #needs:outbox-impl`

### MCP tools

- [ ] **`sm_outbox_send(inbox, to, subject, body, options?)`** — fresh mail.
- [ ] **`sm_outbox_status(id)`** — single-draft status + per-attempt history.
- [ ] **`sm_outbox_list({ inbox, filter?, cursor?, limit? })`** — drafts/queued/sent/failed.
- [ ] **`sm_outbox_cancel(id)`** — cancel before send.
- [ ] **`sm_outbox_history(id)`** — full per-attempt log.
- [ ] **`sm_messaging_respond(inbox, item_id, body, options?)`** — sugar for the reply flow: reads the inbox item, threads `reply_to` + `In-Reply-To` headers, enqueues with `idempotency_key` derived from `item_id` so retrying the call doesn't double-send. The killer feature for agent-mediated replies. `#outbox #mcp #needs:outbox-http`

## Open questions (resolve at promotion time, not now)

- **Idempotency key derivation** — caller-supplied vs derived from `(reply_to.item_id, hash(body))`? Probably both — caller can override.
- **DLQ shape** — separate D1 table vs `failed` status with retention? Matters more once we see real failure modes.
- **Throttling / per-recipient quota** — CF Email Sending has limits; outbox should self-throttle. How exposed should this be? Probably internal heuristic + admin override.
- **Reply threading correctness** — `In-Reply-To` + `References` header construction from the inbox item's Message-ID. Pure utility, but worth a focused test once it exists.
- **Send-as identity** — can the outbox send AS the user (`hello@janzheng.com`)? Depends on CF Email Sending's verified-domain config. Document at the spike phase.

## Out of scope (unless a real need surfaces)

- Multi-recipient batch send (`sm_outbox_send_many`) — premature; single-recipient covers reply + notification flows.
- Templated drafts (mustache / handlebars) — agents build the body. The outbox just queues + sends.
- Schedule-for-later — CF Queues + DO alarms can do this if the spike picks that path; not a v1 feature.
- A2P / commercial sending compliance (CAN-SPAM unsubscribe footers, etc.) — out of scope until the user actually wants to send to non-self addresses.

## See also

- `TASKS-MESSAGING.md` — inbound side (mailroom + spam-layers + channels-in)
- `src/messaging/types.ts` — `Outbox`, `OutboxDraft`, `OutboxStatus` stubs already shipped
- Predecessor design notes (superseded but preserved): `research/_workshop/messaging-plugins-inbox-outbox.md`, `research/_workshop/inboxes-as-first-class.md`
- When implementation kicks off, write `.brief/outbox.md` first per the standard fold:mxit:brief flow.
