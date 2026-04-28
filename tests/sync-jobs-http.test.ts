/**
 * /_sync background-mode + /_sync/jobs endpoint integration tests.
 *
 * Boots serve.ts as a subprocess with a memory-preset config pointing at a
 * temp dataDir, POSTs /_sync (background), polls for completion via
 * /_sync/jobs/:id, and inspects the JSONL file directly.
 */

import { assert, assertEquals } from 'jsr:@std/assert';

const SERVE_ENTRY = new URL('../serve.ts', import.meta.url).pathname;

interface Server {
  url: string;
  dataDir: string;
  proc: Deno.ChildProcess;
  stop: () => Promise<void>;
}

async function startServer(): Promise<Server> {
  const port = (() => {
    const probe = Deno.listen({ port: 0 });
    const p = (probe.addr as Deno.NetAddr).port;
    probe.close();
    return p;
  })();
  const tmpCwd = await Deno.makeTempDir({ prefix: 'smallstore-sync-jobs-' });
  // Manual mode with two memory adapters so /_sync has distinct source+target
  // without the `memory` preset's extra routing surface.
  await Deno.writeTextFile(
    `${tmpCwd}/.smallstore.json`,
    JSON.stringify({
      port,
      dataDir: `${tmpCwd}/data`,
      adapters: {
        source: { type: 'memory' },
        target: { type: 'memory' },
      },
      defaultAdapter: 'source',
    }),
  );

  const proc = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-all', SERVE_ENTRY],
    cwd: tmpCwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    env: { NO_COLOR: '1' },
  }).spawn();

  // Wait for /health.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) { await res.body?.cancel(); break; }
      await res.body?.cancel();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }

  return {
    url: `http://localhost:${port}`,
    dataDir: `${tmpCwd}/data`,
    proc,
    stop: async () => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      try { await proc.stdout.cancel(); } catch { /* ignore */ }
      try { await proc.stderr.cancel(); } catch { /* ignore */ }
      await proc.status;
      try { await Deno.remove(tmpCwd, { recursive: true }); } catch { /* ignore */ }
    },
  };
}

Deno.test('sync-jobs-http: POST /_sync returns jobId + logPath in background mode', async () => {
  const srv = await startServer();
  try {
    // Seed a handful of records on source.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${srv.url}/api/source/item-${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { i } }),
      });
      assert(r.ok, `seed item-${i} failed: ${r.status}`);
      await r.body?.cancel();
    }

    const res = await fetch(`${srv.url}/_sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'source', target: 'target', options: { mode: 'push' } }),
    });
    assertEquals(res.status, 202);
    const body = await res.json();
    assert(typeof body.jobId === 'string' && body.jobId.startsWith('sync-'));
    assert(typeof body.logPath === 'string' && body.logPath.endsWith('.jsonl'));
    assertEquals(body.status, 'running');

    // Poll /_sync/jobs/:id until terminal. Deadline raised to 30s (was 10s)
    // because full-suite parallelism loads the filesystem enough that the
    // job's JSONL writes can lag — the test was a flaky 1-in-3 failure
    // under `deno test tests/`. Polled every 50ms; in isolation the job
    // settles in <1s, so this only matters under contention.
    const deadline = Date.now() + 30000;
    let summary: Record<string, unknown> | null = null;
    let lastStatus: unknown = 'never-fetched';
    let pollCount = 0;
    while (Date.now() < deadline) {
      const s = await fetch(`${srv.url}/_sync/jobs/${body.jobId}`);
      if (s.ok) {
        summary = await s.json() as Record<string, unknown>;
        lastStatus = summary.status;
        pollCount++;
        if (summary.status === 'completed' || summary.status === 'failed') break;
      } else {
        await s.body?.cancel();
      }
      await new Promise(r => setTimeout(r, 50));
    }
    assert(summary !== null, 'summary should be fetched at least once before deadline');
    assertEquals(
      summary.status,
      'completed',
      `expected completed, got ${lastStatus} after ${pollCount} polls; events=${JSON.stringify((summary as { events?: unknown[] }).events?.slice(-3))}`,
    );
    const events = summary.events as Array<Record<string, unknown>>;
    assertEquals(events[0].event, 'started');
    assertEquals(events[events.length - 1].event, 'completed');
    assert(events.some(e => e.event === 'progress'), 'should have progress events');

    // JSONL file exists on disk with the same content.
    const raw = await Deno.readTextFile(body.logPath);
    assert(raw.includes('"event":"started"'));
    assert(raw.includes('"event":"completed"'));
  } finally {
    await srv.stop();
  }
});

Deno.test('sync-jobs-http: POST /_sync?wait=true returns result inline', async () => {
  const srv = await startServer();
  try {
    await fetch(`${srv.url}/api/source/only-item`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { x: 1 } }),
    }).then(r => r.body?.cancel());

    const res = await fetch(`${srv.url}/_sync?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'source', target: 'target', options: { mode: 'push' } }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(typeof body.jobId === 'string');
    assert(typeof body.result === 'object', 'wait=true should include result inline');
  } finally {
    await srv.stop();
  }
});

Deno.test('sync-jobs-http: GET /_sync/jobs lists recent jobs', async () => {
  const srv = await startServer();
  try {
    // Create two jobs.
    for (let i = 0; i < 2; i++) {
      await fetch(`${srv.url}/api/source/item-${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { i } }),
      }).then(r => r.body?.cancel());
    }
    await fetch(`${srv.url}/_sync?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'source', target: 'target', options: { mode: 'push' } }),
    }).then(r => r.body?.cancel());
    await fetch(`${srv.url}/_sync?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'source', target: 'target', options: { mode: 'push' } }),
    }).then(r => r.body?.cancel());

    const res = await fetch(`${srv.url}/_sync/jobs`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body.jobs));
    assert(body.jobs.length >= 2, `expected at least 2 jobs, got ${body.jobs.length}`);
    // Every job should have a status.
    for (const j of body.jobs) {
      assert(['running', 'completed', 'failed', 'unknown'].includes(j.status));
    }
  } finally {
    await srv.stop();
  }
});

Deno.test('sync-jobs-http: GET /_sync/jobs/:id rejects path-traversal ids', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.url}/_sync/jobs/..%2Fsecret`);
    // The hono router decodes %2F → /, turning this into a different route,
    // so status is 404 (no matching route) rather than our 400. Either is OK —
    // both deny the traversal attempt. Important thing: not 200.
    assert(res.status === 400 || res.status === 404, `expected 400/404 for traversal, got ${res.status}`);
    await res.body?.cancel();
  } finally {
    await srv.stop();
  }
});
