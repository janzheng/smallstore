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

Deno.test('applyNewsletterName — happy path: newsletter label + display name + slug field', () => {
  const item = makeItem({ from_addr: '"Sidebar.io" <hello@uxdesign.cc>' });
  const r = applyNewsletterName(item);
  assertEquals(r.name, 'Sidebar.io');
  assertEquals(r.label, 'newsletter:sidebar-io');
  assertEquals(r.slug, 'sidebar-io');
});

Deno.test('applyNewsletterName — no newsletter label → all null', () => {
  const item = makeItem(
    { from_addr: '"Sidebar.io" <hello@uxdesign.cc>' },
    { labels: [] }, // no newsletter label
  );
  const r = applyNewsletterName(item);
  assertEquals(r.name, null);
  assertEquals(r.label, null);
  assertEquals(r.slug, null);
});

Deno.test('applyNewsletterName — no from_addr → null name/label, but slug from email domain', () => {
  const item = makeItem({ from_email: 'hello@uxdesign.cc' }); // missing from_addr
  const r = applyNewsletterName(item);
  assertEquals(r.name, null);
  assertEquals(r.label, null);
  // domain fallback gives the mirror something to group on
  assertEquals(r.slug, 'uxdesign-cc');
});

Deno.test('applyNewsletterName — filler-prefix display name → cleaner slug than label', () => {
  // "Steph at Internet Pipes" → label slugifies whole string, slug strips prefix
  const item = makeItem({ from_addr: '"Steph at Internet Pipes" <hi@example.com>' });
  const r = applyNewsletterName(item);
  assertEquals(r.name, 'Steph at Internet Pipes');
  assertEquals(r.label, 'newsletter:steph-at-internet-pipes');
  assertEquals(r.slug, 'internet-pipes');
});

// ============================================================================
// createNewsletterNameHook
// ============================================================================

Deno.test('hook — happy path: adds newsletter:<slug> label + newsletter_name + newsletter_slug fields', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '"Sidebar.io" <hello@uxdesign.cc>' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assert(verdict.labels?.includes('newsletter:sidebar-io'));
  assertEquals(verdict.fields.newsletter_name, 'Sidebar.io');
  assertEquals(verdict.fields.newsletter_slug, 'sidebar-io');
});

Deno.test('hook — direct sub with display name → writes newsletter_slug for mirror grouping', async () => {
  // Regression: before this hook wrote slug, direct subs (not forwarded) were
  // missing fields.newsletter_slug, so the tigerflare mirror skipped them.
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '"Every" <hello@every.to>', from_email: 'hello@every.to' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.newsletter_slug, 'every');
});

Deno.test('hook — re-derives slug to pick up improved filler-prefix logic on replay', async () => {
  // Replay scenario: an existing item had a "fabricio-from-sidebar-io"
  // slug from before the bracketed-publisher pattern shipped. After the
  // pattern fix lands, replaying should produce "sidebar-io" — overwrite
  // is safe because newsletter-name only fires on items with the
  // `newsletter` label, which forwarded items don't carry, so this hook
  // never competes with forward-detect.
  const hook = createNewsletterNameHook();
  const item = makeItem(
    {
      from_addr: '"Fabricio (from Sidebar.io)" <hello@uxdesign.cc>',
      newsletter_slug: 'fabricio-from-sidebar-io', // stale slug from old derivation
    },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.newsletter_slug, 'sidebar-io');
});

Deno.test('hook — same slug already set → idempotent (no diff)', async () => {
  // The "no overwrite when slug already matches what we'd derive" path:
  // the hook should not produce a diff in this case.
  const hook = createNewsletterNameHook();
  const item = makeItem(
    {
      from_addr: '"Sidebar.io" <hello@uxdesign.cc>',
      newsletter_name: 'Sidebar.io',
      newsletter_slug: 'sidebar-io',
    },
    { labels: ['newsletter', 'newsletter:sidebar-io'] },
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — bare angle-address with from_email → still populates slug from domain', async () => {
  // No display name to label with, but mirror still gets a grouping handle.
  const hook = createNewsletterNameHook();
  const item = makeItem({ from_addr: '<hello@every.to>', from_email: 'hello@every.to' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  // No newsletter:<slug> label (no display name), but slug field is set.
  assertEquals(verdict.fields.newsletter_slug, 'every-to');
  assert(!(verdict.labels ?? []).some((l) => l.startsWith('newsletter:')));
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

Deno.test('hook — idempotent: skips when label, name, and slug are all already present', async () => {
  const hook = createNewsletterNameHook();
  const item = makeItem(
    {
      from_addr: '"Sidebar.io" <hello@uxdesign.cc>',
      newsletter_name: 'Sidebar.io',
      newsletter_slug: 'sidebar-io',
    },
    { labels: ['newsletter', 'newsletter:sidebar-io'] },
  );
  const verdict = await hook(item, CTX);
  assertEquals(verdict, 'accept');
});

Deno.test('hook — backfills missing newsletter_slug even when label is already set', async () => {
  // Realistic backfill: items ingested before the slug-write change have the
  // label but no slug field. Replay should fill it in on a re-run.
  const hook = createNewsletterNameHook();
  const item = makeItem(
    { from_addr: '"Sidebar.io" <hello@uxdesign.cc>' },
    { labels: ['newsletter', 'newsletter:sidebar-io'] },
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.newsletter_slug, 'sidebar-io');
  assertEquals(verdict.fields.newsletter_name, 'Sidebar.io');
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
