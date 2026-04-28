/**
 * Messaging — `dispatchItem` pipeline tests.
 *
 * Targets the shared dispatcher used by both `email-handler.ts` (push) and
 * `pull-runner.ts` (pull). The dispatcher runs five stages:
 *   preIngest → classify → postClassify → sinks → postStore.
 *
 * These tests focus on **B009**: a throwing classifier must NOT silently
 * fall through to postClassify with broken (un-merged) labels — that path
 * silently breaks the auto-confirm flow because newsletter-name,
 * confirm-detect, auto-confirm, and sender-index all gate on
 * classifier-applied labels (`newsletter`, `list`, `bounce`). The fix
 * promotes a classifier throw to a logged drop with
 * `drop_reason: 'classifier-failed'`.
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import { dispatchItem } from '../src/messaging/dispatch.ts';
import type { InboxRegistration } from '../src/messaging/registry.ts';
import type {
  HookVerdict,
  InboxConfig,
  InboxItem,
  PostClassifyHook,
  PostStoreHook,
  PreIngestHook,
  Sink,
  SinkResult,
} from '../src/messaging/types.ts';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal InboxRegistration shape suitable for dispatch tests. The
 * dispatcher only reads `hooks` + `sinks` from the registration, so we skip
 * the inbox + config-storage plumbing and inject pre-built arrays directly.
 */
function makeReg(opts: {
  preIngest?: PreIngestHook[];
  postClassify?: PostClassifyHook[];
  postStore?: PostStoreHook[];
  sinks?: Sink[];
} = {}): InboxRegistration {
  return {
    inbox: undefined,
    sinks: opts.sinks ?? [],
    hooks: {
      preIngest: opts.preIngest ?? [],
      postClassify: opts.postClassify ?? [],
      postStore: opts.postStore ?? [],
    },
    config: { channel: 'cf-email', storage: 'items' } as InboxConfig,
    created_at: Date.now(),
    origin: 'boot',
  };
}

function makeItem(overrides: Partial<InboxItem> = {}, fields: Record<string, any> = {}): InboxItem {
  return {
    id: 'item-test',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-23T12:00:00Z',
    summary: 'test',
    body: null,
    fields: { ...fields },
    ...overrides,
  };
}

/**
 * Returns a `fields.headers` Proxy whose `Object.keys` enumeration throws.
 * The classifier walks `Object.keys(headers)` for case-insensitive header
 * lookup — making `ownKeys` throw forces `classifyAndMerge` to throw, which
 * is what we use to exercise the B009 fail-closed path.
 */
function headersThatThrow(): Record<string, string> {
  return new Proxy({}, {
    ownKeys() {
      throw new TypeError('synthetic classifier failure (B009 test fixture)');
    },
    has() {
      throw new TypeError('synthetic classifier failure (B009 test fixture)');
    },
    get() {
      throw new TypeError('synthetic classifier failure (B009 test fixture)');
    },
  }) as unknown as Record<string, string>;
}

/** Simple sink that records every call and reports stored: true. */
function recordingSink(records: InboxItem[]): Sink {
  return async (item, _ctx): Promise<SinkResult> => {
    records.push(item);
    return { stored: true, id: item.id };
  };
}

/** Capture `console.error` for the duration of `fn`. Restores on exit. */
async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; calls: any[][] }> {
  const calls: any[][] = [];
  const original = console.error;
  console.error = (...args: any[]) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.error = original;
  }
}

// ============================================================================
// B009 — happy path: classifier returns labels, postClassify sees them
// ============================================================================

Deno.test('dispatch — classifier-merged labels are visible to postClassify hooks', async () => {
  let observedLabels: string[] | undefined;
  const reg = makeReg({
    postClassify: [
      async (item, _ctx): Promise<HookVerdict> => {
        observedLabels = item.labels ? [...item.labels] : [];
        return 'accept';
      },
    ],
  });

  const item = makeItem({ labels: ['existing'] }, {
    headers: { 'list-unsubscribe': '<mailto:u@example.com>' },
  });

  const result = await dispatchItem(reg, 'mailroom', item, {
    channel: 'cf-email',
    log: () => {},
  });

  assertEquals(result.dropped, false);
  assertEquals(result.drop_reason, undefined);
  assertExists(observedLabels);
  // postClassify sees both the existing label and the merged 'newsletter'
  // tag from the classifier.
  assertEquals(new Set(observedLabels!), new Set(['existing', 'newsletter']));
});

// ============================================================================
// B009 — empty-label happy path: classifier returns [], pipeline still flows
// ============================================================================

Deno.test('dispatch — classifier returning empty label set still reaches postClassify + sinks', async () => {
  let postClassifyCalls = 0;
  const sinkRecords: InboxItem[] = [];
  const reg = makeReg({
    postClassify: [async (_item, _ctx): Promise<HookVerdict> => {
      postClassifyCalls++;
      return 'accept';
    }],
    sinks: [recordingSink(sinkRecords)],
  });

  // No headers field at all — classifier returns [].
  const item = makeItem({}, {});

  const result = await dispatchItem(reg, 'mailroom', item, {
    channel: 'cf-email',
    log: () => {},
  });

  assertEquals(result.dropped, false);
  assertEquals(postClassifyCalls, 1);
  assertEquals(sinkRecords.length, 1);
  assertEquals(result.results.length, 1);
  assertEquals(result.results[0].stored, true);
});

