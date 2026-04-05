/**
 * Glob Pattern Matching Tests
 *
 * Tests for the glob utility (unit) and router keys() glob integration.
 */

import { assertEquals } from 'jsr:@std/assert';
import {
  isGlobPattern,
  globToRegex,
  matchGlob,
  extractStaticPrefix,
} from '../src/utils/glob.ts';

// ============================================================================
// isGlobPattern()
// ============================================================================

Deno.test('isGlobPattern - returns false for plain strings', () => {
  assertEquals(isGlobPattern('research'), false);
  assertEquals(isGlobPattern('research/papers/2024'), false);
  assertEquals(isGlobPattern('hello-world'), false);
  assertEquals(isGlobPattern(''), false);
});

Deno.test('isGlobPattern - returns true for * patterns', () => {
  assertEquals(isGlobPattern('*'), true);
  assertEquals(isGlobPattern('research/*'), true);
  assertEquals(isGlobPattern('research/*/2024'), true);
});

Deno.test('isGlobPattern - returns true for ** patterns', () => {
  assertEquals(isGlobPattern('**'), true);
  assertEquals(isGlobPattern('research/**'), true);
});

Deno.test('isGlobPattern - returns true for ? patterns', () => {
  assertEquals(isGlobPattern('file?.txt'), true);
});

Deno.test('isGlobPattern - returns true for {a,b} patterns', () => {
  assertEquals(isGlobPattern('{json,csv}'), true);
  assertEquals(isGlobPattern('data/{users,posts}'), true);
});

// ============================================================================
// extractStaticPrefix()
// ============================================================================

Deno.test('extractStaticPrefix - returns full string for non-glob', () => {
  assertEquals(extractStaticPrefix('research/papers'), 'research/papers');
  assertEquals(extractStaticPrefix('hello'), 'hello');
});

Deno.test('extractStaticPrefix - returns prefix before first glob char', () => {
  assertEquals(extractStaticPrefix('research/*/2024'), 'research/');
  assertEquals(extractStaticPrefix('data/**'), 'data/');
  assertEquals(extractStaticPrefix('users/alice?'), 'users/alice');
  assertEquals(extractStaticPrefix('data/{users,posts}'), 'data/');
});

Deno.test('extractStaticPrefix - returns empty string when glob starts at beginning', () => {
  assertEquals(extractStaticPrefix('*'), '');
  assertEquals(extractStaticPrefix('**'), '');
  assertEquals(extractStaticPrefix('?file'), '');
  assertEquals(extractStaticPrefix('{a,b}'), '');
});

// ============================================================================
// globToRegex() + matchGlob()
// ============================================================================

Deno.test('matchGlob - single * matches within one segment', () => {
  assertEquals(matchGlob('research/ai', 'research/*'), true);
  assertEquals(matchGlob('research/bio', 'research/*'), true);
  assertEquals(matchGlob('research/ai/2024', 'research/*'), false); // no recursive
  assertEquals(matchGlob('other/ai', 'research/*'), false);
});

Deno.test('matchGlob - * in middle of path', () => {
  assertEquals(matchGlob('research/ai/2024', 'research/*/2024'), true);
  assertEquals(matchGlob('research/bio/2024', 'research/*/2024'), true);
  assertEquals(matchGlob('research/ai/2023', 'research/*/2024'), false);
  assertEquals(matchGlob('research/ai/deep/2024', 'research/*/2024'), false);
});

Deno.test('matchGlob - ** matches across segments', () => {
  assertEquals(matchGlob('research/ai', 'research/**'), true);
  assertEquals(matchGlob('research/ai/2024', 'research/**'), true);
  assertEquals(matchGlob('research/ai/deep/nested', 'research/**'), true);
  assertEquals(matchGlob('research', 'research/**'), false); // ** needs at least something
  assertEquals(matchGlob('other/ai', 'research/**'), false);
});

Deno.test('matchGlob - ** matches everything when alone', () => {
  assertEquals(matchGlob('anything', '**'), true);
  assertEquals(matchGlob('a/b/c/d', '**'), true);
  assertEquals(matchGlob('', '**'), true);
});

Deno.test('matchGlob - ? matches single character', () => {
  assertEquals(matchGlob('file1.txt', 'file?.txt'), true);
  assertEquals(matchGlob('fileA.txt', 'file?.txt'), true);
  assertEquals(matchGlob('file.txt', 'file?.txt'), false);    // no char to match
  assertEquals(matchGlob('file12.txt', 'file?.txt'), false);  // two chars
  assertEquals(matchGlob('file/.txt', 'file?.txt'), false);   // / not matched by ?
});

Deno.test('matchGlob - {a,b} alternation', () => {
  assertEquals(matchGlob('data/users', 'data/{users,posts}'), true);
  assertEquals(matchGlob('data/posts', 'data/{users,posts}'), true);
  assertEquals(matchGlob('data/tags', 'data/{users,posts}'), false);
});

