/**
 * RSS pull-runner — the in-Worker polling loop.
 *
 * Iterates every peer registered with `type: 'rss'`, fetches each feed URL,
 * parses the XML through `rssChannel.parseMany`, and dispatches each parsed
 * item into the target inbox via the shared dispatcher (so rules, hooks,
 * and sinks all fire the same way they do for email).
 *
 * Invoked from the Worker's `scheduled()` handler on whatever cron trigger
 * `wrangler.toml` declares. Never throws — per-feed failures are captured
 * in the returned summary so one bad feed can't kill the run.
 *
 * Division of labor (see `.brief/rss-as-mailbox.md`):
 *   - smallstore: funnel + store. Faithful XML → InboxItem mapping, dedup,
 *     persistence. No enrichment. No abstract-fetching. No HTML cleanup.
 *   - collections / valtown: enrichment. Re-reads items, fetches full text,
 *     resolves DOIs, downloads enclosures, etc. Writes back via the API.
 *
 * Peer shape (from the registry):
 *
 * ```json
 * {
 *   "name": "biorxiv-neuroscience",
 *   "type": "rss",
 *   "url": "https://connect.biorxiv.org/biorxiv_xml.php?subject=neuroscience",
 *   "metadata": {
 *     "feed_config": {
 *       "target_inbox": "biorxiv",
 *       "schedule": "hourly",
 *       "default_labels": ["biorxiv", "neuroscience"],
 *       "media_policy": "refs-only"
 *     }
 *   }
 * }
 * ```
 *
 * `target_inbox` is required — feeds without it are skipped (logged).
 * `schedule` is informational in the MVP — the Worker cron runs at a single
 * interval defined in wrangler.toml; per-feed rate limiting is a level-3
 * concern.
 */

import { rssChannel, type RssConfig } from './channels/rss.ts';
import { dispatchItem } from './dispatch.ts';
import type { InboxRegistry } from './registry.ts';
import type { Peer, PeerStore } from '../peers/types.ts';
import { resolvePeerAuth } from '../peers/proxy.ts';

// ============================================================================
// Types
// ============================================================================

export interface CreatePullRunnerOptions {
  /** The peer store — source of `type: 'rss'` registrations. */
  peerStore: PeerStore;
  /** The inbox registry — destination lookup via `target_inbox`. */
  registry: InboxRegistry;
  /**
   * Env bag for resolving peer auth secrets. Usually the Worker's
   * `env` cast to `Record<string, string | undefined>`.
   */
  env: Record<string, string | undefined>;
  /**
   * Per-feed fetch timeout. Default 15s — longer than the proxy default
   * because some RSS feeds are slow and we'd rather wait than drop.
   */
  fetchTimeoutMs?: number;
  /**
   * Max feeds polled per run. Caps concurrent fan-out. Default 200 —
   * far more than any reasonable deployment actually registers.
   */
  maxFeeds?: number;
  /**
   * Run the classifier stage during dispatch. Default `false` for RSS —
   * classifier labels are email-specific (newsletter/bulk/auto-reply/bounce)
   * and would no-op on feed items anyway. Exposed for symmetry.
   */
  classify?: boolean;
  /** Optional structured logger. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface FeedResult {
  /** Peer name (slug). */
  peer: string;
  /** Feed URL that was fetched. */
  url: string;
  /** Target inbox the items were dispatched to. */
  target_inbox?: string;
  /** HTTP status of the fetch; 0 if never dispatched. */
  status: number;
  /** Number of items emitted by the channel parser. */
  items_parsed: number;
  /** Number of items whose dispatch reported a stored sink. */
  items_stored: number;
  /** Number of items that a hook dropped. */
  items_dropped: number;
  /**
   * B031: number of items that hit a dedup-collision in storage — same
   * id as a previously-stored item, so the sink returned the existing
   * item unchanged. Distinct from `items_dropped` (which counts hook
   * rejections). High counts here usually mean two distinct feed entries
   * collapse to the same content-addressed id (e.g. both lack guid +
   * link + title, or share a duplicated guid) — a feed-quality signal.
   */
  items_collided: number;
  /** Number of items that hit an error mid-dispatch. */
  items_errored: number;
  /** Milliseconds: fetch + parse + dispatch. */
  duration_ms: number;
  /** Per-feed error message (fetch failure, missing target_inbox, parse throw). */
  error?: string;
}

export interface PullRunSummary {
  /** ISO timestamp when the run started. */
  started_at: string;
  /** ISO timestamp when the run finished. */
  ended_at: string;
  /** Wall-clock duration for the whole run. */
  duration_ms: number;
  /** Number of rss peers considered. */
  feeds_seen: number;
  /** Number of feeds whose items were actually dispatched (target_inbox present, parse succeeded). */
  feeds_polled: number;
  /** Number of feeds that hit an error (fetch / parse / missing inbox). */
  feeds_errored: number;
  /** Total items stored across all feeds. */
  items_stored: number;
  /** Total items dropped by hooks across all feeds. */
  items_dropped: number;
  /** B031: total items that hit dedup-collisions across all feeds. */
  items_collided: number;
  /** Per-feed outcomes, same order as the peer iteration. */
  feeds: FeedResult[];
}

