/**
 * Smallstore MCP Server Tests
 *
 * Spawns src/mcp-server.ts as a stdio subprocess and exercises it via
 * JSON-RPC. Uses a mock HTTP server (random port) to capture the requests
 * the MCP server forwards, except for one end-to-end test that boots the
 * real serve.ts.
 *
 * Run: deno test --allow-all tests/mcp-server.test.ts
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';

// ============================================================================
// Constants
// ============================================================================

const MCP_ENTRY = new URL('../src/mcp-server.ts', import.meta.url).pathname;
const SERVE_ENTRY = new URL('../serve.ts', import.meta.url).pathname;
const READ_TIMEOUT_MS = 5000;

// ============================================================================
// JSON-RPC subprocess harness
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpProcess {
  proc: Deno.ChildProcess;
  send: (msg: JsonRpcRequest) => Promise<void>;
  recv: () => Promise<JsonRpcResponse>;
  close: () => Promise<void>;
}

function startMcp(env: Record<string, string>): McpProcess {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-net', '--allow-read', '--allow-env', MCP_ENTRY],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    env: { ...env, NO_COLOR: '1' },
  });
  const proc = cmd.spawn();

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const writer = proc.stdin.getWriter();
  const reader = proc.stdout.getReader();

  let buffer = '';
  const pending: string[] = [];

  async function readLine(): Promise<string> {
    while (true) {
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        return line;
      }
      // Race read against a timeout so tests can't hang forever.
      const { promise: timeoutP, cancel } = timeout(READ_TIMEOUT_MS);
      const result = await Promise.race([
        reader.read().then((r) => ({ kind: 'read' as const, r })),
        timeoutP.then(() => ({ kind: 'timeout' as const })),
      ]);
      cancel();
      if (result.kind === 'timeout') {
        throw new Error(`MCP stdout read timeout after ${READ_TIMEOUT_MS}ms`);
      }
      if (result.r.done) throw new Error('MCP stdout closed');
      buffer += decoder.decode(result.r.value);
    }
  }

  return {
    proc,
    async send(msg) {
      const line = JSON.stringify(msg) + '\n';
      await writer.write(encoder.encode(line));
    },
    async recv() {
      // Drain any already-buffered line first.
      if (pending.length > 0) return JSON.parse(pending.shift()!);
      const line = await readLine();
      return JSON.parse(line);
    },
    async close() {
      try { await writer.close(); } catch { /* already closed */ }
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      try { await reader.cancel(); } catch { /* already cancelled */ }
      try { await proc.stderr.cancel(); } catch { /* already cancelled */ }
      await proc.status;
    },
  };
}

function timeout(ms: number): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    cancel = () => clearTimeout(t);
  });
  return { promise, cancel };
}

// ============================================================================
// Mock HTTP server
// ============================================================================

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockResponder {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface MockServer {
  url: string;
  port: number;
  requests: CapturedRequest[];
  setResponder: (fn: (req: CapturedRequest) => MockResponder) => void;
  stop: () => Promise<void>;
}

function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let responder: (req: CapturedRequest) => MockResponder = () => ({ status: 200, body: { ok: true } });

  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: ({ port, hostname }) => {
        resolve({
          url: `http://${hostname === '::1' ? 'localhost' : hostname}:${port}`,
          port,
          requests,
          setResponder(fn) { responder = fn; },
          async stop() {
            ac.abort();
            try { await server.finished; } catch { /* ignore */ }
          },
        });
      } },
      async (req) => {
        const url = new URL(req.url);
        let body: unknown = undefined;
        const text = await req.text();
        if (text) {
          try { body = JSON.parse(text); } catch { body = text; }
        }
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        const captured: CapturedRequest = {
          method: req.method,
          path: url.pathname + url.search,
          headers,
          body,
        };
        requests.push(captured);
        const r = responder(captured);
        return new Response(
          r.body === undefined ? null : JSON.stringify(r.body),
          {
            status: r.status ?? 200,
            headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
          },
        );
      },
    );
  });
}

// ============================================================================
// Helpers
// ============================================================================

let rpcId = 0;
function nextId() { return ++rpcId; }

async function callTool(
  mcp: McpProcess,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const id = nextId();
  await mcp.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const resp = await mcp.recv();
  assertEquals(resp.id, id, `response id should match request id ${id}`);
  return resp;
}

function extractText(resp: JsonRpcResponse): { text: string; isError: boolean } {
  const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  assertExists(result, 'response.result missing');
  const first = result.content[0];
  assertExists(first, 'no content[0]');
  return { text: first.text, isError: result.isError === true };
}

