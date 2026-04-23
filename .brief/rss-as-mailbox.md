# RSS as mailbox — feed ingestion into smallstore inboxes

**Status:** shaping (not started — fast path is actionable today)
**From:** 2026-04-25 conversation — user wants bioRxiv RSS feeds funneled into smallstore since the bioRxiv APIs are flaky. Existing valtown infrastructure available for polling.
**Pairs with:** existing messaging plugin family; extends without modifying

## The idea in one line

**Every inbox is a mailbox — not just email.** RSS entries become `InboxItem`s the same way emails do, go through the same hooks and sinks and rules and classifier, show up in the same queries and exports. The user's Gmail inbox, bioRxiv feeds, and random blogs all become one unified surface addressable via `/inbox/:name`.

## Motivation

The user has:
- A mailroom inbox that works great for email (curation, rules, export, unsubscribe)
- Biorxiv publishing interesting preprints that they want to track
- Flaky bioRxiv APIs (unreliable; want a more resilient pull)
- Existing valtown infrastructure that's good at scheduled polling
- A growing number of feeds to monitor (likely bioRxiv first, then more)

What's missing: a way to **ingest feed items** into smallstore's inbox surface. The receiving side already exists — `POST /inbox/:name/items` accepts pre-parsed `InboxItem`s with bearer auth. The pulling side does not.

Two paths to fill the gap, each with a clear trigger for when to pick it.

## Two paths

### Path A — External poller (valtown), smallstore receives (FAST)

```
bioRxiv RSS  →  valtown cron  →  POST /inbox/:name/items  →  smallstore stores + classifies + rules-tags
```

What's needed: register the inbox once (`POST /admin/inboxes`), write the valtown poller, done. Smallstore code untouched. Works today.

**Lift:** ~1 hour for the first feed. Subsequent feeds are a config row + (optionally) another poller instance.

**Pros:**
- Ships today, no smallstore redeploy
- Leverages valtown's existing scheduled-poller muscle
- Polling concerns (retries, backoff, flaky feeds) stay isolated in valtown
- Per-feed state (watermarks, dedup sets) lives in valtown's own storage — smallstore stays stateless on the ingest side
- Same pattern scales to any external agentic feeder: just POST InboxItems

**Cons:**
- External dependency (valtown must be up)
- Secret management (valtown needs `SMALLSTORE_TOKEN`)
- No unified "all my data sources in one place" story — you manage pollers outside smallstore

### Path B — In-Worker RSS channel (LATER)

```
bioRxiv RSS  →  smallstore scheduled() cron  →  RSS channel parses  →  stores + classifies + rules-tags
```

What's needed: `src/messaging/channels/rss.ts` (the channel implementation) + a `pull-runner` shared scheduler + wrangler.toml cron triggers + per-feed config in `.smallstore.json` or admin API.

**Lift:** 4-6 hours for the channel + runner. Per-feed is config.

**Pros:**
- Unified architecture — all ingestion inside smallstore Worker
- No external dependency
- Per-feed config alongside mailroom config
- Same auth surface as everything else

**Cons:**
- More code to maintain
- CF Workers cron limits (2-min minimum interval on paid plans, less granular on free tier)
- Migration path from path A is manual (re-ingestion, or dual-write during switchover)

### When to promote from path A → path B

Concrete triggers:

1. **3+ feeds and counting** — managing pollers across multiple valtown endpoints gets noisy; one `.smallstore.json` config row is cleaner.
2. **Sub-minute polling needs** — valtown cron is fine for most feeds but if you need sub-minute polling (unlikely for RSS, but possible for high-frequency sources), in-Worker gives finer control.
3. **Valtown outages bite** — if a valtown hiccup costs you a day of bioRxiv items, the in-Worker channel becomes worth the code.
4. **Unified observability** — if you want "which feeds errored in the last 24 hours" as a single smallstore query, in-Worker puts all the logs in `wrangler tail`.

Until any of those trip, path A wins on speed-to-ship. Start there.

## The `InboxItem` shape for RSS

Same shape as email items, just different `source` + `fields`:

