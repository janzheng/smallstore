# Mailroom pipeline — channel or system?

**Status:** shaping
**From:** conversation 2026-04-24, after first smallstore.labspace.ai deploy
**Parent:** `messaging-plugins.md` (foundational primitives)
**Task:** `-> TASKS-MESSAGING.md` (sections below map to new tasks)

## The question the user raised

> "mailroom is a plugin to smallstore / a channel to smallstore but could somehow also be its own system, as a pure worker i guess, if we set smallstore as a default but not always required db right? its just the *channel* or firehose — you point it somewhere?"

Three questions packed together:

1. Does mailroom belong **inside** smallstore, or is it its own thing?
2. Does mailroom **require** smallstore as storage, or can it point anywhere?
3. What makes mailroom **the mailroom** vs "smallstore with an email channel configured"?

The second question is the one that forces the architecture. If mailroom must route to smallstore-only, it's a smallstore feature. If mailroom can route anywhere (tigerflare path, Slack webhook, HTTP POST, local file, another agent's inbox), it's a **pipeline with pluggable sinks** and smallstore is one sink flavor among many.

## Recommendation (tl;dr)

**Library primitives stay in smallstore. Deploy/app can extract to its own Worker when it outgrows a single channel + single sink, and that's not today.**

Concretely:
- `src/messaging/` (types, filter, filter-spec, cursor, registry, inbox, email-handler, channels/cf-email) — **stays in smallstore**, it's the universal envelope + channel SDK
- Policy on top (pipeline, hooks, classifier, rules, sender-index, spam, unsubscribe, quarantine) — **also starts in smallstore** under `src/messaging/pipeline.ts`, but designed so nothing depends on a specific sink or storage backend
- A `Sink` abstraction (below) replaces "destination = Inbox" — adapter-backed inboxes are one sink; HTTP POST is another; function is another
- Mailroom-as-deploy stays inside `deploy/src/index.ts` for now — when it grows multiple channels × multiple sinks × policy, fork to `_deno/apps/mailroom/` which imports `@yawnxyz/smallstore/messaging` and adds its own composition

This answers all three questions:

1. **Belongs to smallstore?** The primitives do. The app doesn't — it's a deploy today, extractable later.
2. **Requires smallstore DB?** No. Sinks are `(item) => Promise<void>`. StorageAdapter-backed inbox is one implementation. Others are HTTP, function, file-bridge.
3. **What makes it mailroom?** The composition: receive via channels, apply policy pipeline, fan out to sinks. Smallstore alone is storage; mailroom is the firehose that sits upstream of storage.

## The key abstraction that makes everything else work

Today the email-handler loops `for each inbox in registry, inbox.append(item)`. That ties destination to `Inbox` which ties to `StorageAdapter`. Replace with:

```ts
type Sink = (item: InboxItem, ctx: SinkContext) => Promise<SinkResult>;

interface SinkResult {
  stored: boolean;           // did the sink persist it
  id?: string;               // sink-assigned id if any
  error?: string;            // non-fatal; pipeline continues to other sinks
}
```

Sink implementations:
- `inboxSink(inbox: Inbox)` — current behavior, wraps `inbox.append`
- `httpSink({ url, token, headers })` — POST `InboxItem` JSON to any URL
- `functionSink(fn)` — inline handler, for cross-inbox mirroring, tigerflare bridging, etc.
- `fileSink({ path, format })` — write markdown/JSONL to local file (for the existing `__resources/collections/mailroom/` bridge)
- `forwardSink(address)` — emit via outbox channel (future)

Each inbox config in the registry becomes `{ channel, sinks: [...], rules: [...] }` instead of locked-to-adapter. A single incoming email can fan to: D1 inbox (queryable) + R2 archive (full raw) + tigerflare-bridge (HTTP POST to `/inbox/<id>.md`) + slack webhook (if labeled important).

This is what "firehose you point anywhere" actually means in code.

## Pipeline shape

```
channel.receive() → raw
  ↓
channel.parse(raw) → InboxItem
  ↓
[preIngest hooks]   ← regex rules, blocklists, rate limits (drop | quarantine | mutate)
  ↓
classify(item)      ← label: spam | newsletter | bounce | receipt | auto-reply | personal
  ↓
[postClassify hooks]← sender-index upsert, unsubscribe-URL detection
  ↓
fan out to sinks    ← each sink is independent; errors in one don't kill others
  ↓
[postStore hooks]   ← notify, auto-respond (reads sink results)
```

Hook signature: `(item, ctx) => Promise<'drop' | 'quarantine' | item>` — stages can mutate, drop, or quarantine. Quarantine writes to a reserved `quarantine/<inbox>` sink, never drops silently.

## Policy components (sketched in prior discussion)

### Regex filtering

Extend `InboxFilter` with a `regex:` operator + `present`/`absent` for header existence. Access headers via `fields.headers` (requires cf-email channel to preserve full header map — small change in `channels/cf-email.ts`).

