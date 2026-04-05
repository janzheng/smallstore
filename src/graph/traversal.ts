/**
 * Graph Traversal Utilities
 *
 * BFS and DFS traversal algorithms for graph exploration.
 * These utilities power the graph query system.
 */

import type {
  GraphNode,
  GraphEdge,
  TraversalPattern,
  GraphPath,
} from './types.ts';

// ============================================================================
// Traversal Context
// ============================================================================

/**
 * Context for traversal operations
 */
export interface TraversalContext {
  /** Get a node by ID */
  getNode: (id: string) => Promise<GraphNode | null>;

  /** Get edges from a node */
  getOutgoing: (nodeId: string, relationship?: string) => Promise<GraphEdge[]>;

  /** Get edges to a node */
  getIncoming: (nodeId: string, relationship?: string) => Promise<GraphEdge[]>;
}

/**
 * Options for traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse */
  maxDepth?: number;

  /** Maximum nodes to visit */
  maxNodes?: number;

  /** Minimum edge weight to follow */
  minWeight?: number;

  /** Node types to include */
  nodeTypes?: string[];

  /** Relationship types to include */
  relationshipTypes?: string[];

  /** Track paths (memory intensive) */
  trackPaths?: boolean;

  /** Node filter function */
  nodeFilter?: (node: GraphNode) => boolean;

  /** Edge filter function */
  edgeFilter?: (edge: GraphEdge) => boolean;
}

/**
 * Result of a traversal
 */
export interface TraversalResult {
  /** Visited nodes in order */
  nodes: GraphNode[];

  /** Traversed edges */
  edges: GraphEdge[];

  /** Paths from start to each node (if trackPaths was true) */
  paths?: Map<string, GraphPath>;

  /** Statistics about the traversal */
  stats: {
    nodesVisited: number;
    edgesTraversed: number;
    maxDepthReached: number;
  };
}

// ============================================================================
// Breadth-First Search (BFS)
// ============================================================================

/**
 * Perform breadth-first traversal from starting node(s)
 *
 * @param startIds - Starting node ID(s)
 * @param context - Traversal context with graph access methods
 * @param patterns - Traversal patterns to follow
 * @param options - Traversal options
 * @returns Traversal result
 */
export async function bfs(
  startIds: string | string[],
  context: TraversalContext,
  patterns: TraversalPattern[] = [{ relationship: '*', direction: 'both' }],
  options: TraversalOptions = {}
): Promise<TraversalResult> {
  const {
    maxDepth = 10,
    maxNodes = 1000,
    minWeight = 0,
    nodeTypes,
    relationshipTypes,
    trackPaths = false,
    nodeFilter,
    edgeFilter,
  } = options;

  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>();
  const paths = new Map<string, GraphPath>();
  let maxDepthReached = 0;

  // Queue entries: [nodeId, depth, pathToNode]
  const queue: Array<[string, number, GraphPath | null]> = [];

  // Initialize queue with start nodes
  const ids = Array.isArray(startIds) ? startIds : [startIds];
  for (const id of ids) {
    const node = await context.getNode(id);
    if (node && shouldIncludeNode(node, nodeTypes, nodeFilter)) {
      queue.push([id, 0, trackPaths ? { nodes: [node], edges: [], length: 0, totalWeight: 0 } : null]);
      visited.add(id);
      nodes.push(node);
      if (trackPaths) {
        paths.set(id, { nodes: [node], edges: [], length: 0, totalWeight: 0 });
      }
    }
  }

  // BFS traversal
  while (queue.length > 0 && nodes.length < maxNodes) {
    const [currentId, depth, currentPath] = queue.shift()!;

    if (depth > maxDepthReached) {
      maxDepthReached = depth;
    }

    if (depth >= maxDepth) {
      continue;
    }

    // Get neighbors based on patterns
    const neighbors = await getNeighbors(
      currentId,
      context,
      patterns,
      relationshipTypes,
      minWeight,
      edgeFilter
    );

    for (const { node: neighbor, edge } of neighbors) {
      if (visited.has(neighbor.id)) {
        // Still add edge if not seen
        if (!edgeSet.has(edge.id)) {
          edges.push(edge);
          edgeSet.add(edge.id);
        }
        continue;
      }

      if (!shouldIncludeNode(neighbor, nodeTypes, nodeFilter)) {
        continue;
      }

      visited.add(neighbor.id);
      nodes.push(neighbor);

      if (!edgeSet.has(edge.id)) {
        edges.push(edge);
        edgeSet.add(edge.id);
      }

      // Build path
      let newPath: GraphPath | null = null;
      if (trackPaths && currentPath) {
        newPath = {
          nodes: [...currentPath.nodes, neighbor],
          edges: [...currentPath.edges, edge],
          length: currentPath.length + 1,
          totalWeight: currentPath.totalWeight + (typeof edge.weight === 'number' && isFinite(edge.weight) ? edge.weight : 1),
        };
        paths.set(neighbor.id, newPath);
      }

      queue.push([neighbor.id, depth + 1, newPath]);
    }
  }

  return {
    nodes,
    edges,
    paths: trackPaths ? paths : undefined,
    stats: {
      nodesVisited: visited.size,
      edgesTraversed: edges.length,
      maxDepthReached,
    },
  };
}

