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
  deriveNewsletterSlug,
  detectForward,
  extractForwardNote,
  parseForwardDate,
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
// Forward-note extraction
// ============================================================================

Deno.test('extractForwardNote — captures typed commentary above Gmail separator', () => {
  const body = [
    'Thought you\'d want to see this — the preprint looks relevant.',
    '',
    '---------- Forwarded message ----------',
    'From: Jane Doe <jane@example.com>',
    'Subject: bioRxiv preprint',
    '',
    'Original body.',
  ].join('\n');
  const note = extractForwardNote(body);
  assertEquals(note, 'Thought you\'d want to see this — the preprint looks relevant.');
});

Deno.test('extractForwardNote — multi-paragraph note preserved (runs of blank lines collapsed)', () => {
  const body = [
    'First thought.',
    '',
    '',
    '',
    'Second thought.',
    '',
    '-----Original Message-----',
    'From: x@y.com',
  ].join('\n');
  const note = extractForwardNote(body);
  assertEquals(note, 'First thought.\n\nSecond thought.');
});

Deno.test('extractForwardNote — strips trailing "On <date>, <Sender> wrote:" quote header', () => {
  const body = [
    'Take a look at this.',
    '',
    'On Mon, Apr 22, 2026 at 10:00 AM, Jane <jane@example.com> wrote:',
    'Begin forwarded message:',
    'From: Jane <jane@example.com>',
    'Subject: Topic',
  ].join('\n');
  const note = extractForwardNote(body);
  assertEquals(note, 'Take a look at this.');
});

Deno.test('extractForwardNote — Apple Mail "Begin forwarded message:" anchor', () => {
  const body = [
    'FYI',
    '',
    'Begin forwarded message:',
    '',
    'From: dave@apple-sender.test',
  ].join('\n');
  assertEquals(extractForwardNote(body), 'FYI');
});

Deno.test('extractForwardNote — no separator → undefined (cannot anchor)', () => {
  const body = 'Just a message with no forward marker at all.';
  assertEquals(extractForwardNote(body), undefined);
});

Deno.test('extractForwardNote — empty text above separator → undefined', () => {
  const body = '\n\n---------- Forwarded message ----------\nFrom: x@y.com';
  assertEquals(extractForwardNote(body), undefined);
});

Deno.test('extractForwardNote — whitespace-only above separator → undefined', () => {
  const body = '   \n\t\n  ---------- Forwarded message ----------';
  assertEquals(extractForwardNote(body), undefined);
});

Deno.test('extractForwardNote — CRLF line endings normalized', () => {
  const body = 'Hi Jan\r\n\r\n---------- Forwarded message ----------\r\nFrom: x@y.com';
  assertEquals(extractForwardNote(body), 'Hi Jan');
});

Deno.test('extractForwardNote — empty body → undefined', () => {
  assertEquals(extractForwardNote(''), undefined);
});

// ============================================================================
// detectForward + hook: forward_note plumbing
// ============================================================================

Deno.test('detectForward — populates forward_note when commentary present', () => {
  const body = [
    'Heads up — this bug bit us last quarter.',
    '',
    '---------- Forwarded message ----------',
    'From: Ops <ops@example.com>',
    'Subject: Postmortem',
    '',
    'Body of postmortem.',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Postmortem',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.forward_note, 'Heads up — this bug bit us last quarter.');
});

Deno.test('detectForward — forward_note absent when there is no separator', () => {
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: bare forward',
  }, 'Just sharing without any separator.');
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  assertEquals(r.forward_note, undefined);
});

Deno.test('createForwardDetectHook — writes fields.forward_note when present', async () => {
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const body = [
    'Jessica sent this — worth reading.',
    '',
    '---------- Forwarded message ----------',
    'From: Jessica <jessica.c.sacher@example.com>',
    'Subject: Phage digest',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Phage digest',
  }, body);
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected item verdict');
  assertEquals(verdict.fields.forward_note, 'Jessica sent this — worth reading.');
});

Deno.test('createForwardDetectHook — no forward_note written when empty above separator', async () => {
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const body = '---------- Forwarded message ----------\nFrom: x@y.com';
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: bare',
  }, body);
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected item verdict');
  assertEquals(verdict.fields.forward_note, undefined);
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

