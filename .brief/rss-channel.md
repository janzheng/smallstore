# RSS channel — parser surface + real-world quirks

**Status:** live 2026-04-23 at `smallstore.labspace.ai`.
**Sits in:** `src/messaging/channels/rss.ts`. Companion doc: `.brief/rss-as-mailbox.md` (the end-to-end ingestion story — why we built this, path A vs path B, peer-as-feed).
**Consumer:** `src/messaging/pull-runner.ts` calls `rssChannel.parseMany(...)` once per feed tick.

This brief is the **map of the parser itself** — what it handles, what it doesn't, and the real-world gotchas that shaped the current design. When adding a new feed, skim "Real-world quirks" first; it's where the time gets spent.

## What the channel does (and doesn't)

Does:

- Parses **RSS 2.0**, **Atom 1.0**, and **RSS 1.0 (RDF)** into normalized `InboxItem`s.
- Content-addresses each item: `id = sha256(feed_url + ':' + (guid ?? link ?? title)).slice(0, 32)`. Re-polls are idempotent.
- Extracts podcast fields (`<enclosure>`, `itunes:duration`, `itunes:episode`, `itunes:season`, `itunes:explicit`) when present.
- Skips single malformed entries silently (logs + keeps going); throws only when the whole XML is malformed.
- Applies `default_labels` from `metadata.feed_config` to every item from that feed.

Does NOT (by design):

- **No enrichment.** Abstract-fetching, DOI resolution, HTML stripping, readability extraction — all belong to collections-side pollers, not to smallstore. Smallstore funnels and stores.
- **No HTML cleanup.** `content:encoded` is returned as-is, trackers and all.
- **No deduplication beyond content-addressed id.** If a feed changes a guid, you get a duplicate item. Channels don't know feed history.
- **No category normalization.** `"neuroscience"`, `"Neuroscience"`, `"neuro-sci"` pass through as-is. Taxonomy cleanup is a post-ingest concern.
- **No enclosure download.** `media_policy: 'fetch-to-r2'` is reserved config for a future pull-runner feature; the channel only emits enclosure URLs as refs.

## Format detection

`parseFeedXml` picks the shape off the root element:

| Root            | Format     | Items at                         |
|-----------------|------------|----------------------------------|
| `<rss>`         | RSS 2.0    | `rss.channel.item[]`             |
| `<rdf:RDF>`     | RSS 1.0    | `rdf:RDF.item[]` (siblings of `channel`) |
| `<feed>`        | Atom 1.0   | `feed.entry[]`                   |
| anything else   | throws     | — ("unrecognized feed format")   |

RSS 1.0 is the trap. Items are siblings of `<channel>`, not nested under it. Publishers that still emit RDF: bioRxiv, Slashdot, some academic CMSes. The parser catches both `doc['rdf:RDF']` and the rarer unprefixed `doc.RDF`.

## Field mapping

Common fields every item gets (across all three formats):

| Field              | RSS 2.0                       | Atom 1.0                         | RSS 1.0 (RDF)                    |
|--------------------|-------------------------------|----------------------------------|----------------------------------|
| `fields.feed_url`  | the URL we fetched            | same                             | same                             |
| `fields.feed_title`| `channel.title`               | `feed.title`                     | `channel.title` (sibling, not parent) |
| `summary`          | `<title>`                     | `<title>`                        | `<title>`                        |
| `fields.entry_url` | `<link>` (text)               | `<link rel="alternate" href>`    | `<link>` (text)                  |
| `fields.entry_guid`| `<guid>` / fallback to link   | `<id>` / fallback to link        | `rdf:about` attr / `<link>`      |
| `fields.authors`   | `<author>` + `<dc:creator>`   | `<author><name>`, multiple       | `<dc:creator>`                   |
| `fields.categories`| `<category>text`              | `<category term="...">`          | `<dc:subject>` / `<category>`    |
| `fields.pub_date`  | `<pubDate>` (raw)             | `<published>` / `<updated>`      | `<dc:date>`                      |
| `sent_at`          | `pub_date` parsed to ISO-8601 | same                             | same                             |
| `thread_id`        | `"feed:" + sha256(feed_url).slice(0,16)` (same for every item from one feed) |||

Body preference (first non-empty wins, returned as-is — no stripping):

1. `content:encoded` (RSS full-content convention)
2. `content` (Atom)
3. `description` (RSS)
4. `summary` (Atom)

Podcast fields (only when `<enclosure>` present):

