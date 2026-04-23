/**
 * Messaging — InboxFilter evaluator tests.
 */

import { assertEquals } from 'jsr:@std/assert';
import { evaluateFilter, mainViewFilter, DEFAULT_HIDDEN_LABELS } from '../src/messaging/filter.ts';
import type { InboxFilter, InboxItem } from '../src/messaging/types.ts';

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

// ============================================================================
// Regex / headers — InboxFilter.fields_regex, text_regex, headers
// ============================================================================

const emailItem: InboxItem = {
  id: 'item-email',
  source: 'cf-email',
  source_version: 'email/v1',
  received_at: '2026-04-22T12:00:00Z',
  summary: 'Please confirm your subscription',
  body: 'Click here for a password reset link if you need one.',
  fields: {
    from_email: 'noreply@mailer-daemon.example.com',
    subject: 'Please confirm your subscription',
    headers: {
      'list-unsubscribe': '<https://example.com/unsub?u=123>',
      'auto-submitted': 'auto-generated',
      'content-type': 'text/html; charset=utf-8',
    },
  },
  labels: [],
};

Deno.test('filter — fields_regex matches exact regex', () => {
  const ok = evaluateFilter(
    { fields_regex: { from_email: '^.*@(mailer-daemon|noreply)\\.' } },
    emailItem,
  );
  assertEquals(ok, true);
});

Deno.test('filter — fields_regex array value is OR', () => {
  const ok = evaluateFilter(
    { fields_regex: { from_email: ['never-matches-xyz', '^noreply@'] } },
    emailItem,
  );
  assertEquals(ok, true);

  const miss = evaluateFilter(
    { fields_regex: { from_email: ['^foo@', '^bar@'] } },
    emailItem,
  );
  assertEquals(miss, false);
});

Deno.test('filter — fields_regex on missing field is false', () => {
  assertEquals(
    evaluateFilter({ fields_regex: { not_a_field: '.*' } }, emailItem),
    false,
  );
});

Deno.test('filter — fields_regex is case-insensitive by default', () => {
  assertEquals(
    evaluateFilter({ fields_regex: { from_email: 'MAILER-DAEMON' } }, emailItem),
    true,
  );
});

Deno.test('filter — text_regex matches summary or body', () => {
  assertEquals(evaluateFilter({ text_regex: 'password reset' }, emailItem), true);
  assertEquals(evaluateFilter({ text_regex: 'confirm your subscription' }, emailItem), true);
  assertEquals(evaluateFilter({ text_regex: 'unrelated.*topic' }, emailItem), false);
});

Deno.test('filter — headers present when header exists', () => {
  assertEquals(
    evaluateFilter({ headers: { 'list-unsubscribe': 'present' } }, emailItem),
    true,
  );
  // Case of the rule key normalizes to lowercase for lookup.
  assertEquals(
    evaluateFilter({ headers: { 'List-Unsubscribe': 'present' } }, emailItem),
    true,
  );
  assertEquals(
    evaluateFilter({ headers: { 'x-not-there': 'present' } }, emailItem),
    false,
  );
});

Deno.test('filter — headers absent when header missing', () => {
  assertEquals(
    evaluateFilter({ headers: { 'x-not-there': 'absent' } }, emailItem),
    true,
  );
  assertEquals(
    evaluateFilter({ headers: { 'list-unsubscribe': 'absent' } }, emailItem),
    false,
  );
});

Deno.test('filter — headers with regex value matches header content', () => {
  assertEquals(
    evaluateFilter({ headers: { 'auto-submitted': 'auto-generated' } }, emailItem),
    true,
  );
  assertEquals(
    evaluateFilter({ headers: { 'content-type': '^text/' } }, emailItem),
    true,
  );
  assertEquals(
    evaluateFilter({ headers: { 'content-type': '^application/json' } }, emailItem),
    false,
  );
  // Missing header with regex rule → no-match (not present → empty value)
  assertEquals(
    evaluateFilter({ headers: { 'x-not-there': '.*' } }, emailItem),
    false,
  );
});

Deno.test('filter — invalid regex is skipped (no throw, no match)', () => {
  // Invalid regex in fields_regex
  assertEquals(
    evaluateFilter({ fields_regex: { from_email: '([a-z' } }, emailItem),
    false,
  );
  // Invalid regex in text_regex
  assertEquals(
    evaluateFilter({ text_regex: '([a-z' }, emailItem),
    false,
  );
  // Invalid regex in headers rule
  assertEquals(
    evaluateFilter({ headers: { 'content-type': '([a-z' } }, emailItem),
    false,
  );
});

Deno.test('filter — fields_regex on array field value matches any entry', () => {
  const item: InboxItem = {
    ...emailItem,
    fields: { ...emailItem.fields, to_addrs: ['alice@x.com', 'bob@example.org'] },
  };
  assertEquals(
    evaluateFilter({ fields_regex: { to_addrs: '@example\\.org$' } }, item),
    true,
  );
});

// ============================================================================
// mainViewFilter helper
// ============================================================================

Deno.test('mainViewFilter — no base: returns default hidden labels as exclude_labels', () => {
  const filter = mainViewFilter();
  assertEquals(filter.exclude_labels, DEFAULT_HIDDEN_LABELS);
});

Deno.test('mainViewFilter — base with no exclude_labels: adds hidden', () => {
  const filter = mainViewFilter({ labels: ['newsletter'] });
  assertEquals(filter.labels, ['newsletter']);
  assertEquals(filter.exclude_labels, ['archived', 'quarantined']);
});

Deno.test('mainViewFilter — base with existing exclude_labels: merges + dedups', () => {
  const filter = mainViewFilter({ exclude_labels: ['archived', 'spam'] });
  // Set union: archived (dup), spam (preserved), quarantined (added)
  assertEquals(filter.exclude_labels?.sort(), ['archived', 'quarantined', 'spam']);
});

Deno.test('mainViewFilter — custom hiddenLabels override default', () => {
  const filter = mainViewFilter(undefined, { hiddenLabels: ['read-later'] });
  assertEquals(filter.exclude_labels, ['read-later']);
});

Deno.test('mainViewFilter — preserves all other base filter fields', () => {
  const base: InboxFilter = {
    labels: ['newsletter'],
    fields: { from_email: 'substack' },
    text: 'weekly',
    since: '2026-01-01',
  };
  const filter = mainViewFilter(base);
  assertEquals(filter.labels, ['newsletter']);
  assertEquals(filter.fields, { from_email: 'substack' });
  assertEquals(filter.text, 'weekly');
  assertEquals(filter.since, '2026-01-01');
  assertEquals(filter.exclude_labels, ['archived', 'quarantined']);
});

Deno.test('mainViewFilter — does not mutate base', () => {
  const base: InboxFilter = { exclude_labels: ['spam'] };
  const filter = mainViewFilter(base);
  // Base still has its original single entry
  assertEquals(base.exclude_labels, ['spam']);
  // Returned filter has the merged set
  assertEquals(filter.exclude_labels?.sort(), ['archived', 'quarantined', 'spam']);
});

Deno.test('mainViewFilter — evaluator correctly hides archived items when filter applied', () => {
  const archivedItem: InboxItem = {
    ...baseItem,
    labels: ['newsletter', 'archived'],
  };
  const mainItem: InboxItem = {
    ...baseItem,
    labels: ['newsletter'],
  };
  const filter = mainViewFilter({ labels: ['newsletter'] });
  assertEquals(evaluateFilter(filter, archivedItem), false);
  assertEquals(evaluateFilter(filter, mainItem), true);
});
