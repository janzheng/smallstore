/**
 * Messaging mode + FTS5 for the Cloudflare D1 adapter.
 *
 * D1 doesn't run inside Deno test, so we stand up a D1-shaped binding
 * around Deno's native @db/sqlite (the same engine used by our SQLite
 * adapter). The binding's surface area mirrors the subset of D1 the
 * adapter actually calls: `prepare(sql) -> { bind(...).first()/all()/run(),
 * first()/all()/run() }`. Everything `await`-able; results shaped like
 * `{ results: [...rows] }` for `all()` and the raw row (or null) for
 * `first()`.
 *
 * That shim is enough to exercise the full messaging-mode path end-to-end:
 * migrations, UPSERT, row encode/decode, FTS5 triggers, and the
 * `query({ fts })` search path.
 *
 * Pure unit tests on the migration SQL generator live at the top;
 * integration tests against the SQLite-backed mock binding follow.
 */

import { assert, assertEquals, assertExists, assertRejects } from 'jsr:@std/assert';
import { Database } from 'jsr:@db/sqlite@0.12';

import { CloudflareD1Adapter, createCloudflareD1Adapter } from '../src/adapters/cloudflare-d1.ts';
import { CorruptValueError } from '../src/adapters/errors.ts';
import {
  buildFtsSql,
  buildUpsertSql,
  decodeItemRow,
  encodeItemRow,
  messagingMigrations,
  MESSAGING_COLUMNS,
  sanitizeTableName,
} from '../src/adapters/cloudflare-d1-messaging-schema.ts';

// ============================================================================
// Pure unit tests — migration SQL generation
// ============================================================================

Deno.test('messagingMigrations — produces 10 single-line statements', () => {
  const migs = messagingMigrations('items');
  assertEquals(migs.length, 10);
  for (const m of migs) {
    assert(!m.sql.includes('\n'), `migration ${m.name} has a newline: ${m.sql}`);
    assert(m.name.length > 0);
  }
});

Deno.test('messagingMigrations — uses sanitized table name', () => {
  const migs = messagingMigrations('weird name!');
  // All migrations should reference the sanitized identifier only
  for (const m of migs) {
    assert(!m.sql.includes('weird name!'), `leaked unsafe name in ${m.name}`);
    assert(m.sql.includes('weird_name_'), `expected sanitized name in ${m.name}`);
  }
});

Deno.test('messagingMigrations — FTS virtual table uses external content', () => {
  const migs = messagingMigrations('items');
  const fts = migs.find(m => m.name.endsWith('06_create_fts'));
  assertExists(fts);
  assert(fts!.sql.includes("USING fts5(summary, body, from_display, subject"));
  assert(fts!.sql.includes("content='items'"));
  assert(fts!.sql.includes("content_rowid='rowid'"));
});

Deno.test('messagingMigrations — triggers mirror all FTS-indexed columns', () => {
  const migs = messagingMigrations('items');
  const ai = migs.find(m => m.name.endsWith('07_trigger_ai'))!.sql;
  const ad = migs.find(m => m.name.endsWith('08_trigger_ad'))!.sql;
  const auDel = migs.find(m => m.name.endsWith('09_trigger_au_delete'))!.sql;
  const auIns = migs.find(m => m.name.endsWith('10_trigger_au_insert'))!.sql;

  // AI + UPDATE-insert are INSERT-flavored; AD + UPDATE-delete use the
  // FTS5 'delete' command.
  assert(ai.includes('AFTER INSERT'));
  assert(ai.includes('new.summary'));
  assert(auIns.includes('AFTER UPDATE'));
  assert(auIns.includes('new.summary'));

  assert(ad.includes('AFTER DELETE'));
  assert(ad.includes("'delete'"));
  assert(auDel.includes('AFTER UPDATE'));
  assert(auDel.includes("'delete'"));
});