// ============================================================================
// 1. tools/list
// ============================================================================

Deno.test('MCP: tools/list returns all expected tools with inputSchemas', async () => {
  const mock = await startMockServer();
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    await mcp.send({ jsonrpc: '2.0', id: nextId(), method: 'tools/list' });
    const resp = await mcp.recv();
    const result = resp.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    assertExists(result?.tools);
    const names = result.tools.map((t) => t.name).sort();
    // Tool registry as of 2026-04-28. If you add or remove an MCP tool,
    // update this list. The test exists to catch unintentional drift in
    // the public tool surface — every entry here is something an
    // already-shipped MCP client may depend on.
    assertEquals(names, [
      // core (10)
      'sm_adapters', 'sm_append', 'sm_delete', 'sm_list', 'sm_query', 'sm_read',
      'sm_sync', 'sm_sync_jobs', 'sm_sync_status', 'sm_write',
      // inbox — items + confirmations + notes/todos + replay (21)
      'sm_inbox_attachments_list',
      'sm_inbox_confirm',
      'sm_inbox_delete',
      'sm_inbox_export',
      'sm_inbox_list',
      'sm_inbox_mark_read',
      'sm_inbox_mark_read_many',
      'sm_inbox_mark_unread',
      'sm_inbox_mirror',
      'sm_inbox_notes',
      'sm_inbox_quarantine_list',
      'sm_inbox_query',
      'sm_inbox_read',
      'sm_inbox_replay_hook',
      'sm_inbox_restore',
      'sm_inbox_set_note',
      'sm_inbox_tag',
      'sm_inbox_todos',
      'sm_inbox_unsubscribe',
      // inbox — rules CRUD (6)
      'sm_inbox_rules_apply_retroactive',
      'sm_inbox_rules_create',
      'sm_inbox_rules_delete',
      'sm_inbox_rules_get',
      'sm_inbox_rules_list',
      'sm_inbox_rules_update',
      // newsletter views (4)
      'sm_newsletter_get',
      'sm_newsletter_items',
      'sm_newsletter_notes',
      'sm_newsletters_list',
      // auto-confirm allowlist (3)
      'sm_auto_confirm_add',
      'sm_auto_confirm_list',
      'sm_auto_confirm_remove',
      // peers (8)
      'sm_peers_create',
      'sm_peers_delete',
      'sm_peers_fetch',
      'sm_peers_get',
      'sm_peers_health',
      'sm_peers_list',
      'sm_peers_query',
      'sm_peers_update',
    ].sort());
    for (const tool of result.tools) {
      assertExists(tool.description, `${tool.name} missing description`);
      assertExists(tool.inputSchema, `${tool.name} missing inputSchema`);
      assertEquals(
        (tool.inputSchema as { type?: string }).type,
        'object',
        `${tool.name} inputSchema.type should be "object"`,
      );
    }
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

// ============================================================================
// 2. Tool-call forwarding
// ============================================================================

Deno.test('MCP: sm_read forwards to GET /api/:collection/:key', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { value: { name: 'Alice' }, adapter: 'memory' } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_read', { collection: 'users', key: 'alice' });
    const { text, isError } = extractText(resp);
    assertEquals(isError, false);
    assert(text.includes('Alice'), `response text should include mock body: ${text}`);
    assertEquals(mock.requests.length, 1);
    assertEquals(mock.requests[0].method, 'GET');
    assertEquals(mock.requests[0].path, '/api/users/alice');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_write forwards to PUT with {data} body', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { ok: true } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_write', {
      collection: 'users',
      key: 'bob',
      data: { name: 'Bob', age: 42 },
    });
    const { isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests.length, 1);
    const req = mock.requests[0];
    assertEquals(req.method, 'PUT');
    assertEquals(req.path, '/api/users/bob');
    assertEquals(req.body, { data: { name: 'Bob', age: 42 } });
    assertEquals(req.headers['content-type'], 'application/json');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_delete forwards to DELETE /api/:collection/:key', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { deleted: true } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_delete', { collection: 'users', key: 'bob' });
    const { isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests.length, 1);
    assertEquals(mock.requests[0].method, 'DELETE');
    assertEquals(mock.requests[0].path, '/api/users/bob');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_list forwards pagination params to GET /:collection/keys', async () => {
  const mock = await startMockServer();
  // Server now honors limit server-side and returns hasMore/cursor shape.
  mock.setResponder(() => ({
    status: 200,
    body: { keys: ['a', 'b'], total: 4, hasMore: true, cursor: 'next-2' },
  }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_list', {
      collection: 'users',
      options: { prefix: 'a', limit: 2 },
    });
    const { text, isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests.length, 1);
    assertEquals(mock.requests[0].method, 'GET');
    assertEquals(mock.requests[0].path, '/api/users/keys?prefix=a&limit=2');
    const parsed = JSON.parse(text) as { keys: string[]; hasMore: boolean; cursor?: string };
    assertEquals(parsed.keys, ['a', 'b']);
    assertEquals(parsed.hasMore, true);
    assertEquals(parsed.cursor, 'next-2');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_query forwards filter to POST /api/:collection/query', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { rows: [] } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const filter = { status: 'active', 'meta.tag': { $in: ['x', 'y'] } };
    const resp = await callTool(mcp, 'sm_query', { collection: 'users', filter });
    const { isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests.length, 1);
    assertEquals(mock.requests[0].method, 'POST');
    assertEquals(mock.requests[0].path, '/api/users/query');
    assertEquals(mock.requests[0].body, filter);
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_adapters forwards to GET /_adapters', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({
    status: 200,
    body: { adapters: ['memory', 'local'], defaultAdapter: 'memory', mounts: {}, preset: null },
  }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_adapters', {});
    const { text, isError } = extractText(resp);
    assertEquals(isError, false);
    assert(text.includes('memory'));
    assertEquals(mock.requests.length, 1);
    assertEquals(mock.requests[0].method, 'GET');
    assertEquals(mock.requests[0].path, '/_adapters');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_sync POSTs to /_sync?wait=true by default (blocks for result)', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { source: 'memory', target: 'local', result: { migrated: 3 } } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_sync', {
      source_adapter: 'memory',
      target_adapter: 'local',
      options: { mode: 'push', dryRun: true },
    });
    const { isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests.length, 1);
    const req = mock.requests[0];
    assertEquals(req.method, 'POST');
    // Default is wait=true so callers get the result inline.
    assertEquals(req.path, '/_sync?wait=true');
    assertEquals(req.body, {
      source: 'memory',
      target: 'local',
      options: { mode: 'push', dryRun: true },
    });
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_sync background:true posts to /_sync (no wait param)', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 202, body: { jobId: 'sync-abc', logPath: '/tmp/x.jsonl', status: 'running' } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_sync', {
      source_adapter: 'memory',
      target_adapter: 'local',
      background: true,
    });
    const { isError, text } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests[0].path, '/_sync');
    const body = JSON.parse(text) as { jobId: string };
    assertEquals(body.jobId, 'sync-abc');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_sync_status forwards to GET /_sync/jobs/:id', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { jobId: 'sync-x', status: 'completed', events: [] } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_sync_status', { jobId: 'sync-x', tail: 10 });
    const { isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests[0].method, 'GET');
    assertEquals(mock.requests[0].path, '/_sync/jobs/sync-x?tail=10');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: sm_sync_jobs forwards to GET /_sync/jobs', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { jobs: [], total: 0 } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_sync_jobs', { limit: 20 });
    const { isError } = extractText(resp);
    assertEquals(isError, false);
    assertEquals(mock.requests[0].method, 'GET');
    assertEquals(mock.requests[0].path, '/_sync/jobs?limit=20');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

