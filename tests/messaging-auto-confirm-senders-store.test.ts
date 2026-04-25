/**
 * Auto-confirm senders store tests.
 *
 * Backed by MemoryAdapter so no D1/R2 needed. Covers the CRUD surface,
 * idempotency, normalization, and the env-seed behavior (seed-once,
 * delete-wins on subsequent boots).
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import {
  createAutoConfirmSendersStore,
  normalizePattern,
  seedAutoConfirmFromEnv,
} from '../src/messaging/auto-confirm-senders.ts';

function freshStore() {
  const adapter = new MemoryAdapter();
  const store = createAutoConfirmSendersStore(adapter);
  return { adapter, store };
}

// ============================================================================
// normalizePattern
// ============================================================================

Deno.test('normalizePattern — trims + lowercases + handles undefined', () => {
  assertEquals(normalizePattern('*@SUBSTACK.COM'), '*@substack.com');
  assertEquals(normalizePattern('  *@beehiiv.com  '), '*@beehiiv.com');
  assertEquals(normalizePattern(''), '');
  assertEquals(normalizePattern(undefined), '');
  assertEquals(normalizePattern(null), '');
});

// ============================================================================
// add / get / delete
// ============================================================================

Deno.test('store — add returns a row with normalized pattern + runtime source by default', async () => {
  const { store } = freshStore();
  const row = await store.add({ pattern: '*@SUBSTACK.com' });
  assertEquals(row.pattern, '*@substack.com');
  assertEquals(row.source, 'runtime');
  assert(typeof row.created_at === 'string' && row.created_at.length > 0);
});

Deno.test('store — add is idempotent: re-adding same pattern returns existing row', async () => {
  const { store } = freshStore();
  const first = await store.add({ pattern: '*@beehiiv.com', notes: 'first' });
  const second = await store.add({ pattern: '*@BEEHIIV.com', notes: 'second' });
  assertEquals(second.created_at, first.created_at);
  assertEquals(second.notes, 'first'); // existing wins; notes from second discarded
});

Deno.test('store — add throws on empty/whitespace pattern', async () => {
  const { store } = freshStore();
  let threw = false;
  try {
    await store.add({ pattern: '   ' });
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes('non-empty'));
  }
  assert(threw, 'expected add() to throw on empty pattern');
});

Deno.test('store — get returns null for missing or empty pattern', async () => {
  const { store } = freshStore();
  assertEquals(await store.get('*@nonexistent.com'), null);
  assertEquals(await store.get(''), null);
});

Deno.test('store — get is case-insensitive (lookup uses normalized pattern)', async () => {
  const { store } = freshStore();
  await store.add({ pattern: '*@convertkit.com' });
  const found = await store.get('*@CONVERTKIT.COM');
  assertEquals(found?.pattern, '*@convertkit.com');
});

Deno.test('store — delete returns true once, false thereafter (idempotent on missing)', async () => {
  const { store } = freshStore();
  await store.add({ pattern: '*@substack.com' });
  assertEquals(await store.delete('*@substack.com'), true);
  assertEquals(await store.delete('*@substack.com'), false);
  assertEquals(await store.get('*@substack.com'), null);
});

Deno.test('store — list returns all rows oldest-first', async () => {
  const { store } = freshStore();
  // Insert with manual delays to get distinct created_at timestamps.
  await store.add({ pattern: '*@a.com' });
  await new Promise((r) => setTimeout(r, 5));
  await store.add({ pattern: '*@b.com' });
  await new Promise((r) => setTimeout(r, 5));
  await store.add({ pattern: '*@c.com' });

  const all = await store.list();
  assertEquals(all.map((r) => r.pattern), ['*@a.com', '*@b.com', '*@c.com']);
});

Deno.test('store — patterns() is a thin convenience over list()', async () => {
  const { store } = freshStore();
  await store.add({ pattern: '*@x.com' });
  await store.add({ pattern: '*@y.com' });
  const patterns = await store.patterns();
  assertEquals(patterns.sort(), ['*@x.com', '*@y.com']);
});

// ============================================================================
// keyPrefix isolation
// ============================================================================

Deno.test('store — keyPrefix isolates two stores on the same adapter', async () => {
  const adapter = new MemoryAdapter();
  const a = createAutoConfirmSendersStore(adapter, { keyPrefix: 'a/' });
  const b = createAutoConfirmSendersStore(adapter, { keyPrefix: 'b/' });

  await a.add({ pattern: '*@only-a.com' });
  await b.add({ pattern: '*@only-b.com' });

  const aList = (await a.list()).map((r) => r.pattern);
  const bList = (await b.list()).map((r) => r.pattern);
  assertEquals(aList, ['*@only-a.com']);
  assertEquals(bList, ['*@only-b.com']);
});

// ============================================================================
// seedAutoConfirmFromEnv
// ============================================================================

Deno.test('seed — first boot adds every env pattern with source: env', async () => {
  const { adapter, store } = freshStore();
  const added = await seedAutoConfirmFromEnv('*@substack.com,*@beehiiv.com', store, adapter);
  assertEquals(added.sort(), ['*@beehiiv.com', '*@substack.com']);
  const all = await store.list();
  assertEquals(all.length, 2);
  for (const row of all) assertEquals(row.source, 'env');
});

Deno.test('seed — second boot is a no-op when sentinels already recorded', async () => {
  const { adapter, store } = freshStore();
  await seedAutoConfirmFromEnv('*@substack.com', store, adapter);
  const addedAgain = await seedAutoConfirmFromEnv('*@substack.com', store, adapter);
  assertEquals(addedAgain, []);
});

Deno.test('seed — runtime delete sticks: removed pattern is NOT re-added on next seed', async () => {
  const { adapter, store } = freshStore();
  await seedAutoConfirmFromEnv('*@substack.com,*@beehiiv.com', store, adapter);
  await store.delete('*@beehiiv.com');

  // Simulate cold-start: re-run the seed with the same env value. The
  // sentinel from the first seed makes the seeder skip *@beehiiv.com.
  const addedAfterDelete = await seedAutoConfirmFromEnv(
    '*@substack.com,*@beehiiv.com',
    store,
    adapter,
  );
  assertEquals(addedAfterDelete, []); // beehiiv stays gone
  const remaining = (await store.list()).map((r) => r.pattern);
  assertEquals(remaining, ['*@substack.com']);
});

Deno.test('seed — adding a NEW env pattern on existing deploy still seeds it', async () => {
  const { adapter, store } = freshStore();
  // Initial deploy seeded just substack.
  await seedAutoConfirmFromEnv('*@substack.com', store, adapter);

  // Operator extends env to include beehiiv. Beehiiv has no sentinel yet,
  // so the seeder picks it up on the next cold start.
  const added = await seedAutoConfirmFromEnv('*@substack.com,*@beehiiv.com', store, adapter);
  assertEquals(added, ['*@beehiiv.com']);
  const patterns = (await store.list()).map((r) => r.pattern).sort();
  assertEquals(patterns, ['*@beehiiv.com', '*@substack.com']);
});

Deno.test('seed — undefined / empty env value seeds nothing', async () => {
  const { adapter, store } = freshStore();
  assertEquals(await seedAutoConfirmFromEnv(undefined, store, adapter), []);
  assertEquals(await seedAutoConfirmFromEnv('', store, adapter), []);
  assertEquals(await seedAutoConfirmFromEnv('   ,  ,', store, adapter), []);
  assertEquals((await store.list()).length, 0);
});

Deno.test('seed — preserves runtime row if env has same pattern (no source flip)', async () => {
  const { adapter, store } = freshStore();
  // Caller adds via runtime first.
  await store.add({ pattern: '*@substack.com', source: 'runtime' });
  // Then env seeding runs — store.add is idempotent and returns the
  // existing row, so source stays 'runtime'. The sentinel is still
  // recorded so subsequent seeds skip cleanly.
  const added = await seedAutoConfirmFromEnv('*@substack.com', store, adapter);
  assertEquals(added, ['*@substack.com']);
  const row = await store.get('*@substack.com');
  assertEquals(row?.source, 'runtime'); // existing row wins
});
