/**
 * ProgressiveStore
 *
 * Main class for progressive disclosure operations.
 * Provides Claude-like "skills" - showing relevant information based on context.
 */

import type { Smallstore } from '../types.ts';
import type {
  Skill,
  DisclosureLevel,
  DisclosureContext,
  DisclosedData,
  DiscoveryResult,
  CollectionOverview,
  ProgressiveStoreConfig,
} from './types.ts';
import { RelevanceScorer, sortByRelevance, filterByThreshold } from './relevance.ts';
import { Summarizer } from './summarizer.ts';
import { SkillsManager, createSkillsManager } from './skills.ts';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<ProgressiveStoreConfig> = {
  skillsCollection: '_disclosure/skills',
  defaultLevel: 'summary',
  defaultMaxItems: 20,
  relevance: {},
  summarization: {},
};

// ============================================================================
// ProgressiveStore Class
// ============================================================================

/**
 * ProgressiveStore provides progressive disclosure capabilities.
 *
 * Think of it like Claude's skills system - it matches context to relevant
 * data and shows information at appropriate detail levels.
 */
export class ProgressiveStore {
  private smallstore: Smallstore;
  private config: Required<ProgressiveStoreConfig>;
  private scorer: RelevanceScorer;
  private summarizer: Summarizer;
  private skillsManager: SkillsManager;

  constructor(smallstore: Smallstore, config?: ProgressiveStoreConfig) {
    this.smallstore = smallstore;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scorer = new RelevanceScorer(this.config.relevance);
    this.summarizer = new Summarizer(this.config.summarization);
    this.skillsManager = createSkillsManager(
      smallstore,
      this.config.skillsCollection,
      this.scorer
    );
  }

  // ============================================================================
  // Skill Management
  // ============================================================================

  /**
   * Register a skill
   *
   * @param skill - Skill to register
   */
  async registerSkill(skill: Skill): Promise<void> {
    await this.skillsManager.registerSkill(skill);
  }

  /**
   * Unregister a skill
   *
   * @param name - Skill name to remove
   */
  async unregisterSkill(name: string): Promise<void> {
    await this.skillsManager.unregisterSkill(name);
  }

  /**
   * Get all registered skills
   *
   * @returns Array of all skills
   */
  async getSkills(): Promise<Skill[]> {
    return this.skillsManager.getSkills();
  }

  /**
   * Get skills that are active for a given context
   *
   * @param context - Disclosure context
   * @returns Array of active skill names
   */
  async getActiveSkills(context: DisclosureContext): Promise<Skill[]> {
    const active = await this.skillsManager.getActiveSkills(context);
    return active.map((a) => a.skill);
  }

  // ============================================================================
  // Disclosure Operations
  // ============================================================================

  /**
   * Disclose data at a specific path
   *
   * @param path - Data path
   * @param context - Disclosure context
   * @returns Disclosed data at appropriate level
   */
  async disclose(
    path: string,
    context: DisclosureContext
  ): Promise<DisclosedData> {
    const startTime = Date.now();

    // Get raw data (raw: true to avoid StorageFileResponse wrapper)
    const data = await this.smallstore.get(path, { raw: true });

    if (data === null || data === undefined) {
      return {
        path,
        level: 'summary',
        summary: `No data found at ${path}`,
        relevanceScore: 0,
        canExpandTo: [],
      };
    }

    // Determine disclosure level
    const level = await this.determineLevel(path, context);

    // Calculate relevance
    const relevance = this.calculateRelevance(data, path, context);

    // Find matching skill
    const matchedSkill = await this.findMatchingSkill(path, context);

    // Generate disclosed data
    return this.summarizer.disclose(
      data,
      path,
      level,
      relevance,
      matchedSkill?.name
    );
  }

