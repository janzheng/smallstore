/**
 * Newsletter-name auto-tag hook — attach a `newsletter:<slug>` label derived
 * from the sender's display name, for items the classifier already labeled
 * as `newsletter`.
 *
 * Motivation: the classifier tags anything with a `List-Unsubscribe` header
 * as `newsletter`. That gets you "this is a newsletter" but not "which
 * newsletter" — the from-address is usually a boring `hello@uxdesign.cc`
 * shared across Sidebar + other EmailOctopus lists. The display name
 * (`"Sidebar.io" <hello@uxdesign.cc>`) is the actual brand. Slugify it →
 * `newsletter:sidebar-io` → query every Sidebar issue without knowing the
 * exact from-address.
 *
 * Complement (not replacement) for `sender-aliases.ts`: that one maps by
 * hand for people (Jan, Jessica). This one auto-names brands. Manual wins
 * over auto — if the item already carries a `sender:*` label (from
 * sender-aliases), we skip adding `newsletter:*` to avoid double-tagging.
 *
 * ## Hook placement
 *
 * postClassify, because we need the `newsletter` label the classifier
 * adds (`hasHeader(headers, 'list-unsubscribe')` → `newsletter`). Running
 * preIngest means the `newsletter` label isn't there yet.
 *
 * ## What this hook does NOT do
 *
 * - **Fire on non-newsletter mail.** If the classifier didn't tag
 *   `newsletter`, we pass through untouched. No bare-display-name tagging
 *   for regular correspondence (that's what manual `sender-aliases` is for).
 * - **Override manual sender aliases.** A `sender:*` label means the user
 *   explicitly said "this person is X" — we don't add `newsletter:*` on top.
 * - **Fabricate a name from the email local-part.** If there's no display
 *   name (`<hello@uxdesign.cc>` alone), we skip. `newsletter:hello-uxdesign-cc`
 *   is worse than no tag.
 */

import { deriveNewsletterSlug } from './forward-detect.ts';
import { slugifySenderName } from './sender-aliases.ts';
import type {
  HookContext,
  HookVerdict,
  InboxItem,
  PostClassifyHook,
} from './types.ts';

// ============================================================================
// Types
// ============================================================================

export interface NewsletterNameResult {
  /** Extracted display name (e.g. "Sidebar.io"), or null if we didn't find one. */
  name: string | null;
  /** `newsletter:<slug>` label to merge, or null. */
  label: string | null;
  /**
   * Slug for `fields.newsletter_slug`, derived via `deriveNewsletterSlug` so
   * direct subs share the same slug shape as forwarded items (filler prefixes
   * stripped, domain fallback). May differ from the slug embedded in `label`
   * (which uses `slugifySenderName` for backward-compat with existing labels).
   * Null when no slug-worthy input exists.
   */
  slug: string | null;
}

export interface NewsletterNameOptions {
  /**
   * Skip when the item already carries a `sender:*` label (from manual
   * alias matching). Default: true — manual aliases represent explicit
   * user intent and shouldn't be doubled up with auto-tags.
   */
  skipIfSenderTagged?: boolean;
}

// ============================================================================
// Extraction
// ============================================================================

/**
 * Extract the display-name portion from an RFC 5322 `From` address string.
 *
 *   '"Sidebar.io" <hello@uxdesign.cc>' → "Sidebar.io"
 *   'Jane Doe <jane@example.com>'      → "Jane Doe"
 *   '<hello@uxdesign.cc>'              → null
 *   'hello@uxdesign.cc'                → null  (bare address, no name)
 *   ''                                 → null
 *
 * Strips surrounding quotes. Decodes common MIME encoded-word forms
 * defensively (`=?utf-8?Q?...?=` → pass through unchanged rather than
 * returning mojibake — we don't try to decode). When the display name is
 * *just* the email address repeated (some clients do this), we reject it.
 */
