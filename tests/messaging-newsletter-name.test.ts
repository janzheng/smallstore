/**
 * Newsletter-name auto-tag hook tests.
 *
 * Covers display-name extraction, `newsletter:<slug>` label emission,
 * manual-alias deference, and idempotence.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import {
  applyNewsletterName,
  createNewsletterNameHook,
  extractDisplayName,
} from '../src/messaging/newsletter-name.ts';
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
// extractDisplayName
// ============================================================================

Deno.test('extractDisplayName — quoted display name', () => {
  assertEquals(extractDisplayName('"Sidebar.io" <hello@uxdesign.cc>'), 'Sidebar.io');
});

Deno.test('extractDisplayName — unquoted display name', () => {
  assertEquals(extractDisplayName('Jane Doe <jane@example.com>'), 'Jane Doe');
});

Deno.test('extractDisplayName — single-quoted display name', () => {
  assertEquals(extractDisplayName("'Stratechery' <ben@stratechery.com>"), 'Stratechery');
});

Deno.test('extractDisplayName — bare angle-bracketed address → null', () => {
  assertEquals(extractDisplayName('<hello@uxdesign.cc>'), null);
});

Deno.test('extractDisplayName — bare address → null', () => {
  assertEquals(extractDisplayName('hello@uxdesign.cc'), null);
});

Deno.test('extractDisplayName — empty / undefined → null', () => {
  assertEquals(extractDisplayName(''), null);
  assertEquals(extractDisplayName(undefined), null);
  assertEquals(extractDisplayName(null), null);
});

Deno.test('extractDisplayName — MIME encoded-word → null (defensive pass-through)', () => {
  assertEquals(extractDisplayName('=?utf-8?Q?Caf=C3=A9?= <cafe@example.com>'), null);
});

Deno.test('extractDisplayName — display name that is the email address → null', () => {
  assertEquals(
    extractDisplayName('hello@uxdesign.cc <hello@uxdesign.cc>'),
    null,
  );
});

Deno.test('extractDisplayName — whitespace-only display name → null', () => {
  assertEquals(extractDisplayName('   <a@b.com>'), null);
});

// ============================================================================
// applyNewsletterName
// ============================================================================

Deno.test('applyNewsletterName — happy path: newsletter label + display name', () => {
  const item = makeItem({ from_addr: '"Sidebar.io" <hello@uxdesign.cc>' });
  const r = applyNewsletterName(item);
  assertEquals(r.name, 'Sidebar.io');
  assertEquals(r.label, 'newsletter:sidebar-io');
});

Deno.test('applyNewsletterName — no newsletter label → null result', () => {
  const item = makeItem(
    { from_addr: '"Sidebar.io" <hello@uxdesign.cc>' },
    { labels: [] }, // no newsletter label
  );
  const r = applyNewsletterName(item);
  assertEquals(r.name, null);
  assertEquals(r.label, null);
});

Deno.test('applyNewsletterName — no from_addr → null result', () => {
  const item = makeItem({ from_email: 'hello@uxdesign.cc' }); // missing from_addr
  const r = applyNewsletterName(item);
  assertEquals(r.name, null);
  assertEquals(r.label, null);
});

// ============================================================================
// createNewsletterNameHook
// ============================================================================

Deno.test('hook — happy path: adds newsletter:<slug> label + newsletter_name field', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '"Sidebar.io" <hello@uxdesign.cc>' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('newsletter:sidebar-io'));
  assertEquals(verdict.fields.newsletter_name, 'Sidebar.io');
});

Deno.test('hook — skips when sender:* label already present (manual wins)', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem(
    { from_addr: '"Sidebar.io" <hello@uxdesign.cc>' },
    { labels: ['newsletter', 'sender:sidebar'] },
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — skipIfSenderTagged: false → overrides, adds newsletter:<slug> anyway', async () => {
  const hook = createNewsletterNameHook({ skipIfSenderTagged: false });
  const item = makeItem(
    { from_addr: '"Sidebar.io" <hello@uxdesign.cc>' },
    { labels: ['newsletter', 'sender:sidebar'] },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('newsletter:sidebar-io'));
});

Deno.test('hook — idempotent: skips when label already present', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem(
    { from_addr: '"Sidebar.io" <hello@uxdesign.cc>' },
    { labels: ['newsletter', 'newsletter:sidebar-io'] },
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — non-newsletter mail → accept (pass-through)', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem(
    { from_addr: '"Jane Doe" <jane@example.com>' },
    { labels: [] }, // not tagged newsletter
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — bare address (no display name) → accept (pass-through)', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '<hello@uxdesign.cc>' });
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — display name with punctuation slugifies cleanly', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '"Morning Brew ☕️" <crew@morningbrew.com>' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  // Slugify keeps lowercase unicode, strips the emoji/space.
  assert(verdict.labels?.some((l) => l.startsWith('newsletter:morning-brew')));
});

Deno.test('hook — does not mutate input', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '"Sidebar.io" <hello@uxdesign.cc>' });
  const snapshot = JSON.stringify(item);
  await hook(item, CTX);
  assertEquals(JSON.stringify(item), snapshot);
});
