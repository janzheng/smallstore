/**
 * view() Tests
 *
 * Phase 5.5: Wire view() to ViewManager for named views and inline definitions.
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { createSmallstore } from '../mod.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: 'view - named view via lens',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });

    // Store source data (an array) — use replace mode to store array directly
    await store.set('data/users', [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
      { name: 'Charlie', age: 35 },
    ], { mode: 'replace' });

    // Create a named view with slice retriever (take first 2)
    await store.createView('top-users', {
      source: 'data/users',
      retrievers: [
        { type: 'slice', options: { mode: 'head', take: 2 } },
      ],
    });

    // Use view() with lens name
    const result = await store.view('data/users', { lens: 'top-users' });
    assertEquals(Array.isArray(result), true);
    assertEquals(result.length, 2);
  },
});

Deno.test({
  name: 'view - inline definition with filter retriever',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });

    // Store source data — use replace mode to store array directly
    await store.set('data/items', [
      { name: 'Apple', type: 'fruit' },
      { name: 'Carrot', type: 'vegetable' },
      { name: 'Banana', type: 'fruit' },
    ], { mode: 'replace' });

    // Use view() with inline definition (filter for fruits)
    const result = await store.view('data/items', {
      lens: '',
      definition: {
        retrievers: [
          { type: 'filter', options: { where: { type: { $eq: 'fruit' } } } },
        ],
      },
    });

    assertEquals(Array.isArray(result), true);
    assertEquals(result.length, 2);
    assertEquals(result.every((r: any) => r.type === 'fruit'), true);
  },
});

Deno.test({
  name: 'view - inline definition with chained retrievers',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });

    await store.set('data/numbers', [10, 20, 30, 40, 50], { mode: 'replace' });

    // Chain: slice first 3 → then convert to text
    const result = await store.view('data/numbers', {
      lens: '',
      definition: {
        retrievers: [
          { type: 'slice', options: { mode: 'head', take: 3 } },
          { type: 'text', options: { separator: ', ' } },
        ],
      },
    });

    assertEquals(typeof result, 'string');
    assertEquals(result.includes('10'), true);
    assertEquals(result.includes('30'), true);
    assertEquals(result.includes('40'), false);
  },
});

Deno.test({
  name: 'view - throws when no lens or definition provided',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });

    await assertRejects(
      () => store.view('data/anything', { lens: '' }),
      Error,
      'requires either a lens name or inline definition',
    );
  },
});

Deno.test({
  name: 'view - throws for non-existent named view',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });

    await assertRejects(
      () => store.view('data/anything', { lens: 'nonexistent-view' }),
      Error,
      'not found',
    );
  },
});
