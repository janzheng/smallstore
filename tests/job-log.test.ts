/**
 * JSONL job-log unit tests.
 *
 * Subject: src/utils/job-log.ts
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import { createJobLog, generateJobId, listJobs, summarizeJob, tailJobLog } from '../src/utils/job-log.ts';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'smallstore-joblog-' });
  try { await fn(dir); }
  finally { try { await Deno.remove(dir, { recursive: true }); } catch { /* ignore */ } }
}

Deno.test('job-log - generateJobId is unique per call', () => {
  const a = generateJobId('sync');
  const b = generateJobId('sync');
  assert(a.startsWith('sync-'));
  assert(b.startsWith('sync-'));
  assertEquals(a === b, false);
});

Deno.test('job-log - append writes valid JSONL, close idempotent', async () => {
  await withTempDir(async (dir) => {
    const log = await createJobLog({ jobId: 'test-1', dataDir: dir });
    await log.append({ event: 'started', source: 'a', target: 'b' });
    await log.append({ event: 'progress', phase: 'push', key: 'x', index: 0, total: 3 });
    await log.append({ event: 'completed', result: { migrated: 3 } });
    await log.close();
    await log.close(); // idempotent

    const text = await Deno.readTextFile(`${dir}/jobs/test-1.jsonl`);
    const lines = text.trim().split('\n');
    assertEquals(lines.length, 3);
    const parsed = lines.map(l => JSON.parse(l));
    assertEquals(parsed[0].event, 'started');
    assertEquals(parsed[1].event, 'progress');
    assertEquals(parsed[2].event, 'completed');
    // Timestamps auto-filled
    for (const p of parsed) assert(typeof p.t === 'string' && p.t.length > 10);
  });
});

Deno.test('job-log - append swallows errors after close (non-throwing)', async () => {
  await withTempDir(async (dir) => {
    const log = await createJobLog({ jobId: 'test-2', dataDir: dir });
    await log.close();
    // Must not throw even though the file handle is closed.
    await log.append({ event: 'too-late' });
  });
});

Deno.test('job-log - tailJobLog returns last N parsed events, skips malformed', async () => {
  await withTempDir(async (dir) => {
    const log = await createJobLog({ jobId: 'test-3', dataDir: dir });
    for (let i = 0; i < 5; i++) await log.append({ event: 'item', i });
    await log.close();
    // Append a malformed line directly.
    await Deno.writeTextFile(`${dir}/jobs/test-3.jsonl`, 'NOT JSON\n', { append: true });
    await Deno.writeTextFile(`${dir}/jobs/test-3.jsonl`, JSON.stringify({ event: 'tail' }) + '\n', { append: true });

    const last2 = await tailJobLog(`${dir}/jobs/test-3.jsonl`, 2);
    assertEquals(last2.length, 2);
    // Malformed line is skipped — we should see {event:'tail'} + one preceding valid event.
    assertEquals(last2[last2.length - 1].event, 'tail');
  });
});

Deno.test('job-log - listJobs sorts newest-first and skips non-jsonl', async () => {
  await withTempDir(async (dir) => {
    const a = await createJobLog({ jobId: 'a', dataDir: dir });
    await a.append({ event: 'started' });
    await a.close();
    // Ensure b's mtime is strictly later than a's.
    await new Promise(r => setTimeout(r, 10));
    const b = await createJobLog({ jobId: 'b', dataDir: dir });
    await b.append({ event: 'started' });
    await b.close();
    await Deno.writeTextFile(`${dir}/jobs/not-a-job.txt`, 'ignored');

    const jobs = await listJobs(dir);
    assertEquals(jobs.map(j => j.jobId), ['b', 'a']);
  });
});

Deno.test('job-log - summarizeJob marks incomplete runs as "running"', async () => {
  await withTempDir(async (dir) => {
    const log = await createJobLog({ jobId: 'running', dataDir: dir });
    await log.append({ event: 'started', source: 'memory', target: 'local' });
    await log.append({ event: 'progress', phase: 'push', index: 1, total: 10 });
    await log.close();

    const summary = await summarizeJob(`${dir}/jobs/running.jsonl`);
    assertEquals(summary.status, 'running');
    assertEquals(summary.source, 'memory');
    assertEquals(summary.target, 'local');
    assertEquals(summary.lastEvent, 'progress');
    assertEquals(summary.endedAt, undefined);
  });
});

Deno.test('job-log - summarizeJob reports "completed" with result', async () => {
  await withTempDir(async (dir) => {
    const log = await createJobLog({ jobId: 'done', dataDir: dir });
    await log.append({ event: 'started', source: 'a', target: 'b' });
    await log.append({ event: 'completed', result: { migrated: 5 } });
    await log.close();

    const summary = await summarizeJob(`${dir}/jobs/done.jsonl`);
    assertEquals(summary.status, 'completed');
    assertEquals((summary.result as any).migrated, 5);
    assert(typeof summary.endedAt === 'string');
  });
});

Deno.test('job-log - summarizeJob reports "failed" with error', async () => {
  await withTempDir(async (dir) => {
    const log = await createJobLog({ jobId: 'oops', dataDir: dir });
    await log.append({ event: 'started', source: 'a', target: 'b' });
    await log.append({ event: 'failed', error: 'NetworkError', message: 'rate limited' });
    await log.close();

    const summary = await summarizeJob(`${dir}/jobs/oops.jsonl`);
    assertEquals(summary.status, 'failed');
    assertEquals(summary.error, 'rate limited');
  });
});
