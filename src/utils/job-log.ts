/**
 * Append-only JSONL job log.
 *
 * Each job (e.g. a long-running /_sync) writes events to its own file:
 *   <dataDir>/jobs/<jobId>.jsonl
 *
 * Events are line-delimited JSON — one record per line — so `tail -f` gives
 * live progress and `grep '"event":"error"'` gives a post-mortem. The logger
 * writes each event atomically (single write() call) so even a hard kill
 * leaves the file in a valid state up to the last fully-written line.
 *
 * This is a deliberately simple alternative to an in-memory job registry +
 * long-polling HTTP: no daemon state to reconcile, no client long-polls, no
 * cancel dance. Callers stream the file for live progress and grep it for
 * history.
 */

export interface JobLogEvent {
  /** ISO timestamp (auto-filled by append() if caller omits) */
  t?: string;
  /** Event name — `started`, `progress`, `item`, `error`, `completed`, `failed`, etc. */
  event: string;
  /** Arbitrary event payload — keys, counts, errors, whatever the caller wants. */
  [key: string]: unknown;
}

export interface JobLog {
  /** Unique job id for this run. */
  readonly jobId: string;
  /** Absolute path to the JSONL file. */
  readonly path: string;
  /** Append one event. Non-throwing — errors are swallowed to avoid tearing down the job. */
  append(event: JobLogEvent): Promise<void>;
  /** Close the underlying file handle. Safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Generate a timestamped, URL-safe job ID.
 * Shape: `sync-2026-04-18T03-22-15-<rand6>` — sortable + unique per second.
 */
export function generateJobId(prefix = 'job'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Ensure the jobs directory exists under the given dataDir.
 */
async function ensureJobsDir(dataDir: string): Promise<string> {
  const dir = `${dataDir.replace(/\/+$/, '')}/jobs`;
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
  return dir;
}

/**
 * Create a new JSONL log for a job. Opens the file in append mode and keeps
 * the handle open for the lifetime of the job.
 */
export async function createJobLog(options: {
  jobId?: string;
  dataDir?: string;
  prefix?: string;
}): Promise<JobLog> {
  const dataDir = options.dataDir ?? './data';
  const jobId = options.jobId ?? generateJobId(options.prefix);
  const dir = await ensureJobsDir(dataDir);
  const path = `${dir}/${jobId}.jsonl`;

  const file = await Deno.open(path, { write: true, create: true, append: true });
  const encoder = new TextEncoder();
  let closed = false;

  return {
    jobId,
    path,
    async append(event: JobLogEvent): Promise<void> {
      if (closed) return;
      const withTimestamp: JobLogEvent = { t: new Date().toISOString(), ...event };
      // If the caller passed their own `t`, the spread above kept it.
      try {
        const bytes = encoder.encode(JSON.stringify(withTimestamp) + '\n');
        await file.write(bytes);
      } catch (err) {
        // Best-effort — log-writing errors shouldn't kill the job.
        console.error(`[job-log] Failed to append to ${path}:`, err);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try { file.close(); } catch { /* already closed */ }
    },
  };
}

/** Default tail window for `tailJobLog` — surfaces recent progress without loading the full log. */
export const DEFAULT_TAIL_EVENTS = 50;

/** Cap used by `summarizeJob` when looking for the last `started`/`completed`/`failed` event. Has to be large enough that the summary still finds the terminal event even if a sync emitted thousands of `progress` lines. */
export const SUMMARY_SCAN_EVENTS = 2000;

/**
 * Read (up to) the last N events from a job log file.
 * Returns parsed events, skipping any malformed lines.
 */
export async function tailJobLog(path: string, n = DEFAULT_TAIL_EVENTS): Promise<JobLogEvent[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(l => l.length > 0);
  // Walk backward, collecting the last N successfully-parsed events so that
  // malformed lines don't eat into the N budget. Preserves source order in
  // the returned array.
  const events: JobLogEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && events.length < n; i--) {
    try { events.unshift(JSON.parse(lines[i]) as JobLogEvent); }
    catch { /* skip malformed */ }
  }
  return events;
}

/**
 * List job files under <dataDir>/jobs, newest first. Returns file names
 * (sans `.jsonl`) which are the jobIds.
 */
export async function listJobs(dataDir: string): Promise<Array<{ jobId: string; path: string; modifiedAt: string; size: number }>> {
  const dir = `${dataDir.replace(/\/+$/, '')}/jobs`;
  const out: Array<{ jobId: string; path: string; modifiedAt: string; size: number }> = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
      const path = `${dir}/${entry.name}`;
      const stat = await Deno.stat(path);
      out.push({
        jobId: entry.name.replace(/\.jsonl$/, ''),
        path,
        modifiedAt: stat.mtime?.toISOString() ?? '',
        size: stat.size,
      });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Summarize a job log: start/end, status (running if no final event), stats.
 * Used by the list endpoint so callers don't have to tail every file.
 */
export async function summarizeJob(path: string): Promise<{
  status: 'running' | 'completed' | 'failed' | 'unknown';
  startedAt?: string;
  endedAt?: string;
  source?: string;
  target?: string;
  result?: unknown;
  error?: string;
  lastEvent?: string;
}> {
  const events = await tailJobLog(path, SUMMARY_SCAN_EVENTS);
  if (events.length === 0) return { status: 'unknown' };
  const first = events[0];
  const last = events[events.length - 1];
  let status: 'running' | 'completed' | 'failed' | 'unknown' = 'running';
  if (last.event === 'completed') status = 'completed';
  else if (last.event === 'failed') status = 'failed';
  return {
    status,
    startedAt: typeof first.t === 'string' ? first.t : undefined,
    endedAt: status === 'completed' || status === 'failed'
      ? (typeof last.t === 'string' ? last.t : undefined)
      : undefined,
    source: typeof first.source === 'string' ? first.source : undefined,
    target: typeof first.target === 'string' ? first.target : undefined,
    result: (last as any).result,
    error: typeof (last as any).message === 'string' && status === 'failed' ? (last as any).message : undefined,
    lastEvent: last.event,
  };
}
