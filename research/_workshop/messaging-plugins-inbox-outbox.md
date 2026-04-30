# Messaging plugins — Inbox & Outbox in smallstore

> **Superseded 2026-04-22 (same day) by [`.brief/messaging-plugins.md`](../../.brief/messaging-plugins.md).** This workshop draft preceded the conversation that resolved several specific points: (1) `serve.ts` is already the deployable host (no separate "smallstore-host" needed), (2) the existing `SMALLSTORE_TOKEN` middleware in `serve.ts:144-167` covers the auth requirement, (3) static *and* runtime config (admin API) should both be supported so projects like coverflow can spin up inboxes dynamically, (4) the build path is concrete (5 phases, see [TASKS-MESSAGING.md](../../TASKS-MESSAGING.md)). The new brief in `.brief/` consolidates everything in this workshop draft + those resolutions. Read that one for actionable guidance; this one is preserved for the conceptual development.

*Brief — `Inbox` and `Outbox` as a new plugin family in smallstore (sibling to materializers, search providers, retrievers, views — not a new adapter type). Inbox catches; Outbox dispatches; both compose existing adapters underneath.*

*2026-04-22. Started as ["Inboxes as a first-class concept"](#) (this file replaces that draft). Reframed after the user clarified: (1) inbox is a *plugin* like the existing plugin families, not a CRUD adapter; (2) outbox is the parallel concept they've wanted for a long time; (3) mailroom is one inbox instance; agentic email responder = inbox + outbox; this is general infrastructure.*

## TL;DR

**Add a "messaging" plugin family to smallstore: `Inbox` and `Outbox`.** Plugins compose adapters (Inbox over D1+R2; Outbox over a queue+log+sender); they are not adapters themselves. Mailroom is the first `Inbox` instance. Email Sending becomes the first `Outbox` instance. Together they unlock *agentic email responder*, *agentic SMS bot*, *form auto-reply*, *webhook→action loops*, *agent-to-agent messaging*, and so on — all as compositions of inbox + transform + outbox.

**Build path: ship Inbox v1 with mailroom (the on-ramp from the previous draft), but commit to the destination — `Inbox` and `Outbox` as named plugin types in smallstore, with `mailroom` and `email-out` as their reference instances.** Outbox can land at the same time as Inbox or one cycle behind, depending on whether the Email Sending binding is wired before mailroom needs to reply.

## Why "plugin" not "adapter"

Smallstore's [adapter architecture](../../../src/adapters/ARCHITECTURE.md) is explicit about adapters being **CRUD over a backend** — `get/set/delete/has/keys/clear`, with optional native methods (`upsert/insert/query/list`). One adapter wraps one backend (Notion, Airtable, R2, D1).

Inbox and Outbox aren't that. They're patterns that **use one or more adapters** to deliver higher-level semantics:

| Concept | Shape | Composes | Examples in smallstore today |
|---------|-------|----------|------------------------------|
| **Adapter** | CRUD over a backend | nothing | `cloudflare-d1`, `cloudflare-r2`, `notion`, `airtable` |
| **Plugin** (materializer / view / search / retriever) | Capability over data | adapters + other plugins | `materializeMarkdown`, `MaterializedView`, search providers, retrievers |
| **Inbox** (proposed) | Producer-side capture pattern | one or more adapters (typically D1 + R2) | mailroom (email), sms-room, forms-room, ... |
| **Outbox** (proposed) | Dispatch-side delivery pattern | a queue adapter + a log adapter + an external service binding | email-out (CF Email Sending), sms-out (Twilio), webhook-out, ... |

So the move is to add a new **plugin family** — `messaging/` — alongside the existing ones, with `Inbox` and `Outbox` as the two named plugin types in it.

This matches the user's mental model exactly: "I want it to be a plugin like the other plugins — not a new adapter."

## Inbox

A producer-driven, append-only, time-ordered, content-addressed source that an external system writes into and an agent/human consumes from.

### Concrete shape (target interface)

```ts
interface Inbox {
  readonly name: string;          // "mailroom", "sms-room"
  readonly source: string;        // "email", "sms", "webhook:github"
  readonly idScheme: 'content-hash' | 'producer-supplied' | 'ulid';
  readonly storage: { adapters: string[] };  // e.g. ["cloudflare-d1", "cloudflare-r2"]

  list(opts?: { since?: string; until?: string; limit?: number; cursor?: string }): AsyncIterable<InboxItem>;
  read(id: string): Promise<InboxItemFull>;       // joined: row + raw + attachments
  query(filter: InboxFilter): AsyncIterable<InboxItem>;
  cursor(): Promise<string>;                       // current high-water mark
  watch?(filter: InboxFilter): AsyncIterable<InboxItemFull>;  // optional, push semantics
}

type InboxItem = {
  id: string;
  received_at: string;            // ISO 8601
  source: string;
  summary: string;                // canonical short summary
  fields: Record<string, unknown>;
  attachments_count: number;
};

type InboxFilter = {
  // AND across keys; OR within array values
  source_in?: string[];
  since?: string;
  until?: string;
  has_attachments?: boolean;
  labels_any?: string[];
  fields?: Record<string, unknown>;   // partial-match on fields_json
  text?: string;                       // substring across summary + body
  // future: payload_json_path for structured queries
};
```

### Common shape (every inbox satisfies)

1. **Append-only in practice.** Deletes exist (spam, GDPR) but the model is "stuff arrives, accumulates."
2. **External producer.** Smallstore is the consumer-side API; the producer is a Worker / webhook / service smallstore doesn't manage.
3. **Time-ordered.** `received_at` is canonical sort. Pagination is `since X`.
4. **Content-addressed.** Producer computes the ID; consumers dedupe without coordination.
5. **Two consumption modes.** *Browse* (query without materializing) and *materialize* (sync some/all to disk via filter spec).
6. **Filterable views.** Markdown frontmatter filter specs that materialize matching items.
7. **Bimodal storage** (typical, not required). A queryable index (D1 / SQLite) + a blob store (R2 / disk) for raw payload + attachments.

### Inbox instances

| Inbox | Producer | Storage adapters | Item shape |
|-------|----------|------------------|-----------|
| **mailroom** | CF Email Worker (`onEmail`) | `cloudflare-d1` + `cloudflare-r2` | parsed email + `.eml` |
| sms-room | Twilio webhook → Worker | `cloudflare-d1` + `cloudflare-r2` | message + media |
| forms-room | Form submitters → Worker | `cloudflare-d1` | structured payload |
| webhook-room | GitHub / Stripe / etc. → Worker | `cloudflare-d1` + `cloudflare-r2` | event JSON + raw body |
| voicebox | Voice agent (`onTranscript`) | `cloudflare-d1` + `cloudflare-r2` | transcript + audio |
| agent-tasks | another agent → Worker | `cloudflare-d1` | task spec + state |
| browser-clips | browser-harness daemon | `cloudflare-d1` + `cloudflare-r2` | screenshot + page metadata |
| iot-stream | sensor MQTT → Worker | `cloudflare-d1` | reading + tag |
| local-maildir | local Maildir watcher | `local-file` + `sqlite` | email files |

The local-maildir row is intentional — Inbox is a plugin pattern, not a Cloudflare-only feature. `cloudflare-d1` + `cloudflare-r2` is *one backing*; other backings (DO+R2, SQLite+local-file, etc.) are valid.

## Outbox

A **dispatch-side capability** the user has wanted for a long time. The mirror of Inbox: structured items go in (drafts), the plugin handles idempotency / retry / scheduling, and a Cloudflare-side worker (or a local sender) actually delivers them.

### Concrete shape (target interface)

```ts
interface Outbox {
  readonly name: string;          // "email-out", "sms-out"
  readonly destination: string;   // "email", "sms", "webhook:slack"
  readonly storage: { adapters: string[] };

  enqueue(draft: OutboxDraft, opts?: {
    idempotency_key?: string;     // caller-supplied; defaults to hash(draft)
    not_before?: string;          // schedule for later (ISO 8601)
    max_attempts?: number;
  }): Promise<{ id: string; status: 'queued' | 'duplicate' }>;

  status(id: string): Promise<OutboxStatus>;
  list(opts?: { status?: OutboxStatusName; since?: string; limit?: number }): AsyncIterable<OutboxStatus>;
  cancel(id: string): Promise<{ cancelled: boolean }>;        // if not yet sent
  history(id: string): Promise<Attempt[]>;                    // each delivery attempt
}

type OutboxDraft = {
  to: string | string[];
  payload: Record<string, unknown>;     // shape per destination ("subject"+"text"+"html" for email; "body"+"media" for sms; etc.)
  reply_to?: { inbox: string; id: string };  // links to the inbox item this is replying to
};

type OutboxStatus = {
  id: string;
  draft: OutboxDraft;
  state: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'dead-letter';
  attempts: number;
  next_attempt_at?: string;
  sent_at?: string;
  external_id?: string;                  // e.g. message-id from CF Email Sending
  last_error?: string;
};
```

### Common shape (every outbox satisfies)

1. **Idempotent enqueue.** Same `idempotency_key` twice = one delivery. No coordinator needed; the outbox dedupes.
2. **Retry with backoff.** Failed attempts retry per policy; final failure → dead-letter.
3. **Scheduled delivery.** `not_before` lets you queue something for later.
4. **Linkable to inboxes.** `reply_to: { inbox, id }` records that this outbox item is a reply to that inbox item — closes the loop for "agent responds to email."
5. **Replay-safe history.** Every attempt logged with timestamp + error + external response. You can `outbox.history(id)` to debug.
6. **Cancel-while-queued.** If something hasn't fired yet, you can cancel it. After it's `sending`, no.

### Outbox instances

| Outbox | External service | Storage adapters | Draft shape |
|--------|------------------|------------------|-------------|
| **email-out** | CF Email Sending binding (`env.EMAIL.send`) | `cloudflare-d1` + `cloudflare-r2` | `{to, from, subject, text, html?, attachments?}` |
| sms-out | Twilio REST | `cloudflare-d1` | `{to, body, media?}` |
| webhook-out | `fetch` to URL | `cloudflare-d1` + `cloudflare-r2` (response log) | `{url, method, headers, body}` |
| slack-out | Slack Web API | `cloudflare-d1` | `{channel, blocks}` |
| push-out | APNs / FCM | `cloudflare-d1` | `{token, title, body}` |
| local-spool | local mail spool | `local-file` + `sqlite` | per-format |

### Why Outbox is its own plugin (not just "send via an adapter")

Naive "just call `env.EMAIL.send`" loses:
- Idempotency (caller has to do it; usually doesn't)
- Retry on transient failure (Cloudflare returns 5xx ~rarely but it happens)
- Scheduled / delayed delivery (no native support)
- An audit log (what got sent, when, with what response)
- Cancel-while-queued
- Reply linkage to an inbox item

These are the same things that distinguish a real outbox from a `try { send } catch { sigh }` block. They live in the plugin so every consumer gets them.

## What an "agentic email responder" looks like

This is the example the user called out — and it's the cleanest motivation for *both* plugins existing.

```ts
// Pseudocode, post-graduation API
const inbox = store.inbox('mailroom');
const outbox = store.outbox('email-out');

for await (const email of inbox.watch({ to_addrs_in: ['support@mycompany.com'] })) {
  const draft = await llm.respondTo(email);   // your model of choice

  await outbox.enqueue({
    to: email.fields.from_email,
    payload: {
      from: 'support@mycompany.com',
      subject: `Re: ${email.fields.subject}`,
      text: draft.text,
    },
    reply_to: { inbox: 'mailroom', id: email.id },
    idempotency_key: `reply:${email.id}`,    // re-running the loop won't double-send
  });
}
```

Three lines for the loop. The plugins handle: storing inbound mail, joining attachments, deduping the reply on retries, persisting send results, linking the outbound item back to the inbound. Without the plugins, that's hundreds of lines of "I'll just glue D1 and the email binding together" that end up subtly wrong.

The same shape works for: **SMS auto-reply** (`inbox: sms-room` + `outbox: sms-out`), **form acknowledgements** (`inbox: forms-room` + `outbox: email-out`), **webhook → notification** (`inbox: webhook-room` + `outbox: slack-out`), **agent-to-agent messaging** (`inbox: agent-tasks` + `outbox: agent-tasks` on the other side).

## Mailroom is one Inbox instance

The previous draft framed mailroom as the brief's subject. With the plugin reframing, mailroom shrinks to **the reference inbox instance** that ships with smallstore's Inbox plugin. The mailroom collection in `__resources/collections/mailroom/` is a *consumer* of that instance — sync scripts that pull/materialize via the standard `Inbox` API.

This is good news for mailroom's design — most of what's in `mailroom/_tools/sync-raw.ts` and `sync-filtered.ts` collapses to ~5 lines that wrap `inbox.list()` + `inbox.read()` + a write loop.

## Build path

The previous draft proposed staging via "preset + helpers + convention now → graduate after 3 inboxes." With the plugin reframing, the staging is a little different — but the idea (don't design in a vacuum) still holds. Two adjustments:

### Inbox

1. **Ship `Inbox` interface + `CloudflareD1R2Inbox` reference impl** alongside mailroom. Don't pretend it's a "helpers + preset" — it's already a plugin from day one. The interface above is small enough (5 methods, `watch` optional) that we can commit.
2. **Filter spec format and `inbox-pattern.md`** still ship — they're plugin-level docs, not staging.
3. **Refactor freely** between the second and third Inbox instance (sms-room or forms-room or voicebox). The interface might gain a method or lose a parameter; semver-minor break is fine pre-1.0.
4. **`watch` is opt-in** — only impls that genuinely support push (DO + alarms; CF Queues; SSE) implement it. v1 ships without; first consumer that needs it pulls it in.

### Outbox

1. **Ship `Outbox` interface + `CloudflareEmailOutbox` reference impl** as soon as the CF Email Sending binding is wired (per the email-for-agents post, public beta as of 2026-04-16).
2. **Outbox can land same-cycle as Inbox or one cycle behind.** The agentic-email-responder use case wants both. If Inbox is week 1 and Outbox is week 2, mailroom-only consumers (browse / sync) work day 1.
3. **Storage backing** — Outbox needs a queue + a log. CF: D1 (queue table + log table) + R2 (large payloads). Local: SQLite + local-file. Same composition pattern as Inbox.
4. **The actual "send" worker** is its own thing — a Cloudflare Worker that polls the queue table (or is woken by DO alarms / Queues) and calls `env.EMAIL.send`. Smallstore's Outbox plugin is the API; the worker is the implementation. Like with mailroom: producer/sender code lives in `__active/_apps/<inbox-or-outbox-name>/`, consumer API lives in smallstore.

### Concrete deltas to smallstore

```
src/messaging/                         ← new plugin family
├── mod.ts                              ← exports Inbox, Outbox, types
├── inbox/
│   ├── types.ts                        ← Inbox, InboxItem, InboxFilter
│   ├── cloudflare-d1-r2.ts             ← CloudflareD1R2Inbox
│   └── filter-spec.ts                  ← markdown frontmatter parser
├── outbox/
│   ├── types.ts                        ← Outbox, OutboxDraft, OutboxStatus
│   ├── cloudflare-email.ts             ← CloudflareEmailOutbox
│   ├── webhook.ts                      ← WebhookOutbox (any URL)
│   └── retry.ts                        ← shared backoff/policy logic
└── tests/
    ├── inbox.test.ts
    ├── outbox.test.ts
    └── e2e-respond-loop.test.ts        ← inbox+outbox round-trip

docs/design/messaging-pattern.md        ← the plugin family explainer
src/mcp-server.ts                       ← register sm_inbox_*, sm_outbox_* tools
src/types.ts                            ← export Inbox, Outbox from top-level
```

MCP tools (target):
- `sm_inbox_list`, `sm_inbox_read`, `sm_inbox_query`, `sm_inbox_sync`, `sm_inbox_cursor`
- `sm_outbox_send`, `sm_outbox_status`, `sm_outbox_list`, `sm_outbox_cancel`, `sm_outbox_history`
- `sm_messaging_respond` (convenience: `inbox.read(id)` → llm callback → `outbox.enqueue` linked) — sugar but earns its keep for the agentic-responder pattern

Estimated effort: **~3 days inbox, ~3 days outbox, ~1 day docs/MCP/tests = ~1 dev-week.** Compare to the previous "1 day staging + later promotion of unknown cost" — committing pays for itself because we write the plugin once and don't refactor between staging and B.

## Apps and projects this unlocks (beyond mailroom)

- **Agentic email responder** — the canonical example. Inbox + LLM + Outbox.
- **Customer support triage** — Inbox routes by classifier; Outbox sends acknowledgements; D1 keeps the thread.
- **Newsletter auto-archive + summary** — mailroom inbox + Outbox to `digest@me` weekly with the week's summaries.
- **Form-to-email auto-reply** — forms-room inbox + email-out outbox.
- **Webhook → action loops** — webhook-room inbox + (any) outbox. GitHub PR opened → Slack ping; Stripe charge → email receipt; etc.
- **Agent-to-agent messaging** — agent A's outbox writes to agent B's inbox (could be the same shared D1 with `to_agent` field). Replaces ad-hoc job queues for many cases.
- **Voice memo summary** — voicebox inbox + email-out outbox sending you the day's transcript.
- **Browser-clips capture pipeline** — browser-harness writes to inbox; Outbox notifies via Slack when a clip matches a tag.
- **Cron+inbox** — schedule an enqueue into an outbox via `not_before`, no separate cron infra.

The point: once Inbox and Outbox are real, *everything that's "external system <-> agent"* becomes a composition rather than a bespoke wiring job.

## What this brief replaces

[`inboxes-as-first-class.md`](./inboxes-as-first-class.md) — same destination, narrower framing (inbox-only, "InboxAdapter" terminology). This brief is the corrected version: messaging is a plugin family with Inbox + Outbox, neither is an adapter, both ship as named plugins.

The graduation-criteria framing in that earlier draft is *less load-bearing now* because we're committing to the plugin from day one rather than staging. But the spirit (don't bake email-only assumptions into the interface) still applies — let sms-room and forms-room shape the v0.x → v1.0 evolution.

## Open questions

- [?] **Outbox storage shape.** D1 table for the queue + R2 for large payloads is the obvious match. But CF Queues + DO alarms might be a better fit for retry/backoff semantics. Worth a small spike before committing.
- [?] **Reply linkage** (`reply_to`) — should it be one-to-many (one inbox item, multiple outbox replies) or one-to-one? Probably many; "I sent two follow-ups to the same email" is real.
- [?] **Idempotency window.** Forever, or N days? "Same key seen twice in 30 days = duplicate; after 30 days = new send." Default forever; let consumers override.
- [?] **Scheduled delivery max horizon.** Forever (DO alarms support it) or capped (e.g. 90 days, after which use a real scheduler)?
- [?] **"Per-account" vs "per-recipient" rate limits.** CF Email Sending has account-level quotas; the outbox should expose this back to the caller as `state: 'rate-limited'` rather than just retrying blindly.
- [?] **Dead-letter handling.** Auto-archive after N failed attempts? Re-queue from dead-letter is a manual op? Both?
- [?] **Filter-spec for outboxes** — does the markdown filter-spec from inbox apply to outbox listings (e.g. "show me failed sends to a specific recipient")? Probably yes; share the parser.

## What to *not* do

- **Don't make Inbox or Outbox a wrapper around existing adapters** in a way that hides the storage. The composition is explicit (`storage: { adapters: [...] }`) so users know what's underneath and can swap.
- **Don't bake the email-specific schema into the Inbox helper.** Field-level details (`from_email`, `subject`, `body_text`) belong in the inbox *instance*, not the plugin interface. The interface speaks `fields: Record<string, unknown>`.
- **Don't ship Outbox without idempotency.** It's the one feature that distinguishes "a real outbox" from "a wrapper around `fetch`."
- **Don't make the filter spec smallstore-specific syntax.** It's just markdown frontmatter; portable.
- **Don't try to run the Cloudflare-side workers from inside smallstore.** Smallstore is the consumer API. Workers are separate `__active/_apps/<name>/` projects. They communicate via the shared D1+R2 (or DO).

## References

- Mailroom collection spec: `__resources/collections/mailroom/README.md`
- Mailroom build plan: `__resources/collections/mailroom/TASKS.md`
- Cloudflare Email Sending public beta: `__resources/github-repos/_cloudflare-landscape/email-for-agents.md`
- Cloudflare Email Routing (inbound side): `__resources/github-repos/_cloudflare-landscape/email-routing.md`
- Cloudflare agentic-inbox reference impl: `__resources/github-repos/cloudflare-agentic-inbox/`
- Workflows V2 (durable trigger from Inbox-watch): `__resources/github-repos/_cloudflare-landscape/workflows-v2.md`
- Companion brief on RetrievalProvider plugins (precedent for unifying via plugin family): [`unified-retrieval-layer.md`](./unified-retrieval-layer.md)
- Predecessor brief, narrower framing: [`inboxes-as-first-class.md`](./inboxes-as-first-class.md)