// ============================================================================
// B009 — fail-closed: classifier throws → item dropped, postClassify + sinks skipped
// ============================================================================

Deno.test('dispatch — classifier throw drops the item with reason classifier-failed', async () => {
  const postClassifyCalls: InboxItem[] = [];
  const sinkRecords: InboxItem[] = [];
  const postStoreCalls: SinkResult[][] = [];

  const reg = makeReg({
    postClassify: [async (item, _ctx): Promise<HookVerdict> => {
      postClassifyCalls.push(item);
      return 'accept';
    }],
    postStore: [async (_item, _ctx, results) => {
      postStoreCalls.push(results);
    }],
    sinks: [recordingSink(sinkRecords)],
  });

  const item = makeItem({ id: 'item-bad-headers' }, {
    headers: headersThatThrow(),
  });

  const { result, calls } = await captureConsoleError(() =>
    dispatchItem(reg, 'mailroom', item, {
      channel: 'cf-email',
      log: () => {},
    })
  );

  // Item dropped, no further stages ran.
  assertEquals(result.dropped, true);
  assertEquals(result.drop_reason, 'classifier-failed');
  assertEquals(result.item, null);
  assertEquals(result.results.length, 0);
  assertEquals(postClassifyCalls.length, 0);
  assertEquals(sinkRecords.length, 0);
  assertEquals(postStoreCalls.length, 0);

  // Operator-visible signal: console.error fired with item id + channel.
  assertEquals(calls.length, 1);
  const [msg, payload] = calls[0];
  assertEquals(typeof msg, 'string');
  assertEquals((msg as string).includes('classifier threw'), true);
  assertEquals((payload as Record<string, unknown>).item_id, 'item-bad-headers');
  assertEquals((payload as Record<string, unknown>).channel, 'cf-email');
  assertEquals((payload as Record<string, unknown>).registration, 'mailroom');
});

// ============================================================================
// B009 — preIngest still runs before the classifier; its mutations are lost
// when the classifier throws (because we drop the item entirely)
// ============================================================================

Deno.test('dispatch — preIngest runs before classifier; classifier throw still drops', async () => {
  let preIngestRan = false;
  const reg = makeReg({
    preIngest: [async (item, _ctx): Promise<HookVerdict> => {
      preIngestRan = true;
      return { ...item, labels: [...(item.labels ?? []), 'pre-tagged'] };
    }],
    postClassify: [async (_item, _ctx): Promise<HookVerdict> => 'accept'],
  });

  const item = makeItem({}, { headers: headersThatThrow() });

  const { result } = await captureConsoleError(() =>
    dispatchItem(reg, 'mailroom', item, {
      channel: 'cf-email',
      log: () => {},
    })
  );

  assertEquals(preIngestRan, true);
  assertEquals(result.dropped, true);
  assertEquals(result.drop_reason, 'classifier-failed');
});

// ============================================================================
// B009 — opt-out: when classify=false, a throwing-headers item flows through
// (we never call the classifier so it can't throw)
// ============================================================================

Deno.test('dispatch — classify=false bypasses the classifier entirely', async () => {
  const sinkRecords: InboxItem[] = [];
  const reg = makeReg({
    sinks: [recordingSink(sinkRecords)],
  });

  // Even though the headers Proxy would throw if classifier touched it,
  // classify:false means we never enter that path.
  const item = makeItem({}, { headers: headersThatThrow() });

  const result = await dispatchItem(reg, 'mailroom', item, {
    channel: 'rss',
    classify: false,
    log: () => {},
  });

  assertEquals(result.dropped, false);
  assertEquals(sinkRecords.length, 1);
});

// ============================================================================
// Pre-existing semantics: throwing preIngest hook is pass-through (NOT drop).
// Sanity check that the B009 fix didn't accidentally tighten preIngest too.
// ============================================================================

Deno.test('dispatch — throwing preIngest hook is logged but pipeline continues', async () => {
  const sinkRecords: InboxItem[] = [];
  const reg = makeReg({
    preIngest: [async (_item, _ctx): Promise<HookVerdict> => {
      throw new Error('synthetic preIngest bug');
    }],
    sinks: [recordingSink(sinkRecords)],
  });

  const item = makeItem({}, {
    headers: { 'list-unsubscribe': '<mailto:u@example.com>' },
  });

  const result = await dispatchItem(reg, 'mailroom', item, {
    channel: 'cf-email',
    log: () => {},
  });

  // preIngest threw → treated as pass-through → sinks still run.
  assertEquals(result.dropped, false);
  assertEquals(sinkRecords.length, 1);
});
