/**
 * Search Integration Tests — end-to-end flows from router → adapter → provider.
 *
 * Verifies that each real adapter with a SearchProvider correctly auto-indexes
 * on set(), removes on delete(), and returns ranked results through router.search().
 *
 * Scope (per TASKS-MAP.md #search-integration-tests):
 *  1. SQLite + FTS5
 *  2. Memory + BM25
 *  3. LocalJSON + BM25 auto-indexing (incl. reopen → rebuild)
 *  4. StructuredSQLite + FTS5
 *  5. Memory + Vector (brute-force)
 *  6. Hybrid (BM25 + Vector via RRF)
 *  7. Cross-adapter routing
 */

import { assert, assertEquals, assertGreater, assertRejects } from 'jsr:@std/assert';
import { createSmallstore } from '../mod.ts';
import {
  createSQLiteAdapter,
  createMemoryAdapter,
  createLocalJsonAdapter,
  createStructuredSQLiteAdapter,
  createLocalFileAdapter,
} from '../mod.ts';
import {
  MemoryVectorSearchProvider,
  MemoryBm25SearchProvider,
  MemoryHybridSearchProvider,
} from '../src/search/mod.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

// Deterministic pseudo-embed: char-code histogram normalized.
// Produces stable 16-d vectors that cluster similar strings.
function pseudoEmbed(text: string): number[] {
  const dim = 16;
  const v = new Array<number>(dim).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    v[c % dim] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}

// ---------------------------------------------------------------------------
// 1. SQLite + FTS5 integration
// ---------------------------------------------------------------------------

Deno.test({
  name: 'integration/sqlite-fts5 — set, search, update, delete through router',
  ...opts,
  fn: async () => {
    const sqlite = createSQLiteAdapter({ path: ':memory:' });
    const store = createSmallstore({
      adapters: { sqlite, memory: createMemoryAdapter() },
      defaultAdapter: 'sqlite',
      metadataAdapter: 'memory',
    });

    try {
      const docs: Array<[string, { title: string; body: string }]> = [
        ['docs/a', { title: 'Introduction', body: 'Machine learning is a subset of AI.' }],
        ['docs/b', { title: 'Deep Networks', body: 'Neural networks train via backprop.' }],
        ['docs/c', { title: 'Gardening', body: 'Tomatoes need sunlight and water.' }],
        ['docs/d', { title: 'Web Dev', body: 'HTML CSS JavaScript power the browser.' }],
        ['docs/e', { title: 'Quantum', body: 'Qubits exploit superposition for compute.' }],
        ['docs/f', { title: 'Databases', body: 'SQL queries join tables relationally.' }],
        ['docs/g', { title: 'ML Practice', body: 'Machine learning engineers tune models daily.' }],
        ['docs/h', { title: 'Cooking', body: 'Good bread requires patience and a hot oven.' }],
        ['docs/i', { title: 'Rust', body: 'Rust guarantees memory safety without GC.' }],
        ['docs/j', { title: 'Networking', body: 'TCP reliable delivery undergirds the web.' }],
      ];
      for (const [p, v] of docs) await store.set(p, v);

      // Basic BM25 search returns ranked results
      const r1 = await store.search('docs', { type: 'bm25', query: 'machine learning' });
      assertGreater(r1.length, 0);
      const keys1 = r1.map(r => r.path);
      assert(keys1.some(k => k.includes('docs:a')), 'expected doc:a for "machine learning"');
      assert(keys1.some(k => k.includes('docs:g')), 'expected doc:g for "machine learning"');
      assert(!keys1.some(k => k.includes('docs:c')), 'gardening doc should not match');

      // Update a doc — re-search sees new content
      await store.set('docs/c', { title: 'Gardening', body: 'Tomatoes are actually a machine learning analogy.' });
      const r2 = await store.search('docs', { type: 'bm25', query: 'machine learning' });
      assert(r2.some(r => r.path.includes('docs:c')), 'updated doc:c should now match');

      // Delete a doc — re-search no longer finds it
      await store.delete('docs/e');
      const r3 = await store.search('docs', { type: 'bm25', query: 'qubits' });
      assert(!r3.some(r => r.path.includes('docs:e')), 'deleted doc:e should not appear');

      // Multi-word query matches both terms
      const r4 = await store.search('docs', { type: 'bm25', query: 'rust memory' });
      assert(r4.some(r => r.path.includes('docs:i')));

      // Empty query returns empty cleanly
      const r5 = await store.search('docs', { type: 'bm25', query: '' });
      assertEquals(r5.length, 0);

      // Score normalization invariant
      for (const r of r1) {
        assertGreater(r.score, 0);
        assert(r.score <= 1, `score ${r.score} out of 0-1`);
      }
    } finally {
      sqlite.close();
    }
  },
});

