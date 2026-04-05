/**
 * Episodic Store Tests
 *
 * Tests for time-based memory with decay.
 */

import { assertEquals, assertExists } from "@std/assert";
import { createSmallstore, createMemoryAdapter } from '../mod.ts';
import {
  createEpisodicStore,
  EpisodicStore,
  calculateCurrentImportance,
  calculateAgeFactor,
  calculateRecallFactor,
  hasDecayed,
  analyzeDecay,
  filterActive,
  filterDecayed,
  boostImportance,
  filterByTimeRange,
  filterByTags,
  sortByTimestamp,
  applyQuery,
  recallByRelevance,
  recallRecent,
  recallImportant,
  getRecallStats,
  DEFAULT_DECAY_OPTIONS,
  type Episode,
} from '../src/episodic/mod.ts';

// ============================================================================
// Test Helpers
// ============================================================================

function createTestSmallstore() {
  return createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
}

function createTestEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    content: { test: 'data' },
    context: {
      source: 'test',
      tags: ['test'],
    },
    importance: 0.5,
    recalled: 0,
    created: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Decay Algorithm Tests
// ============================================================================

Deno.test('decay: calculateAgeFactor returns correct values', () => {
  // At time 0, factor should be 1
  assertEquals(calculateAgeFactor(0, 0.000001), 1);

  // Factor should decrease with age
  const factor1day = calculateAgeFactor(86400000, 0.000001); // 1 day
  const factor7days = calculateAgeFactor(604800000, 0.000001); // 7 days

  assertEquals(factor1day < 1, true);
  assertEquals(factor7days < factor1day, true);
  assertEquals(factor7days > 0, true);
});

Deno.test('decay: calculateRecallFactor increases with recalls', () => {
  const factor0 = calculateRecallFactor(0, 0.1);
  const factor1 = calculateRecallFactor(1, 0.1);
  const factor5 = calculateRecallFactor(5, 0.1);
  const factor10 = calculateRecallFactor(10, 0.1);

  assertEquals(factor0, 1);
  assertEquals(factor1 > factor0, true);
  assertEquals(factor5 > factor1, true);
  assertEquals(factor10 > factor5, true);
});

Deno.test('decay: calculateCurrentImportance combines factors', () => {
  const now = Date.now();

  // Fresh high-importance episode
  const freshEpisode = createTestEpisode({
    timestamp: now,
    importance: 0.8,
    recalled: 0,
  });

  // Old low-importance episode
  const oldEpisode = createTestEpisode({
    timestamp: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    importance: 0.3,
    recalled: 0,
  });

  // Frequently recalled episode
  const recalledEpisode = createTestEpisode({
    timestamp: now - 7 * 24 * 60 * 60 * 1000, // 7 days ago
    importance: 0.5,
    recalled: 10,
  });

  const freshImportance = calculateCurrentImportance(freshEpisode, {}, now);
  const oldImportance = calculateCurrentImportance(oldEpisode, {}, now);
  const recalledImportance = calculateCurrentImportance(recalledEpisode, {}, now);

  // Fresh should be near original
  assertEquals(freshImportance > 0.7, true);

  // Old should be lower
  assertEquals(oldImportance < freshImportance, true);

  // Recalled should be boosted
  assertEquals(recalledImportance > oldImportance, true);
});

Deno.test('decay: hasDecayed identifies episodes below threshold', () => {
  const now = Date.now();

  // Very old, low-importance episode
  const decayedEpisode = createTestEpisode({
    timestamp: now - 365 * 24 * 60 * 60 * 1000, // 1 year ago
    importance: 0.1,
    recalled: 0,
  });

  // Fresh episode
  const freshEpisode = createTestEpisode({
    timestamp: now,
    importance: 0.5,
    recalled: 0,
  });

  assertEquals(hasDecayed(decayedEpisode, { threshold: 0.1 }, now), true);
  assertEquals(hasDecayed(freshEpisode, { threshold: 0.1 }, now), false);
});

