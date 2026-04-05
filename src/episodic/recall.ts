/**
 * Context-Based Recall
 *
 * Functions for recalling memories based on various criteria.
 * Combines filtering, decay, and relevance scoring.
 */

import type { Episode, RecallQuery, DecayOptions } from './types.ts';
import {
  calculateCurrentImportance,
  hasDecayed,
  DEFAULT_DECAY_OPTIONS,
} from './decay.ts';
import {
  applyQuery,
  filterByTags,
  filterByContext,
  sortByTimestamp,
} from './timeline.ts';

// ============================================================================
// Recall Scoring
// ============================================================================

/**
 * Calculate a relevance score for an episode based on query match
 *
 * Considers:
 * - Tag matches (more matches = higher score)
 * - Context field matches
 * - Recency
 * - Current importance (with decay)
 *
 * @param episode - Episode to score
 * @param query - Query to match against
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Relevance score (higher = more relevant)
 */
export function calculateRelevanceScore(
  episode: Episode,
  query: RecallQuery,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): number {
  let score = 0;

  // Base score from current importance (0-1)
  const currentImportance = calculateCurrentImportance(episode, decayOptions, now);
  score += currentImportance * 0.4; // 40% weight

  // Tag match score (0-1)
  if (query.tags && query.tags.length > 0) {
    const episodeTags = episode.context.tags || [];
    const matchCount = query.tags.filter((tag) => episodeTags.includes(tag)).length;
    const tagScore = matchCount / query.tags.length;
    score += tagScore * 0.3; // 30% weight
  }

  // Context match score (0-1)
  if (query.context) {
    let contextMatches = 0;
    let contextFields = 0;

    for (const [key, value] of Object.entries(query.context)) {
      if (key === 'tags' || key === 'related') continue;
      contextFields++;
      if (episode.context[key] === value) {
        contextMatches++;
      }
    }

    if (contextFields > 0) {
      const contextScore = contextMatches / contextFields;
      score += contextScore * 0.2; // 20% weight
    }
  }

  // Recency bonus (0-0.1, decays with age)
  const ageMs = now - episode.timestamp;
  const dayMs = 24 * 60 * 60 * 1000;
  const recencyScore = Math.exp(-ageMs / (30 * dayMs)); // Decays over 30 days
  score += recencyScore * 0.1; // 10% weight

  return score;
}

// ============================================================================
// Context-Based Recall Functions
// ============================================================================

/**
 * Recall episodes by relevance to a query
 *
 * Returns episodes sorted by relevance score, excluding decayed ones.
 *
 * @param episodes - All episodes
 * @param query - Query to match
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Episodes sorted by relevance
 */