// ============================================================================
// Phase 1: original_sent_at + original_message_id + original_reply_to + newsletter_slug
// (per .brief/forward-notes-and-newsletter-profiles.md)
// ============================================================================

Deno.test('parseForwardDate — Gmail "at" infix', () => {
  const iso = parseForwardDate('Sun, Apr 26, 2026 at 10:16 AM');
  assertExists(iso);
  // Locale-dependent timezone interpretation, but the wall-clock date stays.
  assert(iso.startsWith('2026-04-26'), `expected 2026-04-26 prefix, got ${iso}`);
});

Deno.test('parseForwardDate — Outlook longform weekday', () => {
  const iso = parseForwardDate('Sunday, April 26, 2026 10:16 AM');
  assertExists(iso);
  assert(iso.startsWith('2026-04-26'));
});

Deno.test('parseForwardDate — RFC 5322', () => {
  const iso = parseForwardDate('Sun, 26 Apr 2026 17:16:00 +0000');
  assertEquals(iso, '2026-04-26T17:16:00.000Z');
});

Deno.test('parseForwardDate — bare ISO', () => {
  const iso = parseForwardDate('2026-04-26T10:16:00.000Z');
  assertEquals(iso, '2026-04-26T10:16:00.000Z');
});

Deno.test('parseForwardDate — unparseable returns undefined (not approximate)', () => {
  assertEquals(parseForwardDate('not a date at all'), undefined);
  assertEquals(parseForwardDate(''), undefined);
});

Deno.test('deriveNewsletterSlug — "X at Internet Pipes" → internet-pipes', () => {
  const slug = deriveNewsletterSlug(
    'Steph at Internet Pipes <internetpipes@broadcasts.lemonsqueezy-mail.com>',
    'internetpipes@broadcasts.lemonsqueezy-mail.com',
  );
  assertEquals(slug, 'internet-pipes');
});

Deno.test('deriveNewsletterSlug — "Sidebar.io" → sidebar-io', () => {
  const slug = deriveNewsletterSlug('Sidebar.io <hello@uxdesign.cc>', 'hello@uxdesign.cc');
  assertEquals(slug, 'sidebar-io');
});

Deno.test('deriveNewsletterSlug — "Stratechery by Ben Thompson" → stratechery', () => {
  const slug = deriveNewsletterSlug(
    'Stratechery by Ben Thompson <stratechery@example.com>',
    'stratechery@example.com',
  );
  assertEquals(slug, 'stratechery');
});

Deno.test('deriveNewsletterSlug — bare display name (no angle bracket)', () => {
  const slug = deriveNewsletterSlug("Lenny's Newsletter", 'lenny@substack.com');
  assertEquals(slug, "lenny-s-newsletter");
});

Deno.test('deriveNewsletterSlug — no display name, falls back to email domain', () => {
  const slug = deriveNewsletterSlug(undefined, 'hello@every.to');
  assertEquals(slug, 'every-to');
});

Deno.test('deriveNewsletterSlug — only angle-bracketed addr, no display → falls back to email domain', () => {
  const slug = deriveNewsletterSlug('<hello@every.to>', 'hello@every.to');
  assertEquals(slug, 'every-to');
});

Deno.test('deriveNewsletterSlug — both undefined → undefined', () => {
  assertEquals(deriveNewsletterSlug(undefined, undefined), undefined);
});

Deno.test('deriveNewsletterSlug — "Fabricio (from Sidebar.io)" → sidebar-io (parenthesized publisher)', () => {
  const slug = deriveNewsletterSlug(
    'Fabricio (from Sidebar.io) <hello@uxdesign.cc>',
    'hello@uxdesign.cc',
  );
  assertEquals(slug, 'sidebar-io');
});

Deno.test('deriveNewsletterSlug — "Daily News from Acme" → acme (publisher after "from")', () => {
  const slug = deriveNewsletterSlug('Daily News from Acme <hi@acme.com>', 'hi@acme.com');
  assertEquals(slug, 'acme');
});

Deno.test('deriveNewsletterSlug — "Jane [from BrandCo]" → brandco (bracketed publisher)', () => {
  const slug = deriveNewsletterSlug('Jane [from BrandCo] <jane@example.com>', 'jane@example.com');
  assertEquals(slug, 'brandco');
});