// ---------------------------------------------------------------------------
// 2. Memory + BM25 integration
// ---------------------------------------------------------------------------

Deno.test({
  name: 'integration/memory-bm25 — ranking, case-insensitive, delete',
  ...opts,
  fn: async () => {
    const memory = createMemoryAdapter();
    const store = createSmallstore({
      adapters: { memory },
      defaultAdapter: 'memory',
      metadataAdapter: 'memory',
    });

    await store.set('posts/p1', { title: 'Hello World', body: 'Greetings from the jungle' });
    await store.set('posts/p2', { title: 'Farewell', body: 'goodbye cruel world — see you next time' });
    await store.set('posts/p3', { title: 'World News', body: 'The WORLD spins ever on in silence' });
    await store.set('posts/p4', { title: 'Recipes', body: 'carrots onions potatoes' });

    // Ranking: 'world' should appear in p1/p2/p3 but not p4
    const r1 = await store.search('posts', { type: 'bm25', query: 'world' });
    const keys = r1.map(r => r.path);
    assert(keys.some(k => k.includes('p1')));
    assert(keys.some(k => k.includes('p2')));
    assert(keys.some(k => k.includes('p3')));
    assert(!keys.some(k => k.includes('p4')));

    // Case-insensitive — uppercase query token matches lowercase content
    const r2 = await store.search('posts', { type: 'bm25', query: 'WORLD' });
    assertGreater(r2.length, 0);

    // Delete + re-search
    await store.delete('posts/p1');
    const r3 = await store.search('posts', { type: 'bm25', query: 'greetings' });
    assert(!r3.some(r => r.path.includes('p1')), 'deleted p1 should not appear');

    // Scores positive, sorted desc
    for (let i = 1; i < r1.length; i++) {
      assert(r1[i - 1].score >= r1[i].score, 'results should be sorted by score desc');
    }
  },
});

// Guardrail: the current BM25 provider tokenizes without stemming.
// Document that as an explicit failing-invariant flag if stemming is ever expected.
Deno.test({
  name: 'integration/memory-bm25 — KNOWN: provider does not stem (running ≠ run)',
  ...opts,
  fn: async () => {
    const memory = createMemoryAdapter();
    const store = createSmallstore({
      adapters: { memory },
      defaultAdapter: 'memory',
      metadataAdapter: 'memory',
    });

    await store.set('gym/a', { title: 'Jog', body: 'I enjoy running every morning.' });
    await store.set('gym/b', { title: 'Other', body: 'nothing related here' });

    const r = await store.search('gym', { type: 'bm25', query: 'run' });
    // MemoryBm25SearchProvider.tokenize does NOT stem. "running" will not match "run".
    // If this assertion flips in the future, the provider gained stemming — update the test.
    assertEquals(
      r.some(x => x.path.includes('gym:a')),
      false,
      'MemoryBm25SearchProvider intentionally does not stem — if this fails, provider behavior changed',
    );
  },
});

// SQLite FTS5 uses the porter stemmer, so "running" should match "run".
Deno.test({
  name: 'integration/sqlite-fts5 — porter stemmer (running matches run)',
  ...opts,
  fn: async () => {
    const sqlite = createSQLiteAdapter({ path: ':memory:' });
    const store = createSmallstore({
      adapters: { sqlite, memory: createMemoryAdapter() },
      defaultAdapter: 'sqlite',
      metadataAdapter: 'memory',
    });

    try {
      await store.set('gym/a', { title: 'Jog', body: 'I enjoy running every morning.' });
      await store.set('gym/b', { title: 'Other', body: 'nothing related here' });

      const r = await store.search('gym', { type: 'bm25', query: 'run' });
      assert(r.some(x => x.path.includes('gym:a')), 'FTS5 porter stemmer should match running→run');
    } finally {
      sqlite.close();
    }
  },
});

