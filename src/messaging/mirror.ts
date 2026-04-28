/**
 * Cron-driven markdown mirror — Phase 2b of the notes-todos brief.
 *
 * Iterates peers with `metadata.mirror_config` and pushes per-newsletter
 * markdown files (rendered via the Phase 2a renderers) to the peer's
 * destination via PUT. Smallstore stays the source of truth; the mirror
 * is one-way, idempotent (re-rendering the same markdown is a no-op
 * write at the destination).
 *
 * Per-slug failures log + skip; one bad slug does NOT tank the whole
 * mirror run. Per-peer failures (auth missing, inbox not registered)
 * skip the peer with a reason but proceed to other peers.
 *
 * Auth comes from the existing peer-registry pattern — `peer.auth` +
 * `resolvePeerAuth(peer, env)` resolves the bearer/header token from a
 * named env var (e.g. `TF_TOKEN` for tigerflare). No mirror-side secret
 * handling. Disable a mirror by disabling the peer; retarget by editing
 * the peer's `metadata.mirror_config`. All runtime ops, no redeploy.
 *
 * Triggered:
 *   - From `scheduled()` cron (every 30 min in deploy/wrangler.toml).
 *   - From the admin route `POST /admin/inboxes/:name/mirror` for
 *     on-demand verification or after a real-time annotation that
 *     shouldn't wait for the next cron tick.
 */

import type { Peer, PeerStore } from '../peers/types.ts';
import { resolvePeerAuth } from '../peers/proxy.ts';
import type { Inbox, InboxItem, InboxItemFull } from './types.ts';
import type { InboxRegistry } from './registry.ts';
import {
  renderNewsletterIndex,
  renderNewsletterProfile,
  renderRecentFeed,
  type NewsletterIndexEntry,
  type NewsletterProfile,
} from './newsletter-markdown.ts';

/**
 * Per-peer mirror config carried under `peer.metadata.mirror_config`.
 * Edited at runtime via `PUT /peers/:name`; no schema migration needed.
 */
export interface MirrorConfig {
  /** Inbox name to source content from (must be in the registry). */
  source_inbox: string;
  /**
   * Path prefix on the peer's URL where files land.
   * Default: `/<peer.name>/` (each peer gets a folder named after itself).
   * Trailing slash is added automatically if missing.
   */
  target_path_prefix?: string;
  /** When true, also emit `index.md` listing every newsletter. */
  include_index?: boolean;
  /**
   * Optional origin override for "View item →" links inside the
   * markdown. Default: empty string (links omitted). Pass the smallstore
   * Worker's public URL to make the mirrored markdown self-link back.
   */
  link_origin?: string;
  /**
   * When true, after pushing per-newsletter pages, list the destination
   * directory and DELETE any `*.md` files that no longer correspond to
   * an active slug (orphans from items deleted in smallstore). Skips
   * `index.md` and `recent.md`. Default: `true` — without this, deleting
   * a newsletter's last item leaves a stale `.md` lingering on the peer
   * until manually cleaned up. Disable to opt out (e.g. when sharing a
   * directory with non-mirror content).
   */
  prune_orphans?: boolean;
  /**
   * When true, also emit `recent.md` — a cross-publisher reading list
   * of items from the last `recent_window_days` days, newest-first,
   * body-inlined. Default: `true`. Disable per-peer to skip.
   */
  include_recent?: boolean;
  /**
   * Days back to include in `recent.md`. Default `7`. Items older than
   * this are excluded; items with no usable date are excluded entirely.
   */
  recent_window_days?: number;
}

/**
 * Sentinel peer name used in the single-element result array returned when
 * a `runMirror()` invocation is short-circuited because another invocation
 * is already in flight (B019). Callers that want to distinguish "this run
 * did nothing because someone else is doing it" from "this run found no
 * peers" can match on `peer_name === MIRROR_INFLIGHT_SENTINEL`.
 */
export const MIRROR_INFLIGHT_SENTINEL = '__mirror_inflight__';

/** Per-peer summary returned from `runMirror`. */
export interface MirrorRunResult {
  peer_name: string;
  /**
   * When set, the peer (or the entire run, for the `__mirror_inflight__`
   * sentinel) was skipped before any pushes. Known values:
   *   - `inbox "<name>" not registered` — registry miss
   *   - `<env-var>` (from `resolvePeerAuth`) — auth env missing
   *   - `'in-flight'` — another `runMirror()` invocation is already running
   *     in this isolate; the second caller short-circuits to avoid two
   *     concurrent rounds of PUTs racing on the peer.
   */
  skipped?: string;
  /** Files successfully pushed. */
  pushed: number;
  /** Per-slug failures (other slugs still attempted). */
  failed: Array<{ slug: string; error: string }>;
  /**
   * Orphan files deleted from the peer when `prune_orphans` is enabled —
   * `.md` files that existed at the destination but no longer correspond
   * to an active slug in the source inbox. Set only when prune ran
   * (omitted entirely otherwise so you can tell "didn't run" from "ran
   * and found nothing to prune").
   */
  pruned?: string[];
  /** Set when prune ran but the listing call failed; filled with the error. */
  prune_error?: string;
}