Deno.test('buildUpsertSql — uses ON CONFLICT(id) and covers all columns', () => {
  const sql = buildUpsertSql('items');
  assert(sql.includes('INSERT INTO items'));
  assert(sql.includes('ON CONFLICT(id)'));
  for (const col of MESSAGING_COLUMNS) {
    assert(sql.includes(col), `column ${col} missing from upsert sql`);
  }
  // Single-line contract (D1 exec() safety).
  assert(!sql.includes('\n'), 'upsert sql leaked a newline');
});

Deno.test('buildFtsSql — joins items to fts and orders by received_at DESC', () => {
  const sql = buildFtsSql('items');
  assert(sql.includes('items JOIN items_fts'));
  assert(sql.includes('WHERE items_fts MATCH ?'));
  assert(sql.includes('ORDER BY items.received_at DESC'));
});

Deno.test('sanitizeTableName — strips non-alphanumerics', () => {
  assertEquals(sanitizeTableName('abc'), 'abc');
  assertEquals(sanitizeTableName('abc_123'), 'abc_123');
  assertEquals(sanitizeTableName('my-table'), 'my_table');
  assertEquals(sanitizeTableName('weird name!'), 'weird_name_');
});

Deno.test('encodeItemRow — pulls from_email / from_display out of fields', () => {
  const row = encodeItemRow({
    id: 'x1',
    received_at: '2026-04-22T12:00:00Z',
    source: 'cf-email',
    summary: 'Hello',
    body: 'World',
    fields: { from_email: 'alice@example.com', from_addr: 'Alice <alice@example.com>' },
    labels: ['newsletter'],
  });
  assertEquals(row.id, 'x1');
  assertEquals(row.from_email, 'alice@example.com');
  assertEquals(row.from_display, 'Alice <alice@example.com>');
  assertEquals(row.subject, 'Hello');
  assertEquals(row.labels, JSON.stringify(['newsletter']));
  const fields = JSON.parse(row.fields);
  assertEquals(fields.from_email, 'alice@example.com');
});

Deno.test('decodeItemRow — reconstructs item with parsed fields/labels', () => {
  const decoded = decodeItemRow({
    id: 'x1',
    received_at: '2026-04-22T12:00:00Z',
    source: 'cf-email',
    summary: 'Hello',
    body: 'World',
    fields: JSON.stringify({ from_email: 'alice@example.com' }),
    labels: JSON.stringify(['newsletter']),
  });
  assertEquals(decoded.id, 'x1');
  assertEquals(decoded.fields.from_email, 'alice@example.com');
  assertEquals(decoded.labels, ['newsletter']);
});

Deno.test('decodeItemRow — tolerates corrupt fields blob', () => {
  const decoded = decodeItemRow({
    id: 'x1',
    received_at: '2026-04-22T12:00:00Z',
    fields: 'not-json',
  });
  assertEquals(decoded.fields, {});
});

// ============================================================================
// Integration tests — D1-shaped binding backed by @db/sqlite
// ============================================================================

/**
 * D1-shaped wrapper around a synchronous @db/sqlite Database.
 *
 * We only implement the surface the adapter touches: prepare().bind().{run,first,all}
 * and prepare().{run,first,all} (no bind). Returns match D1:
 *   - `first()` → row object or null
 *   - `all()` → `{ results: [...rows] }`
 *   - `run()` → `{ success: true }` (adapter doesn't inspect)
 *
 * Kept to ~40 lines on purpose — if this grows into a real D1 mock,
 * extract it to a test helper module.
 */
function makeMockD1(): any {
  const db = new Database(':memory:');
  return {
    _db: db,
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const makeOps = (args: any[]) => ({
        run: async () => { stmt.run(...args); return { success: true }; },
        first: async () => (stmt.get(...args) ?? null) as any,
        all: async () => ({ results: stmt.all(...args) as any[] }),
      });
      return {
        bind: (...args: any[]) => makeOps(args),
        ...makeOps([]),
      };
    },
  };
}

function freshAdapter(opts: { messaging?: boolean; table?: string } = {}) {
  const binding = makeMockD1();
  const adapter = createCloudflareD1Adapter({
    binding,
    table: opts.table ?? 'items',
    messaging: opts.messaging ?? true,
  });
  return { adapter, binding };
}

