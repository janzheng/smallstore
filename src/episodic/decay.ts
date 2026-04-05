/**
 * Memory Decay Algorithms
 *
 * Implements decay patterns inspired by human memory:
 * - Exponential decay based on age
 * - Recall boost (accessing memory strengthens it)
 * - Importance-weighted decay (important things fade slower)
 */

import type { Episode, DecayOptions, DecayResult } from './types.ts';

// ============================================================================
// Constants
// ============================================================================

/** Default decay options */
export const DEFAULT_DECAY_OPTIONS: Required<DecayOptions> = {
  threshold: 0.1,
  ageWeight: 0.000001, // Roughly 0.086 decay per day (0.000001 * 86400000ms)
  recallBoost: 0.1,
  minImportance: 0.2,
  deleteDecayed: false,
};

// ============================================================================
// Decay Calculation Functions
// ============================================================================

/**
 * Calculate exponential decay factor based on age
 *
 * Uses the formula: decay = e^(-ageWeight * age)
 * This produces smooth exponential decay over time.
 *
 * @param ageMs - Age in milliseconds
 * @param ageWeight - Decay rate (higher = faster decay)
 * @returns Decay factor between 0 and 1
 */
export function calculateAgeFactor(ageMs: number, ageWeight: number): number {
  return Math.exp(-ageWeight * ageMs);
}

/**
 * Calculate recall boost factor
 *
 * More recalls = stronger memory retention.
 * Uses logarithmic scaling so early recalls matter more.
 *
 * @param recallCount - Number of times episode has been recalled
 * @param recallBoost - Boost per recall
 * @returns Recall factor (always >= 1)
 */
export function calculateRecallFactor(recallCount: number, recallBoost: number): number {
  if (recallCount === 0) return 1;
  // Logarithmic scaling: first recalls matter more
  return 1 + recallBoost * Math.log(recallCount + 1);
}

/**
 * Calculate current importance after decay
 *
 * Combines:
 * - Original importance
 * - Age-based decay (exponential)
 * - Recall boost (logarithmic)
 *
 * @param episode - Episode to calculate importance for
 * @param options - Decay options
 * @param now - Current timestamp (for testing)
 * @returns Current importance value (0-1)
 */
export function calculateCurrentImportance(
  episode: Episode,
  options: DecayOptions = {},
  now: number = Date.now()
): number {
  const opts = { ...DEFAULT_DECAY_OPTIONS, ...options };

  // Calculate age in milliseconds
  const ageMs = now - episode.timestamp;

  // Age decay factor (0-1, decreases with age)
  const ageFactor = calculateAgeFactor(ageMs, opts.ageWeight);

  // Recall boost factor (>=1, increases with recalls)
  const recallFactor = calculateRecallFactor(episode.recalled, opts.recallBoost);

  // Clamp importance to non-negative before calculation
  const importance = Math.max(0, episode.importance ?? 0);

  // Combine factors with original importance
  // importance * ageFactor * recallFactor
  let currentImportance = importance * ageFactor * recallFactor;

  // Clamp to [0, 1] range
  currentImportance = Math.max(0, Math.min(1, currentImportance));

  // Highly recalled episodes have a minimum importance floor
  const RECALL_BOOST_THRESHOLD = 3;
  if (episode.recalled > RECALL_BOOST_THRESHOLD) {
    currentImportance = Math.max(currentImportance, opts.minImportance);
  }

  return currentImportance;
}

/**
 * Check if an episode has decayed below threshold
 *
 * @param episode - Episode to check
 * @param options - Decay options
 * @param now - Current timestamp (for testing)
 * @returns true if episode has decayed below threshold
 */
export function hasDecayed(
  episode: Episode,
  options: DecayOptions = {},
  now: number = Date.now()
): boolean {
  const opts = { ...DEFAULT_DECAY_OPTIONS, ...options };
  const currentImportance = calculateCurrentImportance(episode, options, now);
  return currentImportance < opts.threshold;
}

/**
 * Apply decay to a list of episodes
 *
 * Returns a summary of the decay operation without modifying the episodes.
 *
 * @param episodes - Episodes to analyze
 * @param options - Decay options
 * @param now - Current timestamp (for testing)
 * @returns Decay result with statistics
 */
export function analyzeDecay(
  episodes: Episode[],
  options: DecayOptions = {},
  now: number = Date.now()
): DecayResult {
  const opts = { ...DEFAULT_DECAY_OPTIONS, ...options };

  let forgotten = 0;
  let remaining = 0;
  let totalImportance = 0;
  const decayedIds: string[] = [];

  for (const episode of episodes) {
    const currentImportance = calculateCurrentImportance(episode, options, now);
    totalImportance += currentImportance;

    if (currentImportance < opts.threshold) {
      forgotten++;
      decayedIds.push(episode.id);
    } else {
      remaining++;
    }
  }

  return {
    forgotten,
    remaining,
    deleted: opts.deleteDecayed ? decayedIds : undefined,
    averageImportance:
      episodes.length > 0 ? totalImportance / episodes.length : 0,
    processedAt: new Date(now).toISOString(),
  };
}

/**
 * Sort episodes by current importance (highest first)
 *
 * @param episodes - Episodes to sort
 * @param options - Decay options
 * @param now - Current timestamp (for testing)
 * @returns Sorted episodes (original array not modified)
 */
export function sortByImportance(
  episodes: Episode[],
  options: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  return [...episodes].sort((a, b) => {
    const importanceA = calculateCurrentImportance(a, options, now);
    const importanceB = calculateCurrentImportance(b, options, now);
    return importanceB - importanceA; // Descending
  });
}

/**
 * Filter episodes above decay threshold
 *
 * @param episodes - Episodes to filter
 * @param options - Decay options
 * @param now - Current timestamp (for testing)
 * @returns Episodes above threshold
 */
export function filterActive(
  episodes: Episode[],
  options: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  if (!Array.isArray(episodes)) {
    throw new Error('filterActive requires an array of episodes');
  }
  return episodes.filter(
    (episode) => !hasDecayed(episode, options, now)
  );
}

/**
 * Filter episodes below decay threshold (candidates for cleanup)
 *
 * @param episodes - Episodes to filter
 * @param options - Decay options
 * @param now - Current timestamp (for testing)
 * @returns Episodes below threshold
 */
export function filterDecayed(
  episodes: Episode[],
  options: DecayOptions = {},
  now: number = Date.now()
): Episode[] {
  if (!Array.isArray(episodes)) {
    throw new Error('filterDecayed requires an array of episodes');
  }
  return episodes.filter(
    (episode) => hasDecayed(episode, options, now)
  );
}

/**
 * Boost an episode's importance (called on recall)
 *
 * Returns new importance value after boost.
 *
 * @param currentImportance - Current importance value
 * @param recallBoost - Amount to boost by
 * @returns New importance value (capped at 1)
 */
export function boostImportance(
  currentImportance: number,
  recallBoost: number = DEFAULT_DECAY_OPTIONS.recallBoost
): number {
  // Diminishing returns on boost as importance approaches 1
  const boost = recallBoost * (1 - currentImportance);
  return Math.min(1, currentImportance + boost);
}
