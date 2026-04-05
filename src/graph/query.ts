/**
 * Graph Query Language
 *
 * A fluent query builder for graph traversal and filtering.
 * Supports composable query construction and execution.
 */

import type {
  GraphNode,
  GraphEdge,
  GraphQuery,
  GraphQueryResult,
  GraphQueryMetadata,
  TraversalPattern,
  GraphPath,
} from './types.ts';
import { bfs, shortestPath, type TraversalContext, type TraversalOptions } from './traversal.ts';

// ============================================================================
// Query Builder
// ============================================================================

/**
 * Fluent query builder for graph queries
 *
 * @example
 * const result = await new GraphQueryBuilder()
 *   .from('node-123')
 *   .traverse('references', 'out')
 *   .traverse('related_to', 'both', { maxHops: 2 })
 *   .where({ type: 'document' })
 *   .limit(10)
 *   .execute(context);
 */
export class GraphQueryBuilder {
  private query: GraphQuery = {};

  /**
   * Set starting node(s)
   */
  from(start: string | string[]): this {
    this.query.start = start;
    return this;
  }

  /**
   * Add a traversal pattern
   */
  traverse(
    relationship: string,
    direction: 'in' | 'out' | 'both' = 'both',
    options: Partial<Omit<TraversalPattern, 'relationship' | 'direction'>> = {}
  ): this {
    if (!this.query.traverse) {
      this.query.traverse = [];
    }
    this.query.traverse.push({
      relationship,
      direction,
      ...options,
    });
    return this;
  }

  /**
   * Add metadata filter
   */
  where(filter: Record<string, any>): this {
    this.query.filter = { ...this.query.filter, ...filter };
    return this;
  }

  /**
   * Filter by node type(s)
   */
  ofType(types: string | string[]): this {
    this.query.nodeTypes = Array.isArray(types) ? types : [types];
    return this;
  }

  /**
   * Filter by relationship type(s)
   */
  withRelationship(relationships: string | string[]): this {
    this.query.relationshipTypes = Array.isArray(relationships)
      ? relationships
      : [relationships];
    return this;
  }

  /**
   * Set maximum traversal depth
   */
  depth(maxDepth: number): this {
    this.query.depth = maxDepth;
    return this;
  }

  /**
   * Set minimum edge weight to follow
   */
  minWeight(weight: number): this {
    this.query.minWeight = weight;
    return this;
  }

  /**
   * Limit number of results
   */
  limit(count: number): this {
    this.query.limit = count;
    return this;
  }

  /**
   * Include paths in result
   */
  includePaths(): this {
    this.query.includePaths = true;
    return this;
  }

  /**
   * Get the built query
   */
  build(): GraphQuery {
    return { ...this.query };
  }

  /**
   * Execute the query
   */
  async execute(context: TraversalContext): Promise<GraphQueryResult> {
    return executeQuery(this.build(), context);
  }
}

// ============================================================================
// Query Execution
// ============================================================================

/**
 * Execute a graph query
 *
 * @param query - The query to execute
 * @param context - Traversal context with graph access methods
 * @returns Query result
 */
export async function executeQuery(
  query: GraphQuery,
  context: TraversalContext
): Promise<GraphQueryResult> {
  const startTime = performance.now();
  let nodesScanned = 0;
  let edgesScanned = 0;

  // Default patterns if none specified
  const patterns = query.traverse ?? [{ relationship: '*', direction: 'both' as const }];

  // If no start specified, we can't traverse
  if (!query.start) {
    return {
      nodes: [],
      edges: [],
      metadata: {
        nodesScanned: 0,
        edgesScanned: 0,
        executionTime: performance.now() - startTime,
        truncated: false,
      },
    };
  }

  // Build traversal options
  const traversalOptions: TraversalOptions = {
    maxDepth: query.depth ?? 5,
    maxNodes: query.limit ? query.limit * 2 : 1000, // Over-fetch for filtering
    minWeight: query.minWeight ?? 0,
    nodeTypes: query.nodeTypes,
    relationshipTypes: query.relationshipTypes,
    trackPaths: query.includePaths ?? false,
  };

  // Add node filter if specified
  if (query.filter) {
    traversalOptions.nodeFilter = (node: GraphNode) => {
      return matchesFilter(node, query.filter!);
    };
  }

  // Execute BFS traversal
  const result = await bfs(query.start, context, patterns, traversalOptions);

  nodesScanned = result.stats.nodesVisited;
  edgesScanned = result.stats.edgesTraversed;

  // Apply limit if needed
  let nodes = result.nodes;
  let edges = result.edges;
  let truncated = false;

  if (query.limit && nodes.length > query.limit) {
    nodes = nodes.slice(0, query.limit);
    truncated = true;

    // Also filter edges to only include those between kept nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
  }

  // Build paths if requested
  let paths: GraphPath[] | undefined;
  if (query.includePaths && result.paths) {
    paths = [];
    for (const node of nodes) {
      const path = result.paths.get(node.id);
      if (path) {
        paths.push(path);
      }
    }
  }

  const executionTime = performance.now() - startTime;

  return {
    nodes,
    edges,
    paths,
    metadata: {
      nodesScanned,
      edgesScanned,
      executionTime,
      truncated,
    },
  };
}

// ============================================================================
// Specialized Queries
// ============================================================================

