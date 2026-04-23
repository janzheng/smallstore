/**
 * Quarantine + restore — store-first handling of suspicious items.
 *
 * Design: **label-based quarantine** (NOT a separate sub-inbox).
 *
 * Why label-based over sub-inbox:
 * - Zero new infrastructure — no duplicate InboxConfig, no second adapter mount,
 *   no second DO/D1 footprint, no second HTTP registration. The mailroom
 *   operator configures one inbox, not two.
 * - Aligns with the existing `Inbox.query(filter)` surface. Consumers already
 *   filter on labels; `exclude_labels: ['quarantined']` is the main-view query,
 *   `labels: ['quarantined']` is the review-queue query. No new API shape.
 * - Restore is a single label removal (one item write), not a cross-inbox move
 *   (two writes + integrity window where the item exists in both or neither).
 * - Content-addressed ids stay stable across the quarantine boundary, so audit
 *   tools, blobs refs, and sender-index entries keep working unchanged.
 *
 * Trade-off we accept: ALL queries on the inbox MUST explicitly exclude the
 * `quarantined` label for main views. We document that in
 * `quarantineSink`'s JSDoc so consumers don't forget and accidentally surface
 * quarantined items in the main list. The pipeline-level convention is
 * unambiguous: "quarantined items have the `quarantined` label; filter them
 * out of main views with `exclude_labels: ['quarantined']`."
 *
 * Store-first principle (from `.brief/mailroom-pipeline.md` § "Store-first
 * over filter-first"): quarantined items MUST be persisted so false-positives
 * are trivially recoverable. This module never drops items silently.
 *
 * Three operations:
 * - `quarantineSink(inbox)`     — a Sink factory for the pipeline's preIngest
 *   hook layer: items flowing through this sink pick up the quarantine label
 *   before landing in storage.
 * - `quarantineItem(inbox, id)` — tag an already-stored item as quarantined
 *   without re-ingesting from a channel. Used by hook runners that classify
 *   after initial storage.
 * - `restoreItem(inbox, id)`    — remove the quarantine label. The item keeps
 *   its id, other labels, body, attachments, and received_at.
 * - `listQuarantined(inbox)`    — convenience `inbox.query` wrapper for the
 *   review queue.
 *
 * Depends on `Inbox._ingest({ force: true })` to bypass content-hash dedup
 * when updating labels on an existing item — see inbox.ts. Without `force`,
 * a second `_ingest(sameItem)` would return the existing item unchanged.
 */

import type {
  Inbox,
  InboxItem,
  ListResult,
  Sink,
  SinkContext,
  SinkResult,
} from './types.ts';

// ============================================================================
// Options
// ============================================================================

/** Default label applied to quarantined items. */
export const DEFAULT_QUARANTINE_LABEL = 'quarantined';

export interface QuarantineOptions {
  /** Label to add on quarantined items. Default: `'quarantined'`. */
  label?: string;
  /**
   * Extra reason label applied alongside (e.g. `'spam'`, `'blocklist'`,
   * `'rate-limit'`). Optional; lets consumers slice the quarantine queue by
   * why the item was flagged.
   */
  reason?: string;
}

// ============================================================================
// quarantineSink — Sink that tags then delegates to inbox._ingest
// ============================================================================

/**
 * Create a Sink that tags items with a quarantine label before delegating
 * to the given Inbox. Items DO land in storage (store-first principle);
 * consumers filter them out of main views via
 * `exclude_labels: ['quarantined']` on `Inbox.query`.
 *
 * The sink preserves any labels already on the item, adds the quarantine
 * label, and optionally adds a reason label. Duplicate labels are deduped
 * (Set-based merge).
 *
 * Reminder for consumers: the main inbox view MUST pass
 * `exclude_labels: ['quarantined']` to avoid surfacing flagged items.
 */
