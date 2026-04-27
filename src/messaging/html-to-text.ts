/**
 * Newsletter-shaped HTML → readable plain text.
 *
 * Lossy but pragmatic. Built for the mailroom mirror — we want each `.md`
 * file to be readable in any editor without authenticated link-following,
 * not to round-trip the original presentation. Newsletter HTML is the
 * common case (Substack, Every, Beehiiv, ConvertKit, EmailOctopus): heavy
 * inline styling, tables for layout, lots of tracking pixels — drop the
 * chrome, keep the content.
 *
 * Not a general-purpose HTML→Markdown converter. If you need fidelity for
 * arbitrary HTML, reach for `turndown`. Keeping zero dependencies keeps
 * the Worker bundle small and avoids a transitive surface.
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  trade: '™',
  copy: '©',
  reg: '®',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name] ?? m);
}

/**
 * Convert newsletter-shaped HTML to readable plain text. Preserves
 * heading structure (h1-h6 → markdown # headings), links (as
 * `[text](url)` with self-link collapse), list items, and paragraph
 * breaks. Strips styling, scripts, tracking pixels, and table chrome.
 *
 * Returns trimmed text. If `input` is empty/undefined, returns empty
 * string.
 */
export function htmlToText(input: string | undefined | null): string {
  if (!input) return '';
  let s = input;

  // 1. Drop entire blocks we never want — script/style/head/noscript.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Headings → markdown. Capture level + content, replace block with
  // the right number of `#` characters and a newline pair.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, body) => {
    const hashes = '#'.repeat(Number(lvl));
    return `\n\n${hashes} ${stripInner(body)}\n\n`;
  });

  // 3. Anchors → markdown links. Collapse to bare URL when the visible
  // text equals the href (common in newsletters' "click here:
  // https://...").
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const text = stripInner(body).trim();
    if (!text) return href;
    if (text === href) return href;
    return `[${text}](${href})`;
  });

  // 4. List items → "- " bullets. <ol> ordering is dropped (rare in
  // newsletters, and reconstructing index is fiddly across nesting).
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => `\n- ${stripInner(body).trim()}`);

  // 5. Block-level breaks: <p>, <div>, <br>, <tr> all get a newline so
  // text doesn't run together. <br> also becomes a single newline.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|table|section|article|blockquote|pre)>/gi, '\n\n');

  // 6. Strip everything else (img, span, td, etc).
  s = s.replace(/<[^>]+>/g, '');

  // 7. Decode entities.
  s = decodeEntities(s);

  // 8. Collapse runs of blank lines to at most one blank line. Strip
  // trailing whitespace per line so the output is markdown-friendly.
  s = s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return s;
}

/** Inline-only strip helper — used inside heading + anchor + li bodies. */
function stripInner(s: string): string {
  return decodeEntities(
    s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' '),
  );
}

/**
 * Truncate text to `maxChars`, preferring to cut at a paragraph or
 * sentence boundary. Adds an ellipsis marker when truncation occurs so
 * downstream renderers can flag that more content exists.
 */
export function truncateAtBoundary(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  // Prefer the last paragraph boundary in the slice.
  const lastBlank = slice.lastIndexOf('\n\n');
  if (lastBlank > maxChars * 0.6) {
    return { text: slice.slice(0, lastBlank).trimEnd(), truncated: true };
  }
  // Fall back to the last sentence boundary.
  const lastSentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (lastSentence > maxChars * 0.6) {
    return { text: slice.slice(0, lastSentence + 1), truncated: true };
  }
  // Hard cut.
  return { text: slice.trimEnd(), truncated: true };
}
