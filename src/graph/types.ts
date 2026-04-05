/**
 * GraphStore Types
 *
 * Type definitions for graph-based memory and relationship tracking.
 * GraphStore extends Smallstore with graph operations for tracking
 * relationships between stored items.
 */

// ============================================================================
// Graph Node
// ============================================================================

/**
 * A node in the graph representing a stored item
 */
export interface GraphNode {
  /** Unique node identifier */
  id: string;

  /** Collection this node belongs to */
  collection: string;

  /** Full path within the collection */
  path: string;

  /** Node type (e.g., "document", "entity", "concept") */
  type: string;

  /** Optional metadata about the node */
  metadata?: Record<string, any>;

  /** ISO timestamp when node was created */
  created: string;

  /** ISO timestamp when node was last updated */
  updated: string;
}

/**
 * Input for creating a new node (without auto-generated fields)
 */
export type GraphNodeInput = Omit<GraphNode, 'id' | 'created' | 'updated'>;

// ============================================================================
// Graph Edge
// ============================================================================

/**
 * An edge representing a relationship between two nodes
 */
export interface GraphEdge {
  /** Unique edge identifier */
  id: string;

  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Relationship type */
  relationship: GraphRelationship | string;

  /** Relationship strength (0-1), default 1.0 */
  weight?: number;

  /** Optional metadata about the edge */
  metadata?: Record<string, any>;

  /** ISO timestamp when edge was created */
  created: string;
}

/**
 * Input for creating a new edge (without auto-generated fields)
 */
export type GraphEdgeInput = Omit<GraphEdge, 'id' | 'created'>;

/**
 * Built-in relationship types
 */
export type GraphRelationship =
  | 'references'      // Node A references Node B
  | 'parent_of'       // Node A is parent of Node B
  | 'child_of'        // Node A is child of Node B
  | 'related_to'      // Generic relationship
  | 'derived_from'    // Node A was derived from Node B
  | 'depends_on'      // Node A depends on Node B
  | 'contains'        // Node A contains Node B
  | 'similar_to'      // Node A is similar to Node B
  | 'links_to'        // Node A links to Node B
  | 'created_by'      // Node A was created by Node B
  | 'tagged_with';    // Node A is tagged with Node B

// ============================================================================
// Graph Query
// ============================================================================

/**
 * Query for traversing and filtering the graph
 */
export interface GraphQuery {
  /** Starting node ID(s) */
  start?: string | string[];

  /** Traversal patterns to follow */
  traverse?: TraversalPattern[];

  /** Filter nodes by metadata */
  filter?: Record<string, any>;

  /** Maximum traversal depth */
  depth?: number;

  /** Maximum number of results */
  limit?: number;

  /** Include paths in result */
  includePaths?: boolean;

  /** Minimum edge weight to follow */
  minWeight?: number;

  /** Node types to include */
  nodeTypes?: string[];

  /** Relationship types to include */
  relationshipTypes?: string[];
}

/**
 * Pattern for graph traversal
 */
export interface TraversalPattern {
  /** Relationship type to follow */
  relationship: string;

  /** Direction to traverse */
  direction: 'in' | 'out' | 'both';

  /** Minimum number of hops */
  minHops?: number;

  /** Maximum number of hops */
  maxHops?: number;

  /** Filter for nodes at this step */
  nodeFilter?: Record<string, any>;

  /** Minimum edge weight to follow */
  minWeight?: number;
}

// ============================================================================
// Graph Query Result
// ============================================================================

/**
 * Result of a graph query
 */
export interface GraphQueryResult {
  /** Matching nodes */
  nodes: GraphNode[];

  /** Edges connecting the nodes */
  edges: GraphEdge[];

  /** Paths from start to each result node (if includePaths was true) */
  paths?: GraphPath[];

  /** Query execution metadata */
  metadata?: GraphQueryMetadata;
}

/**
 * A path through the graph
 */
export interface GraphPath {
  /** Ordered list of nodes in the path */
  nodes: GraphNode[];

  /** Edges connecting the nodes */
  edges: GraphEdge[];

  /** Total path length (number of edges) */
  length: number;

  /** Total path weight (sum of edge weights) */
  totalWeight: number;
}

/**
 * Metadata about query execution
 */
export interface GraphQueryMetadata {
  /** Number of nodes scanned */
  nodesScanned: number;

  /** Number of edges scanned */
  edgesScanned: number;

  /** Execution time in milliseconds */
  executionTime: number;

  /** Whether results were truncated by limit */
  truncated: boolean;
}

// ============================================================================
// Graph Statistics
// ============================================================================

/**
 * Statistics about the graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Breakdown of nodes by type */
  nodesByType: Record<string, number>;

  /** Breakdown of edges by relationship */
  edgesByRelationship: Record<string, number>;

  /** Average number of edges per node */
  averageDegree: number;

  /** Node with most connections */
  mostConnected?: {
    node: GraphNode;
    degree: number;
  };
}

// ============================================================================
// Graph Store Options
// ============================================================================

/**
 * Options for GraphStore operations
 */
export interface GraphStoreOptions {
  /** Collection prefix for graph data (default: '_graph') */
  prefix?: string;

  /** Auto-create nodes when adding edges */
  autoCreateNodes?: boolean;

  /** Cascade delete edges when deleting nodes */
  cascadeDelete?: boolean;
}

/**
 * Options for batch operations
 */
export interface BatchOptions {
  /** Skip validation for performance */
  skipValidation?: boolean;

  /** Continue on error */
  continueOnError?: boolean;
}

/**
 * Result of a batch operation
 */
export interface BatchResult<T> {
  /** Successfully processed items */
  success: T[];

  /** Failed items with error messages */
  failed: Array<{
    item: any;
    error: string;
  }>;

  /** Total items processed */
  total: number;
}
