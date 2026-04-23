# 2026-04-24 — Mailroom sprint + plugin discipline audit

**Status:** shipped
**Previous briefs this built on:** `messaging-plugins.md`, `mailroom-pipeline.md`, `plugin-discipline-audit.md`
**Deployed:** `smallstore.labspace.ai` version `b32121f0-47e6-4e8d-a262-15ebe5342829`

## What shipped in one day

One working session moved smallstore from "messaging primitives + first deploy" (end of 2026-04-23) to "newsletter-ready mailroom pipeline with documented plugin discipline" (end of 2026-04-24). Eight production commits, 228/228 messaging tests green, zero regressions, one live production deploy.

```
6361d6a  Mailroom #0: Sink abstraction + email-handler refactor
c851e3f  Wave 1: FTS5, sender-index, classifier, regex filter (+126 tests)
ee4cab0  Label naming: cf-email auto → auto-reply (aligns with classifier)
8f36de9  Wave 2: hook pipeline + unsubscribe + quarantine (+41 tests)
e65cddf  Bulk export endpoint + deploy hook wiring (newsletter-ready)
        + fa40f4f (mailroom-pipeline brief), d4a74a9 (discipline brief+fix),
          f549ee7 (PLUGIN-AUTHORING.md), c0585c3 (search=core refinement)
```

## The day in three arcs

### Arc 1 — research + shape

Started from a question about Cloudflare's `agentic-inbox` repo. Read the whole source and wrote a comparison into the research notes: **different thesis** (theirs is a vertical Gmail-on-Workers with one agent; ours is a horizontal pipeline). Stole the useful parts (Gmail-style search-parser, DO migration runner, two-tier LLM safety pattern) — parked as follow-ups.

User clarified a critical design tension: "mailroom is a plugin / a channel / a firehose — you point it somewhere." That forced the **Sink abstraction**: `(item, ctx) => Promise<SinkResult>`. Adapter-backed inbox is ONE flavor; HTTP POST / function callback / file write / cross-inbox mirror are others. This is the single move that turned "mailroom is embedded in smallstore" into "mailroom composes smallstore."

→ Wrote `.brief/mailroom-pipeline.md` with the full pipeline shape, policy layer, extraction plan for when mailroom outgrows one-channel-one-sink. Answered the "standalone?" question: **brand early, fork late** — the deploy can be `mailroom.labspace.ai` with the code still inside smallstore, until policy size forces extraction.

### Arc 2 — plugin discipline audit

Before adding more plugin families (obsidian adapter+channel, rss channel, webhook channel, tigerflare adapter, mailroom policy stack) — check that the existing plugin pattern holds up. The concern: plugin #2 costs more than #1 if the pattern is sloppy; #3 costs more than #2; etc. User's aspirational shape: pi-mono's simple core + opt-in extensions.

Defined **4 invariants** for what makes a plugin genuinely a plugin:

1. Core never imports the plugin (one-way dep)
2. Heavy deps are optional peers, not core
3. Sub-entry points are self-contained (no cross-plugin imports)
4. Plugin is deletable (`rm -rf src/<plugin>/` + everything still builds)

Audited the messaging family first — 3.5/4. One real leak: `postal-mime` in core `dependencies` but only used by cf-email channel. Fixed via lazy dynamic import + moved to optional peer (same pattern as `hono`). Every npm consumer no longer pays for it.