Deno.test('detectForward — extracts original_sent_at from Gmail-shape body', () => {
  const body = [
    '---------- Forwarded message ---------',
    'From: Steph at Internet Pipes <internetpipes@broadcasts.lemonsqueezy-mail.com>',
    'Date: Sun, Apr 26, 2026 at 10:16 AM',
    'Subject: IP Digest: Whimsymaxxing',
    'To: <janeazy@gmail.com>',
    '',
    'Hello Internet sleuths!',
  ].join('\n');
  const item = makeItem(
    { body },
    { from_email: 'me@example.com', subject: 'Fwd: IP Digest: Whimsymaxxing' },
    body,
  );
  const result = detectForward(item, { selfAddresses: SELF });
  assertExists(result.original_sent_at);
  assert(result.original_sent_at!.startsWith('2026-04-26'));
});

Deno.test('detectForward — populates newsletter_slug from forwarded body', () => {
  const body = [
    '---------- Forwarded message ---------',
    'From: Steph at Internet Pipes <internetpipes@broadcasts.lemonsqueezy-mail.com>',
    'Date: Sun, Apr 26, 2026 at 10:16 AM',
    'Subject: IP Digest',
    '',
    'body',
  ].join('\n');
  const item = makeItem(
    { body },
    { from_email: 'me@example.com', subject: 'Fwd: IP Digest' },
    body,
  );
  const result = detectForward(item, { selfAddresses: SELF });
  assertEquals(result.newsletter_slug, 'internet-pipes');
});

Deno.test('detectForward — extracts message_id and reply_to', () => {
  const body = [
    '---------- Forwarded message ---------',
    'From: Sender <sender@example.com>',
    'Date: Sun, Apr 26, 2026 at 10:16 AM',
    'Subject: Hello',
    'Message-ID: <abc123@mail.example.com>',
    'Reply-To: replies@example.com',
    'To: me@example.com',
    '',
    'body',
  ].join('\n');
  const item = makeItem(
    { body },
    { from_email: 'me@example.com', subject: 'Fwd: Hello' },
    body,
  );
  const result = detectForward(item, { selfAddresses: SELF });
  assertEquals(result.original_message_id, '<abc123@mail.example.com>');
  assertEquals(result.original_reply_to, 'replies@example.com');
});

Deno.test('detectForward — malformed Date silently absent (graceful)', () => {
  const body = [
    '---------- Forwarded message ---------',
    'From: Sender <sender@example.com>',
    'Date: not a real date',
    'Subject: Hello',
    '',
    'body',
  ].join('\n');
  const item = makeItem(
    { body },
    { from_email: 'me@example.com', subject: 'Fwd: Hello' },
    body,
  );
  const result = detectForward(item, { selfAddresses: SELF });
  assertEquals(result.original_sent_at, undefined);
  // Other extractions still succeed
  assertEquals(result.original_subject, 'Hello');
});

Deno.test('detectForward — From: line continuation across two lines (Gmail wrap)', () => {
  // Gmail wraps long From: values onto the next line. The wrapped portion
  // should be stitched back together so `original_from_email` extraction works.
  const body = [
    '---------- Forwarded message ---------',
    'From: Steph at Internet Pipes <',
    'internetpipes@broadcasts.lemonsqueezy-mail.com>',
    'Date: Sun, Apr 26, 2026 at 10:16 AM',
    'Subject: IP Digest',
    '',
    'body',
  ].join('\n');
  const item = makeItem(
    { body },
    { from_email: 'me@example.com', subject: 'Fwd: IP Digest' },
    body,
  );
  const result = detectForward(item, { selfAddresses: SELF });
  assertEquals(
    result.original_from_email,
    'internetpipes@broadcasts.lemonsqueezy-mail.com',
  );
  assertEquals(result.newsletter_slug, 'internet-pipes');
});

Deno.test('createForwardDetectHook — writes new fields when present', async () => {
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const body = [
    '---------- Forwarded message ---------',
    'From: Sender <sender@example.com>',
    'Date: Sun, Apr 26, 2026 at 10:16 AM',
    'Subject: Hello',
    'Message-ID: <abc@mail.com>',
    'Reply-To: replies@example.com',
    '',
    'body',
  ].join('\n');
  const item = makeItem(
    { body },
    { from_email: 'me@example.com', subject: 'Fwd: Hello' },
    body,
  );
  const verdict = await hook(item, {} as HookContext);
  assert(typeof verdict === 'object');
  const next = verdict as InboxItem;
  assertExists(next.fields.original_sent_at);
  assertEquals(next.fields.original_message_id, '<abc@mail.com>');
  assertEquals(next.fields.original_reply_to, 'replies@example.com');
  assertEquals(next.fields.newsletter_slug, 'sender');
});

