/**
 * Messaging — filter spec markdown parser tests.
 */

import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { parseFilterSpec } from '../src/messaging/filter-spec.ts';

Deno.test('filter-spec — parses the canonical mailroom example', () => {
  const md = `---
name: stratechery
description: Stratechery weekly + Update
match:
  from_email_in:
    - newsletters@stratechery.com
    - update@stratechery.com
  since: 2026-01-01
materialize_to: items/newsletters/stratechery/
extract: body_text
---

Body content ignored.`;

  const spec = parseFilterSpec(md);
  assertEquals(spec.name, 'stratechery');
  assertEquals(spec.description, 'Stratechery weekly + Update');
  assertEquals(spec.filter.fields, {
    from_email: ['newsletters@stratechery.com', 'update@stratechery.com'],
  });
  assertEquals(spec.filter.since, '2026-01-01');
  assertEquals(spec.meta.materialize_to, 'items/newsletters/stratechery/');
  assertEquals(spec.meta.extract, 'body_text');
});

Deno.test('filter-spec — bare scalar field becomes single-string match', () => {
  const md = `---
match:
  from_email: alice@example.com
  subject: invoice
---`;
  const spec = parseFilterSpec(md);
  assertEquals(spec.filter.fields, { from_email: 'alice@example.com', subject: 'invoice' });
});

Deno.test('filter-spec — bare array on a field becomes OR-of-array', () => {
  const md = `---
match:
  subject:
    - invoice
    - receipt
---`;
  const spec = parseFilterSpec(md);
  assertEquals(spec.filter.fields, { subject: ['invoice', 'receipt'] });
});

Deno.test('filter-spec — top-level filter keys (text, labels, since, source)', () => {
  const md = `---
match:
  text: apple silicon
  labels: [important]
  exclude_labels: [spam, bounce]
  since: 2026-01-01
  until: 2026-12-31
  source: cf-email
---`;
  const spec = parseFilterSpec(md);
  assertEquals(spec.filter.text, 'apple silicon');
  assertEquals(spec.filter.labels, ['important']);
  assertEquals(spec.filter.exclude_labels, ['spam', 'bounce']);
  assertEquals(spec.filter.since, '2026-01-01');
  assertEquals(spec.filter.until, '2026-12-31');
  assertEquals(spec.filter.source, 'cf-email');
});

Deno.test('filter-spec — empty match block produces empty filter', () => {
  const md = `---
name: empty
match:
---`;
  const spec = parseFilterSpec(md);
  assertEquals(spec.filter, {});
});

Deno.test('filter-spec — missing match block produces empty filter', () => {
  const md = `---
name: no-match-block
description: just metadata
---`;
  const spec = parseFilterSpec(md);
  assertEquals(spec.filter, {});
});

Deno.test('filter-spec — meta passthrough preserves consumer fields', () => {
  const md = `---
name: x
custom_field: hello
materialize_to: out/
match:
  text: foo
---`;
  const spec = parseFilterSpec(md);
  assertEquals(spec.meta.custom_field, 'hello');
  assertEquals(spec.meta.materialize_to, 'out/');
});

Deno.test('filter-spec — throws on missing frontmatter', () => {
  assertThrows(() => parseFilterSpec('# Just a heading, no frontmatter'), Error, 'frontmatter');
});

Deno.test('filter-spec — throws on bad _in array', () => {
  const md = `---
match:
  from_email_in: not-an-array
---`;
  assertThrows(() => parseFilterSpec(md), Error, 'must be an array');
});