```ts
{
  id: "<content-addressed sha256 hex, 32 chars>",
  source: "rss/v1",
  source_version: "rss/v1",
  received_at: "2026-04-25T14:23:01Z",        // when valtown polled + pushed
  sent_at: "2026-04-25T13:00:00Z",            // from feed entry pubDate
  summary: "Title of the blog post / paper",
  body: "abstract or excerpt, inline if < 64KB",
  body_ref: "body/<id>.html",                 // if larger, valtown uploads separately via /api
  thread_id: "feed:<feed-url-hash>",          // per-feed grouping
  labels: [],                                 // classifier won't fire meaningfully on RSS;
                                              // rules engine can still apply
  fields: {
    feed_url: "https://www.biorxiv.org/rss/subject/neuroscience",
    feed_title: "bioRxiv: Neuroscience",
    entry_url: "https://www.biorxiv.org/content/10.1101/2026.04.25.abc",
    entry_guid: "<guid-from-feed>",           // canonical dedup key
    authors: ["Jane Doe", "John Smith"],
    categories: ["neuroscience", "cell-biology"],
    pub_date: "2026-04-25T13:00:00Z",
    // For bioRxiv specifically:
    doi: "10.1101/2026.04.25.abc",
    preprint_server: "biorxiv"
  }
}
```

### Content-addressed `id`

**Critical for dedup on re-delivery.** If valtown re-polls and sees the same `<guid>`, it should POST with the same `id` so smallstore's `_ingest` treats it as a duplicate and returns the existing item instead of double-storing.

Formula:
```
id = sha256(feed_url + ':' + entry_guid).toString('hex').slice(0, 32)
```

Stable across re-polls, stable across valtown restarts. Smallstore's `InboxItem._ingest` already dedups on `id`, so valtown doesn't need to maintain a "have I sent this?" table.

### Labels + classifier

The existing cf-email classifier won't do anything meaningful for RSS (no `List-Unsubscribe` headers, no `Auto-Submitted`). That's fine — the classifier is opt-outable (`createEmailHandler({ classify: false })`) and non-email ingestion via `POST /inbox/:name/items` doesn't go through the email-handler pipeline anyway. RSS items get whatever labels the rules engine applies + whatever valtown attaches inline.

Example rules that might fire on RSS:

```
{ match: { fields: { categories: "neuroscience" } }, action: "tag", action_args: { tag: "neuroscience" } }
{ match: { fields: { authors: "Jane Doe" } }, action: "bookmark" }
{ match: { text_regex: "(?i)\\b(llm|language model)\\b" }, action: "tag", action_args: { tag: "ai" } }
```

## Inbox-per-feed vs. one inbox with source routing

Two defensible layouts:

### Option 1 — one inbox per feed category

`biorxiv-neuroscience`, `biorxiv-bioinformatics`, `hackernews-best`, etc.

Pros: queries stay clean (`/inbox/biorxiv-neuroscience/export`). Per-inbox rules. Clear separation.
Cons: more admin entries; moving items between inboxes is manual.

### Option 2 — one `feeds` inbox with `source` field

All entries go to `/inbox/feeds`; filter by `fields.feed_url` or `source_version`.

Pros: one inbox; cross-feed queries trivial.
Cons: query specificity requires filter boilerplate (`filter: { fields: { feed_url: "...biorxiv/subject/neuroscience" } }`).

### Recommendation

**Option 1 for category-level distinctness, Option 2 within a category.** So:

- `biorxiv` inbox receives all bioRxiv feeds; queries filter by `fields.categories` or `fields.subject`
- `hackernews` inbox separate (different "kind" of content entirely)
- `rss-general` inbox for random blogs

Rules of thumb: if the queries you'd run are naturally scoped to the inbox, keep them in one inbox. If you'd constantly filter-by-source, split.

## Auth model for valtown → smallstore

Valtown needs `SMALLSTORE_TOKEN` to POST into the inbox. Options:

1. **Reuse the existing smallstore master token** — simplest, but broad blast radius. If valtown leaks, everything leaks.
2. **Path-scoped token (future work)** — smallstore's path-scoped auth (parked as `#path-auth` in tigerflare TASKS and similar for smallstore) would let valtown have a token that only allows `POST /inbox/biorxiv/*`. Not shipped yet.
3. **Dedicated secondary token** — add a second `SMALLSTORE_TOKEN_VALTOWN` with equal privileges. Trivial to implement; marginally better than option 1 (rotation doesn't break interactive use).

Today: **option 1**. When path-scoped auth ships, migrate valtown to a scoped token.

## End-to-end walkthrough (path A)

### 1. Register the bioRxiv inbox (one-time, any client)

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "biorxiv",
    "channel": "rss",
    "storage": { "items": "biorxiv_d1", "blobs": "mailroom_r2" }
  }' \
  https://smallstore.labspace.ai/admin/inboxes