function fakeItem(
  id: string,
  overrides: Partial<{
    received_at: string;
    summary: string;
    body: string;
    from_email: string;
    from_addr: string;
    labels: string[];
    thread_id: string;
    extra: Record<string, any>;
  }> = {},
) {
  return {
    id,
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: overrides.received_at ?? '2026-04-22T12:00:00Z',
    summary: overrides.summary ?? `Subject ${id}`,
    body: overrides.body ?? `Body for ${id}`,
    fields: {
      from_email: overrides.from_email ?? 'alice@example.com',
      from_addr: overrides.from_addr ?? 'Alice <alice@example.com>',
      ...overrides.extra,
    },
    labels: overrides.labels,
    thread_id: overrides.thread_id,
  };
}

Deno.test('messaging mode — requires native binding (rejects HTTP mode)', () => {
  let threw = false;
  try {
    createCloudflareD1Adapter({
      baseUrl: 'https://example.workers.dev',
      messaging: true,
    });
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes('messaging mode requires native'));
  }
  assert(threw, 'expected HTTP-mode messaging adapter to throw');
});

Deno.test('messaging mode — migrations create tracking + schema + FTS + triggers', async () => {
  const { adapter, binding } = freshAdapter();
  // Touch the adapter so migrations run.
  await adapter.keys();

  // Tracking table exists with 10 rows
  const migRows = binding._db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as Array<{ name: string }>;
  assertEquals(migRows.length, 10);

  // Main table + FTS virtual table + triggers all present
  const objs = binding._db.prepare(
    "SELECT name, type FROM sqlite_master WHERE name LIKE 'items%' OR name LIKE 'idx_items%' ORDER BY name"
  ).all() as Array<{ name: string; type: string }>;
  const names = objs.map(o => o.name);
  assert(names.includes('items'), `missing items table; got ${names.join(',')}`);
  assert(names.includes('items_fts'), `missing items_fts; got ${names.join(',')}`);
  assert(names.includes('items_ai'), `missing AI trigger; got ${names.join(',')}`);
  assert(names.includes('items_ad'), `missing AD trigger; got ${names.join(',')}`);
  assert(names.includes('items_au_delete'), `missing AU-delete trigger; got ${names.join(',')}`);
  assert(names.includes('items_au_insert'), `missing AU-insert trigger; got ${names.join(',')}`);
});

Deno.test('messaging mode — migrations are idempotent across adapter instances', async () => {
  const binding = makeMockD1();

  // First adapter runs migrations.
  const a1 = createCloudflareD1Adapter({ binding, table: 'items', messaging: true });
  await a1.keys();
  const firstCount = (binding._db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get() as { n: number }).n;
  assertEquals(firstCount, 10);

  // Second adapter on the same binding should not re-apply.
  const a2 = createCloudflareD1Adapter({ binding, table: 'items', messaging: true });
  await a2.keys();
  const secondCount = (binding._db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get() as { n: number }).n;
  assertEquals(secondCount, 10, 'migrations re-applied (tracking table not consulted)');
});

Deno.test('messaging mode — set() denormalizes InboxItem into columns', async () => {
  const { adapter, binding } = freshAdapter();
  const item = fakeItem('a1', {
    summary: 'Welcome to our newsletter',
    body: 'Hello world',
    from_email: 'news@stripe.com',
    from_addr: 'Stripe <news@stripe.com>',
    labels: ['newsletter', 'bulk'],
    extra: { spf_pass: true },
  });
  await adapter.set(item.id, item);

  const row = binding._db.prepare('SELECT * FROM items WHERE id = ?').get('a1') as any;
  assertExists(row);
  assertEquals(row.id, 'a1');
  assertEquals(row.summary, 'Welcome to our newsletter');
  assertEquals(row.subject, 'Welcome to our newsletter'); // duplicated for FTS clarity
  assertEquals(row.from_email, 'news@stripe.com');
  assertEquals(row.from_display, 'Stripe <news@stripe.com>');
  assertEquals(row.channel, 'cf-email');
  const fields = JSON.parse(row.fields);
  assertEquals(fields.spf_pass, true);
  assertEquals(fields.from_email, 'news@stripe.com');
  const labels = JSON.parse(row.labels);
  assertEquals(labels, ['newsletter', 'bulk']);
});

