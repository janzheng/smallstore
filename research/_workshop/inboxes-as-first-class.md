# Inboxes as a first-class concept in smallstore

> **Superseded 2026-04-22 (same day).** This draft framed `Inbox` as a new adapter type, with a "stage as preset → graduate to InboxAdapter" build path. The corrected framing — `Inbox` and `Outbox` as plugins (not adapters) in a new "messaging" plugin family — lives in **[`messaging-plugins-inbox-outbox.md`](./messaging-plugins-inbox-outbox.md)**. The plugin reframing matters: messaging compositions ride on top of existing adapters, they don't extend the adapter family. Outbox is a peer of Inbox, not a follow-up. Read the new draft instead; this one is kept for the option analysis (A vs B vs C) and the graduation-criteria sketch.

*Brief — should smallstore expose an "Inbox" abstraction, or is mailroom just a preset on top of existing adapters?*

*2026-04-22. Triggered by the [mailroom collection spec](../../../../__resources/collections/mailroom/README.md) and the question "would we need to edit smallstore to make this clean?"*

## TL;DR

**The destination is Option B — `Inbox` as a first-class smallstore concept alongside `RetrievalAdapter`, `SearchProvider`, etc.** That's the right end-state because (1) inboxes are a real recurring shape, not a mailroom-specific accident, and (2) keeping inboxes in collection-side `_tools/` permanently is exactly the "every consumer reinvents the plumbing" problem smallstore exists to solve.

**The route there is Option C — ship mailroom on a preset + tiny helpers + documented `inbox-pattern.md` *now*, with explicit graduation criteria (below) for promoting to a real `InboxAdapter` interface.** Rule of three: don't design the abstraction in a vacuum, but commit to building it. The helpers + preset are *staging*, not *destination*.

**Why staging vs. building Option B straight away:** designing `InboxAdapter` against just mailroom means getting the watch semantics, deletion model, id scheme, and cursor format wrong. Two more concrete inboxes (sms-room, forms-room, voicebox — whichever lands next) tell us which parts of the shape are real and which are email-specific. By the time we promote, the interface is shaped by three real cases, not one + speculation.

## What "inbox" actually means

An *inbox* is a **producer-driven, append-only, time-ordered, content-addressed source** that an external system writes into and an agent/human consumes from. Mailroom is the first concrete one, but the shape generalizes:

| Inbox | Producer | Storage | Item shape |
|-------|----------|---------|-----------|
| **mailroom** | CF Email Worker (`onEmail`) | D1 + R2 | parsed email + `.eml` |
| sms-room (hypothetical) | Twilio webhook → Worker | D1 + R2 | message + media |
| forms-room | Form submitters → Worker | D1 | structured payload |
| webhook-room | GitHub/Stripe/etc. → Worker | D1 + R2 | event JSON + raw body |
| voicebox | Voice agent (`onTranscript`) | D1 + R2 | transcript + audio |
| agent-tasks | another agent → Worker | D1 | task spec + state |
| browser-clips | browser-harness daemon | D1 + R2 | screenshot + page metadata |
| iot-stream | sensor MQTT → Worker | D1 | reading + tag |

**Common shape across all of them:**

1. **Append-only in practice.** You can delete, but the model is "stuff arrives, stuff accumulates."
2. **External producer.** Smallstore is the *consumer-side* API; the producer is a Worker or service that smallstore doesn't manage.
3. **Time-ordered.** `received_at` (or equivalent) is the canonical sort key. Pagination is "since X."
4. **Content-addressed.** Producer computes the ID; consumers can dedupe on it without coordination.
5. **Two consumption modes.** *Browse* (query without materializing) and *materialize* (sync some/all to disk for offline / grep / agent context).
6. **Filterable views.** "All emails from X since Y" is a view spec, not a separate dataset.
7. **Bimodal storage.** A queryable index (D1) + a blob store (R2) for the raw payload + attachments. The split is ~always the same.

## What smallstore has today

The `cloudflare-d1` and `cloudflare-r2` adapters already exist. A consumer can wire them together by hand and get most of an inbox. What's *missing* is:

