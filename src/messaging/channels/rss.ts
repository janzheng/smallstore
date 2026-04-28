/**
 * RSS / Atom channel.
 *
 * Parses RSS 2.0 and Atom 1.0 feeds into normalized `InboxItem`s. Pull-shape
 * companion to cf-email: the pull-runner fetches the feed URL and hands the
 * raw XML body here; this channel produces one InboxItem per feed entry.
 *
 * Format detection:
 *   - RSS 2.0 — root `<rss>` containing `<channel>` with `<item>` children
 *   - RSS 1.0 (RDF) — root `<rdf:RDF>` with `<channel>` + sibling `<item>`
 *     elements. Common on legacy publisher pipelines (bioRxiv, slashdot,
 *     some academic CMSes).
 *   - Atom    — root `<feed>` with `<entry>` children
 *
 * Field mapping (`InboxItem.fields`):
 *   - feed_url           — the URL the XML was fetched from
 *   - feed_title         — channel/feed-level title
 *   - entry_url          — item link (href for Atom)
 *   - entry_guid         — item guid / Atom id (falls back to link)
 *   - authors            — string[] normalized from <author>, <dc:creator>,
 *                          Atom <author><name>...</name></author>
 *   - categories         — string[] normalized from <category>text</category>
 *                          (RSS) or <category term="..."/> (Atom)
 *   - pub_date           — raw pubDate / updated string as it appears in the feed
 *
 *   Podcast (only when <enclosure> present):
 *   - audio_url          — enclosure @url
 *   - audio_type         — enclosure @type
 *   - audio_length_bytes — enclosure @length as number
 *   - duration_seconds   — itunes:duration parsed (HH:MM:SS or MM:SS or seconds)
 *   - episode_number     — itunes:episode as number
 *   - season             — itunes:season as number
 *   - explicit           — itunes:explicit === "true" | "yes"
 *
 * Body preference (first non-empty wins, returned as-is — no HTML stripping):
 *   1. content:encoded   (full-content RSS convention)
 *   2. content           (Atom <content>)
 *   3. description       (RSS <description>)
 *   4. summary           (Atom <summary>)
 *
 * Idempotency: `id = sha256(feed_url + ':' + (guid ?? link)).slice(0, 32)` —
 * stable across re-polls. Smallstore's `_ingest` treats re-deliveries with
 * the same id as duplicates.
 *
 * No enrichment: the channel maps XML → InboxItem faithfully and stops.
 * Enrichment (abstract fetch, DOI lookup, HTML cleanup, transcript pulls,
 * enclosure download) is the pull-runner / collections' concern.
 *
 * Single-entry failures (missing title+link+guid) are skipped silently — the
 * remaining entries in the feed still return. Malformed XML throws with the
 * feed URL in the error message.
 */

import type { Channel, ParseResult, InboxItem } from '../types.ts';

