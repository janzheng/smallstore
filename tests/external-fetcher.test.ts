/**
 * External fetcher unit tests
 *
 * Subjects:
 *   src/utils/retry-fetch.ts  (retryFetch, parseRetryAfter, HttpError)
 *   src/utils/retry.ts        (retry, retryWithBackoff, isRetryableError)
 *   src/utils/external-fetcher.ts (fetchExternal, parseCSV, detectDataType)
 *
 * Uses Deno.serve({ port: 0 }) for local mock servers.
 */

import { assert, assertEquals, assertRejects, assertGreater } from 'jsr:@std/assert';
import {
  retryFetch,
  HttpError,
  parseRetryAfter,
} from '../src/utils/retry-fetch.ts';
import {
  retry,
  retryWithBackoff,
  isRetryableError,
} from '../src/utils/retry.ts';
import {
  fetchExternal,
  parseCSV,
  detectDataType,
} from '../src/utils/external-fetcher.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

// Silence retry console noise
const silentRetry = {
  onRetry: (_attempt: number, _err: any, _delay: number) => {},
};

interface MockServer {
  url: string;
  server: Deno.HttpServer;
  stop: () => Promise<void>;
  hits: () => number;
}

async function startServer(
  handler: (req: Request, hit: number) => Response | Promise<Response>,
): Promise<MockServer> {
  let count = 0;
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    (req) => {
      count++;
      return handler(req, count);
    },
  );
  // @ts-ignore – addr is NetAddr
  const port = server.addr.port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    server,
    stop: async () => {
      await server.shutdown();
    },
    hits: () => count,
  };
}

// ============================================================================
// Successful fetch
// ============================================================================