// ============================================================================
// 3. Error propagation
// ============================================================================

Deno.test('MCP: HTTP 404 surfaces as MCP isError response', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 404, body: { error: 'NotFound', message: 'no such key' } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_read', { collection: 'users', key: 'missing' });
    const { text, isError } = extractText(resp);
    assertEquals(isError, true, 'expected isError: true on 404');
    assert(text.includes('404'), `error text should mention status: ${text}`);
    assert(text.includes('sm_read failed'), `error text should name the tool: ${text}`);
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

Deno.test('MCP: HTTP 500 surfaces as MCP isError response', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 500, body: { error: 'InternalServerError', message: 'boom' } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url });
  try {
    const resp = await callTool(mcp, 'sm_write', { collection: 'users', key: 'alice', data: { x: 1 } });
    const { text, isError } = extractText(resp);
    assertEquals(isError, true);
    assert(text.includes('500'));
    assert(text.includes('sm_write failed'));
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

// ============================================================================
// 4. Auth header
// ============================================================================

Deno.test('MCP: SMALLSTORE_TOKEN adds Authorization: Bearer header', async () => {
  const mock = await startMockServer();
  mock.setResponder(() => ({ status: 200, body: { ok: true } }));
  const mcp = startMcp({ SMALLSTORE_URL: mock.url, SMALLSTORE_TOKEN: 'test-token' });
  try {
    await callTool(mcp, 'sm_read', { collection: 'users', key: 'alice' });
    assertEquals(mock.requests.length, 1);
    assertEquals(mock.requests[0].headers['authorization'], 'Bearer test-token');
  } finally {
    await mcp.close();
    await mock.stop();
  }
});

// ============================================================================
// 5. Connection failure
// ============================================================================

Deno.test('MCP: unreachable server surfaces clear error, does not hang', async () => {
  // Port 1 is reserved and nothing listens there — fetch fails immediately.
  const mcp = startMcp({ SMALLSTORE_URL: 'http://localhost:1' });
  try {
    const resp = await callTool(mcp, 'sm_read', { collection: 'users', key: 'alice' });
    const { text, isError } = extractText(resp);
    assertEquals(isError, true);
    assert(
      text.includes('unreachable') || text.toLowerCase().includes('connection') || text.toLowerCase().includes('refused'),
      `expected unreachable/connection/refused in error, got: ${text}`,
    );
  } finally {
    await mcp.close();
  }
});

// ============================================================================
// 6. End-to-end smoke test against real serve.ts
// ============================================================================

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) { await res.body?.cancel(); return; }
      await res.body?.cancel();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`serve.ts never became healthy at ${url}: ${lastErr}`);
}