// Lazy-load fast-xml-parser so consumers who don't use the RSS channel don't
// pay for the dep. Dynamic import is cached by the module system after the
// first call — no per-parse cost beyond the first one.
let _XMLParser: any | undefined;
let _XMLValidator: any | undefined;
async function loadXmlParser(): Promise<{ XMLParser: any; XMLValidator: any }> {
  if (_XMLParser && _XMLValidator) return { XMLParser: _XMLParser, XMLValidator: _XMLValidator };
  try {
    const mod: any = await import('fast-xml-parser');
    _XMLParser = mod.XMLParser ?? mod.default?.XMLParser ?? mod;
    _XMLValidator = mod.XMLValidator ?? mod.default?.XMLValidator;
    return { XMLParser: _XMLParser, XMLValidator: _XMLValidator };
  } catch (err) {
    throw new Error(
      "The rss channel requires 'fast-xml-parser'. Install:\n" +
        '  npm install fast-xml-parser\n' +
        '  (or add to deno.json imports: "fast-xml-parser": "npm:fast-xml-parser@^4.5.0")\n' +
        `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ============================================================================
// Input shape + config
// ============================================================================

/**
 * Inputs to the RSS channel parser.
 *
 * The pull-runner fetches the feed URL, then hands the raw XML body here
 * along with the feed URL (used for content-addressed id + thread_id).
 */
export interface RssInput {
  /** Raw feed XML as a string. */
  raw: string;
  /** Feed URL (used for content-addressed id + stored in fields.feed_url). */
  feed_url: string;
  /**
   * Feed-level config from the peer registry (metadata.feed_config), threaded
   * through so parse can apply defaults (e.g. default_labels). This is a
   * convenience for callers that already have the config — the explicit
   * `config` argument to `parse()` / `parseMany()` takes precedence.
   */
  feed_config?: RssConfig;
}

/**
 * Per-feed configuration, threaded from the peer registry.
 */
export interface RssConfig {
  /** Labels every item from this feed gets at ingest. Merged into `item.labels`. */
  default_labels?: string[];
  /**
   * Media policy for podcasts. 'refs-only' (default) just stores the
   * enclosure URL. 'fetch-to-r2' is pull-runner territory — the channel
   * ignores it and only emits refs.
   */
  media_policy?: 'refs-only' | 'fetch-to-r2';
}

// ============================================================================
// Channel
// ============================================================================

export class RssChannel implements Channel<RssInput, RssConfig> {
  readonly name = 'rss';
  readonly kind = 'pull' as const;
  readonly source = 'rss/v1';

  /**
   * Single-item contract. Returns the first parseable entry, or null if the
   * feed has no entries. Runners with many-items-per-feed feeds should use
   * `parseMany()` instead.
   */
  async parse(input: RssInput, config?: RssConfig): Promise<ParseResult | null> {
    const all = await this.parseMany(input, config);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Multi-item contract. Returns one ParseResult per feed entry. Malformed
   * entries (no title + no link + no guid) are skipped silently so a single
   * bad entry doesn't tank the whole feed. Malformed XML throws.
   */
  async parseMany(input: RssInput, config?: RssConfig): Promise<ParseResult[]> {
    const effectiveConfig: RssConfig = { ...(input.feed_config ?? {}), ...(config ?? {}) };
    const parsed = await parseFeedXml(input.raw, input.feed_url);

    const feedTitle = parsed.feedTitle;
    const entries = parsed.entries;
    const threadId = 'feed:' + (await sha256Hex(input.feed_url)).slice(0, 16);

    const results: ParseResult[] = [];
    for (const entry of entries) {
      try {
        const item = await mapEntryToItem({
          entry,
          feed_url: input.feed_url,
          feed_title: feedTitle,
          thread_id: threadId,
          config: effectiveConfig,
        });
        if (item) results.push({ item });
      } catch (err) {
        // Single-entry mapping errors: log + skip, don't bubble. This keeps
        // feeds resilient to weird entries (malformed dates, missing fields
        // the mapper expected, etc.) without dropping the good entries.
        // eslint-disable-next-line no-console
        console.warn(
          `[rss channel] skipped malformed entry in ${input.feed_url}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    return results;
  }
}

export const rssChannel: RssChannel = new RssChannel();

// ============================================================================
// Feed parsing
// ============================================================================

interface ParsedFeed {
  format: 'rss2' | 'rss1' | 'atom';
  feedTitle: string | undefined;
  entries: any[];
}

/**
 * Parse XML → a unified entry list. Throws with feed URL context when the
 * XML is malformed or the root element isn't one we recognize.
 */
async function parseFeedXml(raw: string, feedUrl: string): Promise<ParsedFeed> {
  const { XMLParser, XMLValidator } = await loadXmlParser();

  // Validate first — fast-xml-parser is forgiving by default (silently
  // closes unterminated tags), so we use the validator for an explicit
  // malformed-XML signal.
  if (XMLValidator) {
    const validation = XMLValidator.validate(raw);
    if (validation !== true) {
      const msg = validation?.err?.msg ?? 'invalid XML';
      throw new Error(`RSS channel: malformed XML from ${feedUrl}: ${msg}`);
    }
  }

  // parseTagValue: false — keeps text nodes as strings (avoid coercing
  //   "E1", "1.0", "NaN" etc. into numbers / null).
  // parseAttributeValue: false — same reasoning for attributes.
  // ignoreAttributes: false — we need <enclosure url=.../> and Atom <link href=.../>.
  // attributeNamePrefix: '@_' — lets us distinguish attrs from child elements.
  // trimValues: true — strip incidental whitespace in text nodes.
  // processEntities.maxTotalExpansions: fast-xml-parser's anti-"billion
  //   laughs" cap. Default is 1000, which counts every `&amp;` / `&#39;` /
  //   etc — trivially exceeded by a busy podcast feed (anchor.fm, flightcast
  //   both hit this). Real entity bombs use DOCTYPE-defined recursive
  //   entities (which fast-xml-parser disables by default); the only path
  //   that consumes this budget is the 5 standard entities + numeric refs.
  //   B030: dropped from 1M to 50_000 — three orders of magnitude is more
  //   headroom than any legitimate feed needs (the busiest podcast feeds
  //   we've measured land around 8k expansions for a year of episodes).
  //   The lower cap is defense-in-depth: even though DTD recursion is off,
  //   keeping the standard-entity budget bounded narrows the CPU window a
  //   crafted-but-DTD-free feed could chew through.
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    textNodeName: '#text',
    processEntities: { enabled: true, maxTotalExpansions: 50_000 },
  });

  let doc: any;
  try {
    doc = parser.parse(raw);
  } catch (err) {
    throw new Error(
      `RSS channel: failed to parse XML from ${feedUrl}: ${(err as Error)?.message ?? err}`,
    );
  }

  if (doc && doc.rss && doc.rss.channel) {
    const channel = doc.rss.channel;
    const items = toArray(channel.item);
    return {
      format: 'rss2',
      feedTitle: stringifyText(channel.title),
      entries: items,
    };
  }

  // RSS 1.0 (RDF). Structure: <rdf:RDF> with sibling <channel> + <item>
  // elements. Note items are NOT nested under channel; they sit at the same
  // level. fast-xml-parser exposes the root as `doc['rdf:RDF']`.
  const rdfRoot = doc?.['rdf:RDF'] ?? doc?.RDF;
  if (rdfRoot) {
    const channel = rdfRoot.channel;
    const items = toArray(rdfRoot.item);
    return {
      format: 'rss1',
      feedTitle: channel ? stringifyText(channel.title) : undefined,
      entries: items,
    };
  }

  if (doc && doc.feed) {
    const feed = doc.feed;
    const entries = toArray(feed.entry);
    return {
      format: 'atom',
      feedTitle: stringifyText(feed.title),
      entries,
    };
  }

  throw new Error(
    `RSS channel: unrecognized feed format from ${feedUrl} (expected <rss>, <rdf:RDF>, or <feed> root)`,
  );
}

