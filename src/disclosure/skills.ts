/**
 * Skills Management
 *
 * Registration, storage, and matching of skills.
 * Skills are like Claude's contextual capabilities.
 */

import type { Smallstore } from '../types.ts';
import type {
  Skill,
  DisclosureContext,
} from './types.ts';
import { RelevanceScorer, sortByRelevance } from './relevance.ts';

// ============================================================================
// Skills Manager
// ============================================================================

/**
 * SkillsManager handles skill registration, storage, and matching
 */
export class SkillsManager {
  private smallstore: Smallstore;
  private skillsCollection: string;
  private scorer: RelevanceScorer;

  // In-memory cache for fast lookups
  private skillsCache: Map<string, Skill> = new Map();
  private cacheLoaded = false;

  constructor(
    smallstore: Smallstore,
    skillsCollection = '_disclosure/skills',
    scorer?: RelevanceScorer
  ) {
    this.smallstore = smallstore;
    this.skillsCollection = skillsCollection;
    this.scorer = scorer || new RelevanceScorer();
  }

  // ============================================================================
  // Skill CRUD
  // ============================================================================

  /**
   * Register a new skill
   *
   * @param skill - Skill to register
   */
  async registerSkill(skill: Skill): Promise<void> {
    // Validate skill
    this.validateSkill(skill);

    // Add timestamps
    const now = new Date().toISOString();
    const skillWithMeta: Skill = {
      ...skill,
      created: skill.created || now,
      updated: now,
    };

    // Store skill
    const path = `${this.skillsCollection}/${skill.name}`;
    await this.smallstore.set(path, skillWithMeta, { mode: 'overwrite' });

    // Update cache
    this.skillsCache.set(skill.name, skillWithMeta);
  }

  /**
   * Unregister a skill
   *
   * @param name - Skill name to remove
   */
  async unregisterSkill(name: string): Promise<void> {
    const path = `${this.skillsCollection}/${name}`;
    await this.smallstore.delete(path);
    this.skillsCache.delete(name);
  }

  /**
   * Get a skill by name
   *
   * @param name - Skill name
   * @returns Skill or null if not found
   */
  async getSkill(name: string): Promise<Skill | null> {
    // Check cache first
    if (this.skillsCache.has(name)) {
      return this.skillsCache.get(name) || null;
    }

    // Load from storage
    const path = `${this.skillsCollection}/${name}`;
    const skill = await this.smallstore.get(path);

    if (skill) {
      this.skillsCache.set(name, skill);
    }

    return skill || null;
  }

  /**
   * Get all registered skills
   *
   * @returns Array of all skills
   */
  async getSkills(): Promise<Skill[]> {
    await this.loadCache();
    return Array.from(this.skillsCache.values());
  }

  /**
   * Update an existing skill
   *
   * @param name - Skill name
   * @param updates - Partial skill updates
   */
  async updateSkill(name: string, updates: Partial<Skill>): Promise<void> {
    const existing = await this.getSkill(name);
    if (!existing) {
      throw new Error(`Skill not found: ${name}`);
    }

    const updated: Skill = {
      ...existing,
      ...updates,
      name, // Prevent name change
      updated: new Date().toISOString(),
    };

    await this.registerSkill(updated);
  }

  // ============================================================================
  // Skill Matching
  // ============================================================================

  /**
   * Get skills that are active for a given context
   *
   * @param context - Disclosure context
   * @returns Array of active skills with relevance scores
   */
  async getActiveSkills(
    context: DisclosureContext
  ): Promise<Array<{ skill: Skill; score: number }>> {
    const skills = await this.getSkills();
    const threshold = context.relevanceThreshold ?? 0.1;

    const scored = skills.map((skill) => ({
      skill,
      score: this.scorer.scoreSkill(skill, context),
    }));

    // Filter by threshold and sort by score
    const active = scored.filter((s) => s.score >= threshold);
    return sortByRelevance(
      active.map((s) => ({ ...s, relevanceScore: s.score }))
    ).map((s) => ({
      skill: s.skill,
      score: s.relevanceScore,
    }));
  }

  /**
   * Get skills that can access a specific collection
   *
   * @param collectionPath - Collection path
   * @returns Skills that have access
   */
  async getSkillsForCollection(collectionPath: string): Promise<Skill[]> {
    const skills = await this.getSkills();

    return skills.filter((skill) =>
      skill.collections.some(
        (c) =>
          c === collectionPath ||
          collectionPath.startsWith(c + '/') ||
          c.startsWith(collectionPath + '/')
      )
    );
  }

  /**
   * Find the best matching skill for a query
   *
   * @param query - Query string
   * @returns Best matching skill or null
   */
  async findBestSkill(query: string): Promise<Skill | null> {
    const context: DisclosureContext = { query };
    const active = await this.getActiveSkills(context);

    if (active.length === 0) return null;
    return active[0].skill;
  }