Deno.test('createForwardDetectHook — does not overwrite missing fields with undefined', async () => {
  // When forward body has no Date: line, original_sent_at is absent in the
  // verdict and MUST NOT clobber any pre-existing `fields.original_sent_at`.
  const hook = createForwardDetectHook({ selfAddresses: SELF });
  const body = [
    '---------- Forwarded message ---------',
    'From: Sender <sender@example.com>',
    'Subject: Hello',
    '',
    'body',
  ].join('\n');
  const item = makeItem(
    { body },
    {
      from_email: 'me@example.com',
      subject: 'Fwd: Hello',
      original_sent_at: '2020-01-01T00:00:00Z', // pre-existing
    },
    body,
  );
  const verdict = await hook(item, {} as HookContext);
  const next = verdict as InboxItem;
  assertEquals(next.fields.original_sent_at, '2020-01-01T00:00:00Z');
});

// ============================================================================
// B025 — extractEmailAddress regex hardening
// ============================================================================
//
// The bare-address fallback regex previously accepted `+` and `%` in the
// local-part, which let a malicious forwarder set `original_from_email` to
// `attacker+newsletter@example.com` (or a percent-encoded variant) and
// piggyback on sender-aliases / auto-confirm allowlists keyed off a
// different address.
//
// **Decision on plus-addressing:** the hardened regex rejects `+` in the
// bare-address path even though some senders use it legitimately
// (e.g. `user+inbox@gmail.com`). The trade-off is acceptable because:
//   1. plus-addressing is overwhelmingly used for INCOMING routing, not
//      sending — real senders don't typically send FROM a plus-address.
//   2. The angle-bracket branch (`<addr@host>`) is still permissive
//      (`[^<>\s]+`), so well-formed `From:` headers like
//      `"User" <user+inbox@example.com>` still extract correctly.
// Only the bare-address fallback (e.g. body `From: addr@host` lines with
// no `<...>` wrap) is tightened.

Deno.test('B025 — bare address with `+` in local-part is rejected (plus-addressing fallback path)', () => {
  // Body has a bare address with `+` — the bare regex should refuse to
  // match, so original_from_email stays undefined.
  const body = [
    '---------- Forwarded message ---------',
    'From: attacker+newsletter@example.com',
    'Subject: Sneaky',
    '',
    'body',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Sneaky',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.isForwarded, true);
  // The injection address must NOT be picked up.
  assertEquals(r.original_from_email, undefined);
});

Deno.test('B025 — bare address with `%` (percent-encoded `@`) in local-part is rejected', () => {
  // attacker%40example.com is the percent-encoded form of
  // attacker@example.com — pre-fix the regex accepted `%` in the local
  // part and would have matched something nonsensical.
  const body = [
    '---------- Forwarded message ---------',
    'From: attacker%40example.com',
    'Subject: Encoded',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Encoded',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.original_from_email, undefined);
});

Deno.test('B025 — angle-bracket form still accepts `+` (safe path stays permissive)', () => {
  // The angle-bracket branch uses `[^<>\s]+` — unchanged. So a well-
  // formed `From: "Name" <user+inbox@example.com>` still extracts.
  // The injection vector is specifically the bare-address fallback,
  // not the angle form.
  const body = [
    '---------- Forwarded message ---------',
    'From: User <user+inbox@example.com>',
    'Subject: Plus-addressing legit',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Plus-addressing legit',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.original_from_email, 'user+inbox@example.com');
});

Deno.test('B025 — bare address with normal local-part still extracts', () => {
  // Regression check: the dot/dash/underscore/digit cases still work —
  // we only removed `+` and `%` from the character class.
  const body = [
    '---------- Forwarded message ---------',
    'From: jane.doe-2_test@example.co',
    'Subject: Normal',
  ].join('\n');
  const item = makeItem({}, {
    from_email: 'me@example.com',
    subject: 'Fwd: Normal',
  }, body);
  const r = detectForward(item, { selfAddresses: SELF });
  assertEquals(r.original_from_email, 'jane.doe-2_test@example.co');
});