- **A canonical join** — `read("mailroom://email/<id>")` should return D1 row + raw R2 + attachments without the caller doing two reads and stitching them.
- **A canonical "since" cursor** — every inbox wants `list(since: "...")`. Today the caller writes per-source pagination.
- **A canonical filter spec** — every inbox wants markdown-driven filters that materialize matching items. Today the caller invents the format.
- **A "sync" concept that knows about high-water marks** — `sm_sync_jobs` exists but isn't inbox-aware (doesn't know what "since" means for an email vs a task vs a webhook event).
- **A spawn/registration story** — "spin up a new inbox" should be one call, not "create D1, create R2, create binding, register preset."

These are real gaps but each one can be filled at the convention layer first.

## Three options

### Option A — Mailroom as a preset (no smallstore changes)

Add to `presets.ts`:

```ts
mailroom: {
  d1: { binding: "MAILROOM_D1", table: "emails" },
  r2: { binding: "MAILROOM_R2", prefix: "" },
}
```

Mailroom-side code does its own joining (D1 row + R2 raw + attachments) before returning. Filter specs, since-cursors, materialization scripts all live in the mailroom collection's `_tools/`.

- ✓ Zero smallstore work.
- ✓ Ships fastest.
- ✗ Every future inbox copies the same plumbing.
- ✗ No shared mental model — "inbox" is a private idea that mailroom happens to use.

### Option B — First-class `InboxAdapter` interface

A new adapter type alongside `RetrievalAdapter`, `SearchProvider`, etc.:

```ts
interface InboxAdapter {
  readonly name: string;
  readonly idScheme: 'content-hash' | 'producer-supplied' | 'ulid';
  list(opts: { since?: string; until?: string; limit?: number; cursor?: string }): AsyncIterable<InboxItem>;
  read(id: string): Promise<InboxItem & { raw?: ReadableStream; attachments?: Attachment[] }>;
  query(filter: InboxFilter): AsyncIterable<InboxItem>;
  watch?(filter: InboxFilter, onItem: (item: InboxItem) => void): Unsubscribe;  // long-poll / webhook fan-in
  cursor(): Promise<string>;     // current high-water mark
}

type InboxItem = {
  id: string;
  received_at: string;
  source: string;        // "email", "sms", "webhook:github"
  summary: string;       // short canonical summary for listings
  fields: Record<string, unknown>;  // type-specific
  attachments_count: number;
};
```

Smallstore ships:
- A `CloudflareD1R2Inbox` impl that mailroom and friends instantiate.
- A canonical filter spec format (the markdown frontmatter shape the mailroom collection sketched).
- An `inbox-sync` runner that consumes filter specs and materializes to a path.
- MCP tools: `sm_inbox_list`, `sm_inbox_read`, `sm_inbox_query`, `sm_inbox_sync`, `sm_inbox_cursor`.

- ✓ Every future inbox is `class FormsInbox extends CloudflareD1R2Inbox` plus a Worker.
- ✓ Filter spec format is one place, not N.
- ✓ Watch/notify is a real primitive (useful for agent triggers).
- ✗ Designed mostly speculatively against one concrete case (mailroom). High risk of getting the shape wrong.
- ✗ Significant smallstore work before mailroom ships at all.
- ✗ The interface above is already three different concerns (read, query, watch) that may not split cleanly when sms/forms show up.

### Option C — Convention now, on-ramp to B

Ship Option A's preset. Also:

1. **Document "the inbox shape"** in `docs/design/inbox-pattern.md` — the seven characteristics from above + the canonical D1 schema columns (`id`, `received_at`, `source`, `summary`, `fields_json`) that any inbox is encouraged to use. Optional, not enforced. **Mark the doc as "pre-adapter convention; will graduate to `InboxAdapter` interface — see graduation criteria below."**
2. **Document the filter spec format** in the same place — copy mailroom's frontmatter spec, mark it as "the mailroom shape; future inboxes should mirror unless they have a reason not to."
3. **Add two small generic helpers** in `src/helpers/inbox/`:
    - `joinD1AndR2(d1Row, r2Bucket, mapping)` → returns the joined object. Mailroom uses it; future inboxes use it.
    - `runFilteredSync(filterSpec, source)` → reads any filter spec, materializes to a path. Mailroom uses it; future inboxes use it.
    - **These helpers' signatures will become `InboxAdapter` methods at promotion time** — design them with that in mind. Don't take mailroom-only parameters.