export function quarantineSink(inbox: Inbox, opts?: QuarantineOptions): Sink {
  const label = opts?.label ?? DEFAULT_QUARANTINE_LABEL;
  const reason = opts?.reason;
  return async (item: InboxItem, ctx: SinkContext): Promise<SinkResult> => {
    const merged = applyQuarantineLabels(item, label, reason);
    try {
      const saved = await inbox._ingest(merged, { blobs: ctx.blobs });
      return { stored: true, id: saved.id };
    } catch (err) {
      return {
        stored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// ============================================================================
// quarantineItem — tag an already-stored item
// ============================================================================

/**
 * Mark an already-stored item as quarantined without re-ingesting from a
 * channel. Used by Wave 2 hook runners that classify after initial storage.
 *
 * Idempotent: calling twice with the same label leaves the item unchanged
 * (label set is a Set, so the second call is a no-op label-wise). A fresh
 * `_ingest` still runs under the hood so the updated `updated_at` (if any)
 * reflects the operation.
 *
 * Returns the updated item, or `null` if the id doesn't exist in the inbox.
 */
export async function quarantineItem(
  inbox: Inbox,
  id: string,
  opts?: QuarantineOptions,
): Promise<InboxItem | null> {
  const existing = await inbox.read(id);
  if (!existing) return null;

  const label = opts?.label ?? DEFAULT_QUARANTINE_LABEL;
  const reason = opts?.reason;
  const merged = applyQuarantineLabels(existing, label, reason);
  // force: true — bypass the content-hash dedup in _ingest so the label
  // change actually persists (dedup would otherwise return the old item).
  const saved = await inbox._ingest(merged, { force: true });
  return saved;
}

// ============================================================================
// restoreItem — remove the quarantine label
// ============================================================================

/**
 * Restore a quarantined item by removing the quarantine label. Other labels
 * (reason label like `'spam'`, plus anything classifier added) are preserved
 * so the review trail stays auditable — restore means "not quarantined
 * anymore," not "wipe the item's history."
 *
 * Returns the updated item with labels refreshed, or `null` if:
 * - the id doesn't exist in the inbox, OR
 * - the item exists but isn't quarantined (no-op rather than silent success,
 *   so callers can tell whether restore actually did anything).
 */
export async function restoreItem(
  inbox: Inbox,
  id: string,
  opts?: { label?: string },
): Promise<InboxItem | null> {
  const existing = await inbox.read(id);
  if (!existing) return null;

  const label = opts?.label ?? DEFAULT_QUARANTINE_LABEL;
  const currentLabels = existing.labels ?? [];
  if (!currentLabels.includes(label)) return null; // not quarantined — nothing to do

  const nextLabels = currentLabels.filter((l) => l !== label);
  const restored: InboxItem = {
    ...existing,
    labels: nextLabels.length > 0 ? nextLabels : undefined,
  };

  // force: true — bypass content-hash dedup so label removal persists.
  const saved = await inbox._ingest(restored, { force: true });
  return saved;
}

// ============================================================================
// listQuarantined — review-queue query
// ============================================================================

/**
 * List quarantined items — convenience wrapper over `Inbox.query` with the
 * quarantine label filter applied. Supports cursor paging through
 * `Inbox.query`'s native cursor surface.
 *
 * Equivalent to `inbox.query({ labels: [label] }, { cursor, limit })`.
 */
export function listQuarantined(
  inbox: Inbox,
  opts?: { label?: string; cursor?: string; limit?: number },
): Promise<ListResult> {
  const label = opts?.label ?? DEFAULT_QUARANTINE_LABEL;
  return inbox.query(
    { labels: [label] },
    { cursor: opts?.cursor, limit: opts?.limit },
  );
}

// ============================================================================
// Internals
// ============================================================================

/** Merge quarantine + reason labels into the item's existing label set. */
function applyQuarantineLabels(
  item: InboxItem,
  label: string,
  reason: string | undefined,
): InboxItem {
  const next = new Set<string>(item.labels ?? []);
  next.add(label);
  if (reason) next.add(reason);
  return {
    ...item,
    labels: Array.from(next),
  };
}