```yaml
match:
  from_email_regex: "^.*@(mailer-daemon|noreply)\\..*$"
  subject_regex: "(?i)(unsubscribe|newsletter|digest)"
  headers.list-unsubscribe: present
  headers.auto-submitted: "auto-generated"
```

### Rules engine

Not a new subsystem — a `messaging_rules` table (or JSON file, or in-memory array; pluggable source) of `{id, inbox, priority, filter_spec, action, action_args}`. Priority-ordered evaluation in `preIngest`.

Match-all-and-apply-all for tagging actions; first-match-wins for terminal actions (drop/quarantine/forward).

### Sender index

`senders(address PK, display_name, first_seen, last_seen, count, spam_count, tags JSON, list_unsubscribe_url)`. Upserted in `postClassify`. Queryable via existing `Inbox.query({ from })`.

**Key design choice:** sender-index should **not** require D1. Wrap it as a smallstore inbox itself (recursive: mailroom uses smallstore adapters for its own bookkeeping) or a bare KV. Lets mailroom run with memory adapter in dev, D1 in prod, Upstash if someone else wants it.

### FTS5 (D1-specific)

Only activates when the sink is a D1-backed inbox. Schema migration creates `items_fts` virtual table + INSERT/UPDATE/DELETE triggers mirroring `messaging_items`.

Exposed via `?fts=` query param. Non-D1 sinks fall through to existing substring scan. **Nothing in the pipeline requires FTS5.**

### Unsubscribe

Detection (ingest) + action (runtime):
- Parse `List-Unsubscribe`/`List-Unsubscribe-Post` headers → store on sender row
- Expose `sm_inbox_unsubscribe(inbox, sender)` — one-click HTTPS, mailto fallback via outbox, tag sender `unsubscribed`
- Future items from unsubscribed sender: auto-tagged but **not dropped** (easy rollback; cheap storage)

### Spam layers (non-LLM)

Composed as `preIngest` rules, cheapest first:

1. Regex blocklist (terminal drop → quarantine)
2. Header heuristics (`Auto-Submitted`, missing DKIM, `Precedence: bulk`)
3. Sender reputation (`senders[from].spam_count / count > 0.5 && count >= 3`)
4. Content hash dedup (hash subject + first-500-chars, skip if seen in last hour)

LLM classifier is optional layer 5, not in the critical path.

### Store-first over filter-first

Spam gets stored (tagged) in a quarantine sub-inbox rather than dropped. False-positive recovery is trivial; D1/R2 is cheap; "oh no I lost that email" is expensive.

Only layer 1 (explicit regex blocklist) drops to quarantine; layers 2-4 tag but keep in main inbox.

## Architectural bets to call before building

1. **Sink abstraction** — commit now or commit later? I'd commit now. Without it, extraction hurts because email-handler has to be rewritten. With it, extraction is "lift and shift the composition file". Cost: small refactor of email-handler + registry.

2. **D1 messaging mode vs. generic k/v** — today items live as opaque `{key,value,metadata}` in the generic D1 adapter. FTS + sender-index need real columns. Grow the D1 adapter with `messaging: true` option that triggers proper schema migration on init. Keeps generic k/v usable for non-messaging needs. Alternative: messaging gets its own adapter-shaped thing on top of D1 directly (more code, cleaner separation, but duplicates a lot of the D1 adapter).

3. **Rules storage: code vs D1 vs hybrid** — hybrid wins. Core rules (bounce/auto-submitted/List-Unsubscribe detection) are code, user rules live in a pluggable source (D1 row / YAML file / JS array). Consumer picks.

4. **Sender normalization** — lowercase address as key, keep display on item. Don't over-normalize subdomains (`foo@news.substack.com` ≠ `foo@substack.com`). Unicode normalize RFC-5322 style. Document the normalization explicitly.

5. **Quarantine inbox shape** — separate inbox? Separate labels on same inbox? I'd do a separate sub-inbox (`mailroom-quarantine`) — queryable + restorable without polluting main queries. `sm_inbox_restore(sender, id)` moves back to main.

## What "extract to its own Worker" would actually look like

When do you know it's time?

- Multiple channels (cf-email **and** webhook **and** RSS **and** voice) — today: one
- Multiple independent sinks per deployment (D1 + tigerflare + Slack + file bridge) — today: one
- Policy that's opinionated enough that embedding it in every smallstore deploy feels heavy — today: not yet

When those happen, fork to `_deno/apps/mailroom/`:

```
apps/mailroom/
  src/
    pipeline.ts       ← imports from @yawnxyz/smallstore/messaging
    rules/            ← opinionated default rules
    sinks/            ← tigerflare, slack, file-bridge (beyond generic http)
    index.ts          ← Worker entry, composes pipeline + sinks
  wrangler.toml       ← own account, own routes (mailroom.labspace.ai)
  deploy/             ← own D1 (rules, senders, quarantine), own R2
```

