/**
 * Peers — peer-registry CRUD + validation tests.
 *
 * Exercises `createPeerStore` against `MemoryAdapter`:
 * - create assigns id + created_at + defaults
 * - slug + url + tags validation
 * - uniqueness
 * - getById round-trip (alias key works)
 * - update patches + rename + alias cleanup
 * - delete cleans alias
 * - list filters (name / type / tags / disabled) + pagination
 */

import { assertEquals, assertExists, assertRejects } from 'jsr:@std/assert';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { createPeerStore } from '../src/peers/peer-registry.ts';
import type { Peer } from '../src/peers/types.ts';

// ============================================================================
// Fixtures
// ============================================================================

function freshStore(opts?: { generateId?: () => string }) {
  const adapter = new MemoryAdapter();
  let counter = 0;
  const gen = opts?.generateId ?? (() => `peer-${String(++counter).padStart(3, '0')}`);
  const store = createPeerStore(adapter, { generateId: gen });
  return { adapter, store };
}

/** Minimal valid create input. Override via `overrides`. */
function makeInput(overrides: Partial<Omit<Peer, 'id' | 'created_at'>> = {}) {
  return {
    name: overrides.name ?? 'tigerflare-prod',
    type: overrides.type ?? ('tigerflare' as const),
    url: overrides.url ?? 'https://tigerflare.labspace.ai',
    description: overrides.description,
    auth: overrides.auth,
    headers: overrides.headers,
    tags: overrides.tags,
    capabilities: overrides.capabilities,
    disabled: overrides.disabled,
    path_mapping: overrides.path_mapping,
  };
}

// ============================================================================
// create — id / timestamps / defaults
// ============================================================================

Deno.test('peers — create assigns id, created_at, defaults disabled=false + auth=none', async () => {
  const { store } = freshStore();
  const peer = await store.create(makeInput());
  assertExists(peer.id);
  assertExists(peer.created_at);
  assertEquals(peer.disabled, false);
  assertEquals(peer.auth, { kind: 'none' });
});

Deno.test('peers — create + get round-trip preserves all fields', async () => {
  const { store } = freshStore();
  const input = makeInput({
    name: 'sheetlog-faves',
    type: 'sheetlog',
    url: 'https://script.google.com/s/abc/exec',
    description: 'favorites log',
    auth: { kind: 'query', name: 'key', value_env: 'SL_KEY' },
    headers: { 'User-Agent': 'smallstore-peer' },
    tags: ['personal', 'sheets'],
    capabilities: ['read'],
  });
  const created = await store.create(input);
  const fetched = await store.get('sheetlog-faves');
  assertExists(fetched);
  assertEquals(fetched!.id, created.id);
  assertEquals(fetched!.name, 'sheetlog-faves');
  assertEquals(fetched!.type, 'sheetlog');
  assertEquals(fetched!.url, 'https://script.google.com/s/abc/exec');
  assertEquals(fetched!.description, 'favorites log');
  assertEquals(fetched!.auth, { kind: 'query', name: 'key', value_env: 'SL_KEY' });
  assertEquals(fetched!.headers, { 'User-Agent': 'smallstore-peer' });
  assertEquals(fetched!.tags, ['personal', 'sheets']);
  assertEquals(fetched!.capabilities, ['read']);
});

// ============================================================================
// create — validation
// ============================================================================

Deno.test('peers — create rejects invalid slugs', async () => {
  const { store } = freshStore();
  const bad = [
    'UPPERCASE',
    'has spaces',
    '-leading-dash',
    '_leading-underscore', // must start with [a-z0-9]
    '',
    'too-long-' + 'x'.repeat(64), // >64 chars total
    'has/slash',
    'has.dot',
    'has:colon',
  ];
  for (const name of bad) {
    await assertRejects(
      () => store.create(makeInput({ name })),
      Error,
      'Peer name must match',
    );
  }
});

Deno.test('peers — create accepts boundary-valid slugs (single char, 64 chars, digits/dash/underscore)', async () => {
  const { store } = freshStore();
  // single char
  await store.create(makeInput({ name: 'a' }));
  // exactly 64 chars
  const sixtyFour = 'a' + 'b'.repeat(63);
  assertEquals(sixtyFour.length, 64);
  await store.create(makeInput({ name: sixtyFour }));
  // digits, dash, underscore mixed
  await store.create(makeInput({ name: '0abc_def-123' }));
  const list = await store.list();
  assertEquals(list.peers.length, 3);
});

