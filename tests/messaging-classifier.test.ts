/**
 * Messaging — Header-based classifier tests.
 */

import { assertEquals } from 'jsr:@std/assert';
import { classify, classifyAndMerge } from '../src/messaging/classifier.ts';
import type { InboxItem } from '../src/messaging/types.ts';

function makeItem(overrides: Partial<InboxItem> = {}, fields: Record<string, any> = {}): InboxItem {
  return {
    id: 'item-test',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-23T12:00:00Z',
    summary: 'test',
    body: null,
    fields: { ...fields },
    ...overrides,
  };
}

// ============================================================================
// Missing / empty headers
// ============================================================================

Deno.test('classifier — no headers field returns []', () => {
  const item = makeItem({}, {});
  assertEquals(classify(item), []);
});

Deno.test('classifier — empty headers map returns []', () => {
  const item = makeItem({}, { headers: {} });
  assertEquals(classify(item), []);
});

Deno.test('classifier — unrelated headers return []', () => {
  const item = makeItem({}, {
    headers: {
      'subject': 'Hello',
      'date': 'Thu, 23 Apr 2026 12:00:00 +0000',
    },
  });
  assertEquals(classify(item), []);
});

// ============================================================================
// newsletter / list
// ============================================================================

Deno.test('classifier — list-unsubscribe -> [newsletter]', () => {
  const item = makeItem({}, {
    headers: { 'list-unsubscribe': '<mailto:u@example.com>' },
  });
  assertEquals(classify(item), ['newsletter']);
});

Deno.test('classifier — list-id alone -> [list]', () => {
  const item = makeItem({}, {
    headers: { 'list-id': 'my-list.example.com' },
  });
  assertEquals(classify(item), ['list']);
});

Deno.test('classifier — list-id + list-post does NOT duplicate list label', () => {
  const item = makeItem({}, {
    headers: {
      'list-id': 'my-list.example.com',
      'list-post': '<mailto:my-list@example.com>',
    },
  });
  assertEquals(classify(item), ['list']);
});

Deno.test('classifier — list-help alone -> [list]', () => {
  const item = makeItem({}, {
    headers: { 'list-help': '<mailto:help@example.com>' },
  });
  assertEquals(classify(item), ['list']);
});

// ============================================================================
// bulk
// ============================================================================

Deno.test('classifier — precedence: bulk -> [bulk]', () => {
  const item = makeItem({}, { headers: { 'precedence': 'bulk' } });
  assertEquals(classify(item), ['bulk']);
});

Deno.test('classifier — precedence: Bulk (mixed case) -> [bulk]', () => {
  const item = makeItem({}, { headers: { 'precedence': 'Bulk' } });
  assertEquals(classify(item), ['bulk']);
});

Deno.test('classifier — precedence: list -> [bulk]', () => {
  const item = makeItem({}, { headers: { 'precedence': 'list' } });
  assertEquals(classify(item), ['bulk']);
});

Deno.test('classifier — precedence: junk (non-matching) -> []', () => {
  const item = makeItem({}, { headers: { 'precedence': 'junk' } });
  assertEquals(classify(item), []);
});

// ============================================================================
// auto-reply
// ============================================================================

Deno.test('classifier — auto-submitted: auto-generated -> [auto-reply]', () => {
  const item = makeItem({}, { headers: { 'auto-submitted': 'auto-generated' } });
  assertEquals(classify(item), ['auto-reply']);
});

Deno.test('classifier — auto-submitted: auto-replied -> [auto-reply]', () => {
  const item = makeItem({}, { headers: { 'auto-submitted': 'auto-replied' } });
  assertEquals(classify(item), ['auto-reply']);
});

Deno.test('classifier — auto-submitted: no does NOT emit auto-reply', () => {
  const item = makeItem({}, { headers: { 'auto-submitted': 'no' } });
  assertEquals(classify(item), []);
});

Deno.test('classifier — auto-submitted: NO (uppercase) does NOT emit', () => {
  const item = makeItem({}, { headers: { 'auto-submitted': 'NO' } });
  assertEquals(classify(item), []);
});

Deno.test('classifier — precedence: auto_reply -> [auto-reply]', () => {
  const item = makeItem({}, { headers: { 'precedence': 'auto_reply' } });
  assertEquals(classify(item), ['auto-reply']);
});

Deno.test('classifier — x-auto-response-suppress present -> [auto-reply]', () => {
  const item = makeItem({}, {
    headers: { 'x-auto-response-suppress': 'OOF, AutoReply' },
  });
  assertEquals(classify(item), ['auto-reply']);
});

Deno.test('classifier — x-autoreply present -> [auto-reply]', () => {
  const item = makeItem({}, { headers: { 'x-autoreply': 'yes' } });
  assertEquals(classify(item), ['auto-reply']);
});

// ============================================================================
// bounce
// ============================================================================

Deno.test('classifier — return-path: <> -> [bounce]', () => {
  const item = makeItem({}, { headers: { 'return-path': '<>' } });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — return-path: empty -> [bounce]', () => {
  const item = makeItem({}, { headers: { 'return-path': '' } });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — return-path: normal addr does NOT emit bounce', () => {
  const item = makeItem({}, {
    headers: { 'return-path': '<alice@example.com>' },
  });
  assertEquals(classify(item), []);
});