// ---------------------------------------------------------------------------
// 3. LocalJSON + BM25 auto-indexing (incl. reopen)
// ---------------------------------------------------------------------------

Deno.test({
  name: 'integration/local-json-bm25 — auto-index on set/delete',
  ...opts,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: 'ss-search-ljson-' });
    try {
      const adapter = createLocalJsonAdapter({ baseDir: tmp });
      const store = createSmallstore({
        adapters: { local: adapter, memory: createMemoryAdapter() },
        defaultAdapter: 'local',
        metadataAdapter: 'memory',
      });

      await store.set('notes/n1', { title: 'alpha', body: 'the alpha content mentions dogs' });
      await store.set('notes/n2', { title: 'beta', body: 'this is about cats only' });

      const r1 = await store.search('notes', { type: 'bm25', query: 'dogs' });
      assertEquals(r1.length, 1);
      assert(r1[0].path.includes('n1'));

      await store.delete('notes/n1');
      const r2 = await store.search('notes', { type: 'bm25', query: 'dogs' });
      assertEquals(r2.length, 0);

      await adapter.dispose();
    } finally {
      try { await Deno.remove(tmp, { recursive: true }); } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: 'integration/local-json-bm25 — index auto-rebuilds from disk on reopen',
  ...opts,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: 'ss-search-ljson-reopen-' });
    try {
      const a1 = createLocalJsonAdapter({ baseDir: tmp });
      const s1 = createSmallstore({
        adapters: { local: a1, memory: createMemoryAdapter() },
        defaultAdapter: 'local',
        metadataAdapter: 'memory',
      });
      await s1.set('notes/n1', { title: 'persist', body: 'quantum computing references here' });
      await a1.flush();
      await a1.dispose();

      const a2 = createLocalJsonAdapter({ baseDir: tmp });
      const s2 = createSmallstore({
        adapters: { local: a2, memory: createMemoryAdapter() },
        defaultAdapter: 'local',
        metadataAdapter: 'memory',
      });

      // Lazy hydration on first search rebuilds the BM25 index from disk.
      const r = await s2.search('notes', { type: 'bm25', query: 'quantum' });
      assertEquals(r.length, 1);

      await a2.dispose();
    } finally {
      try { await Deno.remove(tmp, { recursive: true }); } catch { /* ignore */ }
    }
  },
});

// ---------------------------------------------------------------------------
// 4. StructuredSQLite + FTS5
// ---------------------------------------------------------------------------

Deno.test({
  name: 'integration/structured-sqlite-fts5 — typed rows + full-text search',
  ...opts,
  fn: async () => {
    const structured = createStructuredSQLiteAdapter({
      path: ':memory:',
      schema: {
        articles: {
          columns: {
            id: { type: 'text', primaryKey: true },
            title: { type: 'text', notNull: true },
            body: { type: 'text' },
            published: { type: 'integer', default: 0 },
          },
        },
      },
    });

    const store = createSmallstore({
      adapters: { articles: structured, memory: createMemoryAdapter() },
      defaultAdapter: 'articles',
      metadataAdapter: 'memory',
    });

    try {
      await store.set('articles/a1', { id: 'a1', title: 'SQL basics', body: 'Relational databases use structured query language.', published: 1 });
      await store.set('articles/a2', { id: 'a2', title: 'Vector search', body: 'Cosine similarity powers embedding retrieval.', published: 1 });
      await store.set('articles/a3', { id: 'a3', title: 'Draft', body: 'unpublished ramblings about databases', published: 0 });

      const r1 = await store.search('articles', { type: 'bm25', query: 'databases' });
      assertGreater(r1.length, 0);
      const keys = r1.map(r => r.path);
      assert(keys.some(k => k.includes('a1')));
      assert(keys.some(k => k.includes('a3')));

      // Round-tripping typed rows via adapter.get still works
      const a1 = await structured.get('smallstore:articles:a1');
      assertEquals(a1.title, 'SQL basics');
      assertEquals(a1.published, 1);

      // FTS updates on set()
      await store.set('articles/a3', { id: 'a3', title: 'Draft', body: 'now published cosine vectors', published: 1 });
      const r2 = await store.search('articles', { type: 'bm25', query: 'cosine' });
      const keys2 = r2.map(r => r.path);
      assert(keys2.some(k => k.includes('a2')));
      assert(keys2.some(k => k.includes('a3')));

      // Delete removes from FTS
      await store.delete('articles/a2');
      const r3 = await store.search('articles', { type: 'bm25', query: 'embedding' });
      assert(!r3.some(r => r.path.includes('a2')));
    } finally {
      structured.close();
    }
  },
});