Deno.test('messaging mode — get() reconstructs InboxItem', async () => {
  const { adapter } = freshAdapter();
  const item = fakeItem('a1', { summary: 'Hi', body: 'Body' });
  await adapter.set(item.id, item);
  const got = await adapter.get('a1');
  assertExists(got);
  assertEquals(got.id, 'a1');
  assertEquals(got.summary, 'Hi');
  assertEquals(got.body, 'Body');
  assertEquals(got.fields.from_email, 'alice@example.com');
  assertEquals(got.source, 'cf-email');
  assertEquals(got.source_version, 'email/v1');
});

Deno.test('messaging mode — get() returns null for missing id', async () => {
  const { adapter } = freshAdapter();
  assertEquals(await adapter.get('nope'), null);
});

Deno.test('messaging mode — delete() removes row and keeps FTS in sync', async () => {
  const { adapter, binding } = freshAdapter();
  // Use a single-word rare token — FTS5's default tokenizer splits on
  // hyphens/punctuation and treats `-` between bare tokens as the NOT
  // operator, so multi-word hyphenated tokens in MATCH parse weirdly.
  await adapter.set('a1', fakeItem('a1', { summary: 'deleteme uniquetokenzzz' }));
  await adapter.delete('a1');

  assertEquals(await adapter.get('a1'), null);

  // FTS should no longer find the row
  const ftsHit = binding._db.prepare(
    "SELECT rowid FROM items_fts WHERE items_fts MATCH 'uniquetokenzzz'",
  ).all();
  assertEquals(ftsHit.length, 0, 'FTS still holds deleted row');
});

Deno.test('messaging mode — query({ fts }) finds items by body and summary', async () => {
  const { adapter } = freshAdapter();
  await adapter.set('a1', fakeItem('a1', { summary: 'Welcome newsletter from Stripe', body: 'Your invoice is ready' }));
  await adapter.set('a2', fakeItem('a2', { summary: 'Daily digest', body: 'Nothing about payments' }));
  await adapter.set('a3', fakeItem('a3', { summary: 'Reminder', body: 'Your Stripe account needs attention' }));

  const byStripe = await adapter.query({ fts: 'Stripe' });
  assertEquals(byStripe.data.length, 2);
  const ids = byStripe.data.map((i: any) => i.id).sort();
  assertEquals(ids, ['a1', 'a3']);

  const byDigest = await adapter.query({ fts: 'digest' });
  assertEquals(byDigest.data.length, 1);
  assertEquals(byDigest.data[0].id, 'a2');

  // No hits → empty
  const empty = await adapter.query({ fts: 'nonexistentxyzzyx' });
  assertEquals(empty.data.length, 0);
});

Deno.test('messaging mode — query({ fts }) matches from_display', async () => {
  const { adapter } = freshAdapter();
  await adapter.set('a1', fakeItem('a1', {
    summary: 'Hi',
    body: 'body',
    from_addr: 'Anthropic Team <hello@anthropic.com>',
  }));
  await adapter.set('a2', fakeItem('a2', {
    summary: 'Hi',
    body: 'body',
    from_addr: 'Stripe <news@stripe.com>',
  }));

  const hits = await adapter.query({ fts: 'Anthropic' });
  assertEquals(hits.data.length, 1);
  assertEquals(hits.data[0].id, 'a1');
});

Deno.test('messaging mode — query({ fts }) respects limit + filter', async () => {
  const { adapter } = freshAdapter();
  for (let i = 0; i < 5; i++) {
    await adapter.set(`a${i}`, fakeItem(`a${i}`, {
      summary: 'newsletter edition',
      body: `body ${i}`,
      received_at: `2026-04-22T12:0${i}:00Z`,
    }));
  }

  // limit
  const limited = await adapter.query({ fts: 'newsletter', limit: 2 });
  assertEquals(limited.data.length, 2);

  // filter (only keep items with even index in id)
  const filtered = await adapter.query({
    fts: 'newsletter',
    filter: (item: any) => Number(item.id.slice(1)) % 2 === 0,
  });
  assertEquals(filtered.data.length, 3);
  assertEquals(filtered.data.map((i: any) => i.id).sort(), ['a0', 'a2', 'a4']);
});