// ============================================================================
// Depth-First Search (DFS)
// ============================================================================

/**
 * Perform depth-first traversal from starting node(s)
 *
 * @param startIds - Starting node ID(s)
 * @param context - Traversal context with graph access methods
 * @param patterns - Traversal patterns to follow
 * @param options - Traversal options
 * @returns Traversal result
 */
export async function dfs(
  startIds: string | string[],
  context: TraversalContext,
  patterns: TraversalPattern[] = [{ relationship: '*', direction: 'both' }],
  options: TraversalOptions = {}
): Promise<TraversalResult> {
  const {
    maxDepth = 10,
    maxNodes = 1000,
    minWeight = 0,
    nodeTypes,
    relationshipTypes,
    trackPaths = false,
    nodeFilter,
    edgeFilter,
  } = options;

  // visited set bounded by maxNodes parameter (default 1000) — the while loop
  // condition `nodes.length < maxNodes` prevents unbounded growth
  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>();
  const paths = new Map<string, GraphPath>();
  let maxDepthReached = 0;

  // Stack entries: [nodeId, depth, pathToNode]
  const stack: Array<[string, number, GraphPath | null]> = [];

  // Initialize stack with start nodes (reversed for correct order)
  const ids = Array.isArray(startIds) ? startIds : [startIds];
  for (const id of ids.reverse()) {
    const node = await context.getNode(id);
    if (node && shouldIncludeNode(node, nodeTypes, nodeFilter)) {
      stack.push([id, 0, trackPaths ? { nodes: [node], edges: [], length: 0, totalWeight: 0 } : null]);
    }
  }

  // DFS traversal
  while (stack.length > 0 && nodes.length < maxNodes) {
    const [currentId, depth, currentPath] = stack.pop()!;

    if (visited.has(currentId)) {
      continue;
    }

    const node = await context.getNode(currentId);
    if (!node) {
      continue;
    }

    visited.add(currentId);
    nodes.push(node);

    if (trackPaths && currentPath) {
      paths.set(currentId, currentPath);
    }

    if (depth > maxDepthReached) {
      maxDepthReached = depth;
    }

    if (depth >= maxDepth) {
      continue;
    }

    // Get neighbors based on patterns
    const neighbors = await getNeighbors(
      currentId,
      context,
      patterns,
      relationshipTypes,
      minWeight,
      edgeFilter
    );

    // Add neighbors to stack (reversed for correct order)
    for (const { node: neighbor, edge } of neighbors.reverse()) {
      if (!edgeSet.has(edge.id)) {
        edges.push(edge);
        edgeSet.add(edge.id);
      }

      if (visited.has(neighbor.id)) {
        continue;
      }

      if (!shouldIncludeNode(neighbor, nodeTypes, nodeFilter)) {
        continue;
      }

      // Build path
      let newPath: GraphPath | null = null;
      if (trackPaths && currentPath) {
        newPath = {
          nodes: [...currentPath.nodes, neighbor],
          edges: [...currentPath.edges, edge],
          length: currentPath.length + 1,
          totalWeight: currentPath.totalWeight + (typeof edge.weight === 'number' && isFinite(edge.weight) ? edge.weight : 1),
        };
      }

      stack.push([neighbor.id, depth + 1, newPath]);
    }
  }

  return {
    nodes,
    edges,
    paths: trackPaths ? paths : undefined,
    stats: {
      nodesVisited: visited.size,
      edgesTraversed: edges.length,
      maxDepthReached,
    },
  };
}