```

**⚠️ Isolation note:** each inbox needs its OWN `items` adapter because `Inbox` uses hardcoded keys (`_index`, `items/<id>`) that collide when multiple inboxes share one adapter. The `biorxiv_d1` adapter is pre-registered in `deploy/src/index.ts` (points at `MAILROOM_D1` binding, dedicated `biorxiv_items` table). R2 is shareable (blob keys are content-addressed sha256).

For additional category inboxes (`biorxiv-neuroscience`, `biorxiv-bioinformatics`, etc.), add a matching `biorxiv_neuro_d1` / `biorxiv_bio_d1` adapter in the deploy + redeploy first. Tracked as tech debt: `#inbox-keyprefix-isolation` — the proper fix is a `keyPrefix` option on `Inbox` so runtime-created inboxes auto-isolate without deploy changes.

### 2. Valtown poller (sketch)

```ts
// valtown cron — runs every 30 min against bioRxiv neuro RSS
import { Parser } from "rss-parser";
const parser = new Parser();

export default async function () {
  const feedUrl = "https://www.biorxiv.org/rss/subject/neuroscience.xml";
  const feed = await parser.parseURL(feedUrl);
  const now = new Date().toISOString();

  for (const entry of feed.items) {
    const entryGuid = entry.guid ?? entry.link;
    if (!entryGuid) continue;  // skip malformed entries

    const id = await sha256Hex(feedUrl + ":" + entryGuid);  // stable across re-polls

    const item = {
      id: id.slice(0, 32),
      source: "rss/v1",
      source_version: "rss/v1",
      received_at: now,
      sent_at: entry.pubDate ? new Date(entry.pubDate).toISOString() : undefined,
      summary: entry.title ?? "(no title)",
      body: entry.contentSnippet ?? entry.content ?? null,
      thread_id: "feed:" + (await sha256Hex(feedUrl)).slice(0, 16),
      fields: {
        feed_url: feedUrl,
        feed_title: feed.title,
        entry_url: entry.link,
        entry_guid: entryGuid,
        authors: entry.creator ? [entry.creator] : [],
        categories: entry.categories ?? [],
        pub_date: entry.pubDate,
        // Best-effort bioRxiv-specific fields — parse DOI from link
        doi: entry.link?.match(/10\.1101\/[\d.]+/)?.[0],
        preprint_server: "biorxiv",
      },
    };

    // POST; smallstore dedups on item.id so re-polls are idempotent
    const res = await fetch(
      "https://smallstore.labspace.ai/inbox/biorxiv/items",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SMALLSTORE_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(item),
      },
    );
    if (!res.ok) {
      console.error(`ingest failed for ${entryGuid}: ${res.status} ${await res.text()}`);
    }
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

One valtown script per feed (simpler) or one script with a feed-config array (DRY). Pick based on whether feeds drift apart in polling cadence / auth / parser quirks.

### 3. Query from smallstore

```bash
# Latest bioRxiv preprints
curl -H "Authorization: Bearer $TOKEN" \
  "https://smallstore.labspace.ai/inbox/biorxiv?limit=10"

# Preprints mentioning LLMs, last 7 days, as JSONL
SINCE="2026-04-18"
curl -H "Authorization: Bearer $TOKEN" \
  "https://smallstore.labspace.ai/inbox/biorxiv/export?filter=%7B%22text_regex%22%3A%22(%3Fi)LLM%22%2C%22since%22%3A%22$SINCE%22%7D&include=body&format=jsonl"

# Auto-bookmark papers by specific authors
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"match":{"fields":{"authors":"Karl Friston"}},"action":"bookmark"}' \
  "https://smallstore.labspace.ai/inbox/biorxiv/rules"
