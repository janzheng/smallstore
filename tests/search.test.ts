/**
 * FTS5 Full-Text Search Tests
 *
 * Phase 5.1-5.2: BM25 search via SQLite FTS5.
 */

import { assert, assertEquals, assertGreater, assertRejects } from 'jsr:@std/assert';
import { createSQLiteAdapter } from '../src/adapters/sqlite.ts';
import { createSmallstore } from '../mod.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

// ============================================================================
// Direct adapter FTS tests
// ============================================================================

Deno.test({
  name: 'fts5 - adapter indexes and searches text content',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    // Store documents — auto-indexed via set()
    await adapter.set('doc:1', { title: 'Introduction to Machine Learning', body: 'Machine learning is a subset of artificial intelligence.' });
    await adapter.set('doc:2', { title: 'Web Development Guide', body: 'HTML CSS and JavaScript are the core web technologies.' });
    await adapter.set('doc:3', { title: 'Deep Learning Networks', body: 'Neural networks use machine learning for complex patterns.' });

    const results = adapter.ftsSearch('machine learning');
    assertGreater(results.length, 0);

    // Both doc:1 and doc:3 mention machine learning
    const keys = results.map(r => r.key);
    assertEquals(keys.includes('doc:1'), true);
    assertEquals(keys.includes('doc:3'), true);
    assertEquals(keys.includes('doc:2'), false);

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - scores are normalized to 0-1 range',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    await adapter.set('doc:1', { title: 'Rust programming language', body: 'Rust is a systems programming language focused on safety.' });
    await adapter.set('doc:2', { title: 'Python guide', body: 'Python is popular for data science.' });

    const results = adapter.ftsSearch('rust programming');
    assertGreater(results.length, 0);

    for (const r of results) {
      assertGreater(r.score, 0);
      assertEquals(r.score <= 1, true);
    }

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - returns snippets',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    await adapter.set('doc:1', { body: 'The quick brown fox jumps over the lazy dog. This is a classic typing test sentence.' });

    const results = adapter.ftsSearch('quick brown fox');
    assertGreater(results.length, 0);
    assertEquals(typeof results[0].snippet, 'string');

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - respects limit option',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    for (let i = 0; i < 10; i++) {
      await adapter.set(`doc:${i}`, { title: `Document ${i} about testing`, body: `Testing content number ${i}` });
    }

    const results = adapter.ftsSearch('testing', { limit: 3 });
    assertEquals(results.length, 3);

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - empty query returns empty',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });
    await adapter.set('doc:1', { title: 'Hello World' });

    const results = adapter.ftsSearch('');
    assertEquals(results.length, 0);

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - delete removes from index',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    await adapter.set('doc:1', { title: 'Searchable document about quantum computing' });
    let results = adapter.ftsSearch('quantum');
    assertGreater(results.length, 0);

    await adapter.delete('doc:1');
    results = adapter.ftsSearch('quantum');
    assertEquals(results.length, 0);

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - indexes plain string values',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    await adapter.set('note:1', 'This is a plain text note about gardening');
    const results = adapter.ftsSearch('gardening');
    assertGreater(results.length, 0);

    adapter.close();
  },
});

Deno.test({
  name: 'fts5 - collection scoping via collection option',
  ...opts,
  fn: async () => {
    const adapter = createSQLiteAdapter({ path: ':memory:' });

    await adapter.set('smallstore:articles:a1', { title: 'Article about dogs' });
    await adapter.set('smallstore:notes:n1', { title: 'Note about dogs' });

    const articlesOnly = adapter.ftsSearch('dogs', { collection: 'articles' });
    assertEquals(articlesOnly.length, 1);
    assertEquals(articlesOnly[0].key.includes('articles'), true);

    adapter.close();
  },
});

// ============================================================================
// Router-level search tests
// ============================================================================

Deno.test({
  name: 'fts5 - router search() works on local-sqlite preset',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'local-sqlite' });

    await store.set('articles/intro', { title: 'Introduction to Smallstore', body: 'Smallstore is a universal storage abstraction for agents.' });
    await store.set('articles/search', { title: 'Full-Text Search', body: 'FTS5 provides BM25 ranked search capabilities.' });
    await store.set('articles/other', { title: 'Unrelated Topic', body: 'This is about cooking recipes.' });

    const results = await store.search('articles', { type: 'bm25', query: 'search' });
    assertGreater(results.length, 0);

    // Should find the search article
    assertEquals(results.some(r => r.score > 0), true);

    // Clean up
    await store.delete('articles/intro');
    await store.delete('articles/search');
    await store.delete('articles/other');
  },
});

Deno.test({
  name: 'fts5 - router search() throws for vector type',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'local-sqlite' });

    await assertRejects(
      () => store.search('articles', { type: 'vector', query: 'test' }),
      Error,
      'not available on this adapter',
    );
  },
});

Deno.test({
  name: 'bm25 - router search() works on memory preset (in-memory BM25)',
  ...opts,
  fn: async () => {
    const store = createSmallstore({ preset: 'memory' });
    await store.set('docs/hello', { title: 'Hello World', body: 'This is a greeting document' });
    await store.set('docs/goodbye', { title: 'Goodbye', body: 'This is a farewell document' });

    const results = await store.search('docs', { type: 'bm25', query: 'greeting' });
    assertEquals(results.length, 1);
    assert(results[0].path.includes('hello'));
    assert(results[0].score > 0);
  },
});