Then audited every other plugin family. Scorecard: **7 real plugin families (messaging, graph, episodic, blob-middleware, http, disclosure, vault-graph), 6 clean + 1 known leak (blob-middleware uses aws-sdk)**. Reclassified 3 "plugins" as core modules (`views`, `materializers`, `search` — used by router/adapters, can't be deleted).

Important user-surfaced criterion: **ubiquitous utility promotes to core, even if it "sprawled" there.** `src/search/` is imported by 7 adapters for BM25 indexing — initial instinct was "invariant-4 failure, search isn't deletable." User's call: "bm25 is so useful might as well make it core." The leak pattern is *one* caller dragging in a heavy dep the others don't need — NOT many callers benefiting from a shared primitive. Saved to memory for future audits.

→ Wrote `docs/design/PLUGIN-AUTHORING.md` — one-page canonical recipe. 4 invariants + lazy-load pattern (postal-mime as worked example) + sub-entry-point convention + deletion test + checklist + known exceptions + role decision tree (adapter/channel/sink/processor table with worked examples).

Adapter-level leaks (`@notionhq/client`, `@aws-sdk/*`, `unstorage`) deferred — `factory-slim.ts` is the already-proven mitigation for production consumers. Fixing properly needs either (a) breaking removal of adapter re-exports from root `mod.ts` or (b) per-adapter sub-entry-points + lazy-load. Both queued as `[?]`, six granular tasks total.

### Arc 3 — mailroom pipeline build

Executed the pipeline in waves against the discipline doc.

**Wave 0 (me, sequential) — Sink abstraction.** The commitment-point refactor. Sink type + three factories (inboxSink, httpSink, functionSink); InboxRegistration extended with `sinks[]`; email-handler replaces "for each inbox, inbox._ingest" with per-sink try/catch fan-out. Backwards-compatible: existing `register(name, inbox, config)` auto-wraps with `inboxSink(inbox)`. Added cf-email header preservation (lowercase-keyed `fields.headers` map) as prep for Wave 1 agents. 27/27 tests.

**Wave 1 (4 parallel agents) — FTS5 + sender index + classifier + regex filter.**
- Agent A: `cloudflareD1({ messaging: true })` triggers proper messaging schema migration, items_fts virtual table, 4 triggers (ai/ad/au_delete/au_insert), `query({ fts: "..." })`. 26 tests. Plugin invariant 1 preserved — adapter doesn't import messaging; uses local structural types.
- Agent B: `createSenderIndex(adapter, opts)` — upsert/get/query/delete with aggregate stats. Adapter-agnostic (MemoryAdapter in tests). 16 tests.
- Agent C: `classify(item)` / `classifyAndMerge(item)` — pure functions emitting newsletter/list/bulk/auto-reply/bounce labels with 4 independent bounce signals. 37 tests.
- Agent D: `InboxFilter` extended with `fields_regex`/`text_regex`/`headers` (present/absent/regex). Invalid regex safe-skipped. YAML spec parser extended. 39 tests.
- 4 agents, file scopes disjoint by design, **zero merge conflicts** across 6 files in parallel edit.

Surfaced a blocker for Wave 2: **label naming divergence** — cf-email inline detector emits `auto`/`ooo`; classifier emits `auto-reply`. Resolved by renaming cf-email's `auto` → `auto-reply`, keeping `ooo` as a distinct subtype. 1-line fix.

**Wave 2 (2 parallel agents + me) — hooks + unsubscribe + quarantine.**
- Me: Hook interface in pipeline. Three stages (preIngest / postClassify / postStore), HookVerdict (accept/drop/quarantine/InboxItem), throwing-hook safety, 10 new tests.
- Agent E: `unsubscribe.ts` with `unsubscribeSender(senderIndex, address)` — RFC 8058 one-click HTTPS, mailto fallback, sender tagged even when URL missing. 12 tests + HTTP route.
- Agent F: `quarantine.ts` — label-based approach (not sub-inbox) for zero-new-infrastructure. `quarantineSink(inbox)` factory + `quarantineItem(id)`/`restoreItem(id)` helpers using `_ingest({ force: true })`. 19 tests.

**Finishing touches — newsletter export + deploy wiring.**
Bulk export endpoint `GET /inbox/:name/export?format=jsonl&filter=<json>&include=body&limit=N` — streams ND-JSON with body inflation from blobs adapter. 9 tests. This is the "download newsletters for LLM processing" affordance the user named as their first real use case.

Deploy wiring: `deploy/src/index.ts` now registers mailroom with a `postClassify` hook that upserts into a memory-backed sender index. `senderIndexFor` resolver wired into messaging routes so the unsubscribe endpoint works against the live index.

**Production deploy.** `wrangler deploy` → version `b32121f0-47e6-4e8d-a262-15ebe5342829`. Live verification: `/health`, `/inbox/mailroom`, `/inbox/mailroom/export?format=jsonl&include=body` all returning clean JSON. The chicken-crossing-the-road email from 2026-04-23's build persists in D1+R2 across the deploy (as expected).

## End-state capabilities

A user can now:

- Receive an email to `mailroom@labspace.ai` → item automatically classified (`newsletter`/`list`/`bulk`/`auto-reply`/`bounce` where applicable) → sender-index upserted → stored in D1+R2
- **Query newsletters**: `POST /inbox/mailroom/query` with `{labels:['newsletter']}` or regex filter
- **Download for LLM processing**: `GET /inbox/mailroom/export?filter={"labels":["newsletter"]}&include=body` — one curl, JSONL stream, body inlined
- **Unsubscribe**: `POST /inbox/mailroom/unsubscribe` with `{address:"news@substack.com"}` — RFC 8058 one-click
- **Fan out to external services**: register an `httpSink` to POST every item (or only newsletters) to tigerflare/slack/anything
- **Add filter rules inline**: `preIngest` hook with regex → drop/quarantine/mutate
- **Quarantine suspicious items**: hook returns `'quarantine'` → item labeled, stored, queryable, restorable

All of it behind the same `SMALLSTORE_TOKEN` bearer auth as the existing `/api` surface.

## Metrics

| Measure | Value |
|---|---|
| Tests added | 186 (0 → 186 messaging-family tests; 228/228 total green) |
| Commits pushed | 8 to `smallstore` |
| LOC added (src + tests + docs) | ~5,400 net insertions |
| Subagent dispatches | 6 (4 parallel Wave 1 + 2 parallel Wave 2) |
| Merge conflicts across parallel work | 0 |
| Live production bundle | 583 KiB (gzip 124 KiB) |
| Docs shipped | `PLUGIN-AUTHORING.md`, `mailroom-pipeline.md`, `plugin-discipline-audit.md` briefs; `2026-04-24-mailroom-sprint.md` (this) |

## What's still queued

### Mailroom pipeline (deferred, not blocking)

- **#6 Rules table** — runtime-editable rules (D1 row / YAML file / JS array source). Core rules stay in code; user rules extend. Wave 3 work.
- **#8 Spam layers** — composed preIngest rules (regex blocklist / header heuristics / sender reputation / content hash dedup). Needs #6 + sender-index (already shipped).
- **MCP `sm_inbox_*` tool family** — doesn't exist yet; when it does, MCP tools for list/read/query/unsubscribe/restore/export land together rather than one-off.
- **Raw / attachment inlining in export** — `include=body` covers 80% of newsletter-to-LLM flows. Raw .eml base64 + presigned attachment URLs are parked.

### Plugin discipline (deferred, not blocking)

- **blob-middleware aws-sdk lazy-load** — priority among these because it's a real plugin family leak (not just an adapter). ~30 min.
- **Notion / r2-direct / unstorage adapter lazy-load** — apply postal-mime recipe to each. Non-breaking.
- **Mirror all adapter sub-entry-points into `build-npm.ts`** — currently only 5 CF adapters are npm-importable individually; the rest go through the barrel. Cheap fix.
- **0.3.0 breaking: remove adapter re-exports from root `mod.ts`** — clean endpoint, defer until a major bump.

### Wave 1/2 `#discovered` backlog

14 follow-ups surfaced during parallel agent work (batch D1 ingest, FTS5 tokenizer choice, unicode normalization on sender addresses, header multi-value drift, spam-reputation threshold predicate, etc.). None blocking; tracked in `TASKS-MESSAGING.md`.

### Motivating-examples-not-built

- **Obsidian adapter + channel** — parked; the discipline work supports adding it in 1-2 hours when needed.
- **RSS channel** — parked; same.
- **Webhook channel** — parked; this is what agentic feeders will POST to for "dump data somewhere" once it ships.
- **Tigerflare adapter** — parked and questioned (tigerflare is being used the *other* direction today; adapter direction is backwards-facing until a real consumer appears).

## Notable design decisions locked in

1. **Sink abstraction is the bedrock.** Everything downstream composes against it. Inboxes are sinks; HTTP endpoints are sinks; functions are sinks. Destinations are trivially pluggable.
2. **Ubiquitous utility = core, not plugin.** Saved as a decision criterion for future audits. The leak pattern is one-caller-drags-heavy-dep, not many-callers-share-primitive.
3. **Store-first over filter-first.** Quarantined items are labeled + persisted, never silently dropped. Restore = single label removal. Content-addressed ids stay stable across quarantine boundary.
4. **Label-based quarantine, not sub-inbox.** Zero new infrastructure; aligns with existing `Inbox.query(filter)` surface; restore is one label removal vs. a cross-inbox move.
5. **Hooks are user-supplied, not built-in (except classify).** Pipeline is three stages — preIngest / postClassify / postStore. The only opinionated built-in is the classifier, and it's opt-out-able.
6. **cf-email emits `auto-reply` (not `auto`), keeps `ooo` distinct.** OOO is a subtype of auto-reply, not a synonym — both labels coexist meaningfully.
7. **Search is core, not a plugin.** Every adapter uses BM25; reclassified and documented.
8. **Plugin-vs-standalone is about extraction cost, not branding.** Brand early (`mailroom.labspace.ai` can point at same Worker); fork late (only when policy size or third-party consumers force it).

## References

- Pipeline brief: `.brief/mailroom-pipeline.md` (design)
- Messaging primitives: `.brief/messaging-plugins.md` (foundation)
- Plugin discipline: `.brief/plugin-discipline-audit.md` (audit findings + 4 invariants)
- Authoring recipe: `docs/design/PLUGIN-AUTHORING.md`
- Prior art comparison: `__resources/github-repos/cloudflare-agentic-inbox/notes.md` (§ 2026-04-24)
- Tigerflare bridge prereq: `_deno/apps/tigerflare/.brief/smallstore-bridge-activation.md` (this sprint unblocks it)
- Task archive: `TASKS.done.md` § `2026-04-24 — Mailroom + plugin discipline sprint`

## Credits

Humans: user framed the day's arc ("mailroom as firehose," "bm25 is core," "first use case is newsletters," "brand ok but clean seam," "go!"). Agents: 6 subagents executed well-scoped parallel tasks with clean file-scope discipline. The 4-invariant audit held up through 41 new test files without a single regression.