```

## Task queue

### Path A — Valtown poller + inbox registration (ship first)

- [ ] Register `biorxiv` inbox via `POST /admin/inboxes` against `smallstore.labspace.ai`. One curl. #rss-biorxiv-inbox
- [ ] Valtown poller for bioRxiv neuroscience feed. Adapt the sketch above into a valtown cron val. Set `SMALLSTORE_TOKEN` as a valtown secret. Test end-to-end (should see the feed entries appear in `/inbox/biorxiv`). ~1 hour #rss-valtown-biorxiv-poller
- [ ] Generalize the poller — accept a feed-config array and one cron that fans over N feeds, OR clone per-feed based on polling cadence needs. #rss-valtown-fanout
- [ ] Add additional bioRxiv subject feeds (bioinformatics, genomics, etc) as new inboxes or as additional feed rows in the generalized poller. #rss-biorxiv-coverage
- [ ] Document the pattern in the valtown-side README — "how to add an RSS feed to smallstore" — so other agentic feeders use the same template #rss-valtown-docs

### Path B — In-Worker RSS channel (defer until trigger conditions)

Queued in `TASKS-MESSAGING.md § More channels`. Includes:

- [?] `src/messaging/channels/rss.ts` — Channel<RssInput> implementation with `parse` + `pull` for cron-driven polling
- [?] Pull runner — shared scheduler module reading `inbox.schedule` from config; hooked to CF Worker `scheduled()` cron export
- [?] Per-channel concurrency cap (don't hammer feeds that share an origin)
- [?] Watermark persistence — per-feed `since` cursor stored in a smallstore adapter
- [?] Promote when: 3+ external pollers exist, OR valtown hiccups cost real data, OR unified observability becomes valuable

### Enhancements (useful regardless of path)

- [?] **Webhook channel** (`src/messaging/channels/webhook.ts`) — generic POST receiver with optional HMAC validation. Already queued in `TASKS-MESSAGING.md`. Would give valtown a more structured target than `POST /inbox/:name/items` — webhook channel validates body shape + applies channel-level transforms before ingest. Useful but not blocking. #channel-webhook
- [?] **Path-scoped auth** — issue a valtown-only token that can only POST to `/inbox/biorxiv/*`. Queued loosely; promote when the master token's blast radius becomes a real concern #path-auth
- [?] **RSS-aware classifier** — tag items based on content (academic paper? blog post? press release?). Low priority; rules engine handles the common cases already #rss-classifier

## Out of scope for this brief

- **Twitter / Nitter feeds** — different shape (no standard GUID, rate limits), different poller. Future brief.
- **Newsletter RSS (Substack export-as-RSS)** — could use this pattern but newsletters already arrive via email in the mailroom inbox; double-ingestion would dup.
- **Archival / full-text PDF fetch for preprints** — bioRxiv entries link to PDFs; pulling + indexing them is a separate blob-middleware concern. Store refs in `fields.pdf_url` for later.
- **ArXiv / medRxiv / PubMed / Semantic Scholar** — same pattern applies, but each feed has its own parser quirks. Add as separate pollers once the bioRxiv pattern is proven.
- **FTS5 on RSS content** — `cloudflareD1({ messaging: true })` already gives us FTS if we route RSS inboxes through the D1 messaging mode. Works today; brief doesn't need to call it out specifically.

## Success criteria

User can do all of this within a day of starting:

1. See bioRxiv neuroscience preprints land in `/inbox/biorxiv` automatically via valtown
2. Query for keywords: `POST /inbox/biorxiv/query { text_regex: "(?i)\\b(attention|transformer)\\b" }`
3. Auto-bookmark papers by favorite authors: one `POST /inbox/biorxiv/rules` call
4. Export last 30 days of ingested items as JSONL for LLM summarization
5. Add a second feed (e.g. bioRxiv bioinformatics) by cloning the valtown val + registering a second inbox — ~5 minutes

## Notable design decisions

1. **Reuse existing ingest route rather than build webhook channel first.** `POST /inbox/:name/items` is already the universal "push me an InboxItem" door. Webhook channel adds validation + auth-kind flexibility but isn't blocking for this use case.
2. **Valtown does the polling, smallstore does the curation.** Separation of concerns matches each tool's strengths. In-Worker polling (path B) is the eventual unification but not the first move.
3. **Content-addressed ids = valtown is stateless on dedup.** Smallstore's `_ingest` handles idempotency; valtown doesn't need a "have I sent this?" store.
4. **One inbox per feed category, not per feed.** Same storage, grouped by intent ("all my bioRxiv stuff"), filterable by `fields.feed_url` for finer splits.
5. **Path A solves today's problem; path B waits for scale.** No premature in-Worker infrastructure before external pollers stress-test the shape.

## References

- Existing ingest route: `src/messaging/http-routes.ts` — `POST /inbox/:name/items` (line ~76)
- Inbox admin API: `src/messaging/http-routes.ts` — `POST /admin/inboxes`
- InboxItem shape: `src/messaging/types.ts` — full schema
- Rules engine: `.brief/mailroom-curation.md` (already applies to any inbox, not just cf-email)
- Queued in-Worker RSS tasks: `TASKS-MESSAGING.md § More channels`
- Path-scoped auth parked context: tigerflare `.brief/path-scoped-auth.md` (similar concept applies here)
