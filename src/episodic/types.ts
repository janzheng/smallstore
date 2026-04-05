/**
 * Episodic Store Types
 *
 * Type definitions for time-based memory with decay.
 * Like human episodic memory - remembers important things, forgets trivial ones.
 */

// ============================================================================
// Episode Types
// ============================================================================

/**
 * Episode - A single memory unit
 *
 * Represents a piece of stored information with temporal context,
 * importance weighting, and recall tracking.
 */
export interface Episode {
  /** Unique episode identifier */
  id: string;

  /** Unix timestamp when this episode occurred */
  timestamp: number;

  /** Optional sequence/timeline ID for grouping related episodes */
  sequence?: string;

  /** The stored data (any serializable content) */
  content: any;

  /** Context about when/how this was stored */
  context: EpisodeContext;

  /** Importance level (0-1), affects decay rate - higher = decays slower */
  importance: number;

  /** Number of times this episode has been recalled (boosts retention) */
  recalled: number;

  /** ISO timestamp of creation */
  created: string;

  /** ISO timestamp of last recall (undefined if never recalled) */
  lastRecalled?: string;
}

/**
 * Episode Context - Information about when/how data was stored
 */
export interface EpisodeContext {
  /** Source of the data (e.g., "api", "user-input", "scraper") */
  source?: string;

  /** What triggered this storage (e.g., "bookmark-action", "search-result") */
  trigger?: string;

  /** Related episode IDs for linking memories */
  related?: string[];

  /** Tags for categorization and filtering */
  tags?: string[];

  /** Any additional context metadata */
  [key: string]: any;
}

// ============================================================================
// Sequence Types
// ============================================================================

/**
 * Sequence - A named timeline for grouping related episodes
 *
 * Sequences allow organizing episodes into meaningful timelines,
 * like "research-session-2024-01", "project-discovery-phase", etc.
 */
export interface Sequence {
  /** Unique sequence identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Optional description */
  description?: string;

  /** ISO timestamp of creation */
  created: string;

  /** ISO timestamp of last update */
  updated: string;
}

// ============================================================================
// Query Types
// ============================================================================

/**
 * Recall Query - Options for retrieving episodes
 */
export interface RecallQuery {
  /** Filter by time range (Unix timestamps) */
  timeRange?: {
    start?: number;
    end?: number;
  };

  /** Filter by context fields */
  context?: Partial<EpisodeContext>;

  /** Filter by tags (matches any tag in list) */
  tags?: string[];

  /** Filter by importance range */
  importance?: {
    min?: number;
    max?: number;
  };

  /** Maximum number of episodes to return */
  limit?: number;

  /** Filter by sequence ID */
  sequence?: string;

  /** Skip N episodes (for pagination) */
  offset?: number;

  /** Sort order (default: newest first) */
  sortBy?: 'timestamp' | 'importance' | 'recalled';

  /** Sort direction (default: 'desc') */
  sortDirection?: 'asc' | 'desc';

  /** Include episodes below decay threshold (default: false) */
  includeDecayed?: boolean;
}

// ============================================================================
// Decay Types
// ============================================================================

/**
 * Decay Options - Configuration for memory decay algorithm
 */
export interface DecayOptions {
  /**
   * Below this importance, consider the episode "forgotten"
   * Episodes below threshold are candidates for deletion
   * Default: 0.1
   */
  threshold?: number;

  /**
   * How much age affects decay (decay per millisecond)
   * Higher = faster decay
   * Default: 0.000001 (roughly 0.1 per day)
   */
  ageWeight?: number;

  /**
   * How much each recall boosts importance
   * Default: 0.1
   */
  recallBoost?: number;

  /**
   * Minimum importance that highly recalled episodes can decay to
   * Default: 0.2
   */
  minImportance?: number;

  /**
   * Whether to actually delete decayed episodes or just mark them
   * Default: false (mark only)
   */
  deleteDecayed?: boolean;
}

/**
 * Decay Result - Summary of decay operation
 */
export interface DecayResult {
  /** Number of episodes that fell below threshold */
  forgotten: number;

  /** Number of episodes still above threshold */
  remaining: number;

  /** Episodes that were deleted (if deleteDecayed was true) */
  deleted?: string[];

  /** Average importance after decay */
  averageImportance: number;

  /** Timestamp of decay operation */
  processedAt: string;
}

// ============================================================================
// Store Configuration
// ============================================================================

/**
 * EpisodicStore Configuration
 */
export interface EpisodicStoreConfig {
  /** Default importance for new episodes (default: 0.5) */
  defaultImportance?: number;

  /** Default decay options */
  decayOptions?: DecayOptions;

  /** Automatically boost importance on recall (default: true) */
  autoBoostOnRecall?: boolean;

  /** Collection prefix for storage (default: '_episodic') */
  collectionPrefix?: string;
}

// ============================================================================
// Internal Storage Types
// ============================================================================

/**
 * Internal episode record (stored in Smallstore)
 */
export interface EpisodeRecord extends Episode {
  /** Internal: computed current importance after decay */
  _currentImportance?: number;

  /** Internal: marked for deletion */
  _decayed?: boolean;
}
