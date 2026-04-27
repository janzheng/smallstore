/**
 * Tests for the newsletter-shaped HTML → plain text converter.
 *
 * Not exhaustive HTML coverage — focused on the shapes the mailroom mirror
 * actually encounters in newsletter platforms (Substack, Every, Beehiiv,
 * EmailOctopus, ConvertKit) and the failure modes we care about (script
 * leakage, entity garbage, runaway whitespace).
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { htmlToText, truncateAtBoundary } from '../src/messaging/html-to-text.ts';

Deno.test('htmlToText — empty input', () => {
  assertEquals(htmlToText(''), '');
  assertEquals(htmlToText(undefined), '');
  assertEquals(htmlToText(null), '');
});

Deno.test('htmlToText — strips script and style blocks', () => {
  const out = htmlToText(`
    <html><head><style>body{color:red}</style></head>
    <body>
      <script>alert('x')</script>
      <p>Hello world</p>
    </body></html>
  `);
  assertEquals(out.includes('alert'), false);
  assertEquals(out.includes('color:red'), false);
  assertStringIncludes(out, 'Hello world');
});

Deno.test('htmlToText — preserves heading structure as markdown', () => {
  const out = htmlToText('<h1>Title</h1><h2>Section</h2><p>Body text</p>');
  assertStringIncludes(out, '# Title');
  assertStringIncludes(out, '## Section');
  assertStringIncludes(out, 'Body text');
});

Deno.test('htmlToText — anchor with distinct text → markdown link', () => {
  const out = htmlToText('<a href="https://example.com">click here</a>');
  assertStringIncludes(out, '[click here](https://example.com)');
});

Deno.test('htmlToText — anchor where text equals href → bare URL (no [url](url) noise)', () => {
  const out = htmlToText('<a href="https://example.com">https://example.com</a>');
  assertEquals(out.trim(), 'https://example.com');
});

Deno.test('htmlToText — list items become "- " bullets', () => {
  const out = htmlToText('<ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul>');
  assertStringIncludes(out, '- Apple');
  assertStringIncludes(out, '- Banana');
  assertStringIncludes(out, '- Cherry');
});

Deno.test('htmlToText — paragraphs separated by blank lines', () => {
  const out = htmlToText('<p>First.</p><p>Second.</p><p>Third.</p>');
  // Each paragraph on its own, blank line between.
  assert(out.includes('First.\n\nSecond.\n\nThird.'));
});

Deno.test('htmlToText — <br> becomes newline', () => {
  const out = htmlToText('Line one<br>Line two<br/>Line three');
  assertEquals(out, 'Line one\nLine two\nLine three');
});

Deno.test('htmlToText — decodes named entities', () => {
  const out = htmlToText('Tom &amp; Jerry &lt;3 &mdash; &nbsp; &ldquo;quotes&rdquo;');
  assertStringIncludes(out, 'Tom & Jerry');
  assertStringIncludes(out, '<3');
  assertStringIncludes(out, '—');
  assertStringIncludes(out, '“quotes”');
});

Deno.test('htmlToText — decodes numeric entities', () => {
  const out = htmlToText('caf&#233; &#x2014; rocks');
  assertStringIncludes(out, 'café');
  assertStringIncludes(out, '—');
});

Deno.test('htmlToText — strips inline styling tags but keeps text', () => {
  const out = htmlToText('<p>Bold <strong>word</strong> and <em>italic</em> text</p>');
  assertStringIncludes(out, 'Bold word and italic text');
});

Deno.test('htmlToText — collapses 3+ consecutive blank lines to a single blank', () => {
  const out = htmlToText('<p>One</p><br><br><br><br><p>Two</p>');
  // Should not contain 3+ \n in a row.
  assertEquals(/\n{3,}/.test(out), false);
});

Deno.test('htmlToText — newsletter-shape sample (h1 + p + a + ul)', () => {
  const out = htmlToText(`
    <html><body>
      <h1>You Are the Most Expensive Model</h1>
      <p>Today's piece looks at <a href="https://every.to/p/123">Tyler's analysis</a>.</p>
      <ul>
        <li>Point one</li>
        <li>Point two</li>
      </ul>
      <p>Subscribe at <a href="https://every.to">https://every.to</a>.</p>
    </body></html>
  `);
  assertStringIncludes(out, '# You Are the Most Expensive Model');
  assertStringIncludes(out, "[Tyler's analysis](https://every.to/p/123)");
  assertStringIncludes(out, '- Point one');
  assertStringIncludes(out, '- Point two');
  assertStringIncludes(out, 'Subscribe at https://every.to');
});

Deno.test('htmlToText — table layouts: contents preserved, chrome dropped', () => {
  const out = htmlToText(`
    <table><tr><td>Cell A</td><td>Cell B</td></tr><tr><td>Cell C</td><td>Cell D</td></tr></table>
  `);
  // Cells flatten with row breaks; we don't try to reconstruct columns.
  assertStringIncludes(out, 'Cell A');
  assertStringIncludes(out, 'Cell B');
  assertStringIncludes(out, 'Cell C');
  assertStringIncludes(out, 'Cell D');
});

Deno.test('htmlToText — comment blocks stripped', () => {
  const out = htmlToText('<p>Visible</p><!-- secret --><p>Also visible</p>');
  assertEquals(out.includes('secret'), false);
  assertStringIncludes(out, 'Visible');
  assertStringIncludes(out, 'Also visible');
});

// ============================================================================
// truncateAtBoundary
// ============================================================================

Deno.test('truncateAtBoundary — under limit returns unchanged, not truncated', () => {
  const r = truncateAtBoundary('short text', 100);
  assertEquals(r.text, 'short text');
  assertEquals(r.truncated, false);
});

Deno.test('truncateAtBoundary — cuts at paragraph boundary when available', () => {
  const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
  const r = truncateAtBoundary(text, 50);
  // Should end at a \n\n boundary, not mid-sentence.
  assert(r.text.endsWith('here.'));
  assertEquals(r.truncated, true);
});

Deno.test('truncateAtBoundary — falls back to sentence boundary', () => {
  const text = 'Sentence one. Sentence two. Sentence three.';
  const r = truncateAtBoundary(text, 30);
  assert(r.text.endsWith('.'));
  assertEquals(r.truncated, true);
});

Deno.test('truncateAtBoundary — hard cut when no boundary available', () => {
  const text = 'a'.repeat(100);
  const r = truncateAtBoundary(text, 50);
  assertEquals(r.text.length, 50);
  assertEquals(r.truncated, true);
});