// ============================================================================
// Shortest Path (Dijkstra)
// ============================================================================

/**
 * Find shortest path between two nodes using Dijkstra's algorithm
 *
 * @param startId - Starting node ID
 * @param endId - Target node ID
 * @param context - Traversal context
 * @param options - Traversal options
 * @returns Shortest path, or null if no path exists
 */
export async function shortestPath(
  startId: string,
  endId: string,
  context: TraversalContext,
  options: TraversalOptions = {}
): Promise<GraphPath | null> {
  const {
    maxDepth = 20,
    minWeight = 0,
    relationshipTypes,
    edgeFilter,
  } = options;

  // Distance and predecessor maps
  const distances = new Map<string, number>();
  const predecessors = new Map<string, { nodeId: string; edge: GraphEdge } | null>();
  const visited = new Set<string>();

  // Priority queue (simple array, sorted by distance)
  // Helper: insert into sorted queue using binary search
  function insertSorted(queue: Array<[string, number]>, item: [string, number]) {
    let lo = 0, hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (queue[mid][1] < item[1]) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, item);
  }

  const queue: Array<[string, number]> = [[startId, 0]];
  distances.set(startId, 0);
  predecessors.set(startId, null);

  while (queue.length > 0) {
    const [currentId, currentDist] = queue.shift()!;

    if (visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);

    // Found target
    if (currentId === endId) {
      return await reconstructPath(endId, predecessors, context);
    }

    // Check depth limit
    const currentDepth = await getPathLength(currentId, startId, predecessors);
    if (currentDepth >= maxDepth) {
      continue;
    }

    // Get neighbors
    const patterns: TraversalPattern[] = [{ relationship: '*', direction: 'both' }];
    const neighbors = await getNeighbors(
      currentId,
      context,
      patterns,
      relationshipTypes,
      minWeight,
      edgeFilter
    );

    for (const { node: neighbor, edge } of neighbors) {
      if (visited.has(neighbor.id)) {
        continue;
      }

      const edgeWeight = typeof edge.weight === 'number' && isFinite(edge.weight) ? edge.weight : 1;
      const newDist = currentDist + edgeWeight;

      const existingDist = distances.get(neighbor.id);
      if (existingDist === undefined || newDist < existingDist) {
        distances.set(neighbor.id, newDist);
        predecessors.set(neighbor.id, { nodeId: currentId, edge });
        insertSorted(queue, [neighbor.id, newDist]);
      }
    }
  }

  return null; // No path found
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get neighbors of a node based on traversal patterns
 */