Deno.test('decay: analyzeDecay returns correct statistics', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({ timestamp: now, importance: 0.8, recalled: 5 }),
    createTestEpisode({ timestamp: now - 30 * 24 * 60 * 60 * 1000, importance: 0.5, recalled: 0 }),
    createTestEpisode({ timestamp: now - 365 * 24 * 60 * 60 * 1000, importance: 0.1, recalled: 0 }),
  ];

  const result = analyzeDecay(episodes, { threshold: 0.1 }, now);

  assertEquals(result.forgotten >= 0, true);
  assertEquals(result.remaining >= 0, true);
  assertEquals(result.forgotten + result.remaining, episodes.length);
  assertEquals(result.averageImportance >= 0, true);
  assertEquals(result.averageImportance <= 1, true);
  assertExists(result.processedAt);
});

Deno.test('decay: filterActive and filterDecayed partition episodes', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({ timestamp: now, importance: 0.8, recalled: 0 }),
    createTestEpisode({ timestamp: now, importance: 0.5, recalled: 0 }),
    createTestEpisode({ timestamp: now - 365 * 24 * 60 * 60 * 1000, importance: 0.05, recalled: 0 }),
  ];

  const active = filterActive(episodes, { threshold: 0.1 }, now);
  const decayed = filterDecayed(episodes, { threshold: 0.1 }, now);

  assertEquals(active.length + decayed.length, episodes.length);
});

Deno.test('decay: boostImportance increases importance', () => {
  const original = 0.5;
  const boosted = boostImportance(original, 0.1);

  assertEquals(boosted > original, true);
  assertEquals(boosted <= 1, true);

  // Diminishing returns near 1
  const high = 0.9;
  const highBoosted = boostImportance(high, 0.1);
  assertEquals(highBoosted > high, true);
  assertEquals(highBoosted <= 1, true);
});

// ============================================================================
// Timeline Tests
// ============================================================================

Deno.test('timeline: filterByTimeRange filters correctly', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({ timestamp: now - 10000 }),
    createTestEpisode({ timestamp: now - 5000 }),
    createTestEpisode({ timestamp: now }),
  ];

  // Filter last 7 seconds
  const recent = filterByTimeRange(episodes, now - 7000, now + 1000);
  assertEquals(recent.length, 2);

  // Filter first 7 seconds
  const older = filterByTimeRange(episodes, now - 15000, now - 3000);
  assertEquals(older.length, 2);
});

Deno.test('timeline: filterByTags matches any tag', () => {
  const episodes = [
    createTestEpisode({ context: { tags: ['ai', 'research'] } }),
    createTestEpisode({ context: { tags: ['web', 'design'] } }),
    createTestEpisode({ context: { tags: ['ai', 'design'] } }),
  ];

  const aiEpisodes = filterByTags(episodes, ['ai']);
  assertEquals(aiEpisodes.length, 2);

  const designOrWeb = filterByTags(episodes, ['design', 'web']);
  assertEquals(designOrWeb.length, 2);

  const notFound = filterByTags(episodes, ['nonexistent']);
  assertEquals(notFound.length, 0);
});

Deno.test('timeline: sortByTimestamp orders correctly', () => {
  const episodes = [
    createTestEpisode({ timestamp: 1000 }),
    createTestEpisode({ timestamp: 3000 }),
    createTestEpisode({ timestamp: 2000 }),
  ];

  const ascending = sortByTimestamp(episodes, 'asc');
  assertEquals(ascending[0].timestamp, 1000);
  assertEquals(ascending[2].timestamp, 3000);

  const descending = sortByTimestamp(episodes, 'desc');
  assertEquals(descending[0].timestamp, 3000);
  assertEquals(descending[2].timestamp, 1000);
});

Deno.test('timeline: applyQuery combines filters and sorting', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({ timestamp: now - 10000, context: { tags: ['a'], source: 'x' }, importance: 0.3 }),
    createTestEpisode({ timestamp: now - 5000, context: { tags: ['b'], source: 'y' }, importance: 0.5 }),
    createTestEpisode({ timestamp: now, context: { tags: ['a'], source: 'x' }, importance: 0.8 }),
  ];

  // Filter by tags and sort
  const result = applyQuery(episodes, {
    tags: ['a'],
    sortBy: 'timestamp',
    sortDirection: 'desc',
  });

  assertEquals(result.length, 2);
  assertEquals(result[0].timestamp > result[1].timestamp, true);

  // With limit
  const limited = applyQuery(episodes, { limit: 2 });
  assertEquals(limited.length, 2);
});