export interface RunMirrorOptions {
  registry: InboxRegistry;
  peerStore: PeerStore;
  env: Record<string, string | undefined>;
  /** Optional: filter to a specific peer name (default: all matching peers). */
  peer_name?: string;
  /** Optional fetch override for tests. */
  fetcher?: typeof fetch;
  /**
   * Test-only overrides for the `recent.md` size caps (B022). Production
   * never sets these — the defaults (200 items, 10 MB) are tuned for CF's
   * 30 MB response cap. Tests use small values to exercise the trim
   * mechanism without seeding millions of items.
   * @internal
   */
  _recent_caps?: { itemCap?: number; byteCap?: number };
}

/**
 * In-process mutex for `runMirror()` (B019).
 *
 * Cron fires `runMirror()` every 30 min while `POST /admin/inboxes/:name/mirror`
 * calls the same function on demand. Two simultaneous runs both PUT
 * `${prefix}slug.md` (and `recent.md`, where note ordering / window
 * computation can diverge) → last-write-wins on the peer with the loser
 * silently overwritten.
 *
 * `runMirror()` enumerates ALL peers regardless of caller (the optional
 * `peer_name` filter is post-enumeration), so two concurrent invocations
 * always do overlapping work. We therefore use a SINGLE GLOBAL key — not
 * one-per-peer or one-per-source-inbox. The first caller acquires the
 * mutex and runs to completion; the second caller sees `inFlight !== null`
 * and short-circuits with a sentinel `MirrorRunResult[]` carrying
 * `skipped: 'in-flight'`. The mutex is released in a `finally` so a thrown
 * implementation error doesn't wedge the lock.
 *
 * (B020 follow-on: prune is the last block of `runMirrorImpl`, so the
 * single mutex also gates prune against PUTs from a sibling call.)
 */
const inFlightMirror = new Map<string, Promise<MirrorRunResult[]>>();
const MIRROR_LOCK_KEY = '__mirror__';

/**
 * Run the mirror over every peer with a `metadata.mirror_config` (or just
 * one peer when `peer_name` is set). Returns one result per attempted
 * peer; never throws on per-slug or per-peer failures.
 *
 * Mutex'd against itself (B019): a second concurrent invocation does NOT
 * await the first's completion — it returns a single
 * `{ peer_name: MIRROR_INFLIGHT_SENTINEL, skipped: 'in-flight', pushed: 0, failed: [] }`
 * result so the caller can log+move on without queuing another round.
 */
export async function runMirror(opts: RunMirrorOptions): Promise<MirrorRunResult[]> {
  const existing = inFlightMirror.get(MIRROR_LOCK_KEY);
  if (existing) {
    return [{
      peer_name: MIRROR_INFLIGHT_SENTINEL,
      skipped: 'in-flight',
      pushed: 0,
      failed: [],
    }];
  }
  const promise = runMirrorImpl(opts).finally(() => {
    inFlightMirror.delete(MIRROR_LOCK_KEY);
  });
  inFlightMirror.set(MIRROR_LOCK_KEY, promise);
  return await promise;
}

