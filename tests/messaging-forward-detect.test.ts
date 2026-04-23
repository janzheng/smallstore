/**
 * Messaging — forward-detection hook tests.
 *
 * Covers detection signals, header-vs-body extraction priority, and the
 * PreIngestHook wiring. Uses synthetic InboxItems — the hook operates on
 * parsed items, so no .eml fixtures needed.
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';
import {
  createForwardDetectHook,
  detectForward,
  parseSelfAddresses,
} from '../src/messaging/forward-detect.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

const SELF = ['me@example.com', 'user@labspace.ai'];

function makeItem(
  overrides: Partial<InboxItem> = {},
  fields: Record<string, any> = {},
  body: string | null = null,
): InboxItem {
  return {
    id: 'item-test',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-23T12:00:00Z',
    summary: fields.subject ?? 'test',
    body,
    fields: { ...fields },
    ...overrides,
  };
}

const CTX: HookContext = { channel: 'cf-email', registration: 'test' };

// ============================================================================
// Baseline: not a forward
// ============================================================================

Deno.test('detectForward — plain mail is not a forward', () => {
  const item = makeItem({}, {
    from_email: 'alice@external.com',
    subject: 'Hey there',
    headers: { 'from': 'Alice <alice@external.com>' },
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, false);
  assertEquals(r.labels, []);
  assertEquals(r.original_from_email, undefined);
  assertEquals(r.original_from_addr, undefined);
  assertEquals(r.original_subject, undefined);
});

// ============================================================================
// Signal: from_email matches self
// ============================================================================

Deno.test('detectForward — from_email matches self → forwarded', () => {
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: important thing',
    headers: {},
  }, 'hi — sharing this.');
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.labels, ['forwarded', 'manual']);
});

Deno.test('detectForward — case-insensitive self-address match', () => {
  const item = makeItem({}, {
    from_email: 'ME@Example.COM',
    subject: 'Fwd: shared',
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
});

Deno.test('detectForward — custom labels option is honored', () => {
  const item = makeItem({}, { from_email: 'me@example.com' });
  const r = detectForward(item, {
    selfAddresses: SELF,
    labels: ['bookmark', 'user-forward'],
  });
  assertEquals(r.labels, ['bookmark', 'user-forward']);
});

// ============================================================================
// Signal: X-Forwarded-For / X-Forwarded-From / Resent-From headers
// ============================================================================

Deno.test('detectForward — x-forwarded-for header alone → forwarded', () => {
  const item = makeItem({}, {
    from_email: 'stranger@other.com',
    subject: 'just a thing',
    headers: { 'x-forwarded-for': 'relay@example.com' },
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.labels, ['forwarded', 'manual']);
});

Deno.test('detectForward — resent-from header → forwarded + original extracted', () => {
  const item = makeItem({}, {
    from_email: 'stranger@other.com',
    subject: 'See below',
    headers: { 'resent-from': 'Alice Example <alice@external.com>' },
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, 'alice@external.com');
  assertEquals(r.original_from_addr, 'Alice Example <alice@external.com>');
});

Deno.test('detectForward — x-forwarded-from header → original email extracted', () => {
  const item = makeItem({}, {
    from_email: 'stranger@other.com',
    headers: { 'x-forwarded-from': 'Bob <bob@bobs.co>' },
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, 'bob@bobs.co');
});

// ============================================================================
// Signal strength: subject "Fwd:" alone is NOT enough
// ============================================================================

Deno.test('detectForward — subject "Fwd:" alone (external sender, no body sep) → NOT forwarded', () => {
  const item = makeItem({}, {
    from_email: 'stranger@other.com',
    subject: 'Fwd: check this out',
    headers: {},
  }, 'A short note with no separator.');
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, false);
  assertEquals(r.labels, []);
});

Deno.test('detectForward — subject "Fwd:" + from=self → forwarded + original_subject de-prefixed', () => {
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Re: Weekly digest',
    headers: {},
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  // Without a body separator the subject-strip fallback kicks in.
  assertEquals(r.original_subject, 'Weekly digest');
});

Deno.test('detectForward — subject "FW:" + from=self → forwarded (case insensitive prefix)', () => {
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'FW: urgent',
  });
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
});

// ============================================================================
// Body parsing: Gmail forward pattern
// ============================================================================

Deno.test('detectForward — Gmail forward pattern body extracts original sender', () => {
  const body = [
    'Thought you\'d want to see this.',
    '',
    '---------- Forwarded message ----------',
    'From: Jane Doe <jane@example.com>',
    'Date: Tue, Apr 22, 2026 at 10:00 AM',
    'Subject: The real subject',
    'To: me@example.com',
    '',
    'Original body here.',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: The real subject',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, 'jane@example.com');
  assertEquals(r.original_from_addr, 'Jane Doe <jane@example.com>');
  assertEquals(r.original_subject, 'The real subject');
});

// ============================================================================
// Body parsing: Outlook pattern
// ============================================================================

Deno.test('detectForward — Outlook "-----Original Message-----" pattern extracts original', () => {
  const body = [
    'Sharing this.',
    '',
    '-----Original Message-----',
    'From: Carol Outlook <carol@outlook-domain.com>',
    'Sent: Monday, April 21, 2026 8:15 AM',
    'To: Me <me@example.com>',
    'Subject: Project update',
    '',
    'Here is the update text.',
  ].join('\r\n'); // Outlook frequently uses CRLF
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'FW: Project update',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, 'carol@outlook-domain.com');
  assertEquals(r.original_subject, 'Project update');
});

// ============================================================================
// Body parsing: Apple Mail pattern
// ============================================================================

Deno.test('detectForward — Apple Mail "Begin forwarded message:" pattern extracts original', () => {
  const body = [
    'FYI.',
    '',
    'Begin forwarded message:',
    '',
    'From: dave@apple-sender.test',
    'Date: April 20, 2026 at 4:32:10 PM PDT',
    'To: me@example.com',
    'Subject: Re: newsletter digest',
    '',
    'Here is the forwarded content.',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Re: newsletter digest',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, 'dave@apple-sender.test');
  // "Re:" prefix should be stripped from the subject.
  assertEquals(r.original_subject, 'newsletter digest');
});

// ============================================================================
// Body parsing: header beats body
// ============================================================================

Deno.test('detectForward — resent-from header wins over body From: line', () => {
  const body = [
    '---------- Forwarded message ----------',
    'From: Body Sender <body@somewhere.com>',
    'Subject: The subject',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: The subject',
    headers: { 'resent-from': 'Header Sender <header@elsewhere.com>' },
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, 'header@elsewhere.com');
  assertEquals(r.original_from_addr, 'Header Sender <header@elsewhere.com>');
  // Body still supplies the subject.
  assertEquals(r.original_subject, 'The subject');
});

// ============================================================================
// Graceful degradation: no parseable forward block
// ============================================================================

Deno.test('detectForward — body with no forward pattern: forwarded=true, originals undefined', () => {
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Some thought',
    headers: {},
  }, 'Just a plain forwarded message body with no separator inside.');
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.original_from_email, undefined);
  assertEquals(r.original_from_addr, undefined);
  assertEquals(r.original_subject, undefined);
});

Deno.test('detectForward — null body does not throw', () => {
  const item = makeItem({ body: null }, {
    from_email: 'me@example.com',
  });
  // Should not throw even with null body.
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
});

// ============================================================================
// Purity / non-mutation
// ============================================================================

Deno.test('detectForward — does not mutate input', () => {
  const item = makeItem({ labels: ['existing'] }, {
    from_email: 'me@example.com',
    subject: 'Fwd: Weekly digest',
    headers: { 'resent-from': 'Alice <alice@x.com>' },
  }, '---------- Forwarded message ----------\nFrom: Alice <alice@x.com>\nSubject: Weekly digest\n');
  const snapshot = JSON.stringify(item);
  detectForward(item, { selfAddresses: SELF });
  assertEquals(JSON.stringify(item), snapshot);
});

// ============================================================================
// Hook wiring
// ============================================================================

Deno.test('createForwardDetectHook — returns accept when not a forward', async () => {
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const item = makeItem({}, {
    from_email: 'alice@external.com',
    subject: 'Hey',
  });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('createForwardDetectHook — returns mutated item when forwarded', async () => {
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const body = [
    '---------- Forwarded message ----------',
    'From: Jane Doe <jane@example.com>',
    'Subject: The real subject',
  ].join('\n');
  const item = makeItem({ labels: ['pre-existing'] }, {
    from_email: 'me@example.com',
    subject: 'Fwd: The real subject',
  }, body);
  const verdict = await hook(item, CTX);
  // Verdict must be the mutated item, not a string.
  assert(typeof verdict === 'object', 'hook should return a mutated item');
  if (typeof verdict === 'string') throw new Error('expected item verdict');
  assertEquals(verdict.labels, ['pre-existing', 'forwarded', 'manual']);
  assertEquals(verdict.fields.original_from_email, 'jane@example.com');
  assertEquals(verdict.fields.original_from_addr, 'Jane Doe <jane@example.com>');
  assertEquals(verdict.fields.original_subject, 'The real subject');
  // Input must not be mutated.
  assertEquals(item.labels, ['pre-existing']);
  assertExists(item.fields.from_email);
  assertEquals(item.fields.original_from_email, undefined);
});

Deno.test('createForwardDetectHook — does not duplicate labels already present', async () => {
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const item = makeItem({ labels: ['forwarded', 'keep'] }, {
    from_email: 'me@example.com',
    subject: 'Fwd: something',
  });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected item verdict');
  assertEquals(verdict.labels, ['forwarded', 'keep', 'manual']);
});

// ============================================================================
// parseSelfAddresses
// ============================================================================

Deno.test('parseSelfAddresses — comma-separated string → lowercased, trimmed, deduped array', () => {
  const out = parseSelfAddresses('  Me@Example.com ,user@labspace.ai,  ME@example.com  , ');
  assertEquals(out, ['me@example.com', 'user@labspace.ai']);
});

Deno.test('parseSelfAddresses — undefined → []', () => {
  assertEquals(parseSelfAddresses(undefined), []);
});

Deno.test('parseSelfAddresses — empty string → []', () => {
  assertEquals(parseSelfAddresses(''), []);
});

Deno.test('parseSelfAddresses — array input → lowercased & deduped', () => {
  const out = parseSelfAddresses(['A@X.com', 'a@x.com', ' b@y.com ']);
  assertEquals(out, ['a@x.com', 'b@y.com']);
});
