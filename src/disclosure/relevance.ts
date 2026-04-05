/**
 * Relevance Scoring
 *
 * Calculates relevance scores for matching skills and data to queries.
 * Uses fuzzy matching and weighted scoring.
 */

import type {
  Skill,
  DisclosureContext,
  RelevanceConfig,
} from './types.ts';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<RelevanceConfig> = {
  triggerWeight: 0.4,
  collectionWeight: 0.3,
  priorityWeight: 0.2,
  contentWeight: 0.1,
  fuzzyMatch: true,
  fuzzyThreshold: 0.6,
};

// ============================================================================
// Relevance Scorer
// ============================================================================

/**
 * RelevanceScorer calculates relevance scores for skills and data
 */
export class RelevanceScorer {
  private config: Required<RelevanceConfig>;

  constructor(config?: RelevanceConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Score a skill against a query context
   *
   * @param skill - Skill to score
   * @param context - Query context
   * @returns Relevance score 0-1
   */
  scoreSkill(skill: Skill, context: DisclosureContext): number {
    let score = 0;
    let totalWeight = 0;

    // 1. Trigger matching
    if (context.query) {
      const triggerScore = this.scoreTriggers(skill.triggers, context.query);
      score += triggerScore * this.config.triggerWeight;
      totalWeight += this.config.triggerWeight;
    }

    // 2. Collection matching (focus alignment)
    if (context.focus && context.focus.length > 0) {
      const collectionScore = this.scoreCollections(
        skill.collections,
        context.focus
      );
      score += collectionScore * this.config.collectionWeight;
      totalWeight += this.config.collectionWeight;
    }

    // 3. Priority scoring
    const priorityScore = this.scorePriority(skill.priority || 0);
    score += priorityScore * this.config.priorityWeight;
    totalWeight += this.config.priorityWeight;

    // 4. Explicit skill activation
    if (context.activeSkills?.includes(skill.name)) {
      // Explicit activation gives maximum score
      return 1.0;
    }

    // Normalize by total weight
    return totalWeight > 0 ? score / totalWeight : 0;
  }

  /**
   * Score triggers against a query
   *
   * @param triggers - Skill triggers
   * @param query - Search query
   * @returns Score 0-1
   */
  private scoreTriggers(triggers: string[], query: string): number {
    if (triggers.length === 0 || !query) return 0;

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

    let bestScore = 0;

    for (const trigger of triggers) {
      const triggerLower = trigger.toLowerCase();

      // Exact match in query
      if (queryLower.includes(triggerLower)) {
        bestScore = Math.max(bestScore, 1.0);
        continue;
      }

      // Word-level matching
      const triggerWords = triggerLower.split(/\s+/);
      let wordMatchScore = 0;
      for (const tw of triggerWords) {
        for (const qw of queryWords) {
          if (this.config.fuzzyMatch) {
            const similarity = this.calculateSimilarity(tw, qw);
            if (similarity >= this.config.fuzzyThreshold) {
              wordMatchScore = Math.max(wordMatchScore, similarity);
            }
          } else if (qw === tw) {
            wordMatchScore = 1.0;
          }
        }
      }

      bestScore = Math.max(bestScore, wordMatchScore);
    }

    return bestScore;
  }

  /**
   * Score collection overlap
   *
   * @param skillCollections - Collections the skill can access
   * @param focusCollections - Collections user is focused on
   * @returns Score 0-1
   */
  private scoreCollections(
    skillCollections: string[],
    focusCollections: string[]
  ): number {
    if (skillCollections.length === 0 || focusCollections.length === 0) {
      return 0;
    }

    let matches = 0;
    for (const sc of skillCollections) {
      for (const fc of focusCollections) {
        // Exact match
        if (sc === fc) {
          matches++;
          continue;
        }

        // Prefix match (skill covers sub-collection)
        if (fc.startsWith(sc + '/') || sc.startsWith(fc + '/')) {
          matches += 0.8;
          continue;
        }

        // Partial path match
        const scParts = sc.split('/');
        const fcParts = fc.split('/');
        const commonParts = scParts.filter((p) => fcParts.includes(p));
        if (commonParts.length > 0) {
          matches +=
            commonParts.length / Math.max(scParts.length, fcParts.length);
        }
      }
    }

    return Math.min(1.0, matches / focusCollections.length);
  }

  /**
   * Score priority (normalized 0-1)
   *
   * @param priority - Skill priority (can be any number)
   * @returns Score 0-1
   */
  private scorePriority(priority: number): number {
    // Normalize priority using sigmoid-like function
    // Maps any priority to 0-1 range where:
    // - priority 0 = 0.5
    // - priority 10 = ~0.73
    // - priority -10 = ~0.27
    return 1 / (1 + Math.exp(-priority / 10));
  }

  /**
   * Calculate string similarity (Levenshtein-based)
   *
   * @param a - First string
   * @param b - Second string
   * @returns Similarity score 0-1
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    // Quick length-based rejection
    const lenDiff = Math.abs(a.length - b.length);
    const maxLen = Math.max(a.length, b.length);
    if (lenDiff / maxLen > 1 - this.config.fuzzyThreshold) {
      return 0;
    }

    // Calculate Levenshtein distance
    const distance = this.levenshteinDistance(a, b);
    return 1 - distance / maxLen;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    // Use two rows instead of full matrix for memory efficiency
    let prev = new Array(n + 1).fill(0).map((_, i) => i);
    let curr = new Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1, // deletion
          curr[j - 1] + 1, // insertion
          prev[j - 1] + cost // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }

  /**
   * Score content relevance (data against query)
   *
   * @param data - Data to score
   * @param query - Search query
   * @returns Score 0-1
   */
  scoreContent(data: any, query: string): number {
    if (!query) return 0;

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

    // Convert data to searchable text
    const text = this.extractText(data).toLowerCase();

    let matchCount = 0;
    for (const word of queryWords) {
      if (text.includes(word)) {
        matchCount++;
      } else if (this.config.fuzzyMatch) {
        // Try fuzzy matching for each word in text
        const textWords = text.split(/\s+/);
        for (const tw of textWords) {
          if (this.calculateSimilarity(word, tw) >= this.config.fuzzyThreshold) {
            matchCount += 0.5;
            break;
          }
        }
      }
    }

    return queryWords.length > 0 ? matchCount / queryWords.length : 0;
  }

  /**
   * Extract searchable text from data
   */
  private extractText(data: any, depth = 0): string {
    if (depth > 5) return ''; // Prevent infinite recursion

    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    if (typeof data === 'number' || typeof data === 'boolean') {
      return String(data);
    }
    if (Array.isArray(data)) {
      return data
        .slice(0, 10) // Limit array items for performance
        .map((item) => this.extractText(item, depth + 1))
        .join(' ');
    }
    if (typeof data === 'object') {
      return Object.entries(data)
        .slice(0, 20) // Limit object entries for performance
        .map(([key, value]) => `${key} ${this.extractText(value, depth + 1)}`)
        .join(' ');
    }
    return '';
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RelevanceConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sort items by relevance score (descending)
 */
export function sortByRelevance<T extends { relevanceScore: number }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Filter items above threshold
 */
export function filterByThreshold<T extends { relevanceScore: number }>(
  items: T[],
  threshold: number
): T[] {
  return items.filter((item) => item.relevanceScore >= threshold);
}

/**
 * Get top N items by relevance
 */
export function topN<T extends { relevanceScore: number }>(
  items: T[],
  n: number
): T[] {
  return sortByRelevance(items).slice(0, n);
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a relevance scorer with default or custom config
 */
export function createRelevanceScorer(
  config?: RelevanceConfig
): RelevanceScorer {
  return new RelevanceScorer(config);
}