async function runMirrorImpl(opts: RunMirrorOptions): Promise<MirrorRunResult[]> {
  const fetcher = opts.fetcher ?? fetch;
  const results: MirrorRunResult[] = [];

  // Find peers to mirror: not disabled + carry mirror_config + (optionally)
  // match the requested name.
  const allPeers = await opts.peerStore.list({});
  const candidates = allPeers.peers.filter((p) => {
    if (p.disabled) return false;
    if (opts.peer_name && p.name !== opts.peer_name) return false;
    const cfg = (p.metadata as { mirror_config?: unknown } | null | undefined)?.mirror_config;
    return cfg !== null && typeof cfg === 'object' && cfg !== undefined &&
      typeof (cfg as MirrorConfig).source_inbox === 'string';
  });

  for (const peer of candidates) {
    const config = (peer.metadata as { mirror_config: MirrorConfig }).mirror_config;
    const result: MirrorRunResult = { peer_name: peer.name, pushed: 0, failed: [] };

    const inbox = opts.registry.get(config.source_inbox);
    if (!inbox) {
      result.skipped = `inbox "${config.source_inbox}" not registered`;
      results.push(result);
      continue;
    }

    const auth = resolvePeerAuth(peer, opts.env);
    if (auth.error) {
      result.skipped = auth.error;
      results.push(result);
      continue;
    }

    const prefix = normalizePrefix(config.target_path_prefix ?? `/${peer.name}/`);
    const linkOrigin = config.link_origin ?? '';

    // Aggregate newsletters from the inbox — same shape as the JSON
    // `/inbox/:name/newsletters[/:slug]` routes do, kept inline here so
    // mirror has no surprise behavior drift if the route logic changes.
    const queryRes = await inbox.query(
      { fields_regex: { newsletter_slug: '.+' } },
      { limit: 10_000 },
    );
    const groups = groupBySlug(queryRes.items);

    // Optional index page.
    if (config.include_index) {
      const indexEntries: NewsletterIndexEntry[] = [...groups.entries()]
        .map(([slug, items]) => buildIndexEntry(slug, items))
        .sort((a, b) => (b.latest_at ?? '').localeCompare(a.latest_at ?? ''));
      try {
        await pushFile(
          peer,
          auth.headers,
          fetcher,
          `${prefix}index.md`,
          renderNewsletterIndex(config.source_inbox, indexEntries),
        );
        result.pushed++;
      } catch (e) {
        result.failed.push({ slug: '__index__', error: errorMessage(e) });
      }
    }

    // Per-newsletter pages.
    const activeFilenames = new Set<string>();
    const allHydrated: InboxItemFull[] = [];
    for (const [slug, items] of groups) {
      try {
        // Hydrate bodies so the rendered markdown is self-contained
        // reading material — the "View item →" link below requires the
        // bearer token, which a user opening the .md in Finder/Obsidian
        // doesn't have. O(N) R2 reads per slug; on the worst-case
        // newsletter (10k+ items) the previous `Promise.all(items.map(...))`
        // spawned all reads concurrently and could starve the request
        // budget / spike memory (B021). Cap at 10 in-flight per slug via
        // a chunked-await pattern — chunk → await → next chunk. On read
        // failure we keep the slim item; the renderer falls back to
        // "(no note)" gracefully.
        const fullItems: InboxItemFull[] = await mapWithConcurrency(
          items,
          MIRROR_HYDRATE_CONCURRENCY,
          async (item) => {
            try {
              const full = await inbox.read(item.id, { full: true });
              return full ?? (item as InboxItemFull);
            } catch {
              return item as InboxItemFull;
            }
          },
        );
        const profile = buildProfile(slug, fullItems);
        const md = renderNewsletterProfile(config.source_inbox, slug, profile, fullItems, linkOrigin);
        await pushFile(peer, auth.headers, fetcher, `${prefix}${slug}.md`, md);
        result.pushed++;
        activeFilenames.add(`${slug}.md`);
        allHydrated.push(...fullItems);
      } catch (e) {
        result.failed.push({ slug, error: errorMessage(e) });
      }
    }

    // Cross-publisher reading list — `recent.md`. Reuses the bodies
    // already hydrated above so we don't double-fetch from R2.
    //
    // B022: rendered output is bounded by item count (RECENT_ITEM_CAP)
    // AND aggregated body bytes (RECENT_BYTE_CAP). With a 365-day window
    // across 50k inbox items the unbounded version blows past CF's 30 MB
    // response cap. We pre-trim by date (newest first), then by item
    // count, render, and if the resulting markdown is over the byte cap
    // we trim further and re-render. Items beyond either cap are
    // dropped with a console.log noting the omission count.
    if (config.include_recent !== false) {
      const windowDays = typeof config.recent_window_days === 'number' && config.recent_window_days > 0
        ? config.recent_window_days
        : 7;
      const itemCap = opts._recent_caps?.itemCap ?? RECENT_ITEM_CAP;
      const byteCap = opts._recent_caps?.byteCap ?? RECENT_BYTE_CAP;
      try {
        const { capped, omittedCount: itemOmits } = capRecentItems(allHydrated, itemCap);
        let recentMd = renderRecentFeed(config.source_inbox, capped, linkOrigin, windowDays);
        let byteOmits = 0;
        // Byte trim — binary search-ish but simple: halve the slice until
        // it fits. Items in `capped` are sorted newest-first so trimming
        // from the tail keeps the most-recent items.
        let trimmed = capped;
        while (utf8ByteLength(recentMd) > byteCap && trimmed.length > 1) {
          const newLen = Math.max(1, Math.floor(trimmed.length / 2));
          byteOmits += trimmed.length - newLen;
          trimmed = trimmed.slice(0, newLen);
          recentMd = renderRecentFeed(config.source_inbox, trimmed, linkOrigin, windowDays);
        }
        if (itemOmits > 0 || byteOmits > 0) {
          console.log(
            `[mirror] recent.md trimmed for peer=${peer.name}: ` +
              `item-cap omitted ${itemOmits}, byte-cap omitted ${byteOmits}`,
          );
        }
        await pushFile(peer, auth.headers, fetcher, `${prefix}recent.md`, recentMd);
        result.pushed++;
        activeFilenames.add('recent.md');
      } catch (e) {
        result.failed.push({ slug: '__recent__', error: errorMessage(e) });
      }
    }

    // Garbage-collect orphan .md files. Without this, deleting a
    // newsletter's last item leaves a stale file on the peer until
    // manual cleanup. We list the destination prefix, diff against the
    // active set (plus index.md), and DELETE the orphans. Tigerflare
    // returns a JSON array of `{ name, path, isDirectory }` from
    // `GET <prefix>` — caller is responsible for dir-trailing-slash.
    const prune = config.prune_orphans !== false;
    if (prune) {
      result.pruned = [];
      try {
        const listing = await listDirectory(peer, auth.headers, fetcher, prefix);
        if (config.include_index) activeFilenames.add('index.md');
        const orphans = listing
          .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
          .filter((entry) => !activeFilenames.has(entry.name));
        for (const orphan of orphans) {
          try {
            await deleteFile(peer, auth.headers, fetcher, orphan.path);
            result.pruned.push(orphan.name);
          } catch (e) {
            result.failed.push({ slug: `__prune:${orphan.name}`, error: errorMessage(e) });
          }
        }
      } catch (e) {
        result.prune_error = errorMessage(e);
      }
    }

    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------
// Bounded-concurrency + size caps (B021, B022)
// ---------------------------------------------------------------------

/**
 * Maximum in-flight `inbox.read({ full: true })` calls per slug during
 * mirror hydration (B021). Keeps a 10k-item newsletter from spawning 10k
 * concurrent R2 GETs. 10 is a conservative middle ground between
 * throughput and CF subrequest budget pressure.
 */
const MIRROR_HYDRATE_CONCURRENCY = 10;

/**
 * Hard cap on items rendered into `recent.md` (B022). With a 365-day
 * window across 50k inbox items, an unbounded render blows past CF's
 * 30 MB response cap before the byte cap below would catch it. 200 is
 * roughly two months of daily-ish newsletter sends across 5–10
 * publishers — plenty for a "recent reading" view.
 */
const RECENT_ITEM_CAP = 200;

/**
 * Hard cap on `recent.md` rendered byte size (B022). 10 MB leaves
 * generous headroom under CF's 30 MB response cap and matches the
 * order-of-magnitude that markdown viewers / git hosts handle well.
 * Above this we halve the item slice and re-render until we fit.
 */
const RECENT_BYTE_CAP = 10 * 1024 * 1024;

/**
 * Resolve `mapper` over `items` with at most `limit` in-flight at once.
 * Implementation is a simple chunked-await: split into chunks of `limit`,
 * `Promise.all` each chunk, append. Order of results matches input order.
 * Avoids a third-party concurrency-limiter dep — simpler and adequate at
 * this scale.
 */
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const resolved = await Promise.all(chunk.map((item) => mapper(item)));
    out.push(...resolved);
  }
  return out;
}

