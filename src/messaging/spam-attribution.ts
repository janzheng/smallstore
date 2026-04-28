/**
 * Spam attribution — resolve which sender's reputation to update when the
 * user marks an item spam (or not-spam).
 *
 * The naive answer is "always `fields.from_email`" — but forwarded mail
 * makes this nuanced. If a trusted curator forwards a newsletter to me
 * and I mark it spam, the *original sender* shouldn't get dinged for
 * the curator's choice. The curator does — their `spam_count` going up
 * is the right signal that they're forwarding things I don't want.
 *
 * Decision shape (resolved with user 2026-04-28, see `.brief/spam-layers.md`
 * § Edge case decisions #2):
 *
 *   1. If `fields.original_from_email` is present AND the forwarder
 *      (`fields.from_email`) carries the `trusted` tag in sender-index
 *      → attribute to **the forwarder**. Their curation choice is what
 *      we're flagging, not the original sender's identity.
 *   2. Else if `fields.original_from_email` is present → attribute to
 *      the **original sender**. Normal forward case — user got
 *      something gross from someone they don't have a trust relationship
 *      with; the original sender is the right target.
 *   3. Else → attribute to **`fields.from_email`** (no forward chain).
 *
 * Pure async function — only I/O is the senderIndex.get() call to check
 * the forwarder's tags. Returns the canonicalized lowercase address, or
 * null when no sender is identifiable.
 */

import type { InboxItem } from './types.ts';
import type { SenderIndex } from './sender-index.ts';

const TRUSTED_TAG = 'trusted';

/**
 * Resolve the sender address whose reputation should be updated for a
 * mark-spam / mark-not-spam action on the given item.
 *
 * Returns the lowercase normalized address on success. Returns `null`
 * when the item carries no sender at all (rare — non-email channels
 * with no `from_email` field).
 */
export async function resolveSpamAttribution(
  item: InboxItem,
  senderIndex: SenderIndex,
): Promise<string | null> {
  const fields = item.fields ?? {};
  const fromEmail = normalize(fields.from_email);
  const originalFromEmail = normalize(fields.original_from_email);

  // Case 3 (no forward chain): just use from_email.
  if (!originalFromEmail) {
    return fromEmail || null;
  }

  // We have a forward chain. Check whether the forwarder is trusted —
  // a missing forwarder address shouldn't accidentally route to the
  // original (we'd lose the chain entirely); fall back to the original.
  if (!fromEmail) {
    return originalFromEmail;
  }

  const forwarderRecord = await senderIndex.get(fromEmail);
  const forwarderIsTrusted = !!forwarderRecord?.tags?.includes(TRUSTED_TAG);

  // Case 1 (trusted forwarder): attribute to forwarder, breaking the chain.
  if (forwarderIsTrusted) {
    return fromEmail;
  }

  // Case 2 (untrusted forwarder, original visible): attribute to original.
  return originalFromEmail;
}

function normalize(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}