// ============================================================================
// Entry → InboxItem mapping
// ============================================================================

interface MapArgs {
  entry: any;
  feed_url: string;
  feed_title: string | undefined;
  thread_id: string;
  config: RssConfig;
}

async function mapEntryToItem(args: MapArgs): Promise<InboxItem | null> {
  const { entry, feed_url, feed_title, thread_id, config } = args;

  // Extract the canonical identifiers first so we can decide whether to skip.
  const title = stringifyText(entry.title);
  const link = extractLink(entry);
  const guid = stringifyText(entry.guid ?? entry.id) || link || undefined;

  // If all three are missing, we have nothing to dedup on AND nothing to
  // meaningfully display — skip this entry.
  if (!title && !link && !guid) {
    return null;
  }

  const dedupKey = guid ?? link ?? title ?? '';
  const id = (await sha256Hex(feed_url + ':' + dedupKey)).slice(0, 32);

  const summary = title?.trim() || '(no title)';
  const body = selectBody(entry);

  const pubRaw = stringifyText(entry.pubDate ?? entry.published ?? entry.updated ?? entry['dc:date']);
  const sentAt = toIsoDate(pubRaw);

  const authors = extractAuthors(entry);
  const categories = extractCategories(entry);

  const fields: Record<string, any> = {
    feed_url,
    feed_title: feed_title ?? null,
    entry_url: link ?? null,
    entry_guid: guid ?? null,
    authors,
    categories,
    pub_date: pubRaw ?? null,
  };

  // Podcast / enclosure extensions. Many RSS feeds have at most one
  // <enclosure>; we handle the first if there are several.
  const enclosure = firstEnclosure(entry);
  if (enclosure) {
    const url = enclosure['@_url'];
    const type = enclosure['@_type'];
    const length = enclosure['@_length'];
    if (url) fields.audio_url = url;
    if (type) fields.audio_type = type;
    if (length !== undefined && length !== null && length !== '') {
      const n = Number(length);
      if (Number.isFinite(n)) fields.audio_length_bytes = n;
    }

    const duration = stringifyText(entry['itunes:duration']);
    if (duration) {
      const secs = parseItunesDuration(duration);
      if (secs !== undefined) fields.duration_seconds = secs;
    }
    const ep = stringifyText(entry['itunes:episode']);
    if (ep) {
      const n = Number(ep);
      if (Number.isFinite(n)) fields.episode_number = n;
    }
    const season = stringifyText(entry['itunes:season']);
    if (season) {
      const n = Number(season);
      if (Number.isFinite(n)) fields.season = n;
    }
    const explicit = stringifyText(entry['itunes:explicit']);
    if (explicit) {
      const v = explicit.toLowerCase().trim();
      fields.explicit = v === 'true' || v === 'yes';
    }
  }

  const labels = config.default_labels && config.default_labels.length > 0
    ? [...config.default_labels]
    : undefined;

  const item: InboxItem = {
    id,
    source: 'rss/v1',
    source_version: 'rss/v1',
    received_at: new Date().toISOString(),
    sent_at: sentAt,
    summary,
    body,
    thread_id,
    labels,
    fields,
  };

  return item;
}