/**
 * Pre-trim items destined for `recent.md` by item count (B022). Sorts
 * newest-first by `original_sent_at` (with `sent_at` fallback) so the
 * trim keeps the most-recent items, drops the rest, and reports how
 * many were omitted. Items with no resolvable date are excluded too —
 * `renderRecentFeed` filters them later anyway, but trimming here
 * gives a tighter omit count.
 */
function capRecentItems(
  items: ReadonlyArray<InboxItemFull>,
  itemCap: number = RECENT_ITEM_CAP,
): { capped: InboxItemFull[]; omittedCount: number } {
  const dated: Array<{ item: InboxItemFull; dt: string }> = [];
  for (const item of items) {
    const dt = (item.fields?.original_sent_at as string | undefined) ??
      (typeof item.sent_at === 'string' ? item.sent_at : undefined);
    if (typeof dt === 'string' && dt.length > 0) {
      dated.push({ item, dt });
    }
  }
  dated.sort((a, b) => b.dt.localeCompare(a.dt));
  if (dated.length <= itemCap) {
    return { capped: dated.map((d) => d.item), omittedCount: 0 };
  }
  return {
    capped: dated.slice(0, itemCap).map((d) => d.item),
    omittedCount: dated.length - itemCap,
  };
}

/** UTF-8 byte length of a string — used to enforce `recent.md`'s byte cap. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * PUT a single file to the peer. Smallstore-side mirror always uses PUT
 * (idempotent — same path overwrites). Caller is responsible for the
 * URL path; this helper just resolves it against `peer.url`.
 */
