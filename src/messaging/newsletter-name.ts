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
  if (!labels.includes('newsletter')) return { name: null, label: null };

  const fromAddr = item.fields?.from_addr;
  const name = extractDisplayName(fromAddr);
  if (!name) return { name: null, label: null };

  const slug = slugifySenderName(name);
  if (!slug) return { name: null, label: null };

  return { name, label: `newsletter:${slug}` };
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
    if (!result.label) return 'accept';

    const existing = item.labels ?? [];
    if (existing.includes(result.label)) return 'accept'; // idempotent

    return {
      ...item,
      labels: [...existing, result.label],
      fields: {
        ...(item.fields ?? {}),
        newsletter_name: result.name,
      },
    };
  };
}