Deno.test('matchGlob - {a,b,c} three alternatives', () => {
  assertEquals(matchGlob('file.json', 'file.{json,csv,xml}'), true);
  assertEquals(matchGlob('file.csv', 'file.{json,csv,xml}'), true);
  assertEquals(matchGlob('file.xml', 'file.{json,csv,xml}'), true);
  assertEquals(matchGlob('file.txt', 'file.{json,csv,xml}'), false);
});

Deno.test('matchGlob - combined patterns', () => {
  // */2024 — any topic from 2024
  assertEquals(matchGlob('ai/2024', '*/2024'), true);
  assertEquals(matchGlob('bio/2024', '*/2024'), true);
  assertEquals(matchGlob('ai/2023', '*/2024'), false);

  // research/*/{json,csv} — any research topic, json or csv format
  assertEquals(matchGlob('research/ai/json', 'research/*/{json,csv}'), true);
  assertEquals(matchGlob('research/bio/csv', 'research/*/{json,csv}'), true);
  assertEquals(matchGlob('research/ai/xml', 'research/*/{json,csv}'), false);
});

Deno.test('matchGlob - exact match (no glob)', () => {
  assertEquals(matchGlob('research/ai', 'research/ai'), true);
  assertEquals(matchGlob('research/bio', 'research/ai'), false);
});

Deno.test('matchGlob - special regex chars in pattern are escaped', () => {
  assertEquals(matchGlob('file.txt', 'file.txt'), true);
  assertEquals(matchGlob('filextxt', 'file.txt'), false); // . should be literal
  assertEquals(matchGlob('data(1)', 'data(1)'), true);
  assertEquals(matchGlob('data1', 'data(1)'), false);
});

// ============================================================================
// Integration: router keys() with glob
// ============================================================================

Deno.test({
  name: 'Integration - keys() with glob pattern on memory store',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const { createSmallstore } = await import('../mod.ts');

  const store = createSmallstore({ preset: 'memory' });

  // Seed data
  await store.set('topics/ai/2024', { title: 'AI 2024' });
  await store.set('topics/ai/2023', { title: 'AI 2023' });
  await store.set('topics/bio/2024', { title: 'Bio 2024' });
  await store.set('topics/bio/2023', { title: 'Bio 2023' });
  await store.set('topics/cs/deep/2024', { title: 'CS Deep 2024' });

  // * pattern: all direct children under topics
  const allTopics = await store.keys('topics', '*');
  // Should match ai, bio, cs (one level only — ai/2024 etc won't match)
  // But keys are stored as full sub-paths like "ai/2024", "bio/2023", etc.
  // So * only matches keys with no / in them — none of these have that.
  // Actually let me reconsider: the keys returned are sub-paths after collection prefix.
  // Keys are like: "ai/2024", "ai/2023", "bio/2024", "bio/2023", "cs/deep/2024"
  // Pattern * matches keys with no / → none match
  assertEquals(allTopics.length, 0);

  // */2024 pattern: all topics from 2024
  const from2024 = await store.keys('topics', '*/2024');
  assertEquals(from2024.length, 2); // ai/2024, bio/2024
  assertEquals(from2024.sort(), ['ai/2024', 'bio/2024']);

  // ** pattern: everything
  const all = await store.keys('topics', '**');
  assertEquals(all.length, 5);

  // ai/* pattern: all years for ai
  const aiKeys = await store.keys('topics', 'ai/*');
  assertEquals(aiKeys.length, 2); // ai/2024, ai/2023
  assertEquals(aiKeys.sort(), ['ai/2023', 'ai/2024']);

  // {ai,bio}/2024 pattern
  const aiBio2024 = await store.keys('topics', '{ai,bio}/2024');
  assertEquals(aiBio2024.length, 2);
  assertEquals(aiBio2024.sort(), ['ai/2024', 'bio/2024']);
  },
});

Deno.test('Integration - keys() without glob still works as prefix', async () => {
  const { createSmallstore } = await import('../mod.ts');

  const store = createSmallstore({ preset: 'memory' });

  await store.set('users/alice', { name: 'Alice' });
  await store.set('users/bob', { name: 'Bob' });
  await store.set('posts/1', { title: 'Post 1' });

  // Plain prefix (no glob)
  const userKeys = await store.keys('users');
  assertEquals(userKeys.length, 2);

  // Empty prefix
  const postKeys = await store.keys('posts');
  assertEquals(postKeys.length, 1);
});

Deno.test('Integration - keys() with glob on SQLite store', async () => {
  const { createSmallstore } = await import('../mod.ts');

  const store = createSmallstore({ preset: 'local-sqlite' });

  await store.set('data/users/alice', { role: 'admin' });
  await store.set('data/users/bob', { role: 'user' });
  await store.set('data/posts/hello', { title: 'Hello' });
  await store.set('data/posts/world', { title: 'World' });

  // Glob: users/*
  const users = await store.keys('data', 'users/*');
  assertEquals(users.length, 2);
  assertEquals(users.sort(), ['users/alice', 'users/bob']);

  // Glob: */alice
  const alice = await store.keys('data', '*/alice');
  assertEquals(alice.length, 1);
  assertEquals(alice[0], 'users/alice');

  // Glob: {users,posts}/*
  const both = await store.keys('data', '{users,posts}/*');
  assertEquals(both.length, 4);
});
