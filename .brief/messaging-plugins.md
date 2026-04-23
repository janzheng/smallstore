# Messaging plugins — Inbox, Outbox, Channels

**Status:** ready
**From:** conversation 2026-04-22 (research arc starting from Cloudflare Agents Week 2026-04 captures)
**Task:** `-> TASKS-MESSAGING.md`

## Problem

Smallstore is a portable storage layer with adapters for ~17 backends. It does **storage** very well. It has nothing for **flows in** (capture from external systems like Cloudflare Email Routing, webhooks, RSS, voice transcripts) or **flows out** (dispatch to external systems like Email Sending, Slack, Twilio).

Two pieces of context made this gap real now:

1. **Cloudflare Agents Week (2026-04-15/16) shipped a much wider agent surface.** Email Routing + Email Sending public beta, Browser Run, Voice Agents, AI Search runtime namespaces, Workflows V2, Artifacts, Agent Lee. The "build agent infrastructure on Cloudflare" story is suddenly coherent — and a lot of those agents need to *receive* and *send* messages over real-world channels.
2. **The user wants email-as-a-collection** — start by getting personal mail into D1 + R2 so it's queryable from any agent / MCP / sync script, then extend to other input channels (webhooks, RSS), then add output (auto-replies, notifications) when needed. The mailroom collection at `__resources/collections/mailroom/` was scaffolded as the first concrete consumer.

The user's instinct: *"smallstore has traditionally been a flexible storage system, but with data, you have data inputs and data outputs and data processors — like fts5 using d1 but we can do vector dbs and all kinds for taking and sending data and processing data; i think they're different from the 'storage areas' though — since cf mail doesn't actually have storage, it's like a pipe not a pool if that makes sense."*

That's the design seed. **Pools, processors, pipes — three categories. Smallstore has the first two. The third doesn't exist yet.**

## Investigation

### How smallstore is actually shaped today

Read of `_deno/apps/smallstore/`:

- **JSR package** `@yawnxyz/smallstore` v0.1.11 (`jsr.json`/`deno.json`)
- **Two-layer storage architecture** documented in `src/adapters/ARCHITECTURE.md`:
  - **Adapters** (Layer 1) — CRUD over a backend. `get/set/delete/has/keys/clear` + optional `query/upsert/insert/list`. ~17 of these (memory, sqlite, local-json, local-file, deno-fs, upstash, sheetlog, notion, airtable, cloudflare-{kv,d1,do,r2}, r2-direct, f2-r2, overlay, structured-sqlite, unstorage). Each wraps one backend.
  - **Router** (Layer 2) — universal composition (`upsertByKey`, `set` modes, etc.) that works with any adapter.
- **Plugin families** (parallel to adapters, layered on top):
  - `src/search/` — search providers (BM25, MemoryVector, Zvec HNSW, Hybrid RRF, SQLite FTS5)
  - `src/retrievers/` — RetrievalAdapter pattern (filter, slice, transform)
  - `src/disclosure/` — ProgressiveStore (depth control)
  - `src/materializers/` — format converters (JSON, MD, CSV, text, YAML)
  - `src/views/` — persisted projections
  - `src/episodic/`, `src/graph/`, `src/keyindex/`, `src/namespace/`, `src/blob-middleware/` — other plugin-shaped modules
- **HTTP layer** in `src/http/` — already exposes collections / namespaces / views / search / query / signed-upload / signed-download / retrieval-pipeline / merge / slice / split / deduplicate via Hono. Framework-agnostic handlers in `handlers.ts`, Hono integration in `integrations/hono.ts`.
- **Deployable host** — `serve.ts` already boots the HTTP server, reads `.smallstore.json`, builds adapters from config, supports CORS + watch. Hono runs on Cloudflare Workers, so this is already deploy-ready (just no `wrangler.jsonc` yet).
- **Existing optional auth** — `serve.ts:144-167` already has a `SMALLSTORE_TOKEN` bearer-token middleware. If env var is set, callers must send `Authorization: Bearer <token>`. If unset, open. Already protects `/_adapters`, `/_sync`, `/_sync/jobs/*`.
- **Sync engine** — `src/sync.ts` does push/pull/sync between any two adapters with conflict resolution.
- **Existing examples folder** — `examples/data-clipper`, `md-paste`, `mini-crm`, `tiny-auth`, `media-gallery`, `file-explorer-example`. Pattern: small Hono apps that import from the package.