export function extractDisplayName(fromAddr: string | undefined | null): string | null {
  if (!fromAddr) return null;
  const raw = String(fromAddr).trim();
  if (!raw) return null;

  // Shape: `name <addr>` — take everything before the `<`.
  const lt = raw.indexOf('<');
  if (lt <= 0) return null; // no display name, or starts with `<`
  let name = raw.slice(0, lt).trim();
  if (!name) return null;

  // Strip surrounding quotes (single or double) if balanced.
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"))
  ) {
    name = name.slice(1, -1).trim();
  }
  if (!name) return null;

  // Reject MIME encoded-word that we can't decode — slugifying `=?utf-8?Q?...?=`
  // produces garbage. Downstream can decode later and re-run.
  if (/^=\?.+\?=$/.test(name)) return null;

  // Reject if the "display name" is just the email address repeated.
  const addr = raw.slice(lt + 1).replace(/>.*$/, '').trim().toLowerCase();
  if (addr && name.toLowerCase() === addr) return null;

  return name;
}

// ============================================================================
// Application
// ============================================================================

/**
 * Pure evaluation — does not mutate. Returns `{ name, label }` with both
 * non-null on a hit, both null on a miss.
 */
export function applyNewsletterName(item: InboxItem): NewsletterNameResult {
  const labels = item.labels ?? [];
  if (!labels.includes('newsletter')) return { name: null, label: null, slug: null };

  const fromAddr = item.fields?.from_addr;
  const fromEmail = item.fields?.from_email;
  const name = extractDisplayName(fromAddr);

  const fieldSlug = deriveNewsletterSlug(fromAddr, fromEmail) ?? null;

  if (!name) return { name: null, label: null, slug: fieldSlug };

  const labelSlug = slugifySenderName(name);
  if (!labelSlug) return { name, label: null, slug: fieldSlug };

  return { name, label: `newsletter:${labelSlug}`, slug: fieldSlug };
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns a `PostClassifyHook` that adds `newsletter:<slug>` when:
 *  - the item has the `newsletter` label (from classifier)
 *  - we can extract a non-empty display name from `fields.from_addr`
 *  - no `sender:*` label is already present (manual wins, unless opts
 *    override via `skipIfSenderTagged: false`)
 *
 * Non-destructive — only adds a label. Skips silently on any miss.
 */
export function createNewsletterNameHook(
  opts: NewsletterNameOptions = {},
): PostClassifyHook {
  const skipIfSenderTagged = opts.skipIfSenderTagged ?? true;

  return async function newsletterNameHook(
    item: InboxItem,
    _ctx: HookContext,
  ): Promise<HookVerdict> {
    if (skipIfSenderTagged && (item.labels ?? []).some((l) => l.startsWith('sender:'))) {
      return 'accept';
    }

    const result = applyNewsletterName(item);

    // Determine what (if anything) needs to change. We may add a label, a
    // newsletter_name field, or a newsletter_slug field — independently.
    const existing = item.labels ?? [];
    const existingFields = item.fields ?? {};

    const labelToAdd = result.label && !existing.includes(result.label)
      ? result.label
      : null;
    const nameToWrite = result.name && existingFields.newsletter_name !== result.name
      ? result.name
      : null;
    // Always re-derive the slug. Newsletter-name only fires on items the
    // classifier tagged `newsletter`; forwarded items lack that label
    // (forward-detect runs preIngest before classification but doesn't add
    // it), so this hook never competes with forward-detect for the slug
    // field. Overwriting is safe AND lets the replay path pick up better
    // slug derivation as the filler-prefix patterns evolve.
    const slugToWrite = result.slug && existingFields.newsletter_slug !== result.slug
      ? result.slug
      : null;

    if (!labelToAdd && !nameToWrite && !slugToWrite) return 'accept';

    return {
      ...item,
      labels: labelToAdd ? [...existing, labelToAdd] : existing,
      fields: {
        ...existingFields,
        ...(nameToWrite ? { newsletter_name: nameToWrite } : {}),
        ...(slugToWrite ? { newsletter_slug: slugToWrite } : {}),
      },
    };
  };
}