// ---------------------------------------------------------------------------
// 5. Memory + Vector search
// ---------------------------------------------------------------------------

// Helper: MemoryAdapter now accepts a searchProvider in its config,
// so custom providers plug in cleanly with no wrapping needed.
function createMemoryAdapterWithProvider(provider: any) {
  return createMemoryAdapter({ searchProvider: provider });
}

Deno.test({
  name: 'integration/search-providers — collection scoping rejects substring matches',
  ...opts,
  fn: async () => {
    // "docs" must not leak results from "old-docs" or "docs-archive".
    const bm25 = new MemoryBm25SearchProvider();
    bm25.index('docs/real', { body: 'the quick brown fox jumps' });
    bm25.index('old-docs/leak', { body: 'the quick brown fox jumps' });
    bm25.index('docs-archive/also-leak', { body: 'the quick brown fox jumps' });

    const r = await bm25.search('quick brown fox', { collection: 'docs' });
    const keys = r.map(x => x.key);
    assert(keys.includes('docs/real'), `real collection match expected; got: ${keys.join(',')}`);
    assert(!keys.includes('old-docs/leak'), `old-docs should not leak into docs scope; got: ${keys.join(',')}`);
    assert(!keys.includes('docs-archive/also-leak'), `docs-archive should not leak into docs scope; got: ${keys.join(',')}`);
  },
});

Deno.test({
  name: 'integration/search-providers — index() rejects internal smallstore:* keys',
  ...opts,
  fn: async () => {
    const bm25 = new MemoryBm25SearchProvider();
    bm25.index('smallstore:meta:docs', { title: 'meta', body: 'INTERNAL_POISON' });
    bm25.index('smallstore:index:docs', { title: 'index', body: 'INTERNAL_POISON' });
    bm25.index('docs/real', { title: 'real', body: 'INTERNAL_POISON' });

    const r = await bm25.search('INTERNAL_POISON', { collection: 'docs' });
    const keys = r.map(x => x.key);
    assert(keys.includes('docs/real'), 'real doc should match');
    assert(!keys.some(k => k.startsWith('smallstore:')), `no internal keys should be indexed, got ${keys.join(',')}`);
  },
});

Deno.test({
  name: 'integration/memory — custom searchProvider via config gets auto-indexed on set',
  ...opts,
  fn: async () => {
    const vector = new MemoryVectorSearchProvider({
      embed: pseudoEmbed,
      dimensions: 16,
      metric: 'cosine',
    });
    const memory = createMemoryAdapter({ searchProvider: vector });

    // set() should auto-index into the custom provider, not a default BM25.
    await memory.set('k/one', { title: 'alpha', body: 'quick brown fox' });
    await memory.set('k/two', { title: 'beta', body: 'lazy dogs' });

    assertEquals((vector as any).size, 2, 'custom provider should receive both set() calls');

    // delete() should remove from the custom provider too.
    await memory.delete('k/one');
    assertEquals((vector as any).size, 1, 'delete() should remove from custom provider');
  },
});