export interface PullRunner {
  /** Poll every registered rss peer once and return a summary. */
  pollAll(): Promise<PullRunSummary>;
  /**
   * Poll a single rss peer by name. Returns null when the peer doesn't exist
   * or isn't `type: 'rss'`. Useful for the manual `POST /admin/rss/poll` trigger.
   */
  pollOne(peerName: string): Promise<FeedResult | null>;
}

// ============================================================================
// Factory
// ============================================================================

export function createRssPullRunner(opts: CreatePullRunnerOptions): PullRunner {
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 15_000;
  const maxFeeds = opts.maxFeeds ?? 200;
  const shouldClassify = opts.classify === true;
  const log = opts.log ?? ((m, extra) => console.log(`[rss-runner] ${m}`, JSON.stringify(extra ?? {})));

  async function listRssPeers(): Promise<Peer[]> {
    const peers: Peer[] = [];
    let cursor: string | undefined = undefined;
    // Page through the peer store. Most deployments will have < 20 feeds,
    // but this keeps us honest for larger sets.
    while (peers.length < maxFeeds) {
      const page = await opts.peerStore.list({
        type: 'rss',
        include_disabled: false,
        cursor,
        limit: 100,
      });
      peers.push(...page.peers);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    if (peers.length > maxFeeds) peers.length = maxFeeds;
    return peers;
  }

  async function pollOne(peerName: string): Promise<FeedResult | null> {
    const peer = await opts.peerStore.get(peerName);
    if (!peer || peer.type !== 'rss') return null;
    return await pollPeer(peer);
  }

  async function pollPeer(peer: Peer): Promise<FeedResult> {
    const started = Date.now();
    const result: FeedResult = {
      peer: peer.name,
      url: peer.url,
      status: 0,
      items_parsed: 0,
      items_stored: 0,
      items_dropped: 0,
      items_collided: 0,
      items_errored: 0,
      duration_ms: 0,
    };

    const feedConfig = extractFeedConfig(peer);
    result.target_inbox = feedConfig.target_inbox;

    if (!feedConfig.target_inbox) {
      result.error = 'missing metadata.feed_config.target_inbox';
      result.duration_ms = Date.now() - started;
      log('skip (no target_inbox)', { peer: peer.name, url: peer.url });
      return result;
    }

    const reg = opts.registry.getRegistration(feedConfig.target_inbox);
    if (!reg) {
      result.error = `target_inbox "${feedConfig.target_inbox}" not registered`;
      result.duration_ms = Date.now() - started;
      log('skip (inbox not registered)', {
        peer: peer.name,
        target_inbox: feedConfig.target_inbox,
      });
      return result;
    }

    // Fetch the feed. Apply peer auth + static headers the same way the proxy
    // helpers do, but without client-header forwarding (there's no HTTP client
    // to forward from inside a cron).
    let xml: string;
    try {
      const fetched = await fetchFeed(peer, opts.env, fetchTimeoutMs);
      result.status = fetched.status;
      if (!fetched.ok) {
        result.error = fetched.error ?? `http ${fetched.status}`;
        result.duration_ms = Date.now() - started;
        log('fetch failed', { peer: peer.name, status: fetched.status, error: result.error });
        return result;
      }
      xml = fetched.body;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.duration_ms = Date.now() - started;
      log('fetch threw', { peer: peer.name, error: result.error });
      return result;
    }

    // Parse. Channel swallows per-entry errors; a malformed feed as a whole
    // throws, which we surface on the feed's FeedResult.
    let parsed: Awaited<ReturnType<typeof rssChannel.parseMany>>;
    try {
      parsed = await rssChannel.parseMany({
        raw: xml,
        feed_url: peer.url,
        feed_config: feedConfig.rssConfig,
      });
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.duration_ms = Date.now() - started;
      log('parse failed', { peer: peer.name, error: result.error });
      return result;
    }

    result.items_parsed = parsed.length;

    // Dispatch each parsed item through the target registration. Per-item
    // errors are captured; sink failures count as items_errored but don't
    // stop subsequent items.
    const regName = feedConfig.target_inbox;
    for (const p of parsed) {
      try {
        const d = await dispatchItem(reg, regName, p.item, {
          channel: 'rss',
          blobs: p.blobs,
          classify: shouldClassify,
          log: (m, extra) => log(m, { ...(extra ?? {}), peer: peer.name }),
        });
        if (d.dropped) {
          result.items_dropped++;
        } else if (d.results.some((r) => r.stored)) {
          // B031: a dedup-collision still reports `stored: true` on the
          // sink (the item exists in storage), but the sink also flags
          // `deduplicated: true` so we count it separately. If ANY sink
          // saw a collision we treat the parse as a collision rather
          // than a fresh store — matches how operators read these counters
          // (new-this-poll vs already-known).
          if (d.results.some((r) => r.deduplicated)) {
            result.items_collided++;
          } else {
            result.items_stored++;
          }
        } else {
          // All sinks failed or returned stored=false.
          result.items_errored++;
        }
      } catch (err) {
        result.items_errored++;
        log('dispatch threw', {
          peer: peer.name,
          item_id: p.item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.duration_ms = Date.now() - started;
    log('feed polled', {
      peer: peer.name,
      target_inbox: feedConfig.target_inbox,
      parsed: result.items_parsed,
      stored: result.items_stored,
      dropped: result.items_dropped,
      collided: result.items_collided,
      errored: result.items_errored,
      duration_ms: result.duration_ms,
    });
    return result;
  }

  async function pollAll(): Promise<PullRunSummary> {
    const startedAt = new Date();
    const peers = await listRssPeers();
    const feeds: FeedResult[] = [];

    // Sequential per-feed for the MVP — CF Workers allow parallel fetches
    // but we don't want to hammer many tiny publishers from one IP. Most
    // deployments have < 50 feeds, and per-feed latency is typically 1-5s,
    // so a full run completes well within the scheduled-worker CPU budget.
    for (const peer of peers) {
      try {
        feeds.push(await pollPeer(peer));
      } catch (err) {
        // pollPeer is supposed to be throw-safe, but defend against bugs.
        feeds.push({
          peer: peer.name,
          url: peer.url,
          status: 0,
          items_parsed: 0,
          items_stored: 0,
          items_dropped: 0,
          items_collided: 0,
          items_errored: 0,
          duration_ms: 0,
          error: `pollPeer threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const endedAt = new Date();
    const summary: PullRunSummary = {
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      feeds_seen: peers.length,
      feeds_polled: feeds.filter((f) => !f.error).length,
      feeds_errored: feeds.filter((f) => f.error).length,
      items_stored: feeds.reduce((n, f) => n + f.items_stored, 0),
      items_dropped: feeds.reduce((n, f) => n + f.items_dropped, 0),
      items_collided: feeds.reduce((n, f) => n + f.items_collided, 0),
      feeds,
    };
    log('run complete', {
      feeds_seen: summary.feeds_seen,
      feeds_polled: summary.feeds_polled,
      feeds_errored: summary.feeds_errored,
      items_stored: summary.items_stored,
      items_collided: summary.items_collided,
      duration_ms: summary.duration_ms,
    });
    return summary;
  }

  return { pollAll, pollOne };
}

// ============================================================================
// Internals
// ============================================================================

interface FeedConfigResolved {
  target_inbox?: string;
  schedule?: string;
  rssConfig: RssConfig;
}

/**
 * Pull the feed-config shape out of peer metadata. Unknown keys are ignored;
 * missing keys just resolve to undefined. The type hasn't been narrowed at
 * the peer-store level (metadata is `Record<string, unknown>`) so we do
 * defensive shape checks here.
 */
function extractFeedConfig(peer: Peer): FeedConfigResolved {
  const cfg = (peer.metadata?.feed_config as Record<string, unknown> | undefined) ?? {};
  const target_inbox = typeof cfg.target_inbox === 'string' ? cfg.target_inbox : undefined;
  const schedule = typeof cfg.schedule === 'string' ? cfg.schedule : undefined;
  const default_labels = Array.isArray(cfg.default_labels)
    ? cfg.default_labels.filter((v): v is string => typeof v === 'string')
    : undefined;
  const media_policy = cfg.media_policy === 'fetch-to-r2' || cfg.media_policy === 'refs-only'
    ? cfg.media_policy
    : undefined;
  return {
    target_inbox,
    schedule,
    rssConfig: {
      default_labels,
      media_policy,
    },
  };
}

interface FetchFeedResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

/**
 * Fetch the feed URL with peer auth applied. Deliberately NOT using
 * `proxyGet` from `src/peers/proxy.ts` because proxyGet is tuned for
 * HTTP-forwarding (client-header merging, hop-by-hop stripping) we don't
 * need here — this is a server-side fetch with no client. Reusing the
 * auth resolver keeps the secret-injection logic identical.
 */
async function fetchFeed(
  peer: Peer,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<FetchFeedResult> {
  const resolved = resolvePeerAuth(peer, env);
  if (resolved.error) {
    return { ok: false, status: 0, body: '', error: resolved.error };
  }

  // Apply auth query params on top of peer.url's existing query string.
  let url = peer.url;
  if (resolved.query_params && resolved.query_params.length > 0) {
    try {
      const u = new URL(url);
      for (const [k, v] of resolved.query_params) u.searchParams.append(k, v);
      url = u.toString();
    } catch {
      // Fall through with the raw url; fetch will error in a moment.
    }
  }

  const headers: Record<string, string> = {
    // Most publishers expect a UA; send one when the peer doesn't override it.
    'User-Agent': 'smallstore-rss/1.0 (+https://smallstore.labspace.ai)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    ...(peer.headers ?? {}),
    ...resolved.headers,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const body = await res.text();
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body,
    };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError' ||
      (err as Error)?.name === 'AbortError';
    if (isAbort) {
      return { ok: false, status: 0, body: '', error: `timeout after ${timeoutMs}ms` };
    }
    return {
      ok: false,
      status: 0,
      body: '',
      error: (err as Error)?.message ?? 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