So: **the project already has a deployable host, an HTTP layer, optional auth, and a plugin pattern.** The thing that genuinely doesn't exist is anything for ingest/dispatch.

### The pipe vs. pool distinction

Cloudflare Email Routing has no storage. It's a fanout: an inbound message hits `onEmail(msg, env)` in a Worker and *the Worker* decides where to write it. CF Email is a **pipe**.

D1 + R2 are storage. **Pools.** Where things end up.

FTS5-over-D1, vector indexes, embeddings — pools that come with transformation. **Processors.**

Smallstore's existing categories: adapters = pools; search/retrievers/materializers/views = processors. **Pipes are missing.** Naming this gap explicitly is what unblocks the design.

### Channel as the missing primitive

A `Channel` is "a thing that emits or accepts items but doesn't own storage." Two shapes:

- **Push channel** — fires when its source emits. Examples: `cf-email` (`onEmail` handler), `webhook` (HTTP receiver), `voice` (transcript stream), `iot` (MQTT subscriber). Needs a Worker / HTTP endpoint.
- **Pull channel** — runs on a schedule. Examples: `rss` (poll feed), `api-poll` (poll a JSON endpoint), `scrape` (fetch + parse). Needs a runner (cron Worker / local cron / Val.town scheduled val).

Both write to a smallstore-managed pool with the **same target shape** (an Inbox item). That sameness is what makes them composable.

### Inbox and Outbox as plugin patterns over Channel + Pool

**Inbox** = `(input Channel + Pool + inbox semantics)` exposed as a unified read-side API. Inbox semantics layer: content-addressed IDs, since-cursors, filter specs, optional watch. Mailroom is one Inbox instance.

**Outbox** = `(Pool: queue + log + output Channel + outbox semantics)` exposed as a unified write-side API. Outbox semantics layer: idempotency keys, retry+backoff, scheduled delivery, dead-letter, reply linkage to inbox items, audit history. `email-out` (CF Email Sending) will be the first instance.

Together they form a **messaging plugin family** — sibling to materializers, search, retrievers, views. Apps compose them: agentic email responder = `inbox.watch → llm.respondTo → outbox.enqueue` with `reply_to` linkage and `idempotency_key`.

### The "smallstore-host" detour I had to undo

Mid-design I proposed inventing a separate `smallstore-host` deployable product. That was wrong — `serve.ts` already is exactly that thing. Same for the proposed `smallstore-receive` Worker — that's just new POST inbox routes added to the existing `src/http/`. The package + serve.ts shape already cleanly resolves the "JSR library vs. running system" tension that I was trying to solve with new infrastructure.

### One Worker, N inboxes, config-driven

The deployment shape is **one Cloudflare Worker** (the `serve.ts`-derived host) that handles all channels. Adding an inbox is a config edit, not a new app:

```ts
// smallstore.config.ts (or .smallstore.json)
{
  storage: { /* bindings */ },
  inboxes: {
    mailroom:   { channel: 'cf-email', storage: 'd1:mailroom/r2:mailroom' },
    github_evt: { channel: 'webhook', auth: { hmac: 'env:GH_HMAC' }, storage: 'd1:webhook' },
    bensbites:  { channel: 'rss', url: '...', schedule: '0 */6 * * *', storage: 'sheetlog:feeds' },
  },
}
```

Inbox storage is *any* smallstore adapter — D1, sheetlog, sqlite, local-file, even a different Notion DB. That's the user's "mail could land in r2 or sheetlog or whatever" insight realized concretely.

A new *channel TYPE* (Twilio, Discord) is a PR to the smallstore package — a file under `src/messaging/channels/`. A new *inbox using an existing channel TYPE* is a config row.

### Runtime config as well as static config

The user noted: *"what's nice about config driven is that you can send configs in at run time (eg we can make smallstore email as part of coverflow for example)."*

That's sharp — and the architecture should support both:

- **Static config** — loaded from `.smallstore.json` / `smallstore.config.ts` at boot. Stable inboxes for the personal deployment.
- **Runtime config via admin API** — `POST /admin/inboxes` (behind `SMALLSTORE_TOKEN`) creates an inbox dynamically. Returns the URLs/token the caller needs to push and pull. Optional `ttl` for auto-tear-down. Lets coverflow / other projects spin up inboxes per-run without redeploying smallstore.
- **Per-request anonymous** — `POST /inbox/items { inbox_config: {...}, items: [...] }` for pure ad-hoc dumps. Not v1; deferred. Conceptually similar to AI Search's `ai_search_namespaces` runtime spawn.

