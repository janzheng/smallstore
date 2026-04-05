/**
 * EpisodicStore - Time-based memory with decay
 *
 * A storage system inspired by human episodic memory:
 * - Memories are timestamped and have importance
 * - Importance decays over time (forgetting)
 * - Recalling a memory strengthens it (recall boost)
 * - Can organize memories into sequences/timelines
 */

import type { Smallstore } from '../types.ts';
import type {
  Episode,
  EpisodeContext,
  Sequence,
  RecallQuery,
  DecayOptions,
  DecayResult,
  EpisodicStoreConfig,
} from './types.ts';
import {
  calculateCurrentImportance,
  analyzeDecay,
  filterActive,
  filterDecayed,
  boostImportance,
  DEFAULT_DECAY_OPTIONS,
} from './decay.ts';
import {
  applyQuery,
  createSequence as makeSequence,
  filterBySequence,
  sortByTimestamp,
  getById,
} from './timeline.ts';
import {
  recallByRelevance,
  recallRecent,
  recallImportant,
  getRecallStats,
} from './recall.ts';

// ============================================================================
// EpisodicStore Class
// ============================================================================

/**
 * EpisodicStore - Time-based memory storage with decay
 *
 * @example
 * ```typescript
 * import { createSmallstore } from '../mod.ts';
 * import { EpisodicStore } from './store.ts';
 *
 * const smallstore = createSmallstore({ ... });
 * const episodic = new EpisodicStore(smallstore);
 *
 * // Remember something
 * const episode = await episodic.remember(
 *   { url: 'https://example.com', title: 'Interesting Article' },
 *   { source: 'browser', tags: ['research', 'ai'] }
 * );
 *
 * // Recall later
 * const memories = await episodic.recall({ tags: ['ai'], limit: 10 });
 *
 * // Apply decay (run periodically)
 * const result = await episodic.applyDecay({ threshold: 0.1 });
 * ```
 */
export class EpisodicStore {
  private smallstore: Smallstore;
  private episodesPath: string;
  private sequencesPath: string;
  private config: Required<EpisodicStoreConfig>;
  private keyLocks = new Map<string, Promise<void>>();