export function recallByRelevance(
  episodes: Episode[],
  query: RecallQuery,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  // Filter out decayed episodes unless explicitly included
  let filtered = query.includeDecayed
    ? episodes
    : episodes.filter((ep) => !hasDecayed(ep, decayOptions, now));

  // Apply query filters
  filtered = applyQuery(filtered, { ...query, sortBy: undefined }); // Don't apply default sort

  // Score and sort by relevance
  const scored = filtered.map((episode) => ({
    episode,
    score: calculateRelevanceScore(episode, query, decayOptions, now),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Apply limit after scoring
  let result = scored.map((s) => s.episode);
  if (query.limit) {
    result = result.slice(0, query.limit);
  }

  return result;
}

/**
 * Recall recent episodes (time-based)
 *
 * @param episodes - All episodes
 * @param limit - Maximum to return
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Most recent non-decayed episodes
 */
export function recallRecent(
  episodes: Episode[],
  limit: number = 10,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  const active = episodes.filter((ep) => !hasDecayed(ep, decayOptions, now));
  return sortByTimestamp(active, 'desc').slice(0, limit);
}

/**
 * Recall most important episodes (by current importance)
 *
 * @param episodes - All episodes
 * @param limit - Maximum to return
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Most important non-decayed episodes
 */
export function recallImportant(
  episodes: Episode[],
  limit: number = 10,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  const active = episodes.filter((ep) => !hasDecayed(ep, decayOptions, now));

  // Sort by current importance (with decay applied)
  const sorted = [...active].sort((a, b) => {
    const impA = calculateCurrentImportance(a, decayOptions, now);
    const impB = calculateCurrentImportance(b, decayOptions, now);
    return impB - impA;
  });

  return sorted.slice(0, limit);
}

/**
 * Recall frequently accessed episodes
 *
 * @param episodes - All episodes
 * @param limit - Maximum to return
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Most frequently recalled non-decayed episodes
 */
export function recallFrequent(
  episodes: Episode[],
  limit: number = 10,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  const active = episodes.filter((ep) => !hasDecayed(ep, decayOptions, now));

  // Sort by recall count
  const sorted = [...active].sort((a, b) => b.recalled - a.recalled);

  return sorted.slice(0, limit);
}

/**
 * Recall episodes by tag
 *
 * @param episodes - All episodes
 * @param tag - Tag to search for
 * @param limit - Maximum to return
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Episodes with matching tag, sorted by timestamp
 */
export function recallByTag(
  episodes: Episode[],
  tag: string,
  limit: number = 10,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  const active = episodes.filter((ep) => !hasDecayed(ep, decayOptions, now));
  const tagged = filterByTags(active, [tag]);
  return sortByTimestamp(tagged, 'desc').slice(0, limit);
}

/**
 * Recall episodes by source
 *
 * @param episodes - All episodes
 * @param source - Source to match
 * @param limit - Maximum to return
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Episodes from source, sorted by timestamp
 */
export function recallBySource(
  episodes: Episode[],
  source: string,
  limit: number = 10,
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  const active = episodes.filter((ep) => !hasDecayed(ep, decayOptions, now));
  const fromSource = filterByContext(active, { source });
  return sortByTimestamp(fromSource, 'desc').slice(0, limit);
}

// ============================================================================
// Recall with Boost
// ============================================================================

/**
 * Track which episodes were recalled (for boosting)
 *
 * Returns a function that updates the recall tracking.
 * Call this when episodes are actually retrieved and shown to user.
 *
 * @param updateEpisode - Function to update an episode
 * @returns Function to mark episodes as recalled
 */
export function createRecallTracker(
  updateEpisode: (id: string, updates: Partial<Episode>) => Promise<void>
): (episodeIds: string[]) => Promise<void> {
  return async (episodeIds: string[]) => {
    const now = new Date().toISOString();
    for (const id of episodeIds) {
      await updateEpisode(id, {
        recalled: undefined as any, // Will be incremented
        lastRecalled: now,
      });
    }
  };
}

// ============================================================================
// Summary Statistics
// ============================================================================

/**
 * Get recall statistics for a set of episodes
 *
 * @param episodes - Episodes to analyze
 * @param decayOptions - Decay options
 * @param now - Current timestamp
 * @returns Statistics about the episodes
 */
export function getRecallStats(
  episodes: Episode[],
  decayOptions: DecayOptions = {},
  now: number = Date.now()
): {
  total: number;
  active: number;
  decayed: number;
  averageImportance: number;
  averageRecallCount: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  tagDistribution: Record<string, number>;
  sourceDistribution: Record<string, number>;
} {
  const opts = { ...DEFAULT_DECAY_OPTIONS, ...decayOptions };

  let totalImportance = 0;
  let totalRecalls = 0;
  let active = 0;
  let decayed = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const tagCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};

  for (const episode of episodes) {
    const currentImportance = calculateCurrentImportance(episode, decayOptions, now);
    totalImportance += currentImportance;
    totalRecalls += episode.recalled;

    if (hasDecayed(episode, decayOptions, now)) {
      decayed++;
    } else {
      active++;
    }

    if (oldest === null || episode.timestamp < oldest) {
      oldest = episode.timestamp;
    }
    if (newest === null || episode.timestamp > newest) {
      newest = episode.timestamp;
    }

    // Count tags
    for (const tag of episode.context.tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    // Count sources
    const source = episode.context.source || 'unknown';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }

  return {
    total: episodes.length,
    active,
    decayed,
    averageImportance: episodes.length > 0 ? totalImportance / episodes.length : 0,
    averageRecallCount: episodes.length > 0 ? totalRecalls / episodes.length : 0,
    oldestTimestamp: oldest,
    newestTimestamp: newest,
    tagDistribution: tagCounts,
    sourceDistribution: sourceCounts,
  };
}