async function getNeighbors(
  nodeId: string,
  context: TraversalContext,
  patterns: TraversalPattern[],
  relationshipTypes?: string[],
  minWeight: number = 0,
  edgeFilter?: (edge: GraphEdge) => boolean
): Promise<Array<{ node: GraphNode; edge: GraphEdge }>> {
  const neighbors: Array<{ node: GraphNode; edge: GraphEdge }> = [];
  const seenNodes = new Set<string>();

  for (const pattern of patterns) {
    // Determine which relationships to follow
    const relationshipFilter = pattern.relationship === '*'
      ? undefined
      : pattern.relationship;

    // Get edges based on direction
    let edges: GraphEdge[] = [];

    if (pattern.direction === 'out' || pattern.direction === 'both') {
      const outgoing = await context.getOutgoing(nodeId, relationshipFilter);
      edges.push(...outgoing);
    }

    if (pattern.direction === 'in' || pattern.direction === 'both') {
      const incoming = await context.getIncoming(nodeId, relationshipFilter);
      edges.push(...incoming);
    }

    // Filter and process edges
    for (const edge of edges) {
      // Apply relationship type filter
      if (relationshipTypes && !relationshipTypes.includes(edge.relationship)) {
        continue;
      }

      // Apply weight filter
      if (minWeight > 0 && (edge.weight ?? 1) < minWeight) {
        continue;
      }

      // Apply pattern weight filter
      if (pattern.minWeight !== undefined && (edge.weight ?? 1) < pattern.minWeight) {
        continue;
      }

      // Apply custom edge filter
      if (edgeFilter && !edgeFilter(edge)) {
        continue;
      }

      // Get the neighbor node
      const neighborId = edge.source === nodeId ? edge.target : edge.source;

      if (seenNodes.has(neighborId)) {
        continue;
      }

      const neighbor = await context.getNode(neighborId);
      if (neighbor) {
        // Apply pattern node filter
        if (pattern.nodeFilter) {
          if (!matchesFilter(neighbor, pattern.nodeFilter)) {
            continue;
          }
        }

        seenNodes.add(neighborId);
        neighbors.push({ node: neighbor, edge });
      }
    }
  }

  return neighbors;
}

/**
 * Check if a node should be included based on type and filter
 */
function shouldIncludeNode(
  node: GraphNode,
  nodeTypes?: string[],
  nodeFilter?: (node: GraphNode) => boolean
): boolean {
  if (nodeTypes && !nodeTypes.includes(node.type)) {
    return false;
  }

  if (nodeFilter && !nodeFilter(node)) {
    return false;
  }

  return true;
}

/**
 * Check if a node matches a metadata filter
 */
function matchesFilter(node: GraphNode, filter: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'type') {
      if (node.type !== value) return false;
    } else if (key === 'collection') {
      if (node.collection !== value) return false;
    } else if (node.metadata) {
      if (node.metadata[key] !== value) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Reconstruct path from predecessors map
 */
async function reconstructPath(
  endId: string,
  predecessors: Map<string, { nodeId: string; edge: GraphEdge } | null>,
  context: TraversalContext
): Promise<GraphPath> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let totalWeight = 0;

  let currentId: string | undefined = endId;

  while (currentId) {
    const node = await context.getNode(currentId);
    if (node) {
      nodes.unshift(node);
    }

    const pred = predecessors.get(currentId);
    if (pred) {
      edges.unshift(pred.edge);
      totalWeight += pred.edge.weight ?? 1;
      currentId = pred.nodeId;
    } else {
      break;
    }
  }

  return {
    nodes,
    edges,
    length: edges.length,
    totalWeight,
  };
}

/**
 * Get path length from start to current node
 */
async function getPathLength(
  currentId: string,
  startId: string,
  predecessors: Map<string, { nodeId: string; edge: GraphEdge } | null>
): Promise<number> {
  let length = 0;
  let id: string | undefined = currentId;

  while (id && id !== startId) {
    const pred = predecessors.get(id);
    if (pred) {
      length++;
      id = pred.nodeId;
    } else {
      break;
    }
  }

  return length;
}

// ============================================================================
// Exports
// ============================================================================

export {
  getNeighbors,
  shouldIncludeNode,
  matchesFilter,
};