Deno.test('MCP end-to-end: write → read → delete against live serve.ts', async () => {
  // Ask the OS for a free port by binding to 0 and immediately closing.
  // Small race window, but far less flaky than a random pick.
  const probe = Deno.listen({ port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const url = `http://localhost:${port}`;

  // Run serve.ts from a tmp cwd with an explicit memory-preset .smallstore.json
  // so it doesn't fall back to env-discovered adapters (Airtable/Notion etc.
  // from the parent process's .env, which crash without mappings/introspection).
  const tmpCwd = await Deno.makeTempDir({ prefix: 'smallstore-mcp-e2e-' });
  await Deno.writeTextFile(
    `${tmpCwd}/.smallstore.json`,
    JSON.stringify({ preset: 'memory', port: port }),
  );

  const serveProc = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-all', SERVE_ENTRY],
    cwd: tmpCwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    env: { SM_PORT: String(port), NO_COLOR: '1' },
  }).spawn();

  const mcp = startMcp({ SMALLSTORE_URL: url });

  try {
    try {
      await waitForHealth(url, 30000);
    } catch (err) {
      // Dump subprocess output to surface why serve.ts didn't come up.
      const so = await new Response(serveProc.stdout).text().catch(() => '');
      const se = await new Response(serveProc.stderr).text().catch(() => '');
      throw new Error(`${err}\n--- serve.ts stdout ---\n${so}\n--- serve.ts stderr ---\n${se}`);
    }

    const collection = `mcp-e2e-${Date.now()}`;
    const key = 'alpha';
    const data = { name: 'Alpha', n: 7 };

    // write
    const writeResp = await callTool(mcp, 'sm_write', { collection, key, data });
    assertEquals(extractText(writeResp).isError, false, 'sm_write should succeed');

    // read
    const readResp = await callTool(mcp, 'sm_read', { collection, key });
    const readText = extractText(readResp);
    assertEquals(readText.isError, false, `sm_read should succeed, got: ${readText.text}`);
    assert(readText.text.includes('Alpha'), `read should return stored value, got: ${readText.text}`);
    assert(readText.text.includes('"n": 7') || readText.text.includes('"n":7'), `read should include n=7, got: ${readText.text}`);

    // delete
    const delResp = await callTool(mcp, 'sm_delete', { collection, key });
    assertEquals(extractText(delResp).isError, false, 'sm_delete should succeed');

    // read again — should 404 and surface as isError
    const missingResp = await callTool(mcp, 'sm_read', { collection, key });
    const missing = extractText(missingResp);
    // Some backends return null with 200 rather than 404 — accept either shape,
    // but require the response to NOT contain the pre-delete value.
    assert(
      missing.isError || !missing.text.includes('Alpha'),
      `after delete, read should 404 or return null, got: ${missing.text}`,
    );
  } finally {
    await mcp.close();
    try { serveProc.kill('SIGTERM'); } catch { /* ignore */ }
    try { await serveProc.stdout.cancel(); } catch { /* ignore */ }
    try { await serveProc.stderr.cancel(); } catch { /* ignore */ }
    await serveProc.status;
    try { await Deno.remove(tmpCwd, { recursive: true }); } catch { /* ignore */ }
  }
});