Deno.test('classifier — x-failed-recipients present -> [bounce]', () => {
  const item = makeItem({}, {
    headers: { 'x-failed-recipients': 'missing@example.com' },
  });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — content-type: multipart/report -> [bounce]', () => {
  const item = makeItem({}, {
    headers: { 'content-type': 'multipart/report; report-type=delivery-status' },
  });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — from_email: mailer-daemon -> [bounce]', () => {
  const item = makeItem({}, {
    from_email: 'mailer-daemon@example.com',
    headers: { 'subject': 'undeliverable' },
  });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — from_email: postmaster -> [bounce]', () => {
  const item = makeItem({}, {
    from_email: 'postmaster@example.com',
    headers: { 'subject': 'hello' },
  });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — bounce via from header (no from_email field)', () => {
  const item = makeItem({}, {
    headers: {
      'from': 'Mail Delivery Subsystem <MAILER-DAEMON@mail.example.com>',
      'subject': 'Returned mail',
    },
  });
  assertEquals(classify(item), ['bounce']);
});

Deno.test('classifier — bounce via from_email works even without headers map', () => {
  const item = makeItem({}, { from_email: 'mailer-daemon@example.com' });
  assertEquals(classify(item), ['bounce']);
});

// ============================================================================
// Combined
// ============================================================================

Deno.test('classifier — newsletter + list combined', () => {
  const item = makeItem({}, {
    headers: {
      'list-unsubscribe': '<mailto:u@example.com>',
      'list-id': 'my-list.example.com',
      'list-post': '<mailto:my-list@example.com>',
    },
  });
  const labels = classify(item);
  assertEquals(new Set(labels), new Set(['newsletter', 'list']));
  assertEquals(labels.length, 2);
});

Deno.test('classifier — newsletter + bulk + list combined', () => {
  const item = makeItem({}, {
    headers: {
      'list-unsubscribe': '<mailto:u@example.com>',
      'list-id': 'my-list.example.com',
      'precedence': 'bulk',
    },
  });
  const labels = classify(item);
  assertEquals(new Set(labels), new Set(['newsletter', 'list', 'bulk']));
});

Deno.test('classifier — bounce signals dedup across sources', () => {
  const item = makeItem({}, {
    from_email: 'mailer-daemon@example.com',
    headers: {
      'return-path': '<>',
      'x-failed-recipients': 'missing@example.com',
      'from': 'MAILER-DAEMON@example.com',
    },
  });
  const labels = classify(item);
  assertEquals(labels, ['bounce']);
});

Deno.test('classifier — case-insensitive header key lookup (defensive)', () => {
  // The headers map is expected lowercase-keyed; this double-checks the
  // classifier still finds headers if a future channel forgets to lowercase.
  const item = makeItem({}, {
    headers: { 'List-Unsubscribe': '<mailto:u@example.com>' },
  });
  assertEquals(classify(item), ['newsletter']);
});

// ============================================================================
// Purity
// ============================================================================

Deno.test('classifier — does not mutate input', () => {
  const headers = {
    'list-unsubscribe': '<mailto:u@example.com>',
    'precedence': 'bulk',
  };
  const fields = { headers };
  const item = makeItem({ labels: ['existing'] }, fields);
  const snapshot = JSON.stringify(item);
  classify(item);
  assertEquals(JSON.stringify(item), snapshot);
});

// ============================================================================
// classifyAndMerge
// ============================================================================

Deno.test('classifyAndMerge — preserves existing labels + adds new ones', () => {
  const item = makeItem({ labels: ['existing', 'manual'] }, {
    headers: { 'list-unsubscribe': '<mailto:u@example.com>' },
  });
  const out = classifyAndMerge(item);
  assertEquals(out.labels, ['existing', 'manual', 'newsletter']);
});

Deno.test('classifyAndMerge — deduplicates overlapping labels', () => {
  const item = makeItem({ labels: ['newsletter', 'keep-me'] }, {
    headers: { 'list-unsubscribe': '<mailto:u@example.com>' },
  });
  const out = classifyAndMerge(item);
  assertEquals(out.labels, ['newsletter', 'keep-me']);
});

Deno.test('classifyAndMerge — empty existing labels + no classification -> []', () => {
  const item = makeItem({}, {});
  const out = classifyAndMerge(item);
  assertEquals(out.labels, []);
});

Deno.test('classifyAndMerge — does not mutate input', () => {
  const item = makeItem({ labels: ['existing'] }, {
    headers: { 'list-unsubscribe': '<mailto:u@example.com>' },
  });
  const snapshot = JSON.stringify(item);
  const out = classifyAndMerge(item);
  assertEquals(JSON.stringify(item), snapshot);
  // And the output is a fresh object
  assertEquals(out !== item, true);
});

Deno.test('classifyAndMerge — merges multiple classified labels', () => {
  const item = makeItem({}, {
    headers: {
      'list-unsubscribe': '<mailto:u@example.com>',
      'list-id': 'my-list.example.com',
      'precedence': 'bulk',
    },
  });
  const out = classifyAndMerge(item);
  assertEquals(new Set(out.labels), new Set(['newsletter', 'list', 'bulk']));
});