  /**
   * Discover relevant data based on context
   *
   * @param context - Disclosure context
   * @returns Discovery result with matching items
   */
  async discoverRelevant(context: DisclosureContext): Promise<DiscoveryResult> {
    const startTime = Date.now();
    const maxItems = context.maxItems ?? this.config.defaultMaxItems;
    const threshold = context.relevanceThreshold ?? 0.1;

    // Get active skills
    const activeSkills = await this.getActiveSkills(context);
    const activeSkillNames = activeSkills.map((s) => s.name);

    // Collect paths to explore from active skills
    const pathsToExplore = new Set<string>();

    for (const skill of activeSkills) {
      for (const collection of skill.collections) {
        if (collection === '*') {
          // Wildcard - get all collections
          const collections = await this.smallstore.listCollections();
          collections.forEach((c) => pathsToExplore.add(c));
        } else {
          pathsToExplore.add(collection);
        }
      }
    }

    // Also explore focus paths
    if (context.focus) {
      context.focus.forEach((f) => pathsToExplore.add(f));
    }

    // Explore each path and collect disclosed data
    const allItems: DisclosedData[] = [];

    for (const path of pathsToExplore) {
      try {
        // Skip internal collections
        if (path.startsWith('_')) continue;

        const keys = await this.smallstore.keys(path);

        for (const key of keys) {
          const fullPath = `${path}/${key}`;
          const disclosed = await this.disclose(fullPath, {
            ...context,
            depth: context.depth ?? this.config.defaultLevel,
          });

          if (disclosed.relevanceScore >= threshold) {
            allItems.push(disclosed);
          }
        }
      } catch {
        // Path might not exist or have access issues
        continue;
      }
    }

    // Sort by relevance and limit
    const sorted = sortByRelevance(allItems);
    const limited = sorted.slice(0, maxItems);

    return {
      items: limited,
      totalMatches: allItems.length,
      activeSkills: activeSkillNames,
      query: context.query,
      executionTime: Date.now() - startTime,
    };
  }

  // ============================================================================
  // Summarization
  // ============================================================================

  /**
   * Generate a summary for a path
   *
   * @param path - Data path
   * @param level - Disclosure level (default: summary)
   * @returns Summary string
   */
  async summarize(
    path: string,
    level: DisclosureLevel = 'summary'
  ): Promise<string> {
    const data = await this.smallstore.get(path, { raw: true });

    if (data === null || data === undefined) {
      return `No data found at ${path}`;
    }

    const disclosed = this.summarizer.disclose(data, path, level, 1.0);

    switch (level) {
      case 'summary':
        return disclosed.summary;
      case 'overview':
        return this.formatOverviewText(disclosed);
      case 'detailed':
        return this.formatDetailedText(disclosed);
      case 'full':
        return JSON.stringify(data, null, 2);
      default:
        return disclosed.summary;
    }
  }