// ============================================================================
// Recall Tests
// ============================================================================

Deno.test('recall: recallByRelevance scores and sorts', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({
      timestamp: now,
      context: { tags: ['ai', 'ml'], source: 'research' },
      importance: 0.8,
    }),
    createTestEpisode({
      timestamp: now - 7 * 24 * 60 * 60 * 1000,
      context: { tags: ['web'], source: 'browsing' },
      importance: 0.3,
    }),
    createTestEpisode({
      timestamp: now - 1 * 24 * 60 * 60 * 1000,
      context: { tags: ['ai'], source: 'reading' },
      importance: 0.5,
    }),
  ];

  const results = recallByRelevance(
    episodes,
    { tags: ['ai'], context: { source: 'research' } },
    {},
    now
  );

  // First result should be the most relevant (ai + research + fresh + high importance)
  assertEquals(results[0].context.tags?.includes('ai'), true);
});

Deno.test('recall: recallRecent returns newest first', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({ timestamp: now - 10000 }),
    createTestEpisode({ timestamp: now }),
    createTestEpisode({ timestamp: now - 5000 }),
  ];

  const recent = recallRecent(episodes, 2, {}, now);

  assertEquals(recent.length, 2);
  assertEquals(recent[0].timestamp, now);
});

Deno.test('recall: recallImportant returns highest importance first', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({ timestamp: now, importance: 0.3, recalled: 0 }),
    createTestEpisode({ timestamp: now, importance: 0.9, recalled: 0 }),
    createTestEpisode({ timestamp: now, importance: 0.5, recalled: 0 }),
  ];

  const important = recallImportant(episodes, 2, {}, now);

  assertEquals(important.length, 2);
  assertEquals(important[0].importance, 0.9);
});

Deno.test('recall: getRecallStats returns comprehensive stats', () => {
  const now = Date.now();

  const episodes = [
    createTestEpisode({
      timestamp: now,
      importance: 0.8,
      recalled: 5,
      context: { tags: ['ai', 'ml'], source: 'research' },
    }),
    createTestEpisode({
      timestamp: now - 7 * 24 * 60 * 60 * 1000,
      importance: 0.5,
      recalled: 2,
      context: { tags: ['web'], source: 'browsing' },
    }),
  ];

  const stats = getRecallStats(episodes, {}, now);

  assertEquals(stats.total, 2);
  assertEquals(stats.tagDistribution['ai'], 1);
  assertEquals(stats.tagDistribution['web'], 1);
  assertEquals(stats.sourceDistribution['research'], 1);
  assertEquals(stats.sourceDistribution['browsing'], 1);
  assertEquals(stats.averageRecallCount, 3.5); // (5+2)/2
});

// ============================================================================
// EpisodicStore Integration Tests
// ============================================================================

Deno.test('EpisodicStore: remember and recall basic flow', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore);

  // Remember something
  const episode = await episodic.remember(
    { url: 'https://example.com', title: 'Test' },
    { source: 'test', tags: ['integration'] }
  );

  assertExists(episode.id);
  assertEquals(episode.content.url, 'https://example.com');
  assertEquals(episode.importance, 0.5); // default

  // Recall
  const recalled = await episodic.recall({ tags: ['integration'] });
  assertEquals(recalled.length, 1);
  assertEquals(recalled[0].id, episode.id);

  // Clean up
  await episodic.clearAll();
});

Deno.test('EpisodicStore: recall boosts importance', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore, {
    autoBoostOnRecall: true,
  });

  const episode = await episodic.remember(
    { data: 'test' },
    { tags: ['boost-test'] }
  );

  const initialRecalled = episode.recalled;

  // Recall the episode
  await episodic.recall({ tags: ['boost-test'] });

  // Check that it was boosted
  const updated = await episodic.getEpisode(episode.id);
  assertExists(updated);
  assertEquals(updated.recalled, initialRecalled + 1);

  await episodic.clearAll();
});