Both static and runtime land in the same in-memory inbox registry under the hood. Static just populates from the config file at boot; runtime mutates via API. Same plugin code.

### Mailroom collection as the first consumer

The local browse/sync view at `__resources/collections/mailroom/` is the first concrete *consumer* of the messaging plugin. Its `_tools/sync-raw.ts` and `_tools/sync-filtered.ts` collapse to ~5-line wrappers around `inbox.list()` / `inbox.read()` calls against the deployed smallstore's HTTP API. Filter specs (markdown frontmatter under `filters/`) are parsed and translated to `InboxFilter` queries.

This is the first **live-mounted** collection shape — canonical state lives on Cloudflare, not on disk. The collection is a thin shell.

## Recommendation

Build a **messaging plugin family** in smallstore. Ship `Inbox` + `Channel` first (with `cf-email` as the reference channel and mailroom as the reference inbox). Defer `Outbox` until the first send use case is real — likely "agentic email responder," likely soon, but not v1.

Concretely:

1. **Add `src/messaging/`** — new module exporting `Channel`, `Inbox`, channel implementations. Sibling to `src/search/`, `src/materializers/`, etc. Exported via `jsr.json` + `mod.ts`.
2. **Extend `src/http/`** — add inbox routes (`POST /inbox/<name>/items`, `GET /inbox/<name>`, `GET /inbox/<name>/items/<id>`, `GET /inbox/<name>/cursor`) and admin routes for runtime config (`POST/GET/DELETE /admin/inboxes`). All behind the existing `requireAuth`.
3. **Extend `serve.ts`** to also export an `email()` handler that dispatches to whichever inbox has `channel: 'cf-email'` configured. Same Worker, two entry points.
4. **Deploy `serve.ts` to Cloudflare Workers** as your personal smallstore host. Tiny `wrangler.jsonc` with bindings declared, `SMALLSTORE_TOKEN` set as a secret. The deployed host is the only Worker.
5. **Wire mailroom** — Email Routing on a domain → deployed smallstore Worker. Add `inboxes.mailroom` to config. Verify mail arrives. Update mailroom collection scripts to hit `GET /inbox/mailroom`.
6. **Write `cf-email-inbox` example** — a documentation-grade example under `examples/` showing the pattern for other smallstore users.

Outbox lands when needed, designed to mirror Inbox: same `messaging` family, same plugin shape, same composition (pool + output channel + semantics). Brief sketches the interface so the design stays coherent, but no code yet.

### Why this is the right shape

- **Channels are a real category, not a leaky abstraction** — pipes vs. pools is a clean distinction once named, and surfaces a missing primitive in smallstore.
- **Inbox/Outbox composing Channel+Pool fits the existing plugin pattern** — same shape as how search providers compose (storage + index logic), how views compose (storage + projection logic). Doesn't introduce a new architectural layer; just a new plugin family.
- **One Worker = matches user's "as few apps as possible" goal directly.** No per-channel Workers. No per-inbox Workers. One smallstore deployment, N inboxes from config.
- **Runtime config makes smallstore a platform, not just a library** — coverflow / other tools can register inboxes dynamically. Same shape as AI Search namespaces.
- **Builds on what's already there** — auth (`SMALLSTORE_TOKEN`), HTTP layer (`src/http/`), deployable host (`serve.ts`), config loader (`config.ts`), MCP server (`src/mcp-server.ts`). Doesn't reinvent any of these.
- **Outbox-deferred is honest about scope** — designing it in the brief keeps the architecture coherent; not building it yet keeps the v1 shippable.

### What this is *not*

- **Not a queue/broker.** No durable subscriptions, no fanout topology, no consumer groups. If you need that, use Cloudflare Queues + a dedicated worker.
- **Not a mail server.** It's the *storage and consumer side*. Cloudflare Email Routing is the actual MTA.
- **Not multi-tenant.** Personal infra; one `SMALLSTORE_TOKEN` for the admin layer; per-channel secrets handled in channel config.
- **Not a generic event sourcing framework.** Inbox is "external pipe → pool with semantic layer," not "every state change becomes an event."

## Implementation Sketch

### Module layout