  /**
   * Generate overview for collections
   *
   * @param collections - Collection paths (empty = all collections)
   * @returns Overview of each collection
   */
  async generateOverview(collections?: string[]): Promise<{
    collections: CollectionOverview[];
  }> {
    const collectionPaths =
      collections || (await this.smallstore.listCollections());

    const overviews: CollectionOverview[] = [];

    for (const name of collectionPaths) {
      // Skip internal collections
      if (name.startsWith('_')) continue;

      try {
        const keys = await this.smallstore.keys(name);
        const schema = await this.smallstore.getSchema(name);
        const relatedSkills = await this.skillsManager.getSkillsForCollection(
          name
        );

        // Sample data for summary
        let summary = `Collection with ${keys.length} items`;
        if (keys.length > 0) {
          const sampleData = await this.smallstore.get(`${name}/${keys[0]}`, { raw: true });
          if (sampleData) {
            summary = this.summarizer.generateSummary(sampleData, name);
          }
        }

        // Get data types from schema
        const dataTypes = new Set<string>();
        for (const pathInfo of Object.values(schema.paths)) {
          dataTypes.add(pathInfo.dataType);
        }

        overviews.push({
          name,
          itemCount: keys.length,
          summary,
          dataTypes: Array.from(dataTypes),
          size: schema.metadata.totalSize
            ? { bytes: 0, formatted: schema.metadata.totalSize }
            : undefined,
          relatedSkills: relatedSkills.map((s) => s.name),
        });
      } catch {
        // Collection might have issues
        overviews.push({
          name,
          itemCount: 0,
          summary: 'Unable to access collection',
        });
      }
    }

    return { collections: overviews };
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Expand disclosed data to a higher level
   *
   * @param disclosed - Current disclosed data
   * @param newLevel - Level to expand to
   * @returns Expanded disclosed data
   */
  async expandTo(
    disclosed: DisclosedData,
    newLevel: DisclosureLevel
  ): Promise<DisclosedData> {
    // Validate expansion
    if (!disclosed.canExpandTo?.includes(newLevel)) {
      throw new Error(`Cannot expand to level: ${newLevel}`);
    }

    // Re-disclose at new level
    return this.disclose(disclosed.path, { depth: newLevel });
  }

  /**
   * Get the underlying Smallstore instance
   */
  getSmallstore(): Smallstore {
    return this.smallstore;
  }

  /**
   * Get the skills manager
   */
  getSkillsManager(): SkillsManager {
    return this.skillsManager;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Determine appropriate disclosure level based on context
   */
  private async determineLevel(
    path: string,
    context: DisclosureContext
  ): Promise<DisclosureLevel> {
    // Explicit level in context
    if (context.depth) {
      return context.depth;
    }

    // Check if any active skill specifies a level
    const skills = await this.getActiveSkills(context);
    if (skills.length > 0) {
      // Use highest priority skill's level
      return skills[0].disclosureLevel;
    }

    // Default level
    return this.config.defaultLevel;
  }

  /**
   * Calculate relevance score for data
   */
  private calculateRelevance(
    data: any,
    path: string,
    context: DisclosureContext
  ): number {
    let score = 0;
    let weights = 0;

    // Query content matching
    if (context.query) {
      const contentScore = this.scorer.scoreContent(data, context.query);
      score += contentScore * 0.5;
      weights += 0.5;

      // Path matching
      const pathScore = this.scorer.scoreContent(path, context.query);
      score += pathScore * 0.2;
      weights += 0.2;
    }

    // Focus matching
    if (context.focus && context.focus.length > 0) {
      const isFocused = context.focus.some(
        (f) => path === f || path.startsWith(f + '/') || f.startsWith(path + '/')
      );
      score += (isFocused ? 1 : 0) * 0.3;
      weights += 0.3;
    }

    // Normalize
    if (weights === 0) return 0.5; // Default neutral score
    return score / weights;
  }

  /**
   * Find the skill that best matches the path and context
   */
  private async findMatchingSkill(
    path: string,
    context: DisclosureContext
  ): Promise<Skill | null> {
    const skills = await this.getActiveSkills(context);

    for (const skill of skills) {
      // Check if skill's collections include this path
      for (const collection of skill.collections) {
        if (
          collection === '*' ||
          path === collection ||
          path.startsWith(collection + '/') ||
          collection.startsWith(path + '/')
        ) {
          return skill;
        }
      }
    }

    return null;
  }

  /**
   * Format overview data as text
   */
  private formatOverviewText(disclosed: DisclosedData): string {
    const lines: string[] = [disclosed.summary];

    if (disclosed.overview) {
      const ov = disclosed.overview;
      if (ov.structure) {
        lines.push(`Structure: ${ov.structure}`);
      }
      if (ov.itemCount !== undefined) {
        lines.push(`Items: ${ov.itemCount}`);
      }
      if (ov.fields && ov.fields.length > 0) {
        lines.push(`Fields: ${ov.fields.slice(0, 10).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format detailed data as text
   */
  private formatDetailedText(disclosed: DisclosedData): string {
    const lines: string[] = [this.formatOverviewText(disclosed)];

    if (disclosed.details) {
      lines.push('---');
      lines.push(JSON.stringify(disclosed.details, null, 2));
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a ProgressiveStore instance
 *
 * @param smallstore - Underlying Smallstore instance
 * @param config - Optional configuration
 * @returns ProgressiveStore instance
 *
 * @example
 * ```typescript
 * import { createSmallstore } from '../mod.ts';
 * import { createProgressiveStore, createSkill } from './disclosure/mod.ts';
 *
 * const storage = createSmallstore({ ... });
 * const progressive = createProgressiveStore(storage);
 *
 * // Register a skill
 * await progressive.registerSkill(createSkill({
 *   name: 'research-explorer',
 *   description: 'Explore research data',
 *   triggers: ['research', 'papers', 'studies'],
 *   collections: ['research'],
 *   disclosureLevel: 'overview',
 * }));
 *
 * // Discover relevant data
 * const result = await progressive.discoverRelevant({
 *   query: 'find papers about AI',
 *   depth: 'overview',
 * });
 * ```
 */
export function createProgressiveStore(
  smallstore: Smallstore,
  config?: ProgressiveStoreConfig
): ProgressiveStore {
  return new ProgressiveStore(smallstore, config);
}