// ============================================================================
// Field extractors
// ============================================================================

/**
 * Extract the entry link. RSS 2.0 has `<link>url</link>` (plain text). Atom
 * has `<link href="url" rel="alternate"/>` (attribute) and may include
 * multiple <link> elements — prefer rel="alternate" (or the first one
 * without a rel attribute) which is the canonical permalink.
 */
function extractLink(entry: any): string | undefined {
  const raw = entry.link;
  if (raw == null) return undefined;

  // RSS 2.0 — plain text
  if (typeof raw === 'string') return raw.trim() || undefined;

  // Atom — object with @_href, or array of them
  if (Array.isArray(raw)) {
    // Prefer rel="alternate" or no rel (= alternate is the default)
    for (const link of raw) {
      const rel = link?.['@_rel'];
      if (!rel || rel === 'alternate') {
        const href = link?.['@_href'];
        if (href) return String(href);
      }
    }
    // Fall back to first href we can find
    for (const link of raw) {
      const href = link?.['@_href'];
      if (href) return String(href);
    }
    return undefined;
  }

  if (typeof raw === 'object') {
    const href = raw['@_href'];
    if (href) return String(href);
    const text = raw['#text'];
    if (text) return String(text);
  }

  return undefined;
}

/**
 * Body selection, first non-empty wins:
 *   content:encoded > content > description > summary
 *
 * Content is returned as-is (possibly HTML). We don't strip it — collections
 * does that if needed.
 */
function selectBody(entry: any): string | null {
  const candidates = [
    entry['content:encoded'],
    entry.content,
    entry.description,
    entry.summary,
  ];
  for (const c of candidates) {
    const s = stringifyText(c);
    if (s && s.length > 0) return s;
  }
  return null;
}

