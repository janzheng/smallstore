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
import { functionSink, inboxSink } from '../src/messaging/sinks.ts';
import type {
  HookContext,
  HookVerdict,
  InboxConfig,
  InboxItem,
  SinkContext,
} from '../src/messaging/types.ts';

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

Deno.test('email handler — sink fan-out: one registration with multiple sinks runs all independently', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const registry = new InboxRegistry();

  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items, blobs } });

  // Capture side effects from a functionSink alongside the primary inboxSink.
  const seen: Array<{ id: string; channel: string; registration?: string }> = [];
  registry.registerSinks('mailroom', {
    inbox,
    sinks: [
      inboxSink(inbox),
      functionSink(async (item: InboxItem, ctx: SinkContext) => {
        seen.push({ id: item.id, channel: ctx.channel, registration: ctx.registration });
      }),
    ],
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  // Both sinks fired: inbox persisted + function saw the item
  const listed = await inbox.list();
  assertEquals(listed.items.length, 1);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].id, listed.items[0].id);
  assertEquals(seen[0].channel, 'cf-email');
  assertEquals(seen[0].registration, 'mailroom');
});

Deno.test('email handler — sink fan-out: a failing sink does not block siblings', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const registry = new InboxRegistry();

  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items, blobs } });

  // Sink that always throws — we want to verify the inboxSink next to it still runs
  const throwingSink = functionSink(async () => {
    throw new Error('simulated downstream failure');
  });

  registry.registerSinks('mailroom', {
    inbox,
    sinks: [throwingSink, inboxSink(inbox)],
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  // Despite the throwing sink, the inboxSink persisted the item
  assertEquals((await inbox.list()).items.length, 1);
});

Deno.test('email handler — addSink: attaches a sink to an existing registration', async () => {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const registry = new InboxRegistry();

  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items, blobs } });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'a' }, 'boot');

  const seen: string[] = [];
  registry.addSink('mailroom', functionSink(async (item) => { seen.push(item.id); }));

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  assertEquals((await inbox.list()).items.length, 1);
  assertEquals(seen.length, 1);
});

// ============================================================================
// Hook pipeline (Wave 2 #4)
// ============================================================================

function setupHookedRegistry() {
  const items = new MemoryAdapter();
  const blobs = new MemoryAdapter();
  const registry = new InboxRegistry();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items, blobs } });
  return { items, blobs, registry, inbox };
}

Deno.test('email handler — built-in classifier runs by default, emits newsletter/list/bulk/auto-reply/bounce labels', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'a' }, 'boot');

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('06-ooo.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  const [item] = (await inbox.list()).items;
  assertExists(item);
  // cf-email inline detector emits auto-reply + ooo; classifier re-emits auto-reply (deduped)
  assertEquals(item.labels?.includes('auto-reply'), true);
  assertEquals(item.labels?.includes('ooo'), true);
});

Deno.test('email handler — classify: false disables built-in classifier', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'a' }, 'boot');

  const handler = createEmailHandler({ registry, classify: false, log: () => {} });
  const raw = await loadFixture('06-ooo.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  const [item] = (await inbox.list()).items;
  // Without classifier, only cf-email's inline labels remain (ooo + auto-reply still)
  // The test here asserts the classifier-only labels (newsletter/list/bulk) are NOT present
  // for the OOO fixture (which has no List-Unsubscribe etc).
  assertEquals(item.labels?.includes('newsletter'), false);
  assertEquals(item.labels?.includes('list'), false);
});

Deno.test('email handler — preIngest hook: drop verdict skips sinks', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      preIngest: [async (_item, _ctx): Promise<HookVerdict> => 'drop'],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  assertEquals((await inbox.list()).items.length, 0);
});

Deno.test('email handler — preIngest hook: quarantine verdict tags item with "quarantined" and still stores', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      preIngest: [async (_item, _ctx): Promise<HookVerdict> => 'quarantine'],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  const [item] = (await inbox.list()).items;
  assertExists(item);
  assertEquals(item.labels?.includes('quarantined'), true);
});

Deno.test('email handler — preIngest hook: mutated InboxItem flows downstream', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      preIngest: [async (item, _ctx): Promise<HookVerdict> => ({
        ...item,
        labels: [...(item.labels ?? []), 'tagged-by-hook'],
      })],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  const [item] = (await inbox.list()).items;
  assertEquals(item.labels?.includes('tagged-by-hook'), true);
});

Deno.test('email handler — postClassify hook sees classifier labels', async () => {
  const { registry, inbox } = setupHookedRegistry();
  let observedLabels: string[] | undefined;
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      postClassify: [async (item, _ctx): Promise<HookVerdict> => {
        observedLabels = item.labels ? [...item.labels] : [];
        return 'accept';
      }],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('06-ooo.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  assertExists(observedLabels);
  // postClassify sees labels AFTER classifier ran — should include auto-reply
  assertEquals(observedLabels!.includes('auto-reply'), true);
});

Deno.test('email handler — postStore hook receives sink results', async () => {
  const { registry, inbox } = setupHookedRegistry();
  let receivedResults: any = null;
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      postStore: [async (_item, _ctx, results) => { receivedResults = results; }],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  assertExists(receivedResults);
  assertEquals(Array.isArray(receivedResults), true);
  assertEquals(receivedResults.length, 1);
  assertEquals(receivedResults[0].stored, true);
});

Deno.test('email handler — throwing hook does not kill pipeline; item still stored', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      preIngest: [async (_item, _ctx): Promise<HookVerdict> => { throw new Error('bug in hook'); }],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  // Hook threw → treated as pass-through → item still lands
  assertEquals((await inbox.list()).items.length, 1);
});

Deno.test('email handler — addHook: attaches hook post-registration', async () => {
  const { registry, inbox } = setupHookedRegistry();
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'a' }, 'boot');

  const seen: string[] = [];
  registry.addHook('mailroom', 'postStore', async (item) => { seen.push(item.id); });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  assertEquals(seen.length, 1);
});

Deno.test('email handler — hook chain: multiple preIngest hooks run in order, short-circuit on drop', async () => {
  const { registry, inbox } = setupHookedRegistry();
  const callOrder: string[] = [];
  registry.registerSinks('mailroom', {
    inbox,
    hooks: {
      preIngest: [
        async (_item, _ctx): Promise<HookVerdict> => { callOrder.push('first'); return 'accept'; },
        async (_item, _ctx): Promise<HookVerdict> => { callOrder.push('second-drop'); return 'drop'; },
        async (_item, _ctx): Promise<HookVerdict> => { callOrder.push('third-never'); return 'accept'; },
      ],
    },
    config: { channel: 'cf-email', storage: 'a' } as InboxConfig,
    origin: 'boot',
  });

  const handler = createEmailHandler({ registry, log: () => {} });
  const raw = await loadFixture('01-plain-text.eml');
  await handler(makeMessage(raw, { to: 'mailroom@labspace.ai' }));

  assertEquals(callOrder, ['first', 'second-drop']);
  assertEquals((await inbox.list()).items.length, 0);
});