Deno.test('peers — create rejects non-http(s) URLs', async () => {
  const { store } = freshStore();
  const bad = [
    'ftp://example.com',
    'file:///etc/passwd',
    '',
    'not-a-url',
    '/relative/path',
    'ws://example.com',
  ];
  for (const url of bad) {
    await assertRejects(
      () => store.create(makeInput({ name: 'x' + Math.random().toString(36).slice(2, 8), url })),
      Error,
    );
  }
});

Deno.test('peers — create rejects duplicate name', async () => {
  const { store } = freshStore();
  await store.create(makeInput({ name: 'dup' }));
  await assertRejects(
    () => store.create(makeInput({ name: 'dup' })),
    Error,
    'already exists',
  );
});

Deno.test('peers — create rejects bad tags (too many, wrong type, too long)', async () => {
  const { store } = freshStore();
  // 17 tags > max 16
  await assertRejects(
    () => store.create(makeInput({ name: 'a1', tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })),
    Error,
    'too many',
  );
  // non-string tag
  await assertRejects(
    () => store.create(makeInput({ name: 'a2', tags: [123 as any] })),
    Error,
  );
  // tag too long
  await assertRejects(
    () => store.create(makeInput({ name: 'a3', tags: ['x'.repeat(33)] })),
    Error,
    'too long',
  );
});

// ============================================================================
// getById
// ============================================================================

Deno.test('peers — getById round-trips; unknown id returns null', async () => {
  const { store } = freshStore();
  const created = await store.create(makeInput({ name: 'alpha' }));
  const byId = await store.getById(created.id);
  assertExists(byId);
  assertEquals(byId!.name, 'alpha');

  const missing = await store.getById('not-a-real-id');
  assertEquals(missing, null);
});

// ============================================================================
// update
// ============================================================================

Deno.test('peers — update patches fields, preserves id + created_at, sets updated_at', async () => {
  const { store } = freshStore();
  const created = await store.create(makeInput({ name: 'tf' }));
  // Sleep a tick to ensure distinguishable timestamps.
  await new Promise((r) => setTimeout(r, 2));

  const updated = await store.update('tf', {
    description: 'now with a description',
    disabled: true,
    tags: ['prod'],
  });
  assertExists(updated);
  assertEquals(updated!.id, created.id);
  assertEquals(updated!.created_at, created.created_at);
  assertEquals(updated!.description, 'now with a description');
  assertEquals(updated!.disabled, true);
  assertEquals(updated!.tags, ['prod']);
  assertExists(updated!.updated_at);
});

Deno.test('peers — update on missing name returns null', async () => {
  const { store } = freshStore();
  const res = await store.update('nope', { description: 'x' });
  assertEquals(res, null);
});

Deno.test('peers — update rejects forbidden id/created_at mutation (silently strips)', async () => {
  const { store } = freshStore();
  const created = await store.create(makeInput({ name: 'tf' }));
  const updated = await store.update('tf', {
    // Attempt to overwrite id + created_at via a loose patch.
    id: 'hacked-id',
    created_at: '1999-01-01T00:00:00Z',
    description: 'ok',
  } as any);
  assertExists(updated);
  // Originals are preserved.
  assertEquals(updated!.id, created.id);
  assertEquals(updated!.created_at, created.created_at);
  assertEquals(updated!.description, 'ok');
});

Deno.test('peers — update changing name: new name taken → throws; free → moves key + getById still works', async () => {
  const { store } = freshStore();
  const peer = await store.create(makeInput({ name: 'old-name' }));
  await store.create(makeInput({ name: 'taken' }));

  // Clash case.
  await assertRejects(
    () => store.update('old-name', { name: 'taken' }),
    Error,
    'already exists',
  );
  // Original name still reachable after a failed rename.
  assertExists(await store.get('old-name'));

  // Free case — key moves.
  const renamed = await store.update('old-name', { name: 'new-name' });
  assertExists(renamed);
  assertEquals(renamed!.name, 'new-name');
  assertEquals(await store.get('old-name'), null);
  const byNew = await store.get('new-name');
  assertExists(byNew);

  // Alias updated — getById still works and resolves to the new slug.
  const byId = await store.getById(peer.id);
  assertExists(byId);
  assertEquals(byId!.name, 'new-name');
});

// ============================================================================
// delete
// ============================================================================

