/**
 * listCollections(pattern?) Tests
 *
 * Phase 5.4: Verify glob and prefix pattern filtering on listCollections.
 */

import { assertEquals } from 'jsr:@std/assert';
import { createSmallstore } from '../mod.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: 'listCollections - returns all collections when no pattern',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });
    await store.set('users/alice', { name: 'Alice' });
    await store.set('posts/hello', { title: 'Hello' });
    await store.set('user-profiles/alice', { bio: 'Hi' });

    const all = await store.listCollections();
    assertEquals(all.includes('users'), true);
    assertEquals(all.includes('posts'), true);
    assertEquals(all.includes('user-profiles'), true);
  },
});

Deno.test({
  name: 'listCollections - glob pattern filters collections',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });
    await store.set('users/alice', { name: 'Alice' });
    await store.set('posts/hello', { title: 'Hello' });
    await store.set('user-profiles/alice', { bio: 'Hi' });

    const filtered = await store.listCollections('user*');
    assertEquals(filtered.includes('users'), true);
    assertEquals(filtered.includes('user-profiles'), true);
    assertEquals(filtered.includes('posts'), false);
  },
});

Deno.test({
  name: 'listCollections - prefix match (non-glob)',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });
    await store.set('users/alice', { name: 'Alice' });
    await store.set('posts/hello', { title: 'Hello' });
    await store.set('user-profiles/alice', { bio: 'Hi' });

    const filtered = await store.listCollections('pos');
    assertEquals(filtered.includes('posts'), true);
    assertEquals(filtered.includes('users'), false);
  },
});

Deno.test({
  name: 'listCollections - brace alternation pattern',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });
    await store.set('users/alice', { name: 'Alice' });
    await store.set('posts/hello', { title: 'Hello' });
    await store.set('comments/c1', { body: 'Nice' });

    const filtered = await store.listCollections('{users,posts}');
    assertEquals(filtered.includes('users'), true);
    assertEquals(filtered.includes('posts'), true);
    assertEquals(filtered.includes('comments'), false);
  },
});

Deno.test({
  name: 'listCollections - no matches returns empty',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });
    await store.set('users/alice', { name: 'Alice' });

    const filtered = await store.listCollections('zzz*');
    assertEquals(filtered.length, 0);
  },
});
