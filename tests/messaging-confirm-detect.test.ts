/**
 * Double-opt-in confirmation detector tests.
 *
 * Covers subject heuristics, URL extraction (anchor-line + path-hint),
 * unsubscribe-URL avoidance, and hook wiring.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import {
  createConfirmDetectHook,
  detectConfirmation,
  extractConfirmUrl,
  isConfirmationSubject,
} from '../src/messaging/confirm-detect.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

const CTX: HookContext = { channel: 'cf-email', registration: 'test' };

function makeItem(
  fields: Record<string, any> = {},
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id: 'item-test',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-24T12:00:00Z',
    summary: fields.subject ?? 'test',
    body: null,
    fields,
    labels: ['newsletter'],
    ...overrides,
  };
}

// ============================================================================
// isConfirmationSubject
// ============================================================================

Deno.test('subject — "Confirm your subscription to Sidebar.io" → true', () => {
  assert(isConfirmationSubject('Confirm your subscription to Sidebar.io'));
});

Deno.test('subject — "Please confirm your email" → true', () => {
  assert(isConfirmationSubject('Please confirm your email'));
});

Deno.test('subject — "Verify your email address" → true', () => {
  assert(isConfirmationSubject('Verify your email address'));
});

Deno.test('subject — "Activate your account" → true', () => {
  assert(isConfirmationSubject('Activate your account'));
});

Deno.test('subject — "One more step" (Substack) → true', () => {
  assert(isConfirmationSubject('One more step to confirm'));
});

Deno.test('subject — "Subscription Confirmation" → true', () => {
  assert(isConfirmationSubject('Subscription Confirmation'));
});

Deno.test('subject — generic newsletter → false', () => {
  assertEquals(isConfirmationSubject('Weekly Roundup: 5 new tools'), false);
});

Deno.test('subject — password reset → false (not a subscription)', () => {
  // "verify your email" matches, but our scope is opt-in newsletters. The
  // hook narrows via requireNewsletterLabel — the subject predicate alone
  // stays loose on purpose.
  assertEquals(isConfirmationSubject('Your password reset request'), false);
});

Deno.test('subject — empty / null → false', () => {
  assertEquals(isConfirmationSubject(''), false);
  assertEquals(isConfirmationSubject(undefined), false);
  assertEquals(isConfirmationSubject(null), false);
});

// ============================================================================
// extractConfirmUrl — anchor-line strategy
// ============================================================================

Deno.test('url — Sidebar plaintext shape: "Yes, subscribe me" anchor → picks footnote URL', () => {
  const body = `Confirm your subscription to Sidebar.io

 Yes, subscribe me to this list [1]

If you received this email by mistake, simply delete it. You won't be
subscribed unless you click the link above.

Links:
------
[1] https://alecto.eomail4.com/subscribe/confirm?l=abc&lc=def
`;
  assertEquals(
    extractConfirmUrl(body),
    'https://alecto.eomail4.com/subscribe/confirm?l=abc&lc=def',
  );
});

Deno.test('url — inline URL on the anchor line', () => {
  const body = `Hi!

Click here to confirm: https://lists.example.com/confirm?id=abc

Thanks!`;
  assertEquals(extractConfirmUrl(body), 'https://lists.example.com/confirm?id=abc');
});

Deno.test('url — URL on the line right after the anchor', () => {
  const body = `Please click to confirm:
https://example.com/verify/xyz

Thanks!`;
  assertEquals(extractConfirmUrl(body), 'https://example.com/verify/xyz');
});

// ============================================================================
// extractConfirmUrl — path-hint strategy
// ============================================================================

Deno.test('url — no anchor phrase, falls back to path hint', () => {
  const body = `Hey!

Tap this link: https://example.com/activate/token?v=123

— Example Newsletter`;
  // "tap this link" is not in ANCHOR_PHRASES, so strategy 1 misses. Path
  // hint `activate` picks it up in strategy 2.
  assertEquals(extractConfirmUrl(body), 'https://example.com/activate/token?v=123');
});

Deno.test('url — returns null when body has only non-confirm URLs', () => {
  const body = `Check out our blog: https://example.com/blog
Social: https://twitter.com/example`;
  assertEquals(extractConfirmUrl(body), null);
});

Deno.test('url — ignores list-unsubscribe URL even if it has "confirm" path', () => {
  const body = `Please confirm your subscription.

To unsubscribe later: https://example.com/unsubscribe?confirm=yes
Real confirm: https://example.com/subscribe/confirm?t=abc`;
  assertEquals(extractConfirmUrl(body), 'https://example.com/subscribe/confirm?t=abc');
});

Deno.test('url — strips trailing punctuation', () => {
  const body = `Click to confirm: https://example.com/confirm?id=abc.`;
  assertEquals(extractConfirmUrl(body), 'https://example.com/confirm?id=abc');
});

Deno.test('url — handles CRLF line endings', () => {
  const body = 'Click here to confirm:\r\nhttps://example.com/confirm?id=abc\r\n';
  assertEquals(extractConfirmUrl(body), 'https://example.com/confirm?id=abc');
});

Deno.test('url — empty / null body → null', () => {
  assertEquals(extractConfirmUrl(''), null);
  assertEquals(extractConfirmUrl(undefined), null);
  assertEquals(extractConfirmUrl(null), null);
});

// ============================================================================
// detectConfirmation
// ============================================================================

Deno.test('detect — subject hit + URL present → is_confirmation=true with url', () => {
  const item = makeItem({
    subject: 'Confirm your subscription to Sidebar.io',
    body_text: 'Click to confirm: https://lists.example.com/subscribe/confirm?t=abc',
  });
  const r = detectConfirmation(item);
  assertEquals(r.is_confirmation, true);
  assertEquals(r.confirm_url, 'https://lists.example.com/subscribe/confirm?t=abc');
});

Deno.test('detect — subject hit but no URL in body → is_confirmation=true, url=null', () => {
  const item = makeItem({
    subject: 'Please confirm your email',
    body_text: 'Hi there, please check your email app to complete signup.',
  });
  const r = detectConfirmation(item);
  assertEquals(r.is_confirmation, true);
  assertEquals(r.confirm_url, null);
});

Deno.test('detect — no subject hit → is_confirmation=false', () => {
  const item = makeItem({
    subject: 'Weekly roundup: 5 new tools',
    body_text: 'Lots of content.',
  });
  const r = detectConfirmation(item);
  assertEquals(r.is_confirmation, false);
  assertEquals(r.confirm_url, null);
});

Deno.test('detect — reads body from string when fields.body_text missing', () => {
  const item = makeItem(
    { subject: 'Confirm subscription' },
    { body: 'Click to confirm: https://example.com/subscribe/confirm?t=xyz' },
  );
  const r = detectConfirmation(item);
  assertEquals(r.is_confirmation, true);
  assertEquals(r.confirm_url, 'https://example.com/subscribe/confirm?t=xyz');
});

Deno.test('detect — reads body.text when body is object shape', () => {
  const item = makeItem(
    { subject: 'Confirm subscription' },
    { body: { text: 'Click to confirm: https://example.com/confirm/xyz' } as any },
  );
  const r = detectConfirmation(item);
  assertEquals(r.confirm_url, 'https://example.com/confirm/xyz');
});

// ============================================================================
// createConfirmDetectHook
// ============================================================================

Deno.test('hook — tags needs-confirm + writes confirm_url on hit', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem({
    subject: 'Confirm your subscription to Sidebar.io',
    body_text: 'Click here: https://example.com/subscribe/confirm?t=abc',
  });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('needs-confirm'));
  assertEquals(verdict.fields.confirm_url, 'https://example.com/subscribe/confirm?t=abc');
});

Deno.test('hook — requireNewsletterLabel (default) skips non-newsletter mail', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem(
    {
      subject: 'Verify your email address',
      body_text: 'https://example.com/verify/abc',
    },
    { labels: [] }, // no newsletter label
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — requireNewsletterLabel: false → fires on non-newsletter', async () => {
  const hook = createConfirmDetectHook({ requireNewsletterLabel: false });
  const item = makeItem(
    {
      subject: 'Verify your email address',
      body_text: 'https://example.com/verify/abc',
    },
    { labels: [] },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('needs-confirm'));
});

Deno.test('hook — idempotent: skips when needs-confirm already present', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem(
    {
      subject: 'Confirm your subscription',
      body_text: 'https://example.com/subscribe/confirm?t=abc',
    },
    { labels: ['newsletter', 'needs-confirm'] },
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — non-confirmation newsletter → accept (pass-through)', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem({
    subject: 'Issue #42: 5 new things',
    body_text: 'Normal newsletter content here.',
  });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — merges needs-confirm with existing labels', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem(
    {
      subject: 'Confirm subscription',
      body_text: 'https://example.com/subscribe/confirm?t=abc',
    },
    { labels: ['newsletter', 'sender:jan'] },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.labels, ['newsletter', 'sender:jan', 'needs-confirm']);
});

Deno.test('hook — does not mutate input', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem({
    subject: 'Confirm your subscription',
    body_text: 'https://example.com/subscribe/confirm?t=abc',
  });
  const snapshot = JSON.stringify(item);
  await hook(item, CTX);
  assertEquals(JSON.stringify(item), snapshot);
});

// ============================================================================
// Ghost — "Complete your sign up to <Publisher>" + /members/?token=...&action=signup
// (added 2026-04-27 after the rosieland.com signup landed unflagged)
// ============================================================================

Deno.test('subject — Ghost "🙌 Complete your sign up to Rosieland!" → true', () => {
  assert(isConfirmationSubject('🙌 Complete your sign up to Rosieland!'));
});

Deno.test('subject — "Complete your signup" (no space) → true', () => {
  assert(isConfirmationSubject('Complete your signup'));
});

Deno.test('subject — "Complete sign-up" → true', () => {
  assert(isConfirmationSubject('Complete sign-up'));
});

Deno.test('subject — "Complete your project" → false (not a signup)', () => {
  assertEquals(isConfirmationSubject('Complete your project'), false);
});

Deno.test('url — Ghost shape: "tap the link below to complete the signup process" anchor + URL on next line', () => {
  const body = `Hey there,

Tap the link below to complete the signup process for Rosieland, and be automatically signed in:

https://rosie.land/members/?token=McJmN3f731hwGuW0I72tJ-ClOQnzUj7j&action=signup&r=https%3A%2F%2Frosie.land%2F

For your security, the link will expire in 24 hours time.

See you soon!`;
  const url = extractConfirmUrl(body);
  assertEquals(
    url,
    'https://rosie.land/members/?token=McJmN3f731hwGuW0I72tJ-ClOQnzUj7j&action=signup&r=https%3A%2F%2Frosie.land%2F',
  );
});

Deno.test('url — Ghost shape: action=signup query param alone is enough via PATH_HINTS', () => {
  // No anchor phrases — extraction should still succeed via path-hint fallback.
  const body = 'Welcome! https://example.com/members/?token=abc&action=signup';
  const url = extractConfirmUrl(body);
  assert(url !== null);
  assertEquals(url!.includes('action=signup'), true);
});

Deno.test('hook — full Ghost flow tags needs-confirm + extracts the signup URL', async () => {
  const hook = createConfirmDetectHook();
  const item = makeItem(
    {
      subject: '🙌 Complete your sign up to Rosieland!',
      from_email: 'rosieland@ghost.io',
      body_text: `Hey there,

Tap the link below to complete the signup process for Rosieland, and be automatically signed in:

https://rosie.land/members/?token=McJmN3f731hwGuW0I72tJ-ClOQnzUj7j&action=signup&r=https%3A%2F%2Frosie.land%2F

For your security, the link will expire in 24 hours time.`,
    },
    { labels: ['newsletter'] },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('needs-confirm'));
  const confirmUrl = verdict.fields?.confirm_url as string | undefined;
  assert(confirmUrl?.includes('action=signup'), `expected signup URL, got ${confirmUrl}`);
  assert(confirmUrl?.includes('rosie.land/members'));
});
