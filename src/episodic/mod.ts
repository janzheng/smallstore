/**
 * Episodic Store Module
 *
 * Time-based memory storage with decay, inspired by human episodic memory.
 *
 * Features:
 * - Store memories with timestamps and importance
 * - Automatic decay over time (forgetting)
 * - Recall boost (accessing memory strengthens it)
 * - Organize memories into sequences/timelines
 * - Context-based recall (tags, sources, related memories)
 *
 * @example
 * ```typescript
 * import { createSmallstore, createMemoryAdapter } from '../mod.ts';
 * import { createEpisodicStore } from './mod.ts';
 *
 * const smallstore = createSmallstore({
 *   adapters: { memory: createMemoryAdapter() },
 *   defaultAdapter: 'memory',
 * });
 *
 * const episodic = createEpisodicStore(smallstore);
 *
 * // Remember something
 * const episode = await episodic.remember(
 *   { url: 'https://example.com', title: 'Great Article' },
 *   { source: 'browser', tags: ['research', 'ai'] }
 * );
 *
 * // Recall later
 * const memories = await episodic.recall({ tags: ['ai'], limit: 10 });
 *
 * // Get timeline
 * const timeline = await episodic.getTimeline({ limit: 20 });
 *
 * // Apply decay (run periodically)
 * const result = await episodic.applyDecay({ threshold: 0.1 });
 * console.log(`Forgotten: ${result.forgotten}, Remaining: ${result.remaining}`);
 * ```
 *
 * @module
 */

// ============================================================================
// Types
// ============================================================================

export type {
  Episode,
  EpisodeContext,
  Sequence,
  RecallQuery,
  DecayOptions,
  DecayResult,
  EpisodicStoreConfig,
  EpisodeRecord,
} from './types.ts';

// ============================================================================
// Store
// ============================================================================

export { EpisodicStore, createEpisodicStore } from './store.ts';

// ============================================================================
// Decay Algorithms
// ============================================================================

export {
  DEFAULT_DECAY_OPTIONS,
  calculateAgeFactor,
  calculateRecallFactor,
  calculateCurrentImportance,
  hasDecayed,
  analyzeDecay,
  sortByImportance,
  filterActive,
  filterDecayed,
  boostImportance,
} from './decay.ts';

// ============================================================================
// Timeline Operations
// ============================================================================

export {
  filterByTimeRange,
  filterBySequence,
  filterByTags,
  filterByContext,
  filterByImportance,
  sortByTimestamp,
  sortByRecalled,
  sortByOriginalImportance,
  applyQuery,
  createSequence,
  getUniqueSequences,
  groupBySequence,
  getTimeWindow,
  getMostRecent,
  getOldest,
  getById,
  getRelated,
} from './timeline.ts';

// ============================================================================
// Recall Functions
// ============================================================================

export {
  calculateRelevanceScore,
  recallByRelevance,
  recallRecent,
  recallImportant,
  recallFrequent,
  recallByTag,
  recallBySource,
  createRecallTracker,
  getRecallStats,
} from './recall.ts';