Deno.test('messaging mode — update rewrites FTS (trigger au_delete + au_insert)', async () => {
  const { adapter } = freshAdapter();
  await adapter.set('a1', fakeItem('a1', { summary: 'originaltokenabc', body: 'body' }));

  // Verify baseline
  let hits = await adapter.query({ fts: 'originaltokenabc' });
  assertEquals(hits.data.length, 1);

  // Re-set with new summary (same id → upsert)
  await adapter.set('a1', fakeItem('a1', { summary: 'replacementtokenxyz', body: 'body' }));

  // Old token should be gone, new one should match
  hits = await adapter.query({ fts: 'originaltokenabc' });
  assertEquals(hits.data.length, 0, 'stale FTS entry still matches old token');

  hits = await adapter.query({ fts: 'replacementtokenxyz' });
  assertEquals(hits.data.length, 1);
});

Deno.test('messaging mode — query() without fts returns denormalized rows newest-first', async () => {
  const { adapter } = freshAdapter();
  await adapter.set('a1', fakeItem('a1', { received_at: '2026-04-22T10:00:00Z' }));
  await adapter.set('a2', fakeItem('a2', { received_at: '2026-04-22T12:00:00Z' }));
  await adapter.set('a3', fakeItem('a3', { received_at: '2026-04-22T11:00:00Z' }));

  const all = await adapter.query({});
  assertEquals(all.data.map((i: any) => i.id), ['a2', 'a3', 'a1']);
});

Deno.test('messaging mode — keys() returns item ids', async () => {
  const { adapter } = freshAdapter();
  await adapter.set('a1', fakeItem('a1'));
  await adapter.set('a2', fakeItem('a2'));

  const keys = await adapter.keys();
  assertEquals(keys.sort(), ['a1', 'a2']);
});

Deno.test('messaging mode — set() rejects non-object values', async () => {
  const { adapter } = freshAdapter();
  await assertRejects(
    () => adapter.set('a1', 'just a string' as any),
    Error,
    'InboxItem-shaped',
  );
});

// ============================================================================
// Non-messaging mode — generic k/v still works after the refactor
// ============================================================================

Deno.test('non-messaging mode — get/set/delete/keys still behave as k/v', async () => {
  const binding = makeMockD1();
  const adapter = createCloudflareD1Adapter({ binding, table: 'kv_store' });

  await adapter.set('foo', { a: 1 });
  await adapter.set('bar', { b: 2 });

  assertEquals(await adapter.get('foo'), { a: 1 });
  assertEquals(await adapter.get('bar'), { b: 2 });
  assertEquals(await adapter.get('missing'), null);

  const keys = await adapter.keys();
  assertEquals(keys.sort(), ['bar', 'foo']);

  await adapter.delete('foo');
  assertEquals(await adapter.get('foo'), null);

  // No d1_migrations tracking in generic mode
  const hasTracking = binding._db.prepare(
    "SELECT name FROM sqlite_master WHERE name = 'd1_migrations'",
  ).get();
  assertEquals(hasTracking, undefined);
});

Deno.test('non-messaging mode — query({ fts }) is a no-op (fts ignored, scan used)', async () => {
  const binding = makeMockD1();
  const adapter = createCloudflareD1Adapter({ binding, table: 'kv_store' });

  await adapter.set('a', { msg: 'hello world' });
  // Should not throw, should not find anything via FTS (no FTS index exists);
  // query falls through to the generic scan which has no filter, so it
  // returns everything.
  const result = await adapter.query({ fts: 'hello' });
  // The fallback scan returns all items (no filter applied).
  assertEquals(result.data.length, 1);
});