  /**
   * Check if any skill matches the given triggers
   *
   * @param triggers - Array of trigger words
   * @returns Matching skills
   */
  async matchByTriggers(triggers: string[]): Promise<Skill[]> {
    const skills = await this.getSkills();
    const triggerSet = new Set(triggers.map((t) => t.toLowerCase()));

    return skills.filter((skill) =>
      skill.triggers.some((t) => triggerSet.has(t.toLowerCase()))
    );
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  /**
   * Register multiple skills at once
   *
   * @param skills - Skills to register
   */
  async registerSkills(skills: Skill[]): Promise<void> {
    for (const skill of skills) {
      await this.registerSkill(skill);
    }
  }

  /**
   * Clear all skills
   */
  async clearSkills(): Promise<void> {
    await this.smallstore.clear(this.skillsCollection);
    this.skillsCache.clear();
    this.cacheLoaded = false;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Load all skills into cache
   */
  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;

    try {
      const keys = await this.smallstore.keys(this.skillsCollection);

      // keys() returns paths relative to the base collection (first segment).
      // skillsCollection may be "collection/sub/path", so extract the base
      // collection to avoid doubling the sub-path when constructing get() paths.
      const baseCollection = this.skillsCollection.split('/')[0];

      for (const key of keys) {
        const path = `${baseCollection}/${key}`;
        const result = await this.smallstore.get(path);
        // get() returns a StorageFileResponse wrapper; extract .content
        const skill = result?.content ?? result;
        if (skill && skill.name) {
          this.skillsCache.set(skill.name, skill);
        }
      }

      this.cacheLoaded = true;
    } catch (error) {
      console.warn('[disclosure] Failed to load skill cache:', error);
      // Don't set cacheLoaded = true — allow retry
    }
  }

  /**
   * Validate a skill definition
   */
  private validateSkill(skill: Skill): void {
    if (!skill.name || typeof skill.name !== 'string') {
      throw new Error('Skill must have a name');
    }

    if (!skill.description || typeof skill.description !== 'string') {
      throw new Error('Skill must have a description');
    }

    if (!Array.isArray(skill.triggers) || skill.triggers.length === 0) {
      throw new Error('Skill must have at least one trigger');
    }

    if (!Array.isArray(skill.collections) || skill.collections.length === 0) {
      throw new Error('Skill must have at least one collection');
    }

    const validLevels = ['summary', 'overview', 'detailed', 'full'];
    if (!validLevels.includes(skill.disclosureLevel)) {
      throw new Error(`Invalid disclosure level: ${skill.disclosureLevel}`);
    }
  }

  /**
   * Invalidate cache (force reload on next access)
   */
  invalidateCache(): void {
    this.skillsCache.clear();
    this.cacheLoaded = false;
  }
}

// ============================================================================
// Pre-defined Skills (Templates)
// ============================================================================

/**
 * Create a basic skill template
 */
export function createSkill(options: {
  name: string;
  description: string;
  triggers: string[];
  collections: string[];
  disclosureLevel?: 'summary' | 'overview' | 'detailed' | 'full';
  priority?: number;
}): Skill {
  return {
    name: options.name,
    description: options.description,
    triggers: options.triggers,
    collections: options.collections,
    disclosureLevel: options.disclosureLevel || 'overview',
    priority: options.priority || 0,
  };
}

/**
 * Example skills that can be used as starting points
 */
export const EXAMPLE_SKILLS = {
  /** Skill for data exploration */
  dataExplorer: createSkill({
    name: 'data-explorer',
    description: 'Explore and understand data structure',
    triggers: ['explore', 'show', 'list', 'what', 'find', 'search'],
    collections: ['*'], // Access all
    disclosureLevel: 'overview',
    priority: 0,
  }),

  /** Skill for detailed data analysis */
  dataAnalyst: createSkill({
    name: 'data-analyst',
    description: 'Detailed analysis and inspection of data',
    triggers: ['analyze', 'inspect', 'detail', 'full', 'complete', 'all'],
    collections: ['*'],
    disclosureLevel: 'detailed',
    priority: 1,
  }),

  /** Skill for metadata operations */
  metaReader: createSkill({
    name: 'meta-reader',
    description: 'Read metadata and schema information',
    triggers: ['metadata', 'schema', 'structure', 'types', 'fields'],
    collections: ['_metadata', '_schema'],
    disclosureLevel: 'overview',
    priority: 0,
  }),
};

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a skills manager
 */
export function createSkillsManager(
  smallstore: Smallstore,
  skillsCollection?: string,
  scorer?: RelevanceScorer
): SkillsManager {
  return new SkillsManager(smallstore, skillsCollection, scorer);
}