/**
 * Normalize authors into string[] from:
 *   - RSS <author>email@domain (Name)</author>
 *   - RSS <dc:creator>Name</dc:creator>
 *   - Atom <author><name>Name</name><email>...</email></author>
 *   - Atom <contributor><name>...</name></contributor>
 *   - Multiple of any of the above (fast-xml-parser produces an array).
 */
function extractAuthors(entry: any): string[] {
  const out: string[] = [];
  const push = (val: unknown) => {
    const s = normalizeAuthor(val);
    if (s) out.push(s);
  };

  for (const key of ['author', 'dc:creator', 'contributor']) {
    const raw = entry[key];
    if (raw == null) continue;
    if (Array.isArray(raw)) {
      for (const v of raw) push(v);
    } else {
      push(raw);
    }
  }
  // Dedup in insertion order
  return Array.from(new Set(out));
}

function normalizeAuthor(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // RSS convention: "email@domain (Display Name)" — prefer the name in parens
    const m = trimmed.match(/^\s*[^\s<@]+@[^\s()]+\s*\(([^)]+)\)\s*$/);
    if (m) return m[1].trim();
    return trimmed;
  }
  if (typeof val === 'object') {
    const obj = val as any;
    // Atom — prefer <name>, fall back to <email>, then any #text
    const name = stringifyText(obj.name);
    if (name) return name;
    const email = stringifyText(obj.email);
    if (email) return email;
    const text = stringifyText(obj['#text']);
    if (text) return text;
  }
  return null;
}

/**
 * Normalize categories into string[] from:
 *   - RSS <category>text</category>             → "text"
 *   - Atom <category term="x" label="X"/>       → "x" (prefer term, then label)
 *   - Multiple in either shape (array).
 */
function extractCategories(entry: any): string[] {
  const raw = entry.category ?? entry.categories;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const c of list) {
    if (c == null) continue;
    if (typeof c === 'string') {
      const t = c.trim();
      if (t) out.push(t);
      continue;
    }
    if (typeof c === 'object') {
      const term = c['@_term'];
      if (term) {
        out.push(String(term));
        continue;
      }
      const label = c['@_label'];
      if (label) {
        out.push(String(label));
        continue;
      }
      const text = stringifyText(c['#text']);
      if (text) out.push(text);
    }
  }
  return Array.from(new Set(out));
}

/**
 * Grab the first enclosure element. If multiple enclosures exist (rare,
 * mostly audio/video duals) we ignore siblings — one audio file per episode
 * is the overwhelming common case.
 */
function firstEnclosure(entry: any): any {
  const raw = entry.enclosure;
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

/**
 * iTunes durations come in three shapes: "HH:MM:SS", "MM:SS", or a bare
 * integer in seconds. Returns seconds (number) or undefined on parse fail.
 */
function parseItunesDuration(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  // Bare integer — treat as seconds
  if (/^\d+$/.test(s)) return Number(s);
  // Colon-delimited
  const parts = s.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return undefined;
}

// ============================================================================
// Tiny helpers
// ============================================================================

/** Normalize one-or-many → always an array. */
function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Flatten a fast-xml-parser value to a plain string. Handles:
 *   - plain strings (returned as-is)
 *   - numbers / booleans (coerced via String)
 *   - objects with a `#text` key (returned as that text; attrs ignored)
 *   - null / undefined (returned as undefined)
 *   - arrays (first string-ifiable element wins — rare on leaf fields)
 */
function stringifyText(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    for (const v of val) {
      const s = stringifyText(v);
      if (s) return s;
    }
    return undefined;
  }
  if (typeof val === 'object') {
    const text = (val as any)['#text'];
    if (text != null) {
      if (typeof text === 'string') return text;
      return String(text);
    }
  }
  return undefined;
}

/** Convert an arbitrary date string to ISO-8601, or return undefined. */
function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** sha256 → lowercase hex. Used by content-addressed id + thread_id. */
async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
