/**
 * Unread-state hook + helpers.
 *
 * Stamps `unread` on every newly-ingested item so callers can filter
 * `{ labels: ["unread"] }` to get "what's new since I last looked."
 * Explicit mark-read endpoints (see `http-routes.ts`) remove the label;
 * /unread adds it back.
 *
 * ## Design choices
 *
 * - **Label, not flag.** Fits the existing filter surface —
 *   `{ labels: ["unread"] }` works immediately, no schema change.
 *
 * - **Idempotent.** If `unread` is already present, no-op. Matters for
 *   `_ingest(force: true)` re-writes (e.g. the `/tag`, `/confirm`,
 *   `/read` endpoints all re-ingest the item); those should not
 *   resurrect `unread` after the user cleared it.
 *
 * - **Skip terminal labels.** `quarantined` and `archived` items are
 *   not surfaced in the main view, so stamping them `unread` would
 *   inflate the unread count with invisible items. Rules-engine drops
 *   never reach hooks at all, so no special-case needed there.
 *
 * - **Reads stay side-effect-free.** This hook fires on ingest only.
 *   `GET /inbox/:name` / `sm_inbox_read` do not auto-mark-read. If we
 *   ever want "viewing marks read," layer it at the UI, not here.
 */

import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
} from './types.ts';

export const UNREAD_LABEL = 'unread';

/**
 * Terminal labels — items carrying any of these are excluded from the
 * main inbox view (see `filter.ts:DEFAULT_HIDDEN_LABELS`), so stamping
 * them `unread` is misleading.
 */
const TERMINAL_LABELS: readonly string[] = ['quarantined', 'archived'];

export interface UnreadHookOptions {
  /**
   * Labels that suppress the `unread` stamp. Defaults to
   * `['quarantined', 'archived']`. Provide a custom list if you're
   * running a non-default quarantine/archive taxonomy.
   */
  terminalLabels?: readonly string[];
}

/**
 * Pure check — should this item get stamped `unread`?
 * Returns true when: the item doesn't already have `unread`, AND
 * carries no terminal label. Exported for testing.
 */
export function shouldStampUnread(
  item: InboxItem,
  terminalLabels: readonly string[] = TERMINAL_LABELS,
): boolean {
  const labels = item.labels ?? [];
  if (labels.includes(UNREAD_LABEL)) return false;
  for (const t of terminalLabels) {
    if (labels.includes(t)) return false;
  }
  return true;
}

/**
 * postClassify hook — adds `unread` to every new item that isn't
 * already read or terminal-labeled. Safe to run on re-ingests
 * (`_ingest(force: true)`) because the idempotent guard prevents
 * re-stamping an item the user already marked read.
 */
export function createStampUnreadHook(
  opts: UnreadHookOptions = {},
): PostClassifyHook {
  const terminalLabels = opts.terminalLabels ?? TERMINAL_LABELS;

  return async function stampUnreadHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    if (!shouldStampUnread(item, terminalLabels)) return 'accept';

    const existing = item.labels ?? [];
    return {
      ...item,
      labels: [...existing, UNREAD_LABEL],
    };
  };
}
