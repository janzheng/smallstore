/**
 * Messaging — CloudflareEmailChannel parser tests.
 *
 * Reads .eml fixtures from tests/fixtures/cf-email/, parses through the
 * channel, asserts on field mapping, blob outputs, label detection, threading,
 * and idempotency.
 */

import { assertEquals, assertExists, assertNotEquals } from 'jsr:@std/assert';
import { CloudflareEmailChannel } from '../src/messaging/channels/cf-email.ts';
import type { EmailInput } from '../src/messaging/channels/cf-email.ts';

const channel = new CloudflareEmailChannel();
const FIXTURES_DIR = new URL('./fixtures/cf-email/', import.meta.url);

async function loadFixture(name: string): Promise<Uint8Array> {
  const path = new URL(name, FIXTURES_DIR);
  return await Deno.readFile(path);
}

async function parse(name: string, input?: Partial<EmailInput>) {
  const raw = await loadFixture(name);
  const result = await channel.parse({ raw, envelope_to: 'inbox@labspace.ai', ...input });
  if (!result) throw new Error('channel.parse returned null');
  return result;
}

// ============================================================================
// Channel identity
// ============================================================================

Deno.test('cf-email channel — declares correct name/kind/source', () => {
  assertEquals(channel.name, 'cf-email');
  assertEquals(channel.kind, 'push');
  assertEquals(channel.source, 'email/v1');
});

// ============================================================================
// 01 — Plain text
// ============================================================================

Deno.test('cf-email — plain text: maps from/to/subject/body', async () => {
  const { item } = await parse('01-plain-text.eml');
  assertEquals(item.fields.from_addr, 'Alice Sender <alice@example.com>');
  assertEquals(item.fields.from_email, 'alice@example.com');
  assertEquals(item.fields.to_addrs, ['inbox@labspace.ai']);
  assertEquals(item.summary, 'Hello there');
  assertEquals(item.body?.includes('plain text email body'), true);
  assertEquals(item.fields.message_id, 'plain-001@example.com');
  assertEquals(item.fields.has_attachments, false);
});

Deno.test('cf-email — plain text: stores raw .eml as a blob', async () => {
  const { item, blobs } = await parse('01-plain-text.eml');
  assertExists(item.raw_ref);
  assertExists(blobs?.[item.raw_ref!]);
});

Deno.test('cf-email — plain text: small body inlined, no body_ref', async () => {
  const { item } = await parse('01-plain-text.eml');
  assertExists(item.body);
  assertEquals(item.body_ref, undefined);
});

// ============================================================================
// 02 — Multipart with HTML
// ============================================================================

Deno.test('cf-email — multipart: html body always to blobs (never inlined)', async () => {
  const { item, blobs } = await parse('02-multipart-html.eml');
  // Plain text is small enough to inline
  assertExists(item.body);
  assertEquals(item.body?.includes('plain text version'), true);
  // HTML always to blobs
  const htmlKey = Object.keys(blobs ?? {}).find(k => k.startsWith('html/'));
  assertExists(htmlKey);
  const htmlContent = blobs![htmlKey!].content;
  assertEquals(typeof htmlContent === 'string' && htmlContent.includes('<h1>Newsletter</h1>'), true);
});

// ============================================================================
// 03 — With attachment
// ============================================================================

Deno.test('cf-email — attachment: extracted to blobs with metadata on item.fields.attachments', async () => {
  const { item, blobs } = await parse('03-with-attachment.eml');
  assertEquals(item.fields.has_attachments, true);
  const atts = item.fields.attachments;
  assertEquals(Array.isArray(atts), true);
  assertEquals(atts.length, 1);
  assertEquals(atts[0].filename, 'invoice.txt');
  assertExists(blobs?.[atts[0].ref]);
  // Decoded content should match the base64-decoded fixture body
  const content = blobs![atts[0].ref].content;
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  assertEquals(text.includes('Total: $42.00'), true);
});

// ============================================================================
// 04 — Missing Message-ID
// ============================================================================

Deno.test('cf-email — missing Message-ID: id is still derived from raw bytes', async () => {
  const { item } = await parse('04-no-message-id.eml');
  assertEquals(item.fields.message_id, null);
  assertExists(item.id);
  assertEquals(item.id.length, 32); // 32 hex chars (truncated sha256)
});

Deno.test('cf-email — missing Message-ID: parsing same bytes twice yields same id', async () => {
  const a = await parse('04-no-message-id.eml');
  const b = await parse('04-no-message-id.eml');
  assertEquals(a.item.id, b.item.id);
});