Deno.test({
  name: 'integration/memory-vector — cosine ranking via deterministic embed',
  ...opts,
  fn: async () => {
    const vector = new MemoryVectorSearchProvider({
      embed: pseudoEmbed,
      dimensions: 16,
      metric: 'cosine',
    });
    const memory = createMemoryAdapterWithProvider(vector);

    const store = createSmallstore({
      adapters: { memory },
      defaultAdapter: 'memory',
      metadataAdapter: 'memory',
    });

    const seeds: Array<[string, string]> = [
      ['items/cat', 'cats purr and nap all day long cats'],
      ['items/dog', 'dogs bark and wag their tails happily'],
      ['items/car', 'automobiles drive on roads with engines'],
      ['items/tree', 'trees grow branches in forests quietly'],
      ['items/cat2', 'small kittens and cats play together'],
    ];
    for (const [k, v] of seeds) await store.set(k, v);

    // Query near 'cats' should return the cat docs among top results
    const r = await store.search('items', { type: 'vector', query: 'cats' });
    assertGreater(r.length, 0);
    const top = r.slice(0, 2).map(x => x.path);
    assert(
      top.some(k => k.includes('cat')),
      `top-2 should contain a cat doc, got: ${top.join(', ')}`,
    );

    // topK honored
    const rLimit = await store.search('items', { type: 'vector', query: 'cats', topK: 2 });
    assertEquals(rLimit.length, 2);

    // Different metric — euclidean provider on same seed data
    const vector2 = new MemoryVectorSearchProvider({
      embed: pseudoEmbed,
      dimensions: 16,
      metric: 'euclidean',
    });
    for (const [k, v] of seeds) {
      const key = `smallstore:${k.replace('/', ':')}`;
      await vector2.index(key, v);
    }
    const e = await vector2.search('cats', { limit: 5 });
    assert(e.length > 0);
    assert(
      e[0].score >= 0 && e[0].score <= 1,
      'euclidean score should be normalized 0-1',
    );

    // Delete removes from vector index
    await store.delete('items/cat');
    const rAfter = await store.search('items', { type: 'vector', query: 'cats' });
    assert(
      !rAfter.some(x => x.path === 'smallstore:items:cat'),
      'deleted item should be gone from vector index',
    );
  },
});

// ---------------------------------------------------------------------------
// 6. Hybrid search (BM25 + vector via RRF)
// ---------------------------------------------------------------------------

Deno.test({
  name: 'integration/memory-hybrid — provider directly: alpha shifts ranking between BM25 and vector',
  ...opts,
  fn: async () => {
    const bm25 = new MemoryBm25SearchProvider();
    const vector = new MemoryVectorSearchProvider({
      embed: pseudoEmbed,
      dimensions: 16,
      metric: 'cosine',
    });
    const hybrid = new MemoryHybridSearchProvider({ bm25, vector, defaultAlpha: 0.5 });

    // Two axes:
    //   - 'lexical' contains the exact term "gradient" → BM25 loves it
    //   - 'semantic' shares many letters with query → vector loves it
    await hybrid.index('smallstore:hy:lexical', { title: 'Gradient notes', body: 'gradient descent is optimization' });
    await hybrid.index('smallstore:hy:semantic', { title: 'Overview', body: 'aaaaaa bbbbbb cccccc dddddd' });
    await hybrid.index('smallstore:hy:filler', { title: 'Filler', body: 'totally unrelated prose about the ocean' });

    const query = 'aaaa bbbb cccc dddd gradient';

    // Pure BM25 (alpha=1) → lexical first
    const rBm25 = await hybrid.search(query, { type: 'hybrid', hybridAlpha: 1, collection: 'hy', limit: 5 });
    assertGreater(rBm25.length, 0);
    assert(
      rBm25[0].key.includes('lexical'),
      `alpha=1 (pure BM25) should rank lexical first, got ${rBm25[0].key}`,
    );

    // Pure vector (alpha=0) → semantic first
    const rVec = await hybrid.search(query, { type: 'hybrid', hybridAlpha: 0, collection: 'hy', limit: 5 });
    assertGreater(rVec.length, 0);
    assert(
      rVec[0].key.includes('semantic'),
      `alpha=0 (pure vector) should rank semantic first, got ${rVec[0].key}`,
    );

    // Blended (alpha=0.5) — both appear
    const rMix = await hybrid.search(query, { type: 'hybrid', hybridAlpha: 0.5, collection: 'hy', limit: 5 });
    const keys = rMix.map(r => r.key);
    assert(keys.some(k => k.includes('lexical')));
    assert(keys.some(k => k.includes('semantic')));

    // Hybrid provider also serves plain bm25 / vector types
    const rPureBm25 = await hybrid.search('gradient', { type: 'bm25', collection: 'hy' });
    assert(rPureBm25.some(r => r.key.includes('lexical')));

    const rPureVec = await hybrid.search('aaaa bbbb cccc dddd', { type: 'vector', collection: 'hy' });
    assert(rPureVec.some(r => r.key.includes('semantic')));
  },
});

