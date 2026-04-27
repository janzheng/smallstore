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
   * `index.md`. Default: `true` — without this, deleting a newsletter's
   * last item leaves a stale `.md` lingering on the peer until manually
   * cleaned up. Disable to opt out (e.g. when sharing a directory with
   * non-mirror content).
   */
  prune_orphans?: boolean;
}

/** Per-peer summary returned from `runMirror`. */
export interface MirrorRunResult {
  peer_name: string;
  /** When set, the peer was skipped before any pushes. */
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
}

/**
 * Run the mirror over every peer with a `metadata.mirror_config` (or just
 * one peer when `peer_name` is set). Returns one result per attempted
 * peer; never throws on per-slug or per-peer failures.
 */
export async function runMirror(opts: RunMirrorOptions): Promise<MirrorRunResult[]> {
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
    for (const [slug, items] of groups) {
      try {
        // Hydrate bodies so the rendered markdown is self-contained
        // reading material — the "View item →" link below requires the
        // bearer token, which a user opening the .md in Finder/Obsidian
        // doesn't have. O(N) R2 reads per slug; acceptable at current
        // scale (cron is every 30 min). On read failure we keep the
        // slim item — the renderer falls back to "(no note)" gracefully.
        const fullItems: InboxItemFull[] = await Promise.all(
          items.map(async (item) => {
            try {
              const full = await inbox.read(item.id, { full: true });
              return full ?? (item as InboxItemFull);
            } catch {
              return item as InboxItemFull;
            }
          }),
        );
        const profile = buildProfile(slug, fullItems);
        const md = renderNewsletterProfile(config.source_inbox, slug, profile, fullItems, linkOrigin);
        await pushFile(peer, auth.headers, fetcher, `${prefix}${slug}.md`, md);
        result.pushed++;
        activeFilenames.add(`${slug}.md`);
      } catch (e) {
        result.failed.push({ slug, error: errorMessage(e) });
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