```
@yawnxyz/smallstore (the package)
├── src/messaging/                       ← NEW
│   ├── mod.ts                           ← exports Channel, Inbox, types
│   ├── types.ts                         ← Channel, Inbox, InboxItem, InboxFilter, OutboxDraft, ...
│   ├── inbox.ts                         ← Inbox plugin implementation
│   ├── outbox.ts                        ← (later) Outbox plugin implementation
│   ├── filter-spec.ts                   ← markdown frontmatter parser for filter specs
│   ├── retry.ts                         ← (later) shared backoff/policy logic
│   ├── channels/
│   │   ├── cf-email.ts                  ← v1 — parses email, maps to InboxItem, writes via Inbox
│   │   ├── webhook.ts                   ← v1.x — generic HTTP receiver with optional HMAC
│   │   ├── rss.ts                       ← v1.x — pull-shape; needs a runner
│   │   └── (later: twilio, slack, voice, ...)
│   └── tests/
│       ├── inbox.test.ts
│       ├── filter-spec.test.ts
│       └── e2e-inbox-cf-email.test.ts   ← end-to-end against a fake email
├── src/http/
│   ├── handlers.ts                      ← extend: handleInboxPost, handleInboxList, handleInboxGet, handleInboxCursor, handleAdminCreateInbox, ...
│   └── integrations/hono.ts             ← extend: route bindings for the above
├── src/mcp-server.ts                    ← extend: register sm_inbox_list, sm_inbox_query, sm_inbox_read, sm_inbox_cursor
├── serve.ts                             ← extend: add email() export that dispatches to cf-email-channel inboxes
├── config.ts                            ← extend: parse `inboxes:` section; resolve channel/storage references
├── presets.ts                           ← optionally add a 'messaging-cf' preset bundling D1 + R2 for the inbox pattern
├── jsr.json + deno.json                 ← export ./messaging
└── mod.ts                               ← re-export Inbox, Channel from src/messaging/
```

### Core interfaces (target)

```ts
// src/messaging/types.ts

export interface Channel<TRaw = unknown, TItem = InboxItem> {
  readonly name: string;                          // 'cf-email', 'webhook:github', 'rss:bensbites'
  readonly kind: 'push' | 'pull';
  readonly source: string;                        // 'email', 'webhook', 'rss'
  parse(raw: TRaw): TItem | Promise<TItem>;       // raw event → InboxItem shape
  // For pull channels:
  pull?(opts: { since?: string }): AsyncIterable<TItem>;
  // For push channels: invoked by serve.ts entry points (email(), fetch())
}

export interface Inbox {
  readonly name: string;                          // 'mailroom'
  readonly source: string;                        // 'email'
  readonly storage: { adapters: string[] };       // ['cloudflare-d1', 'cloudflare-r2']
  list(opts?: ListOpts): AsyncIterable<InboxItem>;
  read(id: string): Promise<InboxItemFull>;       // joined: row + raw + attachments
  query(filter: InboxFilter): AsyncIterable<InboxItem>;
  cursor(): Promise<string>;
  watch?(filter: InboxFilter): AsyncIterable<InboxItemFull>;
  // Internal: write path used by channels
  _ingest(item: InboxItem, raw?: ReadableStream, attachments?: Attachment[]): Promise<{ id: string; status: 'inserted' | 'duplicate' }>;
}

export type InboxItem = {
  id: string;                                     // content-addressed
  received_at: string;                            // ISO-8601
  source: string;
  summary: string;
  fields: Record<string, unknown>;
  attachments_count: number;
};

export type InboxFilter = {
  source_in?: string[];
  since?: string;
  until?: string;
  has_attachments?: boolean;
  labels_any?: string[];
  fields?: Record<string, unknown>;
  text?: string;
};

// Outbox sketched for completeness, not built v1:
export interface Outbox {
  readonly name: string;
  readonly destination: string;
  enqueue(draft: OutboxDraft, opts?: EnqueueOpts): Promise<{ id: string; status: 'queued' | 'duplicate' }>;
  status(id: string): Promise<OutboxStatus>;
  list(opts?: ListOpts): AsyncIterable<OutboxStatus>;
  cancel(id: string): Promise<{ cancelled: boolean }>;
  history(id: string): Promise<Attempt[]>;
}
```

### Config schema (target)