async function pushFile(
  peer: Peer,
  authHeaders: Record<string, string>,
  fetcher: typeof fetch,
  path: string,
  content: string,
): Promise<void> {
  const url = new URL(path, peer.url).toString();
  const res = await fetcher(url, {
    method: 'PUT',
    headers: {
      ...authHeaders,
      'Content-Type': 'text/markdown; charset=utf-8',
    },
    body: content,
  });
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status} ${res.statusText}`);
  }
}

/** Directory entry shape returned by tigerflare's `GET <prefix>/`. */
interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * GET a directory listing from the peer at `prefix` (must end with `/`).
 * Returns an array of `{ name, path, isDirectory }` — the shape
 * tigerflare emits. A 404 means the directory doesn't exist yet (e.g.,
 * first mirror run with no prior pushes), which we treat as an empty
 * listing — nothing to prune.
 */
async function listDirectory(
  peer: Peer,
  authHeaders: Record<string, string>,
  fetcher: typeof fetch,
  prefix: string,
): Promise<DirEntry[]> {
  const url = new URL(prefix, peer.url).toString();
  const res = await fetcher(url, {
    method: 'GET',
    headers: { ...authHeaders, Accept: 'application/json' },
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GET ${prefix} → ${res.status} ${res.statusText}`);
  }
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new Error(`GET ${prefix} → expected JSON array, got ${typeof body}`);
  }
  return body as DirEntry[];
}

/** DELETE a single file from the peer. Caller passes the absolute path. */
async function deleteFile(
  peer: Peer,
  authHeaders: Record<string, string>,
  fetcher: typeof fetch,
  path: string,
): Promise<void> {
  const url = new URL(path, peer.url).toString();
  const res = await fetcher(url, { method: 'DELETE', headers: authHeaders });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE ${path} → ${res.status} ${res.statusText}`);
  }
}

function normalizePrefix(prefix: string): string {
  let out = prefix.startsWith('/') ? prefix : `/${prefix}`;
  if (!out.endsWith('/')) out += '/';
  return out;
}

function groupBySlug(items: ReadonlyArray<InboxItem>): Map<string, InboxItem[]> {
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) {
    const slug = (item.fields?.newsletter_slug as string | undefined) ?? '';
    if (!slug) continue;
    const arr = groups.get(slug) ?? [];
    arr.push(item);
    groups.set(slug, arr);
  }
  return groups;
}

function buildIndexEntry(slug: string, items: ReadonlyArray<InboxItem>): NewsletterIndexEntry {
  let latest: string | undefined;
  let display: string | undefined;
  for (const item of items) {
    const at = (item.fields?.original_sent_at as string | undefined) ?? item.received_at;
    if (!latest || at > latest) {
      latest = at;
      const addr = item.fields?.original_from_addr as string | undefined;
      if (addr) display = stripAngle(addr);
    }
  }
  return { slug, count: items.length, latest_at: latest, display };
}

function buildProfile(slug: string, items: ReadonlyArray<InboxItem>): NewsletterProfile {
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let display: string | undefined;
  let notesCount = 0;
  let totalNoteChars = 0;
  for (const item of items) {
    const at = (item.fields?.original_sent_at as string | undefined) ?? item.received_at;
    if (!firstAt || at < firstAt) firstAt = at;
    if (!lastAt || at > lastAt) {
      lastAt = at;
      const addr = item.fields?.original_from_addr as string | undefined;
      if (addr) display = stripAngle(addr);
    }
    const note = item.fields?.forward_note as string | undefined;
    if (typeof note === 'string' && note.trim().length > 0) {
      notesCount++;
      totalNoteChars += note.length;
    }
  }
  return {
    slug,
    display,
    count: items.length,
    first_seen_at: firstAt,
    last_seen_at: lastAt,
    notes_count: notesCount,
    total_note_chars: totalNoteChars,
    avg_note_chars: notesCount > 0 ? Math.round(totalNoteChars / notesCount) : 0,
  };
}

function stripAngle(raw: string): string {
  const lt = raw.indexOf('<');
  return lt === -1 ? raw.trim() : raw.slice(0, lt).trim().replace(/^["']|["']$/g, '');
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
