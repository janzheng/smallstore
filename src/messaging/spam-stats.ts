/**
 * Spam stats — ranking helper for the operator triage surface.
 *
 * Given a `SenderIndex`, produce four ranked lists:
 *
 * - `senders_top_spam`: senders with the highest absolute spam mark
 *   counts. Useful for "show me the worst offenders."
 * - `senders_recently_marked`: senders the user has marked spam OR
 *   not-spam within `windowDays` (default 30). Powers a "recent
 *   triage activity" view.
 * - `suggested_blocklist`: senders the system would propose
 *   blocklisting via `promote-rule` — `count >= 5` and
 *   `spam_rate >= 0.7`. Excludes already-trusted senders.
 * - `suggested_whitelist`: senders the user has explicitly marked
 *   not-spam more than spam, with at least 3 explicit decisions.
 *   Excludes already-trusted senders.
 *
 * Pure function over an in-memory snapshot — the only I/O is the
 * single `senderIndex.query()` call to load all records. For
 * single-user mailroom volumes (~hundreds of unique senders) this is
 * fine. If sender counts ever cross thousands, switch to a
 * paginated query loop.
 *
 * See `.brief/spam-layers.md` § Sprint 3.
 */

import type { SenderIndex, SenderRecord } from './sender-index.ts';

export interface SpamStatsOptions {
  /** Recency window for `senders_recently_marked`. Default 30 days. */
  windowDays?: number;
  /** Minimum count threshold for blocklist suggestions. Default 5. */
  blocklistMinCount?: number;
  /** Minimum spam_rate for blocklist suggestions. Default 0.7. */
  blocklistMinSpamRate?: number;
  /** Minimum total marks (spam + not_spam) for whitelist suggestions. Default 3. */
  whitelistMinMarks?: number;
  /** Max items per ranked list. Default 50. */
  limit?: number;
  /** Clock injection for tests. Default `() => new Date().toISOString()`. */
  now?: () => string;
}

export interface SpamStatsRow {
  address: string;
  display_name?: string;
  count: number;
  spam_count: number;
  not_spam_count: number;
  spam_rate: number;
  marked_at?: string;
  tags: string[];
}

export interface SpamStats {
  senders_top_spam: SpamStatsRow[];
  senders_recently_marked: SpamStatsRow[];
  suggested_blocklist: SpamStatsRow[];
  suggested_whitelist: SpamStatsRow[];
}

const DEFAULT_OPTS: Required<Omit<SpamStatsOptions, 'now'>> = {
  windowDays: 30,
  blocklistMinCount: 5,
  blocklistMinSpamRate: 0.7,
  whitelistMinMarks: 3,
  limit: 50,
};

const TRUSTED = 'trusted';

function spamRate(r: SenderRecord): number {
  const explicit = r.spam_count + r.not_spam_count;
  if (explicit === 0) return 0;
  return r.spam_count / explicit;
}

function toRow(r: SenderRecord): SpamStatsRow {
  return {
    address: r.address,
    display_name: r.display_name,
    count: r.count,
    spam_count: r.spam_count,
    not_spam_count: r.not_spam_count,
    spam_rate: spamRate(r),
    marked_at: r.marked_at,
    tags: r.tags,
  };
}

/**
 * Compute spam stats over the entire sender index.
 *
 * Runs a single unfiltered `senderIndex.query()` and ranks in-memory.
 * For mailroom volumes (single-user, hundreds of senders) this is fine.
 */
export async function getSpamStats(
  senderIndex: SenderIndex,
  options: SpamStatsOptions = {},
): Promise<SpamStats> {
  const opts = { ...DEFAULT_OPTS, ...options };
  const now = options.now ?? (() => new Date().toISOString());

  const allSenders: SenderRecord[] = [];
  let cursor: string | undefined;
  // Loop in case the underlying adapter applies its own page cap.
  while (true) {
    const page = await senderIndex.query({ cursor, limit: 500 });
    allSenders.push(...page.senders);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  const cutoff = new Date(Date.parse(now()) - opts.windowDays * 24 * 60 * 60 * 1000).toISOString();

  const senders_top_spam = allSenders
    .filter((r) => r.spam_count > 0)
    .sort((a, b) => b.spam_count - a.spam_count || b.count - a.count)
    .slice(0, opts.limit)
    .map(toRow);

  const senders_recently_marked = allSenders
    .filter((r) => typeof r.marked_at === 'string' && r.marked_at >= cutoff)
    .sort((a, b) => (b.marked_at ?? '').localeCompare(a.marked_at ?? ''))
    .slice(0, opts.limit)
    .map(toRow);

  const suggested_blocklist = allSenders
    .filter((r) => !r.tags.includes(TRUSTED))
    .filter((r) => r.count >= opts.blocklistMinCount && spamRate(r) >= opts.blocklistMinSpamRate)
    .sort((a, b) => spamRate(b) - spamRate(a) || b.spam_count - a.spam_count)
    .slice(0, opts.limit)
    .map(toRow);

  const suggested_whitelist = allSenders
    .filter((r) => !r.tags.includes(TRUSTED))
    .filter((r) => {
      const explicit = r.spam_count + r.not_spam_count;
      return explicit >= opts.whitelistMinMarks && r.not_spam_count > r.spam_count;
    })
    .sort((a, b) => b.not_spam_count - a.not_spam_count)
    .slice(0, opts.limit)
    .map(toRow);

  return {
    senders_top_spam,
    senders_recently_marked,
    suggested_blocklist,
    suggested_whitelist,
  };
}