4. **Add a single MCP tool**: `sm_inbox_sync <preset> <filter.md>`. Implementation just calls `runFilteredSync` against the preset's d1+r2. **This is the v1 of `sm_inbox_*` tools that get filled out at promotion.**

When the second inbox lands (sms-room, forms-room, whichever), the convention is already there — that inbox is *also* a preset + uses the helpers. When the *third* lands and we've felt three sets of edge cases — promote.

- ✓ Mailroom ships almost as fast as Option A.
- ✓ The next inbox only writes its Worker — the consumption side is solved.
- ✓ Avoids designing the abstraction in a vacuum; chosen against three concrete cases.
- ✓ Helpers carry the design weight; the eventual `InboxAdapter` is a refactor of working code, not a guess.
- ✗ Easy to skip the documentation step under shipping pressure. The convention only works if `inbox-pattern.md` is real, discoverable, and *referenced from `mod.ts` exports*.
- ✗ Doesn't enable `watch`/notify until promotion.

## Graduation criteria (Option C → Option B)

The promotion isn't "we feel ready" — it's a checklist. **Promote when all four are true:**

1. **Three concrete inboxes are running** — mailroom + at least two others (any combination from the table above). Each is a real Worker writing to D1+R2 that real consumers read from.
2. **At least one of them needs a capability the helpers don't expose** — most likely `watch`/notify (push to Workflows/agent), or a non-d1+r2 storage backing (DO SQLite, raw R2 prefix, an external service), or cross-inbox federated query.
3. **The filter spec format has held across all three** without per-inbox dialects. If forms-room needed `match.payload_json_path: "$.fields[*].value"` while mailroom uses `match.body_contains` — that's data we need to fold into the spec, not divergence we paper over.
4. **`docs/design/inbox-pattern.md` has been edited at least twice** in response to real friction — both edits referenced from PRs/commits adding new inboxes, not from speculative tidying.

If any of those is missing, hold. The interface designed without them will be wrong in ways that are hard to migrate.

## What the graduated feature looks like

When promotion happens, the smallstore-side feature is roughly:

- **`InboxAdapter` interface** in `src/adapters/inbox/` (sibling to `cloudflare-d1.ts`, etc.). Methods: `list`, `read`, `query`, `cursor`. `watch` if (2) above pulled it in.
- **`CloudflareD1R2Inbox` reference impl** that today's mailroom preset becomes. Other backings (DO-only, R2-only, external) added as their inboxes appear.
- **`InboxFilter` type** that the existing markdown frontmatter parses into. The .md filter spec format does *not* change at promotion — it's already canonical from the `inbox-pattern.md` doc.
- **MCP tools** fill out: `sm_inbox_list`, `sm_inbox_read`, `sm_inbox_query`, `sm_inbox_sync`, `sm_inbox_cursor` (+ `sm_inbox_watch` if applicable). The single `sm_inbox_sync` from staging stays compatible.
- **Helpers from `src/helpers/inbox/` deprecate** with a one-version overlap. They become thin wrappers around the new adapter methods, then go.
- **Migration cost for existing inboxes** = update one import + replace preset wiring with `new CloudflareD1R2Inbox({...})`. Their Workers don't change; their filter specs don't change; their materialized files don't change.

This is the destination from day one. Option C is staging, not an alternative.

## What changes in smallstore for Option C

Concrete deltas to ship alongside mailroom:

1. **`src/presets.ts`** — add `mailroom` preset. Wires existing d1+r2 adapters.
2. **`src/helpers/inbox/`** (new dir) — `join-d1-r2.ts` and `run-filtered-sync.ts`. Tiny. Both are < 100 LoC if the existing adapters do their jobs.
3. **`docs/design/inbox-pattern.md`** — the seven characteristics + recommended D1 columns + filter spec format + "when to graduate to a real adapter."
4. **`src/mcp-server.ts`** — register `sm_inbox_sync` tool that reads a filter spec and dispatches.
5. **A test fixture inbox** — `tests/fixtures/test-inbox/` with sample D1 + R2 contents + a filter spec. Used in `tests/inbox.test.ts` to exercise the helpers without spinning up real Cloudflare.

Total: ~1 day of smallstore work. Compare to Option B (~1 week) or Option A (~0 days but mortgage paid later).

## Other patterns it would unlock

If the convention sticks, a few things become natural:

- **Inbox-as-trigger for Workflows V2.** `sm_inbox_watch <preset> <filter>` (when the abstraction promotes) → Workflow instance per matching item. Email arrives, instance starts, durable execution. See `__resources/github-repos/_cloudflare-landscape/brainstorm-2026-04-22.md` § D.
- **Multi-inbox queries.** "Search across mailroom + sms-room + forms-room for anything mentioning 'invoice'" becomes a federated query across same-shape sources.
- **Cross-machine inbox materialization.** TigerFlare-side inbox notes (e.g. `tf://inboxes/<source>/recent.md`) refreshed by `sm_inbox_sync` cron. The same inbox is browseable from any machine without each machine pulling Cloudflare directly.
- **Per-agent scratch inboxes.** An agent that emits structured findings can dump into an inbox (D1+R2 spun up at runtime — see [Artifacts](../../../../__resources/github-repos/_cloudflare-landscape/artifacts-git-for-agents.md) and the AI Search `ai_search_namespaces` pattern). Other agents query it.

## What to *not* do

- **Don't make `Inbox` a wrapper around existing `RetrievalAdapter`.** It's a different concept — producer-side pattern, not a transform on read. Conflating them muddies both abstractions.
- **Don't bake the email-specific schema into the generic helper.** `joinD1AndR2` should take a column→r2-key mapping spec, not assume "raw_key" / "attachments table."
- **Don't ship `sm_inbox_watch` in v1.** It implies push semantics that nothing else in smallstore has. Wait until at least one consumer needs it.
- **Don't make the filter spec smallstore-specific syntax.** It's just markdown frontmatter; portable. If you later want to use the same spec to filter a non-smallstore source (e.g. a local Maildir), you can.

## Open questions

- [?] Where do filter specs *belong* — the consumer collection (`mailroom/filters/`) or smallstore (`.smallstore/filters/<source>/`)? Probably collection — they describe the consumer's intent, not the source's data. But shared/common filters might want a registry.
- [?] Does `sm_inbox_sync` support partial materialization (just the index, not the bodies)? Likely yes; useful for "list me what's there without paying R2 reads."
- [?] How do we model deletion? An inbox is append-only in spirit, but real users will want to nuke spam. Soft-delete via a `deleted_at` column, or `DELETE FROM` and let the producer's content-addressing dedupe re-arrivals?
- [?] Does the existing `sm_sync_jobs` machinery already do enough that `runFilteredSync` is just a config wrapper around it? Worth checking before writing new code.

## References

- Mailroom collection spec: `__resources/collections/mailroom/README.md`
- Mailroom build plan: `__resources/collections/mailroom/TASKS.md`
- Cloudflare email primitives: `__resources/github-repos/_cloudflare-landscape/email-for-agents.md`, `email-routing.md`
- Cloudflare agentic-inbox reference impl: `__resources/github-repos/cloudflare-agentic-inbox/`
- Artifacts (Git-shaped storage for per-session inboxes): `__resources/github-repos/_cloudflare-landscape/artifacts-git-for-agents.md`
- AI Search runtime namespaces (related "spin up storage at runtime" pattern): `__resources/github-repos/_cloudflare-landscape/ai-search-agent-primitive.md`
- Existing smallstore unified-retrieval design (companion brief in this folder): `unified-retrieval-layer.md`