  /**
   * Execute a function while holding a per-key lock.
   * Prevents concurrent read-modify-write on the same key.
   */
  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.keyLocks.has(key)) await this.keyLocks.get(key);
    let release!: () => void;
    const p = new Promise<void>(r => { release = r; });
    this.keyLocks.set(key, p);
    try {
      return await fn();
    } finally {
      this.keyLocks.delete(key);
      release();
    }
  }

  constructor(
    smallstore: Smallstore,
    config: EpisodicStoreConfig = {}
  ) {
    this.smallstore = smallstore;

    const prefix = config.collectionPrefix || '_episodic';
    this.episodesPath = `${prefix}/episodes`;
    this.sequencesPath = `${prefix}/sequences`;

    this.config = {
      defaultImportance: config.defaultImportance ?? 0.5,
      decayOptions: config.decayOptions ?? DEFAULT_DECAY_OPTIONS,
      autoBoostOnRecall: config.autoBoostOnRecall ?? true,
      collectionPrefix: prefix,
    };
  }

  // ==========================================================================
  // Episode Operations
  // ==========================================================================

  /**
   * Remember (store) an episode
   *
   * @param content - Data to store
   * @param context - Context about this memory
   * @param options - Additional options
   * @returns Created episode
   */
  async remember(
    content: any,
    context?: Partial<EpisodeContext>,
    options?: {
      id?: string;
      importance?: number;
      sequence?: string;
      timestamp?: number;
    }
  ): Promise<Episode> {
    const now = Date.now();
    const id = options?.id || crypto.randomUUID();

    const episode: Episode = {
      id,
      timestamp: options?.timestamp ?? now,
      sequence: options?.sequence,
      content,
      context: {
        source: context?.source,
        trigger: context?.trigger,
        related: context?.related,
        tags: context?.tags,
        ...context,
      },
      importance: options?.importance ?? this.config.defaultImportance,
      recalled: 0,
      created: new Date(now).toISOString(),
    };

    // Store the episode (use overwrite mode to avoid array wrapping)
    await this.smallstore.set(`${this.episodesPath}/${id}`, episode, { mode: 'overwrite' });

    return episode;
  }

  /**
   * Recall (retrieve) episodes matching a query
   *
   * Each recall boosts the episode's importance (if autoBoostOnRecall is true).
   *
   * @param query - Query options
   * @returns Matching episodes
   */
  async recall(query: RecallQuery = {}): Promise<Episode[]> {
    // Get all episodes
    const allEpisodes = await this.getAllEpisodes();

    // Apply query filters
    let results: Episode[];

    if (query.tags || query.context) {
      // Use relevance-based recall for context queries
      results = recallByRelevance(allEpisodes, query, this.config.decayOptions);
    } else {
      // Use standard query processing
      results = applyQuery(allEpisodes, query);

      // Filter out decayed unless explicitly included
      if (!query.includeDecayed) {
        results = filterActive(results, this.config.decayOptions);
      }
    }

    // Boost recalled episodes
    if (this.config.autoBoostOnRecall && results.length > 0) {
      await this.boostMultiple(results.map((ep) => ep.id));
    }

    return results;
  }

  /**
   * Forget (delete) an episode
   *
   * @param episodeId - Episode to forget
   */
  async forget(episodeId: string): Promise<void> {
    await this.smallstore.delete(`${this.episodesPath}/${episodeId}`);
  }

  /**
   * Boost an episode's importance (e.g., when recalled)
   *
   * @param episodeId - Episode to boost
   * @param amount - Amount to boost (default from config)
   */
  async boost(episodeId: string, amount?: number): Promise<void> {
    await this.withKeyLock(episodeId, async () => {
      const episode = await this.getEpisode(episodeId);
      if (!episode) return;

      const boostAmount = amount ?? this.config.decayOptions.recallBoost ?? DEFAULT_DECAY_OPTIONS.recallBoost;
      const newImportance = boostImportance(episode.importance, boostAmount);

      const updated: Episode = {
        ...episode,
        importance: newImportance,
        recalled: episode.recalled + 1,
        lastRecalled: new Date().toISOString(),
      };

      await this.smallstore.set(`${this.episodesPath}/${episodeId}`, updated, { mode: 'overwrite' });
    });
  }

  /**
   * Boost multiple episodes (batch operation)
   */
  private async boostMultiple(episodeIds: string[]): Promise<void> {
    for (const id of episodeIds) {
      await this.boost(id);
    }
  }

  /**
   * Get a single episode by ID
   *
   * @param episodeId - Episode ID
   * @returns Episode or null
   */
  async getEpisode(episodeId: string): Promise<Episode | null> {
    const response = await this.smallstore.get(`${this.episodesPath}/${episodeId}`);
    return this.extractContent<Episode>(response);
  }

  /**
   * Update an episode's content or context
   *
   * @param episodeId - Episode to update
   * @param updates - Fields to update
   */
  async updateEpisode(
    episodeId: string,
    updates: Partial<Pick<Episode, 'content' | 'context' | 'importance' | 'sequence'>>
  ): Promise<Episode | null> {
    const episode = await this.getEpisode(episodeId);
    if (!episode) return null;

    const updated: Episode = {
      ...episode,
      ...updates,
      context: updates.context
        ? { ...episode.context, ...updates.context }
        : episode.context,
    };

    await this.smallstore.set(`${this.episodesPath}/${episodeId}`, updated, { mode: 'overwrite' });
    return updated;
  }

  // ==========================================================================
  // Sequence Operations
  // ==========================================================================

  /**
   * Create a sequence (timeline) for grouping episodes
   *
   * @param name - Sequence name
   * @param description - Optional description
   * @returns Created sequence
   */
  async createSequence(name: string, description?: string): Promise<Sequence> {
    const id = crypto.randomUUID();
    const sequence = makeSequence(id, name, description);

    await this.smallstore.set(`${this.sequencesPath}/${id}`, sequence, { mode: 'overwrite' });

    return sequence;
  }

  /**
   * Add an episode to a sequence
   *
   * @param sequenceId - Sequence to add to
   * @param episodeId - Episode to add
   */
  async addToSequence(sequenceId: string, episodeId: string): Promise<void> {
    const episode = await this.getEpisode(episodeId);
    if (!episode) {
      throw new Error(`Episode ${episodeId} not found`);
    }

    // Verify sequence exists
    const response = await this.smallstore.get(`${this.sequencesPath}/${sequenceId}`);
    const sequence = this.extractContent<Sequence>(response);
    if (!sequence) {
      throw new Error(`Sequence ${sequenceId} not found`);
    }

    // Update episode with sequence
    await this.updateEpisode(episodeId, { sequence: sequenceId });

    // Update sequence timestamp
    await this.smallstore.set(`${this.sequencesPath}/${sequenceId}`, {
      ...sequence,
      updated: new Date().toISOString(),
    }, { mode: 'overwrite' });
  }

  /**
   * Get all episodes in a sequence
   *
   * @param sequenceId - Sequence ID
   * @returns Episodes in the sequence, sorted by timestamp
   */
  async getSequence(sequenceId: string): Promise<Episode[]> {
    const allEpisodes = await this.getAllEpisodes();
    const sequenceEpisodes = filterBySequence(allEpisodes, sequenceId);
    return sortByTimestamp(sequenceEpisodes, 'asc'); // Oldest first for sequences
  }

  /**
   * Get sequence metadata
   *
   * @param sequenceId - Sequence ID
   * @returns Sequence or null
   */
  async getSequenceMetadata(sequenceId: string): Promise<Sequence | null> {
    const response = await this.smallstore.get(`${this.sequencesPath}/${sequenceId}`);
    return this.extractContent<Sequence>(response);
  }

  /**
   * List all sequences
   *
   * @returns All sequences
   */
  async listSequences(): Promise<Sequence[]> {
    // Keys returns paths relative to the collection root with colons
    const keys = await this.smallstore.keys(this.sequencesPath);
    const sequences: Sequence[] = [];
    const collection = this.config.collectionPrefix;

    for (const key of keys) {
      // Only process sequence keys
      if (!key.startsWith('sequences')) continue;

      // Only replace the first colon (collection separator), not all colons in values
      const firstColon = key.indexOf(':');
      const pathKey = firstColon > -1
        ? key.substring(0, firstColon) + '/' + key.substring(firstColon + 1)
        : key;
      const fullPath = `${collection}/${pathKey}`;
      const response = await this.smallstore.get(fullPath);
      const sequence = this.extractContent<Sequence>(response);
      if (sequence) {
        sequences.push(sequence);
      }
    }

    return sequences;
  }

  /**
   * Delete a sequence (doesn't delete episodes, just removes grouping)
   *
   * @param sequenceId - Sequence to delete
   * @param removeFromEpisodes - Also remove sequence from episodes (default: true)
   */
  async deleteSequence(sequenceId: string, removeFromEpisodes: boolean = true): Promise<void> {
    if (removeFromEpisodes) {
      const episodes = await this.getSequence(sequenceId);
      for (const episode of episodes) {
        await this.updateEpisode(episode.id, { sequence: undefined });
      }
    }

    await this.smallstore.delete(`${this.sequencesPath}/${sequenceId}`);
  }

  // ==========================================================================
  // Timeline Operations
  // ==========================================================================

  /**
   * Get timeline of episodes
   *
   * @param options - Timeline options
   * @returns Episodes sorted by timestamp
   */
  async getTimeline(options?: {
    start?: number;
    end?: number;
    limit?: number;
    includeDecayed?: boolean;
  }): Promise<Episode[]> {
    const allEpisodes = await this.getAllEpisodes();

    let filtered = allEpisodes;

    // Filter by time range
    if (options?.start !== undefined || options?.end !== undefined) {
      filtered = filtered.filter((ep) => {
        if (options.start !== undefined && ep.timestamp < options.start) return false;
        if (options.end !== undefined && ep.timestamp > options.end) return false;
        return true;
      });
    }

    // Filter out decayed
    if (!options?.includeDecayed) {
      filtered = filterActive(filtered, this.config.decayOptions);
    }

    // Sort by timestamp (newest first)
    filtered = sortByTimestamp(filtered, 'desc');

    // Apply limit
    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  // ==========================================================================
  // Decay Operations
  // ==========================================================================

  /**
   * Apply decay to all episodes
   *
   * This doesn't automatically run - call it periodically (e.g., daily).
   *
   * @param options - Decay options
   * @returns Summary of decay operation
   */
  async applyDecay(options?: DecayOptions): Promise<DecayResult> {
    const opts = { ...this.config.decayOptions, ...options };
    const allEpisodes = await this.getAllEpisodes();

    // Analyze decay
    const result = analyzeDecay(allEpisodes, opts);

    // Delete decayed episodes if requested
    if (opts.deleteDecayed) {
      const decayed = filterDecayed(allEpisodes, opts);
      for (const episode of decayed) {
        await this.forget(episode.id);
      }
    }

    return result;
  }

  /**
   * Get current importance for an episode (with decay applied)
   *
   * @param episodeId - Episode ID
   * @returns Current importance or null if not found
   */
  async getImportance(episodeId: string): Promise<number | null> {
    const episode = await this.getEpisode(episodeId);
    if (!episode) return null;

    return calculateCurrentImportance(episode, this.config.decayOptions);
  }

  /**
   * Get memory statistics
   *
   * @returns Statistics about stored episodes
   */
  async getStats(): Promise<ReturnType<typeof getRecallStats>> {
    const allEpisodes = await this.getAllEpisodes();
    return getRecallStats(allEpisodes, this.config.decayOptions);
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Quick recall of recent memories
   */
  async recentMemories(limit: number = 10): Promise<Episode[]> {
    const allEpisodes = await this.getAllEpisodes();
    return recallRecent(allEpisodes, limit, this.config.decayOptions);
  }

  /**
   * Quick recall of important memories
   */
  async importantMemories(limit: number = 10): Promise<Episode[]> {
    const allEpisodes = await this.getAllEpisodes();
    return recallImportant(allEpisodes, limit, this.config.decayOptions);
  }

  /**
   * Quick recall by tag
   */
  async memoriesByTag(tag: string, limit: number = 10): Promise<Episode[]> {
    return this.recall({ tags: [tag], limit });
  }

  /**
   * Quick recall by source
   */
  async memoriesBySource(source: string, limit: number = 10): Promise<Episode[]> {
    return this.recall({ context: { source }, limit });
  }

  /**
   * Clear all episodes (use with caution!)
   */
  async clearAll(): Promise<void> {
    await this.smallstore.clear(this.episodesPath);
    await this.smallstore.clear(this.sequencesPath);
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Get all episodes from storage
   */
  private async getAllEpisodes(): Promise<Episode[]> {
    // Keys returns paths relative to the collection root with colons
    // e.g., for _episodic/episodes, we get back "episodes:uuid"
    // We need to convert colons to slashes for path-based access
    const keys = await this.smallstore.keys(this.episodesPath);
    const episodes: Episode[] = [];

    // Get the collection name (first part of the path)
    const collection = this.config.collectionPrefix;

    for (const key of keys) {
      // Only process episode keys (filter out any metadata/index keys)
      if (!key.startsWith('episodes')) continue;

      // Only replace the first colon (collection separator), not all colons in values
      const firstColon = key.indexOf(':');
      const pathKey = firstColon > -1
        ? key.substring(0, firstColon) + '/' + key.substring(firstColon + 1)
        : key;
      const fullPath = `${collection}/${pathKey}`;
      const response = await this.smallstore.get(fullPath);
      const episode = this.extractContent<Episode>(response);

      // Validate that this is actually an episode (has required fields)
      if (episode && this.isValidEpisode(episode)) {
        episodes.push(episode);
      }
    }

    return episodes;
  }

  /**
   * Check if an object is a valid Episode
   */
  private isValidEpisode(obj: any): obj is Episode {
    return (
      obj &&
      typeof obj === 'object' &&
      typeof obj.id === 'string' &&
      typeof obj.timestamp === 'number' &&
      typeof obj.context === 'object' &&
      typeof obj.importance === 'number'
    );
  }

  /**
   * Extract content from a Smallstore response
   *
   * Smallstore wraps responses in a StorageFileResponse object.
   * This helper extracts the actual content.
   * Note: Smallstore may wrap single items in arrays, so we unwrap if needed.
   */
  private extractContent<T>(response: any): T | null {
    if (response === null || response === undefined) {
      return null;
    }

    let content = response;

    // If response has a 'content' property, extract it (wrapped response)
    if (typeof response === 'object' && 'content' in response) {
      content = response.content;
    }

    // If content is an array with a single item, unwrap it
    // (Smallstore may wrap single objects in arrays)
    if (Array.isArray(content) && content.length === 1) {
      return content[0] as T;
    }

    // If content is null/undefined, return null
    if (content === null || content === undefined) {
      return null;
    }

    return content as T;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an EpisodicStore instance
 *
 * @param smallstore - Smallstore instance
 * @param config - Configuration options
 * @returns EpisodicStore instance
 *
 * @example
 * ```typescript
 * const episodic = createEpisodicStore(smallstore, {
 *   defaultImportance: 0.5,
 *   decayOptions: { threshold: 0.1, ageWeight: 0.000001 },
 *   autoBoostOnRecall: true,
 * });
 * ```
 */
export function createEpisodicStore(
  smallstore: Smallstore,
  config?: EpisodicStoreConfig
): EpisodicStore {
  return new EpisodicStore(smallstore, config);
}