```ts
// extends SmallstoreServerConfig in config.ts
inboxes?: Record<string, {
  channel: string;              // 'cf-email' | 'webhook' | 'rss' | ...
  storage: string;              // 'd1:mailroom/r2:mailroom' or 'sqlite:emails' etc.
  // channel-specific:
  url?: string;                 // rss
  schedule?: string;            // rss/pull
  auth?: { hmac?: string; bearer?: string };  // webhook
  // shared:
  ttl?: string;                 // for runtime-created inboxes
}>;
```

### HTTP routes (target)

```
POST   /inbox/:name/items        — channel writes here (used by webhook + push channels going through HTTP)
GET    /inbox/:name              — list items (paginated by cursor/since)
GET    /inbox/:name/items/:id    — read joined item (row + raw + attachments)
GET    /inbox/:name/cursor       — current high-water mark
POST   /inbox/:name/query        — InboxFilter query

POST   /admin/inboxes            — runtime-create an inbox (auth required)
GET    /admin/inboxes            — list configured inboxes
GET    /admin/inboxes/:name      — get config + status
DELETE /admin/inboxes/:name      — tear down a runtime-created inbox
```

All behind existing `requireAuth` middleware. Channel-internal auth (HMAC validation for incoming GitHub webhooks, etc.) is handled inside the channel's parse step, not by `requireAuth`.

### MCP tools (target)

```
sm_inbox_list <name> [--since <iso>] [--limit N]
sm_inbox_read <name> <id>
sm_inbox_query <name> <filter-json>
sm_inbox_cursor <name>
sm_inbox_create <name> <config-json>          ← runtime config
sm_inbox_delete <name>                         ← runtime config
```

### Deployment shape

**One Cloudflare Worker.** Tiny scaffold:

```
_deno/apps/smallstore/                         ← existing project
├── (everything as today)
├── deploy/                                    ← NEW
│   ├── wrangler.jsonc                         ← bindings (D1, R2, KV), routes, secrets
│   └── worker.ts                              ← re-export from serve.ts
└── deploy.sh                                  ← convenience: wrangler deploy
```

`worker.ts` is essentially:

```ts
import { app, scheduledHandler, emailHandler } from '../serve.ts';

export default {
  fetch: app.fetch,
  email: emailHandler,
  scheduled: scheduledHandler,
};
```

`scheduled` runs pull-channel polls (RSS, etc.) on cron schedules declared in config.

### Channel: cf-email reference implementation

```ts
// src/messaging/channels/cf-email.ts
import postalMime from 'postal-mime';

export class CloudflareEmailChannel implements Channel<ForwardableEmailMessage, InboxItem> {
  readonly name = 'cf-email';
  readonly kind = 'push' as const;
  readonly source = 'email';

  async parse(msg: ForwardableEmailMessage): Promise<InboxItem> {
    const raw = await new Response(msg.raw).text();
    const parsed = await postalMime.parse(raw);
    const id = await sha256(`${parsed.messageId ?? ''}|${raw}`);
    return {
      id,
      received_at: new Date().toISOString(),
      source: 'email',
      summary: `${parsed.from?.address ?? 'unknown'} — ${parsed.subject ?? '(no subject)'}`,
      fields: {
        message_id: parsed.messageId,
        from_addr: parsed.from?.name ? `${parsed.from.name} <${parsed.from.address}>` : parsed.from?.address,
        from_email: parsed.from?.address,
        to_addrs: parsed.to?.map(t => t.address) ?? [],
        cc_addrs: parsed.cc?.map(t => t.address) ?? [],
        subject: parsed.subject,
        body_text: parsed.text,
        date_header: parsed.date,
        spf_pass: msg.headers.get('Authentication-Results')?.includes('spf=pass'),
        // ... etc
      },
      attachments_count: parsed.attachments?.length ?? 0,
    };
  }
}
```

The Worker's `email()` handler (in `serve.ts`):

```ts
export async function emailHandler(msg: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
  const config = await loadConfig();
  const target = findInboxForChannel(config, 'cf-email');
  if (!target) return;
  const channel = new CloudflareEmailChannel();
  const item = await channel.parse(msg);
  const inbox = getInbox(target.name);
  await inbox._ingest(item, msg.raw, /* attachments */);
}
```

### Mailroom wire-up (the integration test)

After steps 1-4 are deployed:

