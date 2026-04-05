/**
 * Disclosure Module
 *
 * Progressive disclosure system for Smallstore.
 * Provides Claude-like "skills" - showing relevant information based on context.
 *
 * Key concepts:
 * - Skills: Match context (queries) to relevant data and disclosure levels
 * - Disclosure Levels: summary -> overview -> detailed -> full
 * - Relevance Scoring: Fuzzy matching and weighted scoring
 * - Summarization: Multi-level data summarization
 *
 * @example
 * ```typescript
 * import { createSmallstore, createMemoryAdapter } from '../mod.ts';
 * import { createProgressiveStore, createSkill } from './mod.ts';
 *
 * // Create storage
 * const storage = createSmallstore({
 *   adapters: { memory: createMemoryAdapter() },
 *   defaultAdapter: 'memory',
 * });
 *
 * // Create progressive store
 * const progressive = createProgressiveStore(storage);
 *
 * // Register skills
 * await progressive.registerSkill(createSkill({
 *   name: 'research-explorer',
 *   description: 'Explore research data',
 *   triggers: ['research', 'papers', 'studies', 'science'],
 *   collections: ['research'],
 *   disclosureLevel: 'overview',
 * }));
 *
 * // Store some data
 * await storage.set('research/paper-1', {
 *   title: 'AI Agents in 2024',
 *   authors: ['Alice', 'Bob'],
 *   abstract: 'This paper explores...',
 * });
 *
 * // Discover relevant data
 * const result = await progressive.discoverRelevant({
 *   query: 'show me research papers',
 * });
 *
 * console.log(result.items[0].summary);
 * // => "AI Agents in 2024"
 *
 * // Get more detail
 * const detailed = await progressive.disclose('research/paper-1', {
 *   depth: 'detailed',
 * });
 *
 * console.log(detailed.details);
 * // => { title: '...', authors: [...], abstract: '...' }
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export type {
  DisclosureLevel,
  Skill,
  DisclosureContext,
  DisclosedData,
  DisclosedOverview,
  DiscoveryResult,
  CollectionOverview,
  SummarizationOptions,
  RelevanceConfig,
  ProgressiveStoreConfig,
} from './types.ts';

// ============================================================================
// Core Classes
// ============================================================================

export { ProgressiveStore, createProgressiveStore } from './store.ts';
export { RelevanceScorer, createRelevanceScorer, sortByRelevance, filterByThreshold, topN } from './relevance.ts';
export { Summarizer, createSummarizer } from './summarizer.ts';
export { SkillsManager, createSkillsManager, createSkill, EXAMPLE_SKILLS } from './skills.ts';