- `audio_url`, `audio_type`, `audio_length_bytes` — from `<enclosure url/type/length>`
- `duration_seconds` — parses `HH:MM:SS`, `MM:SS`, or bare integer
- `episode_number`, `season` — integers, skipped if not finite
- `explicit` — boolean, truthy on `"true"` or `"yes"` (case-insensitive)

## The `parseMany` vs `parse` split

`parse()` satisfies the single-item `Channel` contract — returns the first entry (or `null` for an empty feed). The pull-runner calls `parseMany()` to get every entry. Existing push channels (cf-email) keep using `parse()` only; `parseMany?` is an optional extension on the `Channel` interface.

## Real-world quirks

### bioRxiv — www is challenged, connect.biorxiv.org is open (serves RDF)

First discovered live on 2026-04-23 when the runner started 403ing on every bioRxiv feed.

- **`www.biorxiv.org/rss/subject/*.xml`** — behind Cloudflare's managed challenge. Every non-browser client (Worker, curl, Python `requests`, etc.) gets a 403 with a `Just a moment...` HTML stub containing `cf_chl_opt` + a challenge script. This is bioRxiv's own bot-management, not a Workers-specific block — the same 403 hits from any non-JS-executing client.
- **`connect.biorxiv.org/biorxiv_xml.php?subject=<name>`** — legacy aggregator endpoint. No challenge. Returns RSS 1.0 (RDF). This is why the channel grew RDF support.
- **Topics supported** match the www URLs: `neuroscience`, `bioinformatics`, `genetics`, `cell-biology`, `microbiology`, etc.

Recipe: register peers at `connect.biorxiv.org`, not `www.biorxiv.org`.

### Recipe when any feed 403s

Try in order:

1. **Alternate subdomain / legacy endpoint** — older aggregator-facing paths often predate the site's bot rules. `connect.*`, `api.*`, `feeds.*`, `feedproxy.*`. Sitemaps (`/sitemap.xml`) sometimes escape challenges too.
2. **Different content pipeline** — some sites publish via `feeds.feedburner.com/<name>` or similar CDN indirection that isn't gated.
3. **Non-CF poller** — fall back to the valtown path (see `.brief/rss-as-mailbox.md` § "Path A"). Registers the same peer shape; just POSTs to `/inbox/:name/items` from a non-CF IP. Use when no unchallenged URL exists.
4. **Headless browser service** — Browserless/BrightData/etc can solve challenges. Pricey; only worth it for feeds with no alternative and high value.

What NOT to do: spoof a browser User-Agent. CF's challenge inspects TLS fingerprint + JS execution, not UA. UA spoofing moves you from an obvious-403 to a less-obvious-403.

### `fast-xml-parser` tuning — don't let it coerce

We set `parseTagValue: false` + `parseAttributeValue: false` explicitly. Default behavior silently coerces strings that *look* numeric (`"E1"`, `"1.0"`, `"NaN"`) into the wrong types — breaks version strings, title tokens, iTunes episode codes. The cost: `audio_length_bytes`, `duration_seconds`, `episode_number`, `season` are coerced to `number` by hand in the mapper with `Number.isFinite` guards.

`ignoreAttributes: false` + `attributeNamePrefix: '@_'` is also load-bearing — we need `<enclosure url=...>` attributes and Atom `<link href=...>` to come through as `@_url` / `@_href`.

### Podcast feeds publish their entire history in one XML doc

Unlike blog RSS (which usually paginates to ~10–20 recent posts), podcast RSS publishes the **full back catalog every poll**. Apple Podcasts / Overcast / etc. expect new subscribers to be able to browse the whole archive from a single feed fetch, so publishers ship every episode every time.

Implications:

- **First poll captures everything.** No "since" watermark needed; no historical-import dance. We verified 1565 items across 4 podcast feeds (My First Million 857, Startup Ideas 333, Dumb Money Live 306, How I AI 69) on first ingest — every episode in every feed accounted for via `<item>`-count cross-check.
- **Feed XML is large.** MFM = 6MB, Startup Ideas = 3.4MB, Dumb Money 677KB, anchor.fm 886KB. The `fetchTimeoutMs: 15_000` default in pull-runner held, but a long-running feed (1k+ episodes with rich show notes) could push past it. Bump per-feed via the `peer.metadata.feed_config` if needed; long-term concern is more about CF Worker fetch CPU budget than network speed.
- **Re-poll = no work.** Content-addressed ids mean the second poll dedups every item. Inbox count stayed flat across two consecutive `pollAll()` calls in production.

For sparser-tail feeds (blogs that cap at 20 items, news sites at 50), the cron just keeps rolling and new items land while old ones no-op — same dedup mechanism, different read pattern.