smallstore keeps shipping the primitives; mailroom consumes them as a library dependency. smallstore deploys continue to work without mailroom (you'd just not install the pipeline layer).

**Critical design constraint:** everything in `src/messaging/pipeline.ts` **must** work with just `@yawnxyz/smallstore/messaging` imported — no circular dependency on a hypothetical mailroom package. This is why policy lives above primitives but in the same package for now.

## What this unlocks (restated)

- "Send email to mailroom@labspace.ai, auto-route to tigerflare `/inbox/<id>.md`" — one `httpSink` pointed at tigerflare + bearer token
- "Unsubscribe from this sender with one click from my MCP agent" — `sm_inbox_unsubscribe` surface
- "Find all newsletter receipts I've seen from stripe" — FTS5 + sender-index + tags
- "Quarantine anything from an unknown sender with a URL in the body" — one regex rule + preIngest hook
- "Forward everything from my boss to Slack" — sender rule + slack webhook sink

None of these require smallstore to be the only storage. Several of them require smallstore to not be the only storage.

## Build order (each ~0.5-1 day)

Repeats the order from the chat, with the sink refactor added at position 0 because it's the commitment point:

0. **Sink abstraction + email-handler refactor** — one shape, no behavior change
1. FTS5 + triggers + D1 messaging mode — pure infra, unlocks search
2. Sender index table + upsert hook — pure bookkeeping, works without D1 via smallstore adapter
3. Header-based classifier (newsletter/bounce/auto-reply/List-Unsubscribe) — existing label mechanism
4. Hook interface in pipeline — refactor "for each sink" into preIngest/postClassify/postStore
5. Regex operator in filter.ts + filter-spec
6. Rules table + runtime-editable rules (pluggable source)
7. Unsubscribe action (MCP + HTTP)
8. Spam layers 1-4 composed as preIngest rules
9. Quarantine sub-inbox + restore surface

0-3 don't break existing behavior. 4 is the commitment point where the pipeline becomes opinionated enough that extraction starts making sense.

## Out of scope for this brief

- **Outbox** — `messaging-plugins.md` covers it; mailroom pipeline consumes outbox (for unsubscribe via mailto, auto-reply, forward) but doesn't design it
- **Multi-tenant routing** — "different labspace.ai addresses go to different inboxes" is the `envelope_to` task already tracked in `TASKS-MESSAGING.md`
- **LLM classification** — layer 5, deferred until layers 1-4 prove insufficient
- **Voice / webhook / RSS channels** — scaffolded as future channels in `channels/`; pipeline design accommodates them but doesn't implement

## Prior art: Cloudflare's `agentic-inbox` (checked 2026-04-24)

`github.com/cloudflare/agentic-inbox` — Cloudflare's reference Gmail-clone-on-Workers with an AI sidebar. **Different thesis, worth mining.** Full comparison in `__resources/github-repos/cloudflare-agentic-inbox/notes.md` (§ 2026-04-24 discussion).

What they built that we should steal:
- **Gmail-style search-parser** (`app/lib/search-parser.ts`, ~60 LOC) — `from: to: subject: in: is: has: before: after:` + quoted values + free-text remainder. Strictly better UX than our current YAML-only filter-spec. Candidate as a second input form into the existing `InboxFilter` shape. Add as an extra task in the queue above.
- **DO SQLite migration runner** (`workers/durableObject/migrations.ts`) — `d1_migrations` tracking table + `storage.transactionSync()` wrapping (CF DO runtime forbids SQL-level BEGIN/COMMIT). Use this pattern when building the D1 messaging-mode migration instead of inventing our own.
- **Dual LLM pattern** (fail-closed scan before action + length-ratio verifier after action) — reference design for if/when we grow an LLM classifier layer.
- **Tool taxonomy** — plain verbs (`toolSearchEmails`, `toolDraftReply`) without MCP prefix. We can't copy directly (we need `sm_inbox_*` for multi-server MCP disambiguation) but the verb choices are clean.

What they did NOT build (so we can't borrow): **no FTS5, no rule engine, no sender index, no pluggable sinks, no quarantine, no unsubscribe detection, no envelope_to routing.** The pipeline thesis of our brief has no analog in theirs.

Biggest architectural divergence: theirs is "one DO = app + storage + agent + MCP + UI in one unit, per mailbox-address." Ours is "channels + pipeline + sinks as independently composable pieces." Theirs is hard to slice; ours is designed for it.

## References

- Parent design: `.brief/messaging-plugins.md` (pools/pipes/processors, foundational primitives)
- Tigerflare activation: `_deno/apps/tigerflare/.brief/smallstore-bridge-activation.md` (first real consumer of an httpSink)
- Prior art comparison: `__resources/github-repos/cloudflare-agentic-inbox/notes.md` (§ 2026-04-24)
- Tasks: `TASKS-MESSAGING.md` § Later (where the pipeline work goes)
- Current shape: `src/messaging/` in commit `ad1182d`, live at `smallstore.labspace.ai`
