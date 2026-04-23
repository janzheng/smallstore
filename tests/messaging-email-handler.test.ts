/**
 * Messaging — end-to-end email() handler tests.
 *
 * Builds a mock ForwardableEmailMessage from a fixture, runs the handler,
 * verifies the item lands in the configured inbox + blobs land in storage.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { createEmailHandler, type ForwardableEmailMessage } from '../src/messaging/email-handler.ts';
import type { InboxConfig } from '../src/messaging/types.ts';

const FIXTURES_DIR = new URL('./fixtures/cf-email/', import.meta.url);

async function loadFixture(name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(name, FIXTURES_DIR));
}

interface RejectCapture {
  rejected?: string;
}

function makeMessage(raw: Uint8Array, opts: { from?: string; to?: string } = {}): ForwardableEmailMessage & RejectCapture {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(raw);
      controller.close();
    },
  });
  const capture: RejectCapture = {};
  return {
    from: opts.from ?? 'sender@example.com',
    to: opts.to ?? 'inbox@labspace.ai',
    headers: new Headers(),
    raw: stream,
    rawSize: raw.byteLength,
    setReject(reason: string) { capture.rejected = reason; },
    forward: () => Promise.resolve(),
    rejected: undefined,
    get rejectedReason() { return capture.rejected; },
  } as any;
}

function buildHarness(): {
  registry: InboxRegistry;
  itemsAdapter: MemoryAdapter;
  blobsAdapter: MemoryAdapter;
  handler: ReturnType<typeof createEmailHandler>;
} {
  const itemsAdapter = new MemoryAdapter();
  const blobsAdapter = new MemoryAdapter();
  const registry = new InboxRegistry();
  const inbox = createInbox({
    name: 'mailroom',
    channel: 'cf-email',
    storage: { items: itemsAdapter, blobs: blobsAdapter },
  });
  const cfg: InboxConfig = { channel: 'cf-email', storage: 'items' };
  registry.register('mailroom', inbox, cfg, 'boot');
  const handler = createEmailHandler({ registry, log: () => {} });
  return { registry, itemsAdapter, blobsAdapter, handler };
}

// ============================================================================
// End-to-end
// ============================================================================

Deno.test('email handler — plain text fixture lands in inbox + raw blob persisted', async () => {
  const { handler, registry, blobsAdapter } = buildHarness();
  const raw = await loadFixture('01-plain-text.eml');
  const msg = makeMessage(raw, { from: 'alice@example.com', to: 'inbox@labspace.ai' });

  await handler(msg);

  const inbox = registry.get('mailroom')!;
  const list = await inbox.list();
  assertEquals(list.items.length, 1);
  const stored = list.items[0];
  assertEquals(stored.fields.from_email, 'alice@example.com');
  assertEquals(stored.fields.inbox_addr, 'inbox@labspace.ai');

  // Raw blob persisted
  assertExists(stored.raw_ref);
  const rawBack = await blobsAdapter.get(stored.raw_ref!);
  assertExists(rawBack);
});

Deno.test('email handler — multipart fixture: html lands in blobs adapter', async () => {
  const { handler, registry, blobsAdapter } = buildHarness();
  const raw = await loadFixture('02-multipart-html.eml');
  await handler(makeMessage(raw, { to: 'inbox@labspace.ai' }));

  const inbox = registry.get('mailroom')!;
  const list = await inbox.list();
  const stored = list.items[0];
  assertExists(stored);

  // Find the html blob
  const keys = await blobsAdapter.keys('html/');
  assertEquals(keys.length, 1);
  const html = await blobsAdapter.get(keys[0]);
  assertEquals(typeof html === 'string' && html.includes('<h1>Newsletter</h1>'), true);
});

Deno.test('email handler — attachment fixture: attachment blob is persisted', async () => {
  const { handler, registry, blobsAdapter } = buildHarness();
  const raw = await loadFixture('03-with-attachment.eml');
  await handler(makeMessage(raw, { to: 'inbox@labspace.ai' }));

  const inbox = registry.get('mailroom')!;
  const list = await inbox.list();
  const stored = list.items[0];
  const att = stored.fields.attachments[0];
  const back = await blobsAdapter.get(att.ref);
  assertExists(back);
});

Deno.test('email handler — same fixture twice: idempotent (no duplicate item)', async () => {
  const { handler, registry } = buildHarness();
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'inbox@labspace.ai' }));
  await handler(makeMessage(raw, { to: 'inbox@labspace.ai' }));

  const inbox = registry.get('mailroom')!;
  const list = await inbox.list();
  assertEquals(list.items.length, 1);
});

Deno.test('email handler — no inbox configured: setReject called', async () => {
  const registry = new InboxRegistry(); // empty
  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  const msg = makeMessage(raw);
  await handler(msg);

  assertEquals((msg as any).rejectedReason?.includes('no inbox configured'), true);
});

Deno.test('email handler — fan-out: same email lands in multiple inboxes for same channel', async () => {
  const itemsA = new MemoryAdapter();
  const blobsA = new MemoryAdapter();
  const itemsB = new MemoryAdapter();
  const blobsB = new MemoryAdapter();
  const registry = new InboxRegistry();

  const inboxA = createInbox({ name: 'primary', channel: 'cf-email', storage: { items: itemsA, blobs: blobsA } });
  const inboxB = createInbox({ name: 'archive', channel: 'cf-email', storage: { items: itemsB, blobs: blobsB } });
  registry.register('primary', inboxA, { channel: 'cf-email', storage: 'a' }, 'boot');
  registry.register('archive', inboxB, { channel: 'cf-email', storage: 'b' }, 'boot');

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'inbox@labspace.ai' }));

  assertEquals((await inboxA.list()).items.length, 1);
  assertEquals((await inboxB.list()).items.length, 1);
});
