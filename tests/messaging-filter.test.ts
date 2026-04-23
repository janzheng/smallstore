/**
 * Messaging — InboxFilter evaluator tests.
 */

import { assertEquals } from 'jsr:@std/assert';
import { evaluateFilter } from '../src/messaging/filter.ts';
import type { InboxItem } from '../src/messaging/types.ts';

const baseItem: InboxItem = {
  id: 'item1',
  source: 'cf-email',
  source_version: 'email/v1',
  received_at: '2026-04-22T12:00:00Z',
  summary: 'Stratechery Weekly Update',
  body: 'Today we discuss the new chip strategy and Apple Silicon market dynamics.',
  fields: {
    from_email: 'newsletters@stratechery.com',
    to_addrs: ['inbox@labspace.ai'],
    subject: 'Stratechery Weekly Update',
  },
  labels: ['newsletter'],
  thread_id: 'thread-1',
};

Deno.test('filter — empty filter matches everything', () => {
  assertEquals(evaluateFilter({}, baseItem), true);
});

Deno.test('filter — single field exact-string match', () => {
  assertEquals(evaluateFilter({ fields: { from_email: 'newsletters@stratechery.com' } }, baseItem), true);
});

Deno.test('filter — field substring match (case-insensitive)', () => {
  assertEquals(evaluateFilter({ fields: { from_email: 'STRATECHERY' } }, baseItem), true);
  assertEquals(evaluateFilter({ fields: { subject: 'weekly' } }, baseItem), true);
});

Deno.test('filter — field array OR-of-values', () => {
  const result = evaluateFilter(
    { fields: { from_email: ['unrelated@x.com', 'newsletters@stratechery.com'] } },
    baseItem,
  );
  assertEquals(result, true);
});

Deno.test('filter — field miss returns false', () => {
  assertEquals(evaluateFilter({ fields: { from_email: 'someone-else@example.com' } }, baseItem), false);
});

Deno.test('filter — missing field returns false', () => {
  assertEquals(evaluateFilter({ fields: { not_a_field: 'x' } }, baseItem), false);
});

Deno.test('filter — text searches across summary + body (case-insensitive)', () => {
  assertEquals(evaluateFilter({ text: 'apple silicon' }, baseItem), true);
  assertEquals(evaluateFilter({ text: 'WEEKLY UPDATE' }, baseItem), true);
  assertEquals(evaluateFilter({ text: 'unrelated topic' }, baseItem), false);
});

Deno.test('filter — labels (must have ALL)', () => {
  assertEquals(evaluateFilter({ labels: ['newsletter'] }, baseItem), true);
  assertEquals(evaluateFilter({ labels: ['newsletter', 'important'] }, baseItem), false);
});

Deno.test('filter — exclude_labels (must have NONE)', () => {
  assertEquals(evaluateFilter({ exclude_labels: ['spam'] }, baseItem), true);
  assertEquals(evaluateFilter({ exclude_labels: ['newsletter'] }, baseItem), false);
});

Deno.test('filter — since/until on received_at', () => {
  assertEquals(evaluateFilter({ since: '2026-01-01T00:00:00Z' }, baseItem), true);
  assertEquals(evaluateFilter({ since: '2026-05-01T00:00:00Z' }, baseItem), false);
  assertEquals(evaluateFilter({ until: '2026-12-31T00:00:00Z' }, baseItem), true);
  assertEquals(evaluateFilter({ until: '2026-01-01T00:00:00Z' }, baseItem), false);
});

Deno.test('filter — source match', () => {
  assertEquals(evaluateFilter({ source: 'cf-email' }, baseItem), true);
  assertEquals(evaluateFilter({ source: 'webhook' }, baseItem), false);
  assertEquals(evaluateFilter({ source: ['rss', 'cf-email'] }, baseItem), true);
});

Deno.test('filter — thread_id match', () => {
  assertEquals(evaluateFilter({ thread_id: 'thread-1' }, baseItem), true);
  assertEquals(evaluateFilter({ thread_id: 'thread-99' }, baseItem), false);
});

Deno.test('filter — array field value matches (to_addrs)', () => {
  assertEquals(evaluateFilter({ fields: { to_addrs: 'labspace.ai' } }, baseItem), true);
  assertEquals(evaluateFilter({ fields: { to_addrs: 'someone-else.com' } }, baseItem), false);
});

Deno.test('filter — top-level keys AND together', () => {
  // Both must match
  const ok = evaluateFilter(
    { fields: { from_email: 'stratechery' }, text: 'apple' },
    baseItem,
  );
  assertEquals(ok, true);

  // One fails
  const fail = evaluateFilter(
    { fields: { from_email: 'stratechery' }, text: 'unrelated' },
    baseItem,
  );
  assertEquals(fail, false);
});
