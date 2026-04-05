/**
 * GraphStore Module
 *
 * Graph-based memory and relationship tracking for Smallstore.
 * Provides graph operations for tracking relationships between stored items.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { createSmallstore, createMemoryAdapter } from '../mod.ts';
 * import { GraphStore, createGraphStore } from './mod.ts';
 *
 * // Create Smallstore instance
 * const smallstore = createSmallstore({
 *   adapters: { memory: createMemoryAdapter() },
 *   defaultAdapter: 'memory',
 * });
 *
 * // Create GraphStore
 * const graph = createGraphStore(smallstore);
 *
 * // Add nodes representing stored items
 * const doc1 = await graph.addNode({
 *   collection: 'documents',
 *   path: 'docs/intro.md',
 *   type: 'document',
 *   metadata: { title: 'Introduction' }
 * });
 *
 * const doc2 = await graph.addNode({
 *   collection: 'documents',
 *   path: 'docs/chapter1.md',
 *   type: 'document',
 *   metadata: { title: 'Chapter 1' }
 * });
 *
 * // Add relationship
 * await graph.addEdge({
 *   source: doc1.id,
 *   target: doc2.id,
 *   relationship: 'references',
 *   weight: 0.8,
 *   metadata: { context: 'See Chapter 1 for details' }
 * });
 *
 * // Query the graph
 * const related = await graph.getRelated(doc1.id, 'references');
 * console.log('Related documents:', related);
 *
 * // Use query builder for complex queries
 * const result = await graph.query()
 *   .from(doc1.id)
 *   .traverse('references', 'out')
 *   .depth(3)
 *   .includePaths()
 *   .execute();
 *
 * console.log('Traversal result:', result);
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export type {
  // Node types
  GraphNode,
  GraphNodeInput,

  // Edge types
  GraphEdge,
  GraphEdgeInput,
  GraphRelationship,

  // Query types
  GraphQuery,
  GraphQueryResult,
  GraphQueryMetadata,
  TraversalPattern,
  GraphPath,

  // Statistics
  GraphStats,

  // Options
  GraphStoreOptions,
  BatchOptions,
  BatchResult,
} from './types.ts';

// ============================================================================
// Core Store
// ============================================================================

export { GraphStore, createGraphStore, BoundQueryBuilder } from './store.ts';

// ============================================================================
// Traversal Utilities
// ============================================================================

export {
  bfs,
  dfs,
  shortestPath,
  type TraversalContext,
  type TraversalOptions,
  type TraversalResult,
} from './traversal.ts';

// ============================================================================
// Query Language
// ============================================================================

export {
  GraphQueryBuilder,
  executeQuery,
  findConnected,
  findPath,
  findByPattern,
  findRelated,
  getSubgraph,
} from './query.ts';