Deno.test('peers — delete removes + returns true; unknown → false; alias cleaned so getById returns null', async () => {
  const { store } = freshStore();
  const created = await store.create(makeInput({ name: 'goner' }));

  assertEquals(await store.delete('goner'), true);
  assertEquals(await store.get('goner'), null);
  // Alias should also be gone — no stale `getById` lookups.
  assertEquals(await store.getById(created.id), null);

  // Second delete is a no-op.
  assertEquals(await store.delete('goner'), false);
});

// ============================================================================
// list — filters + pagination
// ============================================================================

Deno.test('peers — list with no filter returns all peers sorted by name ascending', async () => {
  const { store } = freshStore();
  for (const name of ['charlie', 'alpha', 'bravo']) {
    await store.create(makeInput({ name }));
  }
  const res = await store.list();
  assertEquals(res.peers.length, 3);
  assertEquals(res.peers.map((p) => p.name), ['alpha', 'bravo', 'charlie']);
  assertEquals(res.next_cursor, undefined);
});

Deno.test('peers — list filters by tags (AND), by type, by name substring', async () => {
  const { store } = freshStore();
  await store.create(makeInput({ name: 'tf-prod', type: 'tigerflare', tags: ['prod', 'personal'] }));
  await store.create(makeInput({ name: 'tf-dev', type: 'tigerflare', tags: ['dev'] }));
  await store.create(makeInput({ name: 'sl-main', type: 'sheetlog', tags: ['prod'] }));
  await store.create(makeInput({ name: 'sl-faves', type: 'sheetlog', tags: ['prod', 'personal'] }));

  // AND semantics: both 'prod' AND 'personal' → tf-prod + sl-faves.
  const byTags = await store.list({ tags: ['prod', 'personal'] });
  assertEquals(byTags.peers.map((p) => p.name).sort(), ['sl-faves', 'tf-prod']);

  // Type filter.
  const byType = await store.list({ type: 'sheetlog' });
  assertEquals(byType.peers.map((p) => p.name).sort(), ['sl-faves', 'sl-main']);

  // Name substring (case-insensitive).
  const byName = await store.list({ name: 'TF' });
  assertEquals(byName.peers.map((p) => p.name).sort(), ['tf-dev', 'tf-prod']);

  // Combined: tigerflare + tag 'prod' → tf-prod only.
  const combined = await store.list({ type: 'tigerflare', tags: ['prod'] });
  assertEquals(combined.peers.map((p) => p.name), ['tf-prod']);
});

Deno.test('peers — list excludes disabled by default; include_disabled=true surfaces them', async () => {
  const { store } = freshStore();
  await store.create(makeInput({ name: 'live-1' }));
  await store.create(makeInput({ name: 'dead-1', disabled: true }));

  const def = await store.list();
  assertEquals(def.peers.map((p) => p.name), ['live-1']);

  const all = await store.list({ include_disabled: true });
  assertEquals(all.peers.map((p) => p.name).sort(), ['dead-1', 'live-1']);
});

Deno.test('peers — list paginates via cursor + limit correctly', async () => {
  const { store } = freshStore();
  // Create 5 peers, alphabetically sorted by name.
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    await store.create(makeInput({ name: n }));
  }
  const page1 = await store.list({ limit: 2 });
  assertEquals(page1.peers.map((p) => p.name), ['a', 'b']);
  assertEquals(page1.next_cursor, 'b');

  const page2 = await store.list({ limit: 2, cursor: page1.next_cursor });
  assertEquals(page2.peers.map((p) => p.name), ['c', 'd']);
  assertEquals(page2.next_cursor, 'd');

  const page3 = await store.list({ limit: 2, cursor: page2.next_cursor });
  assertEquals(page3.peers.map((p) => p.name), ['e']);
  assertEquals(page3.next_cursor, undefined);
});

// ============================================================================
// Alias key hygiene — make sure _by_id/ keys don't show up in list()
// ============================================================================

Deno.test('peers — list ignores alias (_by_id/) keys so they never surface as peers', async () => {
  const { adapter, store } = freshStore();
  await store.create(makeInput({ name: 'one' }));
  await store.create(makeInput({ name: 'two' }));

  // Sanity-check the alias layer exists in the adapter under the expected subprefix.
  const allKeys = await adapter.keys('peers/');
  const aliasKeys = allKeys.filter((k) => k.startsWith('peers/_by_id/'));
  assertEquals(aliasKeys.length, 2);

  // But list() must only return the two primary records.
  const res = await store.list();
  assertEquals(res.peers.length, 2);
  assertEquals(res.peers.map((p) => p.name).sort(), ['one', 'two']);
});