Deno.test({
  name: 'retryFetch - successful 200 returns response',
  ...opts,
  fn: async () => {
    const s = await startServer(() => new Response('ok', { status: 200 }));
    try {
      const res = await retryFetch(s.url, undefined, silentRetry);
      assertEquals(res.status, 200);
      assertEquals(await res.text(), 'ok');
      assertEquals(s.hits(), 1);
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// 5xx triggers retry, eventually succeeds
// ============================================================================

Deno.test({
  name: 'retryFetch - 5xx then 200 retries and succeeds',
  ...opts,
  fn: async () => {
    const s = await startServer((_req, n) => {
      if (n < 3) return new Response('boom', { status: 503 });
      return new Response('yay', { status: 200 });
    });
    try {
      const res = await retryFetch(s.url, undefined, {
        initialDelay: 10,
        maxRetries: 5,
        ...silentRetry,
      });
      assertEquals(res.status, 200);
      assertEquals(await res.text(), 'yay');
      assertEquals(s.hits(), 3);
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// Exhausts retries → throws HttpError
// ============================================================================

Deno.test({
  name: 'retryFetch - always 500 exhausts retries and throws HttpError',
  ...opts,
  fn: async () => {
    const s = await startServer(() => new Response('nope', { status: 500 }));
    try {
      const err = await assertRejects(
        () =>
          retryFetch(s.url, undefined, {
            initialDelay: 10,
            maxRetries: 2,
            ...silentRetry,
          }),
        HttpError,
      );
      assertEquals((err as HttpError).status, 500);
      // 1 initial + 2 retries = 3 attempts
      assertEquals(s.hits(), 3);
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// 4xx does NOT retry
// ============================================================================

Deno.test({
  name: 'retryFetch - 404 does not retry',
  ...opts,
  fn: async () => {
    const s = await startServer(() => new Response('missing', { status: 404 }));
    try {
      await assertRejects(
        () =>
          retryFetch(s.url, undefined, {
            initialDelay: 10,
            maxRetries: 5,
            ...silentRetry,
          }),
        HttpError,
      );
      assertEquals(s.hits(), 1, '4xx should not retry');
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'retryFetch - 400 does not retry',
  ...opts,
  fn: async () => {
    const s = await startServer(() => new Response('bad', { status: 400 }));
    try {
      await assertRejects(
        () =>
          retryFetch(s.url, undefined, {
            initialDelay: 10,
            maxRetries: 3,
            ...silentRetry,
          }),
        HttpError,
      );
      assertEquals(s.hits(), 1);
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// 429 IS retried (rate limit is transient)
// ============================================================================

Deno.test({
  name: 'retryFetch - 429 then 200 succeeds',
  ...opts,
  fn: async () => {
    const s = await startServer((_req, n) => {
      if (n === 1) return new Response('rate-limited', { status: 429 });
      return new Response('ok', { status: 200 });
    });
    try {
      const res = await retryFetch(s.url, undefined, {
        initialDelay: 10,
        maxRetries: 3,
        ...silentRetry,
      });
      assertEquals(res.status, 200);
      assertEquals(s.hits(), 2);
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// Exponential backoff — time between retries grows
// ============================================================================

Deno.test({
  name: 'retry - exponential backoff delays grow',
  ...opts,
  fn: async () => {
    const delays: number[] = [];
    let attempts = 0;

    await retryWithBackoff(
      async () => {
        attempts++;
        throw Object.assign(new Error('transient'), { statusCode: 500 });
      },
      {
        maxRetries: 3,
        initialDelay: 20,
        backoffMultiplier: 2,
        onRetry: (_a, _e, delay) => {
          delays.push(delay);
        },
      },
    );

    assertEquals(attempts, 4); // 1 initial + 3 retries
    assertEquals(delays.length, 3);
    // initialDelay * multiplier^(attempt-1): 20, 40, 80
    assertEquals(delays[0], 20);
    assertEquals(delays[1], 40);
    assertEquals(delays[2], 80);
    // Strictly growing
    assert(delays[1] > delays[0]);
    assert(delays[2] > delays[1]);
  },
});

Deno.test({
  name: 'retry - maxDelay caps backoff',
  ...opts,
  fn: async () => {
    const delays: number[] = [];
    await retryWithBackoff(
      async () => {
        throw Object.assign(new Error('boom'), { statusCode: 500 });
      },
      {
        maxRetries: 4,
        initialDelay: 100,
        backoffMultiplier: 10,
        maxDelay: 250,
        onRetry: (_a, _e, delay) => { delays.push(delay); },
      },
    );
    // Uncapped: 100, 1000, 10000, 100000. Capped to 250 from attempt 2+.
    assertEquals(delays[0], 100);
    assertEquals(delays[1], 250);
    assertEquals(delays[2], 250);
    assertEquals(delays[3], 250);
  },
});

// ============================================================================
// parseRetryAfter
// ============================================================================

Deno.test('retry - parseRetryAfter handles integer seconds', () => {
  assertEquals(parseRetryAfter('5'), 5000);
  assertEquals(parseRetryAfter('0'), 0);
});

Deno.test('retry - parseRetryAfter handles HTTP-date', () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfter(future);
  assert(ms !== undefined);
  assert(ms! > 5_000 && ms! <= 15_000, `got ${ms}ms`);
});

Deno.test('retry - parseRetryAfter for past date returns 0', () => {
  const past = new Date(Date.now() - 10_000).toUTCString();
  assertEquals(parseRetryAfter(past), 0);
});

Deno.test('retry - parseRetryAfter returns undefined for garbage', () => {
  assertEquals(parseRetryAfter('not-a-number-or-date'), undefined);
});

// ============================================================================
// Retry-After header is honored
// ============================================================================

Deno.test({
  name: 'retryFetch - honors Retry-After header on 429',
  ...opts,
  fn: async () => {
    const s = await startServer((_req, n) => {
      if (n === 1) {
        return new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response('ok', { status: 200 });
    });
    try {
      const start = Date.now();
      const res = await retryFetch(s.url, undefined, {
        initialDelay: 10_000, // huge default, but Retry-After: 0 overrides
        maxRetries: 2,
        ...silentRetry,
      });
      const elapsed = Date.now() - start;
      assertEquals(res.status, 200);
      // Should complete quickly because Retry-After: 0 overrode the 10s default
      assert(elapsed < 1_000, `expected <1s, got ${elapsed}ms`);
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// isRetryableError
// ============================================================================

Deno.test('retry - isRetryableError: 5xx is retryable', () => {
  assertEquals(isRetryableError({ statusCode: 500 }), true);
  assertEquals(isRetryableError({ statusCode: 502 }), true);
  assertEquals(isRetryableError({ status: 503 }), true);
});

Deno.test('retry - isRetryableError: 4xx is not retryable', () => {
  assertEquals(isRetryableError({ statusCode: 400 }), false);
  assertEquals(isRetryableError({ statusCode: 404 }), false);
  assertEquals(isRetryableError({ statusCode: 401 }), false);
});

Deno.test('retry - isRetryableError: 429 IS retryable', () => {
  assertEquals(isRetryableError({ statusCode: 429 }), true);
});

Deno.test('retry - isRetryableError: NotFound is not retryable', () => {
  assertEquals(isRetryableError({ name: 'NotFound' }), false);
  assertEquals(isRetryableError({ name: 'ValidationError' }), false);
});

Deno.test('retry - isRetryableError: network error codes are retryable', () => {
  assertEquals(isRetryableError({ code: 'ECONNRESET' }), true);
  assertEquals(isRetryableError({ code: 'ETIMEDOUT' }), true);
});

// ============================================================================
// retry does not retry on non-retryable errors
// ============================================================================

Deno.test({
  name: 'retry - non-retryable error fails immediately',
  ...opts,
  fn: async () => {
    let attempts = 0;
    const err = await assertRejects(
      () =>
        retry(
          async () => {
            attempts++;
            throw Object.assign(new Error('nope'), { name: 'NotFound' });
          },
          { maxRetries: 5, initialDelay: 10, ...silentRetry },
        ),
    );
    assertEquals(attempts, 1);
    assertEquals((err as Error).name, 'NotFound');
  },
});

// ============================================================================
// AbortSignal support — fetch respects it, retryFetch does not re-retry
// ============================================================================

Deno.test({
  name: 'retryFetch - AbortSignal aborts in-flight request',
  ...opts,
  fn: async () => {
    const s = await startServer(async () => {
      // Hang long enough for the abort to kick in
      await new Promise((r) => setTimeout(r, 2000));
      return new Response('too late');
    });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      await assertRejects(
        () =>
          retryFetch(
            s.url,
            { signal: controller.signal },
            {
              initialDelay: 10,
              maxRetries: 0,
              ...silentRetry,
            },
          ),
      );
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// fetchExternal — successful JSON fetch
// ============================================================================

Deno.test({
  name: 'fetchExternal - fetches JSON successfully',
  ...opts,
  fn: async () => {
    const payload = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    const s = await startServer(() =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'ETag': '"v1"' },
      })
    );
    try {
      const result = await fetchExternal({
        url: s.url + '/data.json',
        type: 'auto',
      });
      assertEquals(result.data, payload);
      assertEquals(result.fromCache, false);
      assertEquals(result.source.type, 'json');
      assertEquals(result.source.etag, '"v1"');
      assert(result.fetchedAt > 0);
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - 5xx retries then succeeds',
  ...opts,
  fn: async () => {
    const s = await startServer((_req, n) => {
      if (n < 2) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      // fetchExternal uses initialDelay: 500 internally — we just ride it out
      const result = await fetchExternal({
        url: s.url,
        type: 'json',
      });
      assertEquals(result.data, { ok: true });
      assertGreater(s.hits(), 1);
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - 404 surfaces as error without endless retry',
  ...opts,
  fn: async () => {
    const s = await startServer(() => new Response('missing', { status: 404 }));
    try {
      await assertRejects(
        () => fetchExternal({ url: s.url, type: 'json' }),
        Error,
      );
      // 4xx should not retry — exactly 1 hit
      assertEquals(s.hits(), 1);
    } finally {
      await s.stop();
    }
  },
});

// 304 Not Modified is now treated as a valid conditional-request response,
// letting fetchExternal's CACHE_VALID branch run.
Deno.test({
  name: 'fetchExternal - 304 Not Modified throws CACHE_VALID',
  ...opts,
  fn: async () => {
    const s = await startServer(() => new Response(null, { status: 304 }));
    try {
      await assertRejects(
        () =>
          fetchExternal({
            url: s.url,
            type: 'json',
            etag: '"v1"',
          }),
        Error,
        'CACHE_VALID',
      );
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - uses cache when within cacheTTL',
  ...opts,
  fn: async () => {
    const s = await startServer(() =>
      new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    try {
      await assertRejects(
        () =>
          fetchExternal({
            url: s.url,
            type: 'json',
            cacheTTL: 60_000,
            lastFetched: Date.now(), // just fetched → still fresh
          }),
        Error,
        'CACHE_VALID',
      );
      assertEquals(s.hits(), 0, 'fresh cache should not hit network');
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - forceRefresh bypasses cache',
  ...opts,
  fn: async () => {
    const s = await startServer(() =>
      new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    try {
      const result = await fetchExternal(
        {
          url: s.url,
          type: 'json',
          cacheTTL: 60_000,
          lastFetched: Date.now(),
        },
        true, // forceRefresh
      );
      assertEquals(result.data, []);
      assertEquals(s.hits(), 1);
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - sends Bearer auth header',
  ...opts,
  fn: async () => {
    let seenAuth = '';
    const s = await startServer((req) => {
      seenAuth = req.headers.get('Authorization') ?? '';
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      await fetchExternal({
        url: s.url,
        type: 'json',
        auth: { type: 'bearer', token: 'SECRET' },
      });
      assertEquals(seenAuth, 'Bearer SECRET');
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - sends Basic auth header',
  ...opts,
  fn: async () => {
    let seenAuth = '';
    const s = await startServer((req) => {
      seenAuth = req.headers.get('Authorization') ?? '';
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      await fetchExternal({
        url: s.url,
        type: 'json',
        auth: { type: 'basic', username: 'alice', password: 'hunter2' },
      });
      assertEquals(seenAuth, 'Basic ' + btoa('alice:hunter2'));
    } finally {
      await s.stop();
    }
  },
});

Deno.test({
  name: 'fetchExternal - sends conditional If-None-Match header',
  ...opts,
  fn: async () => {
    let seenIfNone = '';
    const s = await startServer((req) => {
      seenIfNone = req.headers.get('If-None-Match') ?? '';
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      await fetchExternal({
        url: s.url,
        type: 'json',
        etag: '"v9"',
      });
      assertEquals(seenIfNone, '"v9"');
    } finally {
      await s.stop();
    }
  },
});

// ============================================================================
// detectDataType
// ============================================================================

Deno.test('detectDataType - from content-type', () => {
  assertEquals(detectDataType('http://x', 'application/json'), 'json');
  assertEquals(detectDataType('http://x', 'text/csv'), 'csv');
  assertEquals(detectDataType('http://x', 'application/parquet'), 'parquet');
});

Deno.test('detectDataType - from URL extension', () => {
  assertEquals(detectDataType('http://x/data.json'), 'json');
  assertEquals(detectDataType('http://x/data.csv'), 'csv');
  assertEquals(detectDataType('http://x/data.parquet'), 'parquet');
});

Deno.test('detectDataType - unknown returns auto', () => {
  assertEquals(detectDataType('http://x/data'), 'auto');
});

// ============================================================================
// parseCSV
// ============================================================================

Deno.test('parseCSV - basic rows', () => {
  const csv = 'id,name\n1,Alice\n2,Bob';
  assertEquals(parseCSV(csv), [
    { id: '1', name: 'Alice' },
    { id: '2', name: 'Bob' },
  ]);
});

Deno.test('parseCSV - empty string returns empty array', () => {
  assertEquals(parseCSV(''), []);
});

Deno.test('parseCSV - strips surrounding quotes', () => {
  const csv = '"id","name"\n"1","Alice"';
  assertEquals(parseCSV(csv), [{ id: '1', name: 'Alice' }]);
});