// ============================================================================
// 05 — Bounce
// ============================================================================

Deno.test('cf-email — bounce: tagged with "bounce" + "auto-reply" labels', async () => {
  const { item } = await parse('05-bounce.eml');
  assertEquals(item.labels?.includes('bounce'), true);
  assertEquals(item.labels?.includes('auto-reply'), true);
});

// ============================================================================
// 06 — OOO
// ============================================================================

Deno.test('cf-email — OOO: tagged with "ooo" + "auto-reply"', async () => {
  const { item } = await parse('06-ooo.eml');
  assertEquals(item.labels?.includes('ooo'), true);
  assertEquals(item.labels?.includes('auto-reply'), true);
});

// ============================================================================
// 07 — Threading + verdicts + cc
// ============================================================================

Deno.test('cf-email — threaded reply: thread_id derived from References header', async () => {
  const { item } = await parse('07-threaded-reply.eml');
  assertEquals(item.thread_id, 'plain-001@example.com');
  assertEquals(item.fields.in_reply_to, 'plain-001@example.com');
  assertEquals(item.fields.references, ['plain-001@example.com']);
});

Deno.test('cf-email — threaded reply: cc_addrs populated, lowercased', async () => {
  const { item } = await parse('07-threaded-reply.eml');
  assertEquals(item.fields.cc_addrs, ['inbox@labspace.ai']);
});

Deno.test('cf-email — threaded reply: SPF/DKIM/DMARC verdicts parsed from Authentication-Results', async () => {
  const { item } = await parse('07-threaded-reply.eml');
  assertEquals(item.fields.spf_pass, true);
  assertEquals(item.fields.dkim_pass, true);
  assertEquals(item.fields.dmarc_pass, true);
});

Deno.test('cf-email — verdicts: explicit input.verdicts override header parsing', async () => {
  const { item } = await parse('07-threaded-reply.eml', {
    verdicts: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
  });
  assertEquals(item.fields.spf_pass, false);
  assertEquals(item.fields.dkim_pass, false);
  assertEquals(item.fields.dmarc_pass, false);
});

// ============================================================================
// Idempotency
// ============================================================================

Deno.test('cf-email — same Message-ID + same bytes → same content-addressed id', async () => {
  const a = await parse('01-plain-text.eml');
  const b = await parse('01-plain-text.eml');
  assertEquals(a.item.id, b.item.id);
});

Deno.test('cf-email — different fixtures → different ids', async () => {
  const a = await parse('01-plain-text.eml');
  const b = await parse('02-multipart-html.eml');
  assertNotEquals(a.item.id, b.item.id);
});

// ============================================================================
// Body-size policy
// ============================================================================

Deno.test('cf-email — large text body (>64KB) goes to body_ref blob, not inlined', async () => {
  // Synthesize a large email
  const bigText = 'X'.repeat(80 * 1024); // 80KB
  const eml = `From: Bot <bot@example.com>
To: Inbox <inbox@labspace.ai>
Subject: Big message
Message-ID: <big-001@example.com>
Date: Wed, 22 Apr 2026 12:00:00 +0000
Content-Type: text/plain; charset=utf-8

${bigText}`;
  const result = await channel.parse({
    raw: new TextEncoder().encode(eml),
    envelope_to: 'inbox@labspace.ai',
  });
  assertExists(result);
  assertEquals(result!.item.body, null);
  assertExists(result!.item.body_ref);
  assertEquals(result!.item.body_ref!.startsWith('body/'), true);
  assertExists(result!.blobs?.[result!.item.body_ref!]);
});

// ============================================================================
// Filename safety
// ============================================================================

Deno.test('cf-email — attachment with path-traversal filename is sanitized', async () => {
  const eml = `From: A <a@x.com>
To: Inbox <inbox@labspace.ai>
Subject: Bad name
Message-ID: <bad-001@x.com>
Date: Wed, 22 Apr 2026 12:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain

text body
--b1
Content-Type: text/plain; name="../../etc/passwd"
Content-Disposition: attachment; filename="../../etc/passwd"
Content-Transfer-Encoding: base64

ZGFuZ2Vy
--b1--`;
  const result = await channel.parse({
    raw: new TextEncoder().encode(eml),
    envelope_to: 'inbox@labspace.ai',
  });
  assertExists(result);
  const att = result!.item.fields.attachments[0];
  // Path separators stripped; no `../`
  assertEquals(att.filename.includes('/'), false);
  assertEquals(att.filename.includes('\\'), false);
});
