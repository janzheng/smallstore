/**
 * Disclosure Types
 *
 * Types for progressive disclosure system (Claude-like skills).
 * Provides tiered information disclosure based on context and relevance.
 */

// ============================================================================
// Disclosure Levels
// ============================================================================

/**
 * Disclosure level determines how much information is revealed.
 *
 * - summary: Brief text description (always present)
 * - overview: Key fields, high-level structure
 * - detailed: Most fields, relevant context
 * - full: Everything, complete data
 */
export type DisclosureLevel = 'summary' | 'overview' | 'detailed' | 'full';

// ============================================================================
// Skills
// ============================================================================

/**
 * Skill definition - like Claude skills, provides contextual capabilities.
 *
 * Skills are matched by triggers (keywords) in queries and determine
 * what collections are relevant and how much detail to show.
 */
export interface Skill {
  /** Unique skill name */
  name: string;

  /** Human-readable description of what this skill does */
  description: string;

  /** Keywords that activate this skill (fuzzy matched against queries) */
  triggers: string[];

  /** Collections this skill can access */
  collections: string[];

  /** Default disclosure level when this skill is active */
  disclosureLevel: DisclosureLevel;

  /** Priority for skill selection (higher = more important, default 0) */
  priority?: number;

  /** Optional metadata for skill-specific configuration */
  metadata?: Record<string, any>;

  /** When this skill was created */
  created?: string;

  /** When this skill was last updated */
  updated?: string;
}

// ============================================================================
// Context
// ============================================================================

/**
 * Context for disclosure operations.
 *
 * Determines what information is relevant and how much to show.
 */
export interface DisclosureContext {
  /** What the user/agent is asking about */
  query?: string;

  /** Collections/paths of specific interest */
  focus?: string[];

  /** Requested disclosure depth */
  depth?: DisclosureLevel;

  /** Maximum items to return */
  maxItems?: number;

  /** Explicitly activated skills (by name) */
  activeSkills?: string[];

  /** Minimum relevance score to include (0-1, default 0.1) */
  relevanceThreshold?: number;

  /** Include skills that were not matched but might be relevant */
  includeRelatedSkills?: boolean;
}

// ============================================================================
// Disclosed Data
// ============================================================================

/**
 * Data disclosed at a specific level.
 *
 * Always includes path and summary. Higher levels include more detail.
 */
export interface DisclosedData {
  /** Full path to the data */
  path: string;

  /** Current disclosure level */
  level: DisclosureLevel;

  /** Brief text description (always present) */
  summary: string;

  /** Key fields and structure (if level >= 'overview') */
  overview?: DisclosedOverview;

  /** Most fields with context (if level >= 'detailed') */
  details?: any;

  /** Complete data (if level === 'full') */
  full?: any;

  /** Relevance score (0-1) based on context */
  relevanceScore: number;

  /** Which skill matched this data */
  matchedSkill?: string;

  /** Levels this data can be expanded to */
  canExpandTo?: DisclosureLevel[];

  /** Data type */
  dataType?: string;

  /** Size information */
  size?: {
    bytes: number;
    formatted: string;
    itemCount?: number;
  };
}

/**
 * Overview level data structure
 */
export interface DisclosedOverview {
  /** Key fields from the data */
  fields?: string[];

  /** Sample values for key fields */
  sample?: Record<string, any>;

  /** Data structure type (object, array, etc.) */
  structure?: string;

  /** Item count if array */
  itemCount?: number;

  /** Nested structure info */
  nested?: Record<string, string>;
}

// ============================================================================
// Discovery Results
// ============================================================================

/**
 * Result from discovering relevant data.
 */
export interface DiscoveryResult {
  /** Disclosed items (sorted by relevance) */
  items: DisclosedData[];

  /** Total number of matching items (before limit) */
  totalMatches: number;

  /** Skills that were activated for this discovery */
  activeSkills: string[];

  /** Query that was used */
  query?: string;

  /** Execution time in milliseconds */
  executionTime?: number;
}

// ============================================================================
// Collection Overview
// ============================================================================

/**
 * Overview of a collection
 */
export interface CollectionOverview {
  /** Collection name */
  name: string;

  /** Number of items in collection */
  itemCount: number;

  /** Brief summary of collection contents */
  summary: string;

  /** Data types present */
  dataTypes?: string[];

  /** Size information */
  size?: {
    bytes: number;
    formatted: string;
  };

  /** Skills that can access this collection */
  relatedSkills?: string[];
}

// ============================================================================
// Summarization Options
// ============================================================================

/**
 * Options for summarization
 */
export interface SummarizationOptions {
  /** Maximum length for summary (characters) */
  maxLength?: number;

  /** Fields to prioritize in summary */
  priorityFields?: string[];

  /** Include metadata in summary */
  includeMetadata?: boolean;

  /** Custom summary template */
  template?: string;
}

// ============================================================================
// Relevance Scoring
// ============================================================================

/**
 * Relevance scoring configuration
 */
export interface RelevanceConfig {
  /** Weight for skill trigger matches (default 0.4) */
  triggerWeight?: number;

  /** Weight for collection matches (default 0.3) */
  collectionWeight?: number;

  /** Weight for skill priority (default 0.2) */
  priorityWeight?: number;

  /** Weight for content matches (default 0.1) */
  contentWeight?: number;

  /** Use fuzzy matching for triggers */
  fuzzyMatch?: boolean;

  /** Fuzzy match threshold (0-1, default 0.6) */
  fuzzyThreshold?: number;
}

// ============================================================================
// Store Configuration
// ============================================================================

/**
 * Configuration for ProgressiveStore
 */
export interface ProgressiveStoreConfig {
  /** Collection path for storing skills (default: '_disclosure/skills') */
  skillsCollection?: string;

  /** Default disclosure level (default: 'summary') */
  defaultLevel?: DisclosureLevel;

  /** Default max items for discovery (default: 20) */
  defaultMaxItems?: number;

  /** Relevance scoring configuration */
  relevance?: RelevanceConfig;

  /** Summarization options */
  summarization?: SummarizationOptions;
}