Deno.test('EpisodicStore: sequence management', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore);

  // Create a sequence
  const sequence = await episodic.createSequence('research-session', 'My research');
  assertExists(sequence.id);
  assertEquals(sequence.name, 'research-session');

  // Add episodes to sequence
  const ep1 = await episodic.remember({ step: 1 }, { tags: ['seq-test'] });
  const ep2 = await episodic.remember({ step: 2 }, { tags: ['seq-test'] });

  await episodic.addToSequence(sequence.id, ep1.id);
  await episodic.addToSequence(sequence.id, ep2.id);

  // Get sequence episodes
  const seqEpisodes = await episodic.getSequence(sequence.id);
  assertEquals(seqEpisodes.length, 2);

  await episodic.clearAll();
});

Deno.test('EpisodicStore: forget removes episode', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore);

  const episode = await episodic.remember({ data: 'to-forget' });

  // Verify it exists
  let found = await episodic.getEpisode(episode.id);
  assertExists(found);

  // Forget it
  await episodic.forget(episode.id);

  // Verify it's gone
  found = await episodic.getEpisode(episode.id);
  assertEquals(found, null);

  await episodic.clearAll();
});

Deno.test('EpisodicStore: timeline retrieval', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore);

  // Add episodes at different times
  await episodic.remember({ order: 1 }, {}, { timestamp: Date.now() - 10000 });
  await episodic.remember({ order: 2 }, {}, { timestamp: Date.now() - 5000 });
  await episodic.remember({ order: 3 }, {}, { timestamp: Date.now() });

  // Get timeline (newest first)
  const timeline = await episodic.getTimeline({ limit: 10 });

  assertEquals(timeline.length, 3);
  assertEquals(timeline[0].content.order, 3); // Newest first

  await episodic.clearAll();
});

Deno.test('EpisodicStore: applyDecay processes episodes', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore, {
    decayOptions: { threshold: 0.1, ageWeight: 0.00001 },
  });

  // Add fresh episode
  await episodic.remember({ fresh: true }, {}, { importance: 0.8 });

  // Add very old episode (simulate by setting low importance and old timestamp)
  // Note: In real use, decay happens over time. Here we're just testing the mechanism
  const oldEp = await episodic.remember(
    { old: true },
    {},
    { importance: 0.05, timestamp: Date.now() - 365 * 24 * 60 * 60 * 1000 }
  );

  const result = await episodic.applyDecay({ threshold: 0.1 });

  assertEquals(result.forgotten >= 0, true);
  assertEquals(result.remaining >= 0, true);
  assertExists(result.processedAt);

  await episodic.clearAll();
});

Deno.test('EpisodicStore: getStats returns memory statistics', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore);

  await episodic.remember({ a: 1 }, { tags: ['tag1'], source: 'src1' });
  await episodic.remember({ b: 2 }, { tags: ['tag2'], source: 'src2' });

  const stats = await episodic.getStats();

  assertEquals(stats.total, 2);
  assertEquals(stats.tagDistribution['tag1'], 1);
  assertEquals(stats.tagDistribution['tag2'], 1);

  await episodic.clearAll();
});

Deno.test('EpisodicStore: convenience methods work', async () => {
  const smallstore = createTestSmallstore();
  const episodic = createEpisodicStore(smallstore);

  await episodic.remember({ data: 1 }, { tags: ['ai'], source: 'browser' });
  await episodic.remember({ data: 2 }, { tags: ['web'], source: 'api' });

  const recent = await episodic.recentMemories(10);
  assertEquals(recent.length, 2);

  const byTag = await episodic.memoriesByTag('ai', 10);
  assertEquals(byTag.length, 1);

  const bySource = await episodic.memoriesBySource('browser', 10);
  assertEquals(bySource.length, 1);

  await episodic.clearAll();
});

// ============================================================================
// Run Tests
// ============================================================================

console.log('Running Episodic Store tests...');