Deno.test({
  name: 'integration/memory-hybrid — router forwards hybridAlpha to provider',
  ...opts,
  fn: async () => {
    const bm25 = new MemoryBm25SearchProvider();
    const vector = new MemoryVectorSearchProvider({
      embed: pseudoEmbed,
      dimensions: 16,
      metric: 'cosine',
    });
    const hybrid = new MemoryHybridSearchProvider({ bm25, vector, defaultAlpha: 0.5 });
    const memory = createMemoryAdapterWithProvider(hybrid);
    const store = createSmallstore({
      adapters: { memory },
      defaultAdapter: 'memory',
      metadataAdapter: 'memory',
    });

    await store.set('hy/lexical', { title: 'Gradient notes', body: 'gradient descent is optimization' });
    await store.set('hy/semantic', { title: 'Overview', body: 'aaaaaa bbbbbb cccccc dddddd' });

    const query = 'aaaa bbbb cccc dddd gradient';

    const rVecRouter = await store.search('hy', { type: 'hybrid', query, hybridAlpha: 0 });
    const rVecDirect = await hybrid.search(query, { type: 'hybrid', hybridAlpha: 0, collection: 'hy', limit: 20 });

    assert(
      rVecDirect[0].key.includes('semantic'),
      `direct provider call should put semantic first with alpha=0, got ${rVecDirect[0].key}`,
    );
    assert(
      rVecRouter[0].path.includes('semantic'),
      `router should forward hybridAlpha=0 and put semantic first, got ${rVecRouter[0].path}`,
    );
  },
});

// ---------------------------------------------------------------------------
// 7. Cross-adapter search routing
// ---------------------------------------------------------------------------

Deno.test({
  name: 'integration/cross-adapter — each mount returns from its own provider',
  ...opts,
  fn: async () => {
    const sqlite = createSQLiteAdapter({ path: ':memory:' });
    const memory = createMemoryAdapter();
    const store = createSmallstore({
      adapters: { sqlite, memory },
      defaultAdapter: 'memory',
      metadataAdapter: 'memory',
      // Match both the bare collection (for search) and the path (for set/get).
      mounts: {
        'sql': 'sqlite',
        'sql/*': 'sqlite',
        'mem': 'memory',
        'mem/*': 'memory',
      },
    });

    try {
      await store.set('sql/a', { title: 'sqlite-land', body: 'unique-token-alpha found here' });
      await store.set('mem/a', { title: 'memory-land', body: 'unique-token-beta lives here' });

      // Each search hits its own adapter/provider; results don't bleed.
      const rSql = await store.search('sql', { type: 'bm25', query: 'alpha' });
      assert(rSql.some(r => r.path.includes('sql:a')));
      assert(!rSql.some(r => r.path.includes('mem:a')));

      const rMem = await store.search('mem', { type: 'bm25', query: 'beta' });
      assert(rMem.some(r => r.path.includes('mem:a')));
      assert(!rMem.some(r => r.path.includes('sql:a')));

      // Sanity: sqlite provider (porter stemmer) sees alpha, memory provider sees beta.
      const rMemNoHit = await store.search('mem', { type: 'bm25', query: 'alpha' });
      assertEquals(rMemNoHit.length, 0);
    } finally {
      sqlite.close();
    }
  },
});

Deno.test({
  name: 'integration/cross-adapter — adapter without SearchProvider throws UnsupportedOperation',
  ...opts,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: 'ss-search-lf-' });
    try {
      const files = createLocalFileAdapter({ baseDir: tmp });
      const memory = createMemoryAdapter();
      const store = createSmallstore({
        adapters: { files, memory },
        defaultAdapter: 'files',
        metadataAdapter: 'memory',
      });

      await assertRejects(
        () => store.search('blobs', { type: 'bm25', query: 'anything' }),
        Error,
        'not available on this adapter',
      );
    } finally {
      try { await Deno.remove(tmp, { recursive: true }); } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: 'integration/cross-adapter — unsupported search type throws clear error',
  ...opts,
  fn: async () => {
    const memory = createMemoryAdapter();
    const store = createSmallstore({
      adapters: { memory },
      defaultAdapter: 'memory',
      metadataAdapter: 'memory',
    });

    await store.set('x/one', { title: 'test', body: 'content' });

    // Memory adapter's default provider is BM25-only — vector should be rejected.
    await assertRejects(
      () => store.search('x', { type: 'vector', query: 'test' }),
      Error,
      'not available on this adapter',
    );
  },
});
