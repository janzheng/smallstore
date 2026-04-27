/**
 * Markdown rendering for the newsletter views.
 *
 * Pure functions over already-hydrated data — no I/O, no DB. Same shape
 * as the JSON routes, different render. The HTTP routes in
 * `http-routes.ts` choose between JSON and markdown based on
 * `?format=markdown`; the cron mirror in Phase 2b reuses these
 * functions directly without an HTTP roundtrip.
 *
 * Design notes:
 *   - Notes are rendered as blockquotes — preserves the user's markdown
 *     verbatim while visually separating their voice from the publisher's.
 *   - "View item" links are absolute — built from a passed-in origin so
 *     the markdown is portable (the same content can be rendered from
 *     local dev, prod, or a tigerflare mirror).
 *   - Items missing `original_sent_at` sort to the tail of the list and
 *     render with a `(date unknown)` heading — same semantic as the JSON
 *     items route's missing-field-tails behavior.
 *   - Display name is stripped of any angle-bracketed address — the JSON
 *     profile route already does this, so renderers receive the clean form.
 */

import type { InboxItem } from './types.ts';

export interface NewsletterIndexEntry {
  slug: string;
  count: number;
  latest_at?: string;
  display?: string;
}

export interface NewsletterProfile {
  slug: string;
  display?: string;
  count: number;
  first_seen_at?: string;
  last_seen_at?: string;
  notes_count: number;
}

/**
 * Render the index page — a table of every known newsletter slug.
 * The slug column links to the per-newsletter file using a relative
 * `./<slug>.md` path so a folder of these files browses naturally
 * in Obsidian / tigerflare without absolute URLs.
 */
export function renderNewsletterIndex(
  inboxName: string,
  newsletters: ReadonlyArray<NewsletterIndexEntry>,
): string {
  const lines: string[] = [];
  lines.push(`# ${capitalize(inboxName)} newsletters`);
  lines.push('');
  if (newsletters.length === 0) {
    lines.push('_No newsletters yet — forward something to populate._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| Slug | Display | Issues | Last seen |');
  lines.push('|------|---------|--------|-----------|');
  for (const n of newsletters) {
    lines.push(
      `| [${n.slug}](./${encodeURIComponent(n.slug)}.md) | ${escapePipe(n.display ?? n.slug)} | ${n.count} | ${formatDate(n.latest_at)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the full publisher view — profile metadata header + every
 * issue chronologically (oldest first), notes inlined as blockquotes
 * under each issue.
 *
 * @param origin Absolute origin (`https://smallstore.labspace.ai`) for
 *               building "View item" links. Pass an empty string to
 *               omit links entirely.
 */
export function renderNewsletterProfile(
  inboxName: string,
  slug: string,
  profile: NewsletterProfile,
  items: ReadonlyArray<InboxItem>,
  origin: string,
): string {
  const lines: string[] = [];
  const title = profile.display ?? slug;
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`**Slug:** \`${slug}\`  `);
  if (profile.display) lines.push(`**Display:** ${profile.display}  `);
  lines.push(`**First seen:** ${formatDate(profile.first_seen_at)}  `);
  lines.push(`**Last seen:** ${formatDate(profile.last_seen_at)}  `);
  lines.push(`**Issues:** ${profile.count}  `);
  lines.push(`**Notes:** ${profile.notes_count}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Sort: oldest first by original_sent_at, missing dates tail.
  const sorted = [...items].sort((a, b) => {
    const av = (a.fields?.original_sent_at as string | undefined) ?? '';
    const bv = (b.fields?.original_sent_at as string | undefined) ?? '';
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return av.localeCompare(bv);
  });

  for (const item of sorted) {
    const sentAt = item.fields?.original_sent_at as string | undefined;
    const subject = (item.fields?.original_subject as string | undefined) ??
      item.summary ??
      '(no subject)';
    const heading = sentAt
      ? `## ${formatDate(sentAt)} — ${subject}`
      : `## (date unknown) — ${subject}`;
    lines.push(heading);
    lines.push('');
    const note = item.fields?.forward_note as string | undefined;
    if (typeof note === 'string' && note.trim().length > 0) {
      lines.push('**Note:**');
      lines.push('');
      for (const noteLine of note.split(/\r?\n/)) {
        lines.push(noteLine.length > 0 ? `> ${noteLine}` : '>');
      }
      lines.push('');
    } else {
      lines.push('_(no note)_');
      lines.push('');
    }
    if (origin) {
      lines.push(`[View item →](${origin}/inbox/${inboxName}/items/${item.id})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Render notes-only — slim version for LLM ingest or for "show me what
 * I've thought about this newsletter" surfaces. Same chronological
 * order; items without notes are skipped.
 */
export function renderNewsletterNotes(
  inboxName: string,
  slug: string,
  profile: NewsletterProfile,
  notes: ReadonlyArray<{
    id: string;
    original_sent_at?: string;
    received_at?: string;
    subject?: string;
    from?: string;
    note?: string;
  }>,
  origin: string,
): string {
  const lines: string[] = [];
  const title = profile.display ?? slug;
  lines.push(`# Notes — ${title}`);
  lines.push('');
  lines.push(`**Slug:** \`${slug}\`  `);
  lines.push(`**Notes:** ${notes.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (notes.length === 0) {
    lines.push('_No notes yet — annotate a forward to populate._');
    lines.push('');
    return lines.join('\n');
  }

  for (const n of notes) {
    if (!n.note || n.note.trim().length === 0) continue;
    const heading = n.original_sent_at
      ? `## ${formatDate(n.original_sent_at)} — ${n.subject ?? '(no subject)'}`
      : `## (date unknown) — ${n.subject ?? '(no subject)'}`;
    lines.push(heading);
    lines.push('');
    for (const noteLine of n.note.split(/\r?\n/)) {
      lines.push(noteLine.length > 0 ? `> ${noteLine}` : '>');
    }
    lines.push('');
    if (origin) {
      lines.push(`[View item →](${origin}/inbox/${inboxName}/items/${n.id})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function formatDate(iso: string | undefined): string {
  if (!iso) return '(unknown)';
  // Trim to YYYY-MM-DD for stable rendering across timezones in the markdown.
  // The full ISO is recoverable from the JSON view.
  return iso.slice(0, 10);
}

function escapePipe(s: string): string {
  // Markdown table cells need pipes escaped to avoid breaking the column layout.
  return s.replace(/\|/g, '\\|');
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