// ============================================================================
// Lane C2 — security remediation tests
//
// B005: corrupt rows surface as `CorruptValueError`, not raw strings.
// B034: `clear()` doesn't blow up on a 50-key table.
// B035: concurrent `ensureTable()` calls share one migration run.
// B036: `list({ offset, limit })` pushes the window down to SQL.
// ============================================================================

Deno.test('B005 — generic mode: get() throws CorruptValueError on non-JSON value', async () => {
  const binding = makeMockD1();
  const adapter = createCloudflareD1Adapter({ binding, table: 'kv_store' });

  // Force a normal write so the table exists, then poke a bad row in
  // directly under the binding (simulates external corruption).
  await adapter.set('valid', { ok: true });
  binding._db
    .prepare('INSERT INTO kv_store (key, value) VALUES (?, ?)')
    .run('corrupt', 'this is not json {');

  // Sanity: valid key still round-trips.
  assertEquals(await adapter.get('valid'), { ok: true });

  await assertRejects(
    () => adapter.get('corrupt'),
    CorruptValueError,
    'not valid JSON',
  );
});

Deno.test('B034 — clear() handles 50 keys without blowing up', async () => {
  const binding = makeMockD1();
  // Smaller concurrency than default to make sure batching path is exercised.
  const adapter = createCloudflareD1Adapter({
    binding,
    table: 'kv_store',
    clearConcurrency: 2,
  });

  for (let i = 0; i < 50; i++) {
    await adapter.set(`k${i.toString().padStart(2, '0')}`, { i });
  }
  assertEquals((await adapter.keys()).length, 50);

  await adapter.clear();
  assertEquals((await adapter.keys()).length, 0);
});

Deno.test('B035 — concurrent ensureTable() calls share one migration run', async () => {
  const binding = makeMockD1();
  // Wrap binding.prepare so we can count migration-table writes.
  let migrationInsertCount = 0;
  const realPrepare = binding.prepare.bind(binding);
  binding.prepare = (sql: string) => {
    // Match the tracking-row insert from `applyMessagingMigrations`:
    //   INSERT INTO d1_migrations (name) VALUES (?)
    if (/INSERT\s+INTO\s+d1_migrations/i.test(sql)) {
      migrationInsertCount++;
    }
    return realPrepare(sql);
  };

  const adapter = createCloudflareD1Adapter({ binding, table: 'items', messaging: true });

  // 5 concurrent first-time accesses — all share the same in-flight
  // migration. Without the Promise<void> memoization this races and we'd
  // see 5×10 = 50 migration insert attempts (and PK collisions on the
  // tracking table).
  await Promise.all([
    adapter.keys(),
    adapter.keys(),
    adapter.keys(),
    adapter.keys(),
    adapter.keys(),
  ]);

  // Exactly one migration pass happened — 10 INSERT-tracking-row calls.
  assertEquals(
    migrationInsertCount,
    10,
    `expected 10 migration tracking inserts (one pass), got ${migrationInsertCount}`,
  );

  // And the tracking table holds exactly 10 rows.
  const trackingRows = (binding._db
    .prepare('SELECT COUNT(*) AS n FROM d1_migrations')
    .get() as { n: number }).n;
  assertEquals(trackingRows, 10);
});

Deno.test('B036 — list({ offset, limit }) returns the right SQL window', async () => {
  const binding = makeMockD1();
  const adapter = createCloudflareD1Adapter({ binding, table: 'kv_store' });

  // 25 keys named k00..k24 — keys() orders ASC, so the slice [10..15)
  // should land on k10..k14.
  for (let i = 0; i < 25; i++) {
    await adapter.set(`k${i.toString().padStart(2, '0')}`, { i });
  }

  const items = await adapter.list({ offset: 10, limit: 5 });
  assertEquals(items.length, 5);
  assertEquals(items.map((it: any) => it.i), [10, 11, 12, 13, 14]);

  // Sanity: offset past the end returns empty.
  const past = await adapter.list({ offset: 100, limit: 5 });
  assertEquals(past.length, 0);

  // Sanity: limit unset returns from offset to end.
  const tail = await adapter.list({ offset: 22 });
  assertEquals(tail.map((it: any) => it.i), [22, 23, 24]);
});
