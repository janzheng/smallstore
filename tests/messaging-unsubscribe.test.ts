/**
 * Messaging — unsubscribe action tests.
 *
 * Exercises `unsubscribeSender` + `addSenderTag` against a memory-backed
 * sender index + mocked fetch. No real network is hit.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createSenderIndex, type SenderRecord } from '../src/messaging/sender-index.ts';
import { addSenderTag, unsubscribeSender } from '../src/messaging/unsubscribe.ts';
import type { InboxItem } from '../src/messaging/types.ts';

// ============================================================================
// Helpers
// ============================================================================

function makeItem(overrides: Partial<InboxItem> & { fields?: Record<string, any> } = {}): InboxItem {
  return {
    id: overrides.id ?? 'id-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'cf-email',
    received_at: overrides.received_at ?? '2026-04-22T12:00:00Z',
    summary: overrides.summary ?? 'Hello',
    body: overrides.body ?? 'Body text',
    fields: {
      from_email: 'jane@example.com',
      from_addr: '"Jane Doe" <jane@example.com>',
      ...overrides.fields,
    },
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

function freshIndex() {
  const adapter = new MemoryAdapter();
  const index = createSenderIndex(adapter);
  return { adapter, index };
}

interface FetchCall {
  url: string | URL;
  init?: RequestInit;
}

function mockFetch(response: { status?: number; ok?: boolean } = { status: 200, ok: true }) {
  const calls: FetchCall[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ url: input as string, init });
    const status = response.status ?? 200;
    const ok = response.ok ?? (status >= 200 && status < 300);
    return Promise.resolve(
      new Response('', { status }),
    ) as unknown as Promise<Response>;
  };
  return { fetch, calls };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test('unsubscribe — https URL: POSTs one-click body, returns ok=true, tags sender', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<https://example.com/unsub?u=123>' },
    },
  }));

  const { fetch, calls } = mockFetch({ status: 200 });

  const result = await unsubscribeSender(index, 'jane@example.com', { fetch });

  assertEquals(result.address, 'jane@example.com');
  assertEquals(result.method, 'https');
  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(result.attempted_url, 'https://example.com/unsub?u=123');
  assertExists(result.tagged_at);
  assertEquals(result.error, undefined);

  // Network call shape
  assertEquals(calls.length, 1);
  assertEquals(String(calls[0].url), 'https://example.com/unsub?u=123');
  assertEquals(calls[0].init?.method, 'POST');
  assertEquals(calls[0].init?.body, 'List-Unsubscribe=One-Click');
  const headers = calls[0].init?.headers as Record<string, string>;
  assertEquals(headers['content-type'], 'application/x-www-form-urlencoded');

  // Sender is tagged
  const record = await index.get('jane@example.com');
  assertEquals(record!.tags.includes('unsubscribed'), true);
});

Deno.test('unsubscribe — https non-2xx: ok=false, error carries status, tagged anyway', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<https://example.com/unsub>' },
    },
  }));

  const { fetch } = mockFetch({ status: 500 });

  const result = await unsubscribeSender(index, 'jane@example.com', { fetch });

  assertEquals(result.method, 'https');
  assertEquals(result.ok, false);
  assertEquals(result.status, 500);
  assertEquals(result.error, 'HTTP 500');
  assertExists(result.tagged_at);

  const record = await index.get('jane@example.com');
  assertEquals(record!.tags.includes('unsubscribed'), true);
});

Deno.test('unsubscribe — mailto URL: no fetch call, method=mailto, ok=false, attempted_url set', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<mailto:unsub@example.com>' },
    },
  }));

  const { fetch, calls } = mockFetch();

  const result = await unsubscribeSender(index, 'jane@example.com', { fetch });

  assertEquals(result.method, 'mailto');
  assertEquals(result.ok, false);
  assertEquals(result.attempted_url, 'mailto:unsub@example.com');
  assertEquals(calls.length, 0);
  assertExists(result.tagged_at);

  const record = await index.get('jane@example.com');
  assertEquals(record!.tags.includes('unsubscribed'), true);
});

Deno.test('unsubscribe — no URL on record: method=none, ok=false, sender still tagged', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({})); // no headers -> no list_unsubscribe_url

  const { fetch, calls } = mockFetch();
  const result = await unsubscribeSender(index, 'jane@example.com', { fetch });

  assertEquals(result.method, 'none');
  assertEquals(result.ok, false);
  assertEquals(result.attempted_url, undefined);
  assertEquals(calls.length, 0);
  assertExists(result.tagged_at);
  assertExists(result.error);

  const record = await index.get('jane@example.com');
  assertEquals(record!.tags.includes('unsubscribed'), true);
});

Deno.test('unsubscribe — unknown sender: method=none, ok=false, NOT tagged (no auto-create)', async () => {
  const { adapter, index } = freshIndex();
  const { fetch, calls } = mockFetch();

  const result = await unsubscribeSender(index, 'ghost@nowhere.com', { fetch });

  assertEquals(result.method, 'none');
  assertEquals(result.ok, false);
  assertEquals(result.tagged_at, undefined);
  assertEquals(calls.length, 0);

  // No record was created.
  const keys = await adapter.keys('senders/');
  assertEquals(keys.length, 0);
});

Deno.test('unsubscribe — skipCall=true: no fetch, but sender tagged; attempted_url echoes known URL', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<https://example.com/unsub>' },
    },
  }));

  const { fetch, calls } = mockFetch();
  const result = await unsubscribeSender(index, 'jane@example.com', { fetch, skipCall: true });

  assertEquals(result.method, 'none');
  assertEquals(result.ok, false);
  assertEquals(result.attempted_url, 'https://example.com/unsub');
  assertEquals(calls.length, 0);
  assertExists(result.tagged_at);

  const record = await index.get('jane@example.com');
  assertEquals(record!.tags.includes('unsubscribed'), true);
});

Deno.test('unsubscribe — tag is idempotent: calling twice keeps a single unsubscribed tag', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<https://example.com/unsub>' },
    },
  }));

  const { fetch } = mockFetch({ status: 200 });
  await unsubscribeSender(index, 'jane@example.com', { fetch });
  await unsubscribeSender(index, 'jane@example.com', { fetch });

  const record = await index.get('jane@example.com');
  assertExists(record);
  const unsubCount = record!.tags.filter((t) => t === 'unsubscribed').length;
  assertEquals(unsubCount, 1);
});

Deno.test('unsubscribe — HTTPS timeout: ok=false with timeout error, sender still tagged', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({
    fields: {
      headers: { 'list-unsubscribe': '<https://example.com/slow>' },
    },
  }));

  // Fetch that never resolves unless aborted.
  const fetch: typeof globalThis.fetch = (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }
    });
  };

  const result = await unsubscribeSender(index, 'jane@example.com', { fetch, timeoutMs: 20 });

  assertEquals(result.method, 'https');
  assertEquals(result.ok, false);
  assertExists(result.error);
  // Message should reference timeout
  assertEquals(/timeout/i.test(result.error!), true);
  assertExists(result.tagged_at);

  const record = await index.get('jane@example.com');
  assertEquals(record!.tags.includes('unsubscribed'), true);
});

Deno.test('addSenderTag — idempotent: returns record unchanged when tag already present', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ labels: ['newsletter'] }));

  const r1 = await addSenderTag(index, 'jane@example.com', 'custom');
  assertExists(r1);
  assertEquals(r1!.tags.includes('custom'), true);

  const r2 = await addSenderTag(index, 'jane@example.com', 'custom');
  assertExists(r2);
  assertEquals(r2!.tags.filter((t) => t === 'custom').length, 1);
});

Deno.test('addSenderTag — returns null when sender not found (no auto-create)', async () => {
  const { adapter, index } = freshIndex();
  const r = await addSenderTag(index, 'ghost@nowhere.com', 'unsubscribed');
  assertEquals(r, null);
  const keys = await adapter.keys('senders/');
  assertEquals(keys.length, 0);
});

Deno.test('addSenderTag — address lookup is case-insensitive; record.address stays canonical', async () => {
  const { index } = freshIndex();
  await index.upsert(makeItem({ fields: { from_email: 'Jane@Example.COM', from_addr: 'Jane' } }));

  const updated = await addSenderTag(index, 'JANE@example.com', 'unsubscribed');
  assertExists(updated);
  assertEquals(updated!.address, 'jane@example.com');
  assertEquals(updated!.tags.includes('unsubscribed'), true);
});

Deno.test('setRecord — writes verbatim without bumping count/last_seen', async () => {
  const { index } = freshIndex();
  const initial = await index.upsert(makeItem({ received_at: '2026-04-22T10:00:00Z' }));
  assertExists(initial);

  const mutated: SenderRecord = { ...initial!, tags: [...initial!.tags, 'manual'] };
  await index.setRecord(mutated);

  const after = await index.get('jane@example.com');
  assertEquals(after!.count, 1);
  assertEquals(after!.last_seen, '2026-04-22T10:00:00Z');
  assertEquals(after!.tags.includes('manual'), true);
});
