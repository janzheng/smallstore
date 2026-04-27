/**
 * Stale-unread sweep — marks items read after they've been sitting for
 * more than `cutoffDays` days.
 *
 * Mailrooms accumulate. Most newsletter items get read or deleted within
 * a week; the ones that linger past 30 days are typically "I'll get to
 * this someday" that the user never actually returns to. Marking them
 * read keeps the unread surface useful as a "what's new" view, without
 * actually destroying anything — the items remain queryable, bookmarked,
 * and visible to all read paths.
 *
 * Designed to run from a cron tick. Idempotent — items that are already
 * read (no `unread` label) are filtered out by the query, so re-running
 * is a no-op. Pure read-then-mutate; no R2 reads (only label updates).
 *
 * Disable per-deploy by setting `cutoffDays` to 0 (the cron handler
 * reads this from `UNREAD_SWEEP_DAYS` env, treating empty/0 as off).
 */

import type { Inbox } from './types.ts';

export interface UnreadSweepOptions {
  inbox: Inbox;
  /**
   * Days back from now to consider "stale." Items with
   * `received_at < (now - cutoffDays * 1d)` AND the `unread` label get
   * marked read. Pass 0 to disable (caller should branch before calling
   * — but if 0 slips through, this is a no-op).
   */
  cutoffDays: number;
  /** Safety cap on how many items to mark in one run. Default 10_000. */
  hardCap?: number;
  /** Override "now" for tests. Default: Date.now(). */
  now?: number;
}

export interface UnreadSweepResult {
  /**
   * ISO cutoff that was used — items with `received_at <= cutoff` were
   * candidates. Useful in logs to confirm the window.
   */
  cutoff_iso: string;
  /** Items that matched the stale-unread filter. */
  matched: number;
  /** Items that were actually mutated (matched and still had `unread`). */
  changed: number;
  /** True when the safety cap was hit; rerun for the next batch. */
  capped: boolean;
}

/**
 * Run the sweep against one inbox. No-op when `cutoffDays <= 0`.
 *
 * @returns Summary of what was matched/changed. Per-item failures are
 *          intentionally NOT surfaced — this is a best-effort cleanup,
 *          not a transactional batch.
 */
export async function runUnreadSweep(opts: UnreadSweepOptions): Promise<UnreadSweepResult> {
  const cutoffDays = opts.cutoffDays;
  const now = opts.now ?? Date.now();
  const hardCap = opts.hardCap ?? 10_000;
  const cutoffMs = now - cutoffDays * 24 * 60 * 60 * 1000;
  const cutoff_iso = new Date(cutoffMs).toISOString();

  if (cutoffDays <= 0) {
    return { cutoff_iso, matched: 0, changed: 0, capped: false };
  }

  const filter = { labels: ['unread'], until: cutoff_iso };
  const pageLimit = 500;
  let cursor: string | undefined;
  let matched = 0;
  let changed = 0;

  while (true) {
    const page = await opts.inbox.query(filter, { cursor, limit: pageLimit });
    for (const item of page.items) {
      if (matched >= hardCap) break;
      matched++;
      const labels = item.labels ?? [];
      if (!labels.includes('unread')) continue;
      const nextLabels = labels.filter((l) => l !== 'unread');
      await opts.inbox._ingest(
        { ...item, labels: nextLabels.length > 0 ? nextLabels : undefined },
        { force: true },
      );
      changed++;
    }
    if (matched >= hardCap || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  return { cutoff_iso, matched, changed, capped: matched >= hardCap };
}