### Entity-expansion limit — raise it for podcast feeds

`fast-xml-parser`'s default `processEntities.maxTotalExpansions: 1000` is an anti-"billion laughs" cap that counts *every* entity reference — standard ones (`&amp;`, `&lt;`, `&quot;`) included. Busy podcast feeds blow past it:

- **anchor.fm** (How I AI) hit 1145 entities on a 69-episode feed
- **flightcast** (Startup Ideas) hit 1131 entities on a 333-episode feed
- Rich HTML show notes with many `&amp;` + `&#39;` accumulate fast

We set `processEntities: { enabled: true, maxTotalExpansions: 1_000_000 }`. Real billion-laughs bombs use DOCTYPE-defined recursive entities (whose amplification is unbounded); podcast XML doesn't declare custom entities, so a 1M cap on the 5 standard + numeric refs stays safe against bombs while handling any realistic feed.

Symptom to recognize: `"RSS channel: failed to parse XML from <url>: Entity expansion limit exceeded: <n> > 1000"`. If you see this on a new feed, the limit is likely still the bottleneck — bump it (or investigate if the feed is genuinely hostile).

### Malformed-XML detection

`fast-xml-parser` is forgiving by default (silently closes unterminated tags). We run `XMLValidator.validate(raw)` first and throw with the feed URL in the message if invalid. Without this, `<rss><channel><item><title>unclosed` would silently produce a partial tree and emit a single weird item.

### Author normalization edge cases

`<author>` comes in three shapes, all handled:

- RSS RFC822 style: `"alice@example.com (Alice Jordan)"` → `"Alice Jordan"` (prefers paren'd name)
- Atom: `<author><name>Alice</name><email>...</email></author>` → `"Alice"` (prefers name, falls back to email)
- `<dc:creator>` (both RSS 2.0 and RDF): plain string

Multiple authors produce an array. Dedup is insertion-order preserving via `Set`.

### Atom `<link>` multiplicity

Atom entries often have `<link rel="self">` + `<link rel="alternate">` siblings. `extractLink` prefers `rel="alternate"` (or no rel — which is Atom's default meaning) so `entry_url` points at the permalink, not the feed's self-reference.

## Known gaps (worth doing when they bite)

From the channel agent's `#discovered` list + live-test observations:

- **`#rss-feed-auth`** — feeds behind HTTP Basic / bearer. Peer registry already supports auth kinds; pull-runner threads them through. Confirmed working for `kind: 'bearer'` in tests.
- **`#rss-dc-date-precedence`** — currently `pubDate ?? published ?? updated ?? dc:date`. Atom feeds with both `updated` + `published` get `updated`. Debatable for dedup stability; could flip to `published` preference if real feeds show churn.
- **`#rss-content-encoded-namespace`** — relies on literal key `'content:encoded'` from fast-xml-parser. If a feed uses a different prefix (`<atom:content>`, `<media:description>`), we miss it.
- **`#rss-podcast-chapter-marks`** — `<psc:chapters>` (Podlove) and `<podcast:chapters>` (Podcast Index namespace) not extracted. Add when a real podcast feed needs them.
- **`#rss-category-normalization`** — post-classify hook territory, not the channel's.
- **`#rss-html-body-cleanup`** — collections-side processor (readability? Jina? Firecrawl?), not the channel's.
- **`#rss-per-feed-rate-limit`** — pull-runner concern (shared CDN origins like Substack), not the channel's.

## Test coverage (2026-04-23)

- 32 channel tests (`tests/messaging-channel-rss.test.ts`) across fixtures `01-05`: blog/RSS 2.0, GitHub/Atom, iTunes podcast, malformed-entry resilience, bioRxiv/RDF.
- 14 pull-runner tests (`tests/messaging-pull-runner.test.ts`): happy path, type filtering, disabled-peer skip, missing target_inbox, malformed XML, idempotent re-poll, `default_labels`, `pollOne`, bearer-auth injection, missing-env-var short-circuit.
- Full messaging regression: 94/94 green (rss + cf-email + inbox + email-handler + pull-runner).

## Where to look when things break

- Parsing bug in a new feed type → `parseFeedXml` + add a fixture in `tests/fixtures/rss/` + a test.
- Runner-level bug (wrong inbox, auth, cron) → `src/messaging/pull-runner.ts` + its tests.
- Shared pipeline bug (hooks, sinks, classify) → `src/messaging/dispatch.ts` (used by both email-handler and pull-runner — regressions show up in both test suites).
- Live debugging → `npx wrangler tail` on deploy, or hit `POST /admin/rss/poll` manually and inspect the JSON summary.