1. Pick a Cloudflare-managed domain. Set Email Routing catch-all → smallstore Worker.
2. Add to deployed smallstore's config: `{ inboxes: { mailroom: { channel: 'cf-email', storage: 'd1:mailroom_emails/r2:mailroom_blobs' } } }`.
3. Migrate the D1 table per the schema in `__resources/collections/mailroom/README.md`.
4. Send a test email; verify it lands.
5. Update `__resources/collections/mailroom/_tools/sync-raw.ts` to:
   ```ts
   const items = await fetch(`${SM_BASE_URL}/inbox/mailroom?since=${highWaterMark}`,
     { headers: { Authorization: `Bearer ${TOKEN}` } });
   for await (const item of items) { /* materialize to disk */ }
   ```

### What does NOT change

- Existing adapters: untouched.
- Existing HTTP routes: untouched. New routes added alongside.
- Existing search/retrievers/views/materializers: untouched. Inbox is a new family, not a refactor.
- Existing CLI / VFS / self-interview: untouched.
- `serve.ts`-as-local-dev still works exactly as before. The CF deploy is a new target, not a replacement.

### Risks and mitigations

- **CF Email Routing limits.** Cloudflare's free tier caps inbound email volume (couple hundred/day historically). For the personal use case this is fine; if mailroom ever ingests at higher volumes, may need paid plan or self-hosted MX.
- **Schema drift between channel parsers and consumers.** If `cf-email` channel changes the `fields` shape, every downstream consumer breaks. Mitigation: version the channel (`source: 'email/v1'`); freeze the field set; additive changes only. Document in `inbox-pattern.md` once written.
- **Runtime-created inboxes leaking.** If TTL isn't honored or callers forget to DELETE, runtime inboxes accumulate. Mitigation: TTL is enforced server-side (background cleanup job); admin endpoint lists all runtime inboxes with their creation timestamps.
- **Auth token in mailroom collection scripts.** Token has to live somewhere on disk. Mitigation: `.env` file in collection (gitignored); document the rotation procedure.
- **CF Worker `email()` handler timeout.** Has a wall-clock budget (sub-30s). If the channel parser + storage write can't finish in time, items get dropped. Mitigation: do the minimum synchronously (parse + D1 insert + R2 raw); push expensive things (vector embedding, full-text indexing) to a follow-up Workflow.

### Open questions (worth deciding before/during build)

- **Deletion semantics.** Inbox is append-only in spirit. Do we expose `DELETE /inbox/:name/items/:id` for spam removal, or require a separate admin tool? Suggest: yes, expose, behind auth, with an audit log row.
- **Cursor format.** Server-supplied opaque string vs. caller-readable ISO timestamp. Suggest: opaque string (resilient to clock skew, internal index changes).
- **Filter spec home.** Markdown filter specs live in the consumer (mailroom collection) or in smallstore (`/.smallstore/filters/`)? Suggest: consumer — they describe consumer intent.
- **Outbox storage backing.** D1 queue table + R2 large payloads vs. CF Queues + DO alarms for retry semantics. Defer until we build it; spike both before committing.
- **Should pull channels share a runner abstraction?** RSS, API-poll, scrape all need "do this every N minutes." Likely yes; small scheduler module reading from `inbox.schedule` config and using CF Worker cron triggers (`scheduled()` export).

## References

- Predecessor brief (more exploratory, narrower framing — *superseded by this one*): `research/_workshop/messaging-plugins-inbox-outbox.md` and the earlier `research/_workshop/inboxes-as-first-class.md`
- Mailroom collection (consumer side, first concrete user): `__resources/collections/mailroom/`
- Cloudflare Email primitives (capture): `__resources/github-repos/_cloudflare-landscape/email-for-agents.md`, `email-routing.md`, `mail-build-reference.md`
- Cloudflare Email Sending public beta (anchor for Outbox): `__resources/github-repos/_cloudflare-landscape/email-for-agents.md`
- Cloudflare agentic-inbox reference impl: `__resources/github-repos/cloudflare-agentic-inbox/`
- AI Search runtime namespaces (model for runtime-config inboxes): `__resources/github-repos/_cloudflare-landscape/ai-search-agent-primitive.md`
- Workflows V2 (durable trigger destination for `inbox.watch`): `__resources/github-repos/_cloudflare-landscape/workflows-v2.md`
- Companion brief on RetrievalProvider plugin family (precedent): `research/_workshop/unified-retrieval-layer.md`
- Smallstore architecture (existing two-layer model): `src/adapters/ARCHITECTURE.md`
- Smallstore design + mission (where messaging plugin lives in goals): `TASKS-DESIGN.md`
