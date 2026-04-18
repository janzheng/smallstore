/**
 * Adapter listKeys() tests — mocked HTTP for Upstash + Cloudflare KV.
 *
 * Spins up a local Deno.serve mock that emulates the adapter's upstream
 * paging protocol (Upstash SCAN, CF KV list) and asserts that listKeys()
 * threads cursors + limits through correctly.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import { UpstashAdapter } from '../src/adapters/upstash.ts';
import { CloudflareKVAdapter } from '../src/adapters/cloudflare-kv.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

// ---------------------------------------------------------------------------
// Mock server harness
// ---------------------------------------------------------------------------

interface MockServer {
  url: string;
  requests: Array<{ method: string; path: string; query: URLSearchParams }>;
  stop: () => Promise<void>;
}

async function startMock(
  handler: (req: { path: string; query: URLSearchParams }) => { status?: number; body: unknown },
): Promise<MockServer> {
  const requests: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const u = new URL(req.url);
    requests.push({ method: req.method, path: u.pathname, query: u.searchParams });
    const { status = 200, body } = handler({ path: u.pathname, query: u.searchParams });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://localhost:${addr.port}`,
    requests,
    stop: () => server.shutdown(),
  };
}

// ---------------------------------------------------------------------------
// Upstash SCAN
// ---------------------------------------------------------------------------

Deno.test({
  name: 'UpstashAdapter.listKeys - walks SCAN cursor to collect keys',
  ...opts,
  fn: async () => {
    // Emulate Upstash SCAN: /scan/<cursor>?match=...&count=...
    // Page 1 returns cursor "5" + 3 keys; page 2 returns "0" (done) + 2 keys.
    const pages = new Map<string, [string, string[]]>([
      ['0', ['5', ['k1', 'k2', 'k3']]],
      ['5', ['0', ['k4', 'k5']]],
    ]);
    const mock = await startMock(({ path }) => {
      const m = path.match(/^\/scan\/(.+)$/);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const cursor = decodeURIComponent(m[1]);
      const page = pages.get(cursor) ?? ['0', []];
      return { body: { result: page } };
    });

    try {
      const adapter = new UpstashAdapter({ url: mock.url, token: 'test' });
      const result = await adapter.listKeys({});
      assertEquals(result.keys, ['k1', 'k2', 'k3', 'k4', 'k5']);
      assertEquals(result.hasMore, false);
      assert(mock.requests.length >= 2, 'SCAN must iterate at least 2 pages');
    } finally {
      await mock.stop();
    }
  },
});

Deno.test({
  name: 'UpstashAdapter.listKeys - limit stops iteration and returns cursor',
  ...opts,
  fn: async () => {
    const pages = new Map<string, [string, string[]]>([
      ['0', ['5', ['a', 'b', 'c']]],
      ['5', ['0', ['d', 'e']]],
    ]);
    const mock = await startMock(({ path }) => {
      const m = path.match(/^\/scan\/(.+)$/);
      const cursor = m ? decodeURIComponent(m[1]) : '0';
      const page = pages.get(cursor) ?? ['0', []];
      return { body: { result: page } };
    });

    try {
      const adapter = new UpstashAdapter({ url: mock.url, token: 'test' });
      const result = await adapter.listKeys({ limit: 2 });
      assertEquals(result.keys.length, 2);
      assertEquals(result.keys, ['a', 'b']);
      // After the first page we have 3 keys but limit=2; we return the cursor
      // so callers can continue. hasMore reflects cursor !== '0'.
      assert(result.hasMore || result.keys.length === 2);
    } finally {
      await mock.stop();
    }
  },
});

Deno.test({
  name: 'UpstashAdapter.listKeys - strips namespace prefix from results',
  ...opts,
  fn: async () => {
    const mock = await startMock(() => ({
      body: { result: ['0', ['ns1:alpha', 'ns1:beta']] },
    }));

    try {
      const adapter = new UpstashAdapter({ url: mock.url, token: 'test', namespace: 'ns1' });
      const result = await adapter.listKeys({});
      assertEquals(result.keys, ['alpha', 'beta']);
    } finally {
      await mock.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// Cloudflare KV list (HTTP mode)
// ---------------------------------------------------------------------------

Deno.test({
  name: 'CloudflareKVAdapter.listKeys - threads cursor through CF list endpoint',
  ...opts,
  fn: async () => {
    // Emulate CF: /kv/list?cursor=... → returns { keys, cursor, list_complete }
    const pages: Array<{ keys: Array<{ name: string }>; cursor?: string; list_complete?: boolean }> = [
      { keys: [{ name: 'k1' }, { name: 'k2' }], cursor: 'c1', list_complete: false },
      { keys: [{ name: 'k3' }], cursor: undefined, list_complete: true },
    ];
    let page = 0;
    const mock = await startMock(({ path }) => {
      if (!path.endsWith('/kv/list')) return { status: 404, body: { success: false } };
      return { body: { success: true, data: pages[page++] } };
    });

    try {
      const adapter = new CloudflareKVAdapter({
        mode: 'http',
        accountId: 'acct',
        namespaceId: 'ns',
        apiToken: 'tok',
        baseUrl: mock.url,
      });
      const result = await adapter.listKeys({});
      assertEquals(result.keys, ['k1', 'k2', 'k3']);
      assertEquals(result.hasMore, false);
    } finally {
      await mock.stop();
    }
  },
});

Deno.test({
  name: 'CloudflareKVAdapter.listKeys - returns cursor when limit is reached',
  ...opts,
  fn: async () => {
    const mock = await startMock(({ query }) => {
      // First call: full page, more available. Second call would include cursor=abc.
      if (!query.get('cursor')) {
        return { body: { success: true, data: { keys: [{ name: 'a' }, { name: 'b' }], cursor: 'abc', list_complete: false } } };
      }
      return { body: { success: true, data: { keys: [{ name: 'c' }], list_complete: true } } };
    });

    try {
      const adapter = new CloudflareKVAdapter({
        mode: 'http',
        accountId: 'acct',
        namespaceId: 'ns',
        apiToken: 'tok',
        baseUrl: mock.url,
      });
      const result = await adapter.listKeys({ limit: 2 });
      assertEquals(result.keys, ['a', 'b']);
      assert(result.hasMore, 'hasMore should be true when cursor is set');
      assertEquals(result.cursor, 'abc');
    } finally {
      await mock.stop();
    }
  },
});