/**
 * Find all nodes connected to a starting node within N hops
 *
 * @param startId - Starting node ID
 * @param hops - Maximum number of hops
 * @param context - Traversal context
 * @returns Query result
 */
export async function findConnected(
  startId: string,
  hops: number,
  context: TraversalContext
): Promise<GraphQueryResult> {
  return new GraphQueryBuilder()
    .from(startId)
    .traverse('*', 'both')
    .depth(hops)
    .execute(context);
}

/**
 * Find path between two nodes
 *
 * @param fromId - Starting node ID
 * @param toId - Target node ID
 * @param context - Traversal context
 * @returns Path between nodes, or null if no path exists
 */
export async function findPath(
  fromId: string,
  toId: string,
  context: TraversalContext
): Promise<GraphPath | null> {
  return shortestPath(fromId, toId, context);
}

/**
 * Find nodes that match a pattern
 *
 * @param pattern - Pattern to match (type, metadata, etc.)
 * @param context - Traversal context with node iteration
 * @param getAllNodes - Function to get all nodes
 * @returns Matching nodes
 */
export async function findByPattern(
  pattern: {
    type?: string;
    collection?: string;
    metadata?: Record<string, any>;
  },
  getAllNodes: () => Promise<GraphNode[]>
): Promise<GraphNode[]> {
  const allNodes = await getAllNodes();

  return allNodes.filter(node => {
    if (pattern.type && node.type !== pattern.type) {
      return false;
    }

    if (pattern.collection && node.collection !== pattern.collection) {
      return false;
    }

    if (pattern.metadata) {
      if (!node.metadata) return false;
      for (const [key, value] of Object.entries(pattern.metadata)) {
        if (node.metadata[key] !== value) {
          return false;
        }
      }
    }

    return true;
  });
}

/**
 * Find nodes with specific relationship to a node
 *
 * @param nodeId - Node ID
 * @param relationship - Relationship type
 * @param direction - Relationship direction
 * @param context - Traversal context
 * @returns Related nodes
 */
export async function findRelated(
  nodeId: string,
  relationship: string,
  direction: 'in' | 'out' | 'both',
  context: TraversalContext
): Promise<GraphNode[]> {
  const result = await new GraphQueryBuilder()
    .from(nodeId)
    .traverse(relationship, direction)
    .depth(1)
    .execute(context);

  // Exclude the starting node
  return result.nodes.filter(n => n.id !== nodeId);
}

/**
 * Get subgraph containing specified nodes and edges between them
 *
 * @param nodeIds - Node IDs to include
 * @param context - Traversal context
 * @param getEdgesBetween - Function to get edges between nodes
 * @returns Subgraph
 */
export async function getSubgraph(
  nodeIds: string[],
  context: TraversalContext,
  getEdgesBetween: (sourceId: string, targetId: string) => Promise<GraphEdge[]>
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();

  // Get all specified nodes
  for (const id of nodeIds) {
    const node = await context.getNode(id);
    if (node) {
      nodes.push(node);
    }
  }

  // Get edges between all pairs
  const nodeIdSet = new Set(nodeIds);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const betweenEdges = await getEdgesBetween(nodes[i].id, nodes[j].id);
      for (const edge of betweenEdges) {
        if (!edgeIds.has(edge.id)) {
          edges.push(edge);
          edgeIds.add(edge.id);
        }
      }
    }
  }

  return { nodes, edges };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a node matches a metadata filter
 */
function matchesFilter(node: GraphNode, filter: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'type') {
      if (node.type !== value) return false;
    } else if (key === 'collection') {
      if (node.collection !== value) return false;
    } else if (key === 'path') {
      if (node.path !== value) return false;
    } else if (node.metadata) {
      // Check for operator-based filters
      if (typeof value === 'object' && value !== null) {
        if (!matchOperatorFilter(node.metadata[key], value)) {
          return false;
        }
      } else if (node.metadata[key] !== value) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Match operator-based filters (like MongoDB-style)
 */
function matchOperatorFilter(fieldValue: any, operators: Record<string, any>): boolean {
  for (const [op, value] of Object.entries(operators)) {
    switch (op) {
      case '$eq':
        if (fieldValue !== value) return false;
        break;
      case '$ne':
        if (fieldValue === value) return false;
        break;
      case '$gt':
        if (!(fieldValue > value)) return false;
        break;
      case '$gte':
        if (!(fieldValue >= value)) return false;
        break;
      case '$lt':
        if (!(fieldValue < value)) return false;
        break;
      case '$lte':
        if (!(fieldValue <= value)) return false;
        break;
      case '$in':
        if (!Array.isArray(value) || !value.includes(fieldValue)) return false;
        break;
      case '$nin':
        if (!Array.isArray(value) || value.includes(fieldValue)) return false;
        break;
      case '$contains':
        if (typeof fieldValue !== 'string' || !fieldValue.includes(value)) return false;
        break;
      case '$startsWith':
        if (typeof fieldValue !== 'string' || !fieldValue.startsWith(value)) return false;
        break;
      case '$endsWith':
        if (typeof fieldValue !== 'string' || !fieldValue.endsWith(value)) return false;
        break;
      case '$exists':
        if (value && fieldValue === undefined) return false;
        if (!value && fieldValue !== undefined) return false;
        break;
      default:
        // Unknown operator, treat as equality
        if (fieldValue !== value) return false;
    }
  }
  return true;
}

// ============================================================================
// Exports
// ============================================================================

export { matchesFilter, matchOperatorFilter };
