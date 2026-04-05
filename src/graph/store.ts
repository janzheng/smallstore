/**
 * GraphStore - Graph-based relationship tracking for Smallstore
 *
 * GraphStore wraps a Smallstore instance to provide graph operations
 * for tracking relationships between stored items. It stores nodes
 * and edges in special collections (_graph/nodes, _graph/edges).
 *
 * @example
 * ```typescript
 * import { createSmallstore, createMemoryAdapter } from '../mod.ts';
 * import { GraphStore } from './store.ts';
 *
 * const smallstore = createSmallstore({
 *   adapters: { memory: createMemoryAdapter() },
 *   defaultAdapter: 'memory',
 * });
 *
 * const graph = new GraphStore(smallstore);
 *
 * // Add nodes
 * const doc1 = await graph.addNode({ collection: 'docs', path: 'doc1', type: 'document' });
 * const doc2 = await graph.addNode({ collection: 'docs', path: 'doc2', type: 'document' });
 *
 * // Add relationship
 * await graph.addEdge({ source: doc1.id, target: doc2.id, relationship: 'references' });
 *
 * // Query relationships
 * const related = await graph.getRelated(doc1.id, 'references');
 * ```
 */

import type { Smallstore } from '../types.ts';
import type {
  GraphNode,
  GraphNodeInput,
  GraphEdge,
  GraphEdgeInput,
  GraphQuery,
  GraphQueryResult,
  GraphStats,
  GraphStoreOptions,
  BatchOptions,
  BatchResult,
} from './types.ts';
import { bfs, type TraversalContext } from './traversal.ts';
import { GraphQueryBuilder, executeQuery, findPath, findByPattern } from './query.ts';
import type { TraversalPattern } from './types.ts';

// ============================================================================
// Bound Query Builder
// ============================================================================

/**
 * Query builder bound to a specific traversal context.
 * This allows calling execute() without passing the context.
 */
export class BoundQueryBuilder {
  private context: TraversalContext;
  private query: GraphQuery = {};

  constructor(context: TraversalContext) {
    this.context = context;
  }

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
   * Execute the query (no context needed - it's bound)
   */
  async execute(): Promise<GraphQueryResult> {
    return executeQuery(this.build(), this.context);
  }
}

// ============================================================================
// GraphStore Implementation
// ============================================================================

/**
 * GraphStore - Graph operations on top of Smallstore
 *
 * Stores graph data in two collections:
 * - _graph/nodes: Node data indexed by node ID
 * - _graph/edges: Edge data indexed by edge ID
 * - _graph/index/outgoing: Adjacency lists for outgoing edges
 * - _graph/index/incoming: Adjacency lists for incoming edges
 */
export class GraphStore {
  private smallstore: Smallstore;
  private prefix: string;
  private autoCreateNodes: boolean;
  private cascadeDelete: boolean;

  // Collection paths
  private get nodesCollection(): string {
    return `${this.prefix}/nodes`;
  }

  private get edgesCollection(): string {
    return `${this.prefix}/edges`;
  }

  private get outgoingIndexCollection(): string {
    return `${this.prefix}/index/outgoing`;
  }

  private get incomingIndexCollection(): string {
    return `${this.prefix}/index/incoming`;
  }

  /**
   * Create a new GraphStore
   *
   * @param smallstore - Smallstore instance to use for storage
   * @param options - GraphStore options
   */
  constructor(smallstore: Smallstore, options: GraphStoreOptions = {}) {
    this.smallstore = smallstore;
    this.prefix = options.prefix ?? '_graph';
    this.autoCreateNodes = options.autoCreateNodes ?? false;
    this.cascadeDelete = options.cascadeDelete ?? true;
  }

  // ============================================================================
  // Node Operations
  // ============================================================================

  /**
   * Add a new node to the graph
   *
   * @param input - Node data (without id, created, updated)
   * @returns Created node with generated fields
   */
  async addNode(input: GraphNodeInput): Promise<GraphNode> {
    const now = new Date().toISOString();
    const node: GraphNode = {
      id: this.generateId('node'),
      ...input,
      created: now,
      updated: now,
    };

    // Use overwrite mode to prevent array wrapping
    await this.smallstore.set(`${this.nodesCollection}/${node.id}`, node, { mode: 'overwrite' });

    return node;
  }

  /**
   * Add multiple nodes in batch
   *
   * @param inputs - Array of node inputs
   * @param options - Batch options
   * @returns Batch result with successes and failures
   */
  async addNodes(
    inputs: GraphNodeInput[],
    options: BatchOptions = {}
  ): Promise<BatchResult<GraphNode>> {
    const success: GraphNode[] = [];
    const failed: Array<{ item: any; error: string }> = [];

    for (const input of inputs) {
      try {
        const node = await this.addNode(input);
        success.push(node);
      } catch (error) {
        if (options.continueOnError) {
          failed.push({ item: input, error: String(error) });
        } else {
          throw error;
        }
      }
    }

    return { success, failed, total: inputs.length };
  }

  /**
   * Get a node by ID
   *
   * @param id - Node ID
   * @returns Node or null if not found
   */
  async getNode(id: string): Promise<GraphNode | null> {
    const response = await this.smallstore.get(`${this.nodesCollection}/${id}`);
    return this.extractContent(response);
  }

  /**
   * Get multiple nodes by IDs
   *
   * @param ids - Node IDs
   * @returns Map of ID to node (missing nodes not included)
   */
  async getNodes(ids: string[]): Promise<Map<string, GraphNode>> {
    const nodes = new Map<string, GraphNode>();

    for (const id of ids) {
      const node = await this.getNode(id);
      if (node) {
        nodes.set(id, node);
      }
    }

    return nodes;
  }

  /**
   * Update a node
   *
   * @param id - Node ID
   * @param updates - Fields to update
   */
  async updateNode(id: string, updates: Partial<GraphNodeInput>): Promise<void> {
    const node = await this.getNode(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    const updated: GraphNode = {
      ...node,
      ...updates,
      id: node.id, // Prevent ID change
      created: node.created, // Prevent created change
      updated: new Date().toISOString(),
    };

    await this.smallstore.set(`${this.nodesCollection}/${id}`, updated, { mode: 'overwrite' });
  }

  /**
   * Remove a node
   *
   * @param id - Node ID
   * @param options - Removal options
   */
  async removeNode(id: string): Promise<void> {
    const node = await this.getNode(id);
    if (!node) {
      return; // Node doesn't exist, nothing to do
    }

    // Cascade delete edges if enabled
    if (this.cascadeDelete) {
      const incoming = await this.getIncoming(id);
      const outgoing = await this.getOutgoing(id);

      for (const edge of [...incoming, ...outgoing]) {
        await this.removeEdge(edge.id);
      }

      // Re-check for any edges added concurrently during deletion
      const remainingIncoming = await this.getIncoming(id);
      const remainingOutgoing = await this.getOutgoing(id);
      const remainingEdges = [...remainingIncoming, ...remainingOutgoing];
      if (remainingEdges.length > 0) {
        for (const edge of remainingEdges) {
          await this.removeEdge(edge.id);
        }
      }
    }

    await this.smallstore.delete(`${this.nodesCollection}/${id}`);
  }

  /**
   * List all nodes
   *
   * @param filter - Optional filter criteria
   * @returns Array of nodes
   */
  async listNodes(filter?: { type?: string; collection?: string }): Promise<GraphNode[]> {
    // Keys returns relative paths like "nodes:node_xyz" from the _graph collection
    const keys = await this.smallstore.keys(this.prefix);
    const nodes: GraphNode[] = [];

    for (const key of keys) {
      // Only process node keys (starts with "nodes/")
      if (!key.startsWith('nodes/')) continue;

      // Extract the node ID from the key
      const nodeId = key.replace('nodes/', '');
      const response = await this.smallstore.get(`${this.nodesCollection}/${nodeId}`);
      const node = this.extractContent<GraphNode>(response);
      if (node) {
        // Apply filters
        if (filter?.type && node.type !== filter.type) continue;
        if (filter?.collection && node.collection !== filter.collection) continue;
        nodes.push(node);
      }
    }

    return nodes;
  }

  /**
   * Check if a node exists
   *
   * @param id - Node ID
   * @returns true if node exists
   */
  async hasNode(id: string): Promise<boolean> {
    return this.smallstore.has(`${this.nodesCollection}/${id}`);
  }

  // ============================================================================
  // Edge Operations
  // ============================================================================

  /**
   * Add an edge between two nodes
   *
   * @param input - Edge data (without id, created)
   * @returns Created edge with generated fields
   */
  async addEdge(input: GraphEdgeInput): Promise<GraphEdge> {
    // Validate source and target exist (or auto-create)
    const sourceExists = await this.hasNode(input.source);
    const targetExists = await this.hasNode(input.target);

    if (!sourceExists) {
      if (this.autoCreateNodes) {
        // Auto-create node with the provided ID
        await this.createNodeWithId(input.source, {
          collection: '_auto',
          path: input.source,
          type: 'auto',
        });
      } else {
        throw new Error(`Source node not found: ${input.source}`);
      }
    }

    if (!targetExists) {
      if (this.autoCreateNodes) {
        // Auto-create node with the provided ID
        await this.createNodeWithId(input.target, {
          collection: '_auto',
          path: input.target,
          type: 'auto',
        });
      } else {
        throw new Error(`Target node not found: ${input.target}`);
      }
    }

    const edge: GraphEdge = {
      id: this.generateId('edge'),
      ...input,
      weight: input.weight ?? 1.0,
      created: new Date().toISOString(),
    };

    // Store edge (use overwrite mode to prevent array wrapping)
    await this.smallstore.set(`${this.edgesCollection}/${edge.id}`, edge, { mode: 'overwrite' });

    // Update adjacency indexes
    await this.addToIndex(this.outgoingIndexCollection, input.source, edge.id);
    await this.addToIndex(this.incomingIndexCollection, input.target, edge.id);

    // Post-validation: verify nodes still exist after storing the edge
    // (a concurrent removeNode could have deleted them between validation and storage)
    const sourceStillExists = await this.hasNode(input.source);
    const targetStillExists = await this.hasNode(input.target);

    if (!sourceStillExists || !targetStillExists) {
      // Clean up the edge we just created
      await this.removeEdge(edge.id);
      const missing = !sourceStillExists ? input.source : input.target;
      throw new Error(`Node was deleted during edge creation: ${missing}`);
    }

    return edge;
  }

  /**
   * Add multiple edges in batch
   *
   * @param inputs - Array of edge inputs
   * @param options - Batch options
   * @returns Batch result
   */
  async addEdges(
    inputs: GraphEdgeInput[],
    options: BatchOptions = {}
  ): Promise<BatchResult<GraphEdge>> {
    const success: GraphEdge[] = [];
    const failed: Array<{ item: any; error: string }> = [];

    for (const input of inputs) {
      try {
        const edge = await this.addEdge(input);
        success.push(edge);
      } catch (error) {
        if (options.continueOnError) {
          failed.push({ item: input, error: String(error) });
        } else {
          throw error;
        }
      }
    }

    return { success, failed, total: inputs.length };
  }

  /**
   * Get an edge by ID
   *
   * @param id - Edge ID
   * @returns Edge or null if not found
   */
  async getEdge(id: string): Promise<GraphEdge | null> {
    const response = await this.smallstore.get(`${this.edgesCollection}/${id}`);
    return this.extractContent(response);
  }

  /**
   * Update an edge
   *
   * @param id - Edge ID
   * @param updates - Fields to update (cannot change source/target)
   */
  async updateEdge(
    id: string,
    updates: Partial<Omit<GraphEdgeInput, 'source' | 'target'>>
  ): Promise<void> {
    const edge = await this.getEdge(id);
    if (!edge) {
      throw new Error(`Edge not found: ${id}`);
    }

    const updated: GraphEdge = {
      ...edge,
      ...updates,
      id: edge.id, // Prevent ID change
      source: edge.source, // Prevent source change
      target: edge.target, // Prevent target change
      created: edge.created, // Prevent created change
    };

    await this.smallstore.set(`${this.edgesCollection}/${id}`, updated, { mode: 'overwrite' });
  }

  /**
   * Remove an edge
   *
   * @param id - Edge ID
   */
  async removeEdge(id: string): Promise<void> {
    const edge = await this.getEdge(id);
    if (!edge) {
      return; // Edge doesn't exist
    }

    // Remove from indexes
    await this.removeFromIndex(this.outgoingIndexCollection, edge.source, id);
    await this.removeFromIndex(this.incomingIndexCollection, edge.target, id);

    // Delete edge
    await this.smallstore.delete(`${this.edgesCollection}/${id}`);
  }

  /**
   * List all edges
   *
   * @param filter - Optional filter criteria
   * @returns Array of edges
   */
  async listEdges(filter?: { relationship?: string }): Promise<GraphEdge[]> {
    // Keys returns relative paths from the _graph collection
    const keys = await this.smallstore.keys(this.prefix);
    const edges: GraphEdge[] = [];

    for (const key of keys) {
      // Only process edge keys (starts with "edges/")
      if (!key.startsWith('edges/')) continue;

      // Extract the edge ID from the key
      const edgeId = key.replace('edges/', '');
      const response = await this.smallstore.get(`${this.edgesCollection}/${edgeId}`);
      const edge = this.extractContent<GraphEdge>(response);
      if (edge) {
        if (filter?.relationship && edge.relationship !== filter.relationship) continue;
        edges.push(edge);
      }
    }

    return edges;
  }

  // ============================================================================
  // Traversal Operations
  // ============================================================================

  /**
   * Get nodes related to a node
   *
   * @param nodeId - Starting node ID
   * @param relationship - Optional relationship filter
   * @returns Related nodes
   */
  async getRelated(nodeId: string, relationship?: string): Promise<GraphNode[]> {
    const outgoing = await this.getOutgoing(nodeId, relationship);
    const incoming = await this.getIncoming(nodeId, relationship);

    const nodeIds = new Set<string>();
    for (const edge of outgoing) {
      nodeIds.add(edge.target);
    }
    for (const edge of incoming) {
      nodeIds.add(edge.source);
    }

    const nodes: GraphNode[] = [];
    for (const id of nodeIds) {
      const node = await this.getNode(id);
      if (node) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  /**
   * Get incoming edges to a node
   *
   * @param nodeId - Target node ID
   * @param relationship - Optional relationship filter
   * @returns Incoming edges
   */
  async getIncoming(nodeId: string, relationship?: string): Promise<GraphEdge[]> {
    const edgeIds = await this.getFromIndex(this.incomingIndexCollection, nodeId);
    const edges: GraphEdge[] = [];

    for (const id of edgeIds) {
      const edge = await this.getEdge(id);
      if (edge) {
        if (relationship && edge.relationship !== relationship) continue;
        edges.push(edge);
      }
    }

    return edges;
  }

  /**
   * Get outgoing edges from a node
   *
   * @param nodeId - Source node ID
   * @param relationship - Optional relationship filter
   * @returns Outgoing edges
   */
  async getOutgoing(nodeId: string, relationship?: string): Promise<GraphEdge[]> {
    const edgeIds = await this.getFromIndex(this.outgoingIndexCollection, nodeId);
    const edges: GraphEdge[] = [];

    for (const id of edgeIds) {
      const edge = await this.getEdge(id);
      if (edge) {
        if (relationship && edge.relationship !== relationship) continue;
        edges.push(edge);
      }
    }

    return edges;
  }

  /**
   * Get edges between two nodes
   *
   * @param sourceId - Source node ID
   * @param targetId - Target node ID
   * @returns Edges between the nodes (both directions)
   */
  async getEdgesBetween(sourceId: string, targetId: string): Promise<GraphEdge[]> {
    const outgoing = await this.getOutgoing(sourceId);
    const incoming = await this.getIncoming(sourceId);

    const edges: GraphEdge[] = [];

    for (const edge of outgoing) {
      if (edge.target === targetId) {
        edges.push(edge);
      }
    }

    for (const edge of incoming) {
      if (edge.source === targetId) {
        edges.push(edge);
      }
    }

    return edges;
  }

  // ============================================================================
  // Query Operations
  // ============================================================================

  /**
   * Execute a graph query
   *
   * @param query - Graph query
   * @returns Query result
   */
  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    const context = this.createTraversalContext();
    return executeQuery(query, context);
  }

  /**
   * Create a query builder bound to this graph store
   *
   * @returns New query builder with bound execute method
   */
  query(): BoundQueryBuilder {
    const context = this.createTraversalContext();
    return new BoundQueryBuilder(context);
  }

  /**
   * Find shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @returns Path or null if no path exists
   */
  async findPath(fromId: string, toId: string) {
    const context = this.createTraversalContext();
    return findPath(fromId, toId, context);
  }

  /**
   * Find nodes matching a pattern
   *
   * @param pattern - Pattern to match
   * @returns Matching nodes
   */
  async findNodes(pattern: {
    type?: string;
    collection?: string;
    metadata?: Record<string, any>;
  }): Promise<GraphNode[]> {
    return findByPattern(pattern, () => this.listNodes());
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get graph statistics
   *
   * @returns Graph statistics
   */
  async getStats(): Promise<GraphStats> {
    const nodes = await this.listNodes();
    const edges = await this.listEdges();

    // Count by type
    const nodesByType: Record<string, number> = {};
    for (const node of nodes) {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    }

    // Count by relationship
    const edgesByRelationship: Record<string, number> = {};
    for (const edge of edges) {
      edgesByRelationship[edge.relationship] =
        (edgesByRelationship[edge.relationship] || 0) + 1;
    }

    // Calculate degree for each node
    const degrees = new Map<string, number>();
    for (const edge of edges) {
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    }

    // Find most connected
    let mostConnected: { node: GraphNode; degree: number } | undefined;
    let maxDegree = 0;
    for (const [nodeId, degree] of degrees) {
      if (degree > maxDegree) {
        maxDegree = degree;
        const node = nodes.find(n => n.id === nodeId);
        if (node) {
          mostConnected = { node, degree };
        }
      }
    }

    // Calculate average degree
    const totalDegree = edges.length * 2; // Each edge contributes to 2 nodes
    const averageDegree = nodes.length > 0 ? totalDegree / nodes.length : 0;

    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodesByType,
      edgesByRelationship,
      averageDegree,
      mostConnected,
    };
  }

  // ============================================================================
  // Utility Operations
  // ============================================================================

  /**
   * Clear all graph data
   */
  async clear(): Promise<void> {
    await this.smallstore.clear(this.nodesCollection);
    await this.smallstore.clear(this.edgesCollection);
    await this.smallstore.clear(this.outgoingIndexCollection);
    await this.smallstore.clear(this.incomingIndexCollection);
  }

  /**
   * Export graph as JSON
   *
   * @returns Graph data as JSON object
   */
  async export(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes = await this.listNodes();
    const edges = await this.listEdges();
    return { nodes, edges };
  }

  /**
   * Import graph from JSON
   *
   * @param data - Graph data to import
   * @param options - Import options
   */
  async import(
    data: { nodes: GraphNode[]; edges: GraphEdge[] },
    options: { clearExisting?: boolean } = {}
  ): Promise<void> {
    if (options.clearExisting) {
      await this.clear();
    }

    // Import nodes
    for (const node of data.nodes) {
      await this.smallstore.set(`${this.nodesCollection}/${node.id}`, node, { mode: 'overwrite' });
    }

    // Import edges (validate that source and target nodes exist)
    for (const edge of data.edges) {
      const sourceExists = await this.getNode(edge.source);
      const targetExists = await this.getNode(edge.target);
      if (!sourceExists || !targetExists) {
        console.warn(`[Graph] Skipping edge ${edge.id}: source=${edge.source} exists=${!!sourceExists}, target=${edge.target} exists=${!!targetExists}`);
        continue;
      }
      await this.smallstore.set(`${this.edgesCollection}/${edge.id}`, edge, { mode: 'overwrite' });
      await this.addToIndex(this.outgoingIndexCollection, edge.source, edge.id);
      await this.addToIndex(this.incomingIndexCollection, edge.target, edge.id);
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Generate a unique ID
   */
  private generateId(prefix: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${random}`;
  }

  /**
   * Create a node with a specific ID (used for auto-creation)
   */
  private async createNodeWithId(id: string, input: GraphNodeInput): Promise<GraphNode> {
    const now = new Date().toISOString();
    const node: GraphNode = {
      id,
      ...input,
      created: now,
      updated: now,
    };

    await this.smallstore.set(`${this.nodesCollection}/${node.id}`, node, { mode: 'overwrite' });
    return node;
  }

  /**
   * Create a traversal context for query operations
   */
  private createTraversalContext(): TraversalContext {
    return {
      getNode: (id: string) => this.getNode(id),
      getOutgoing: (nodeId: string, relationship?: string) =>
        this.getOutgoing(nodeId, relationship),
      getIncoming: (nodeId: string, relationship?: string) =>
        this.getIncoming(nodeId, relationship),
    };
  }

  /**
   * Add an edge ID to an adjacency index
   */
  private async addToIndex(
    collection: string,
    nodeId: string,
    edgeId: string
  ): Promise<void> {
    const key = `${collection}/${nodeId}`;
    const response = await this.smallstore.get(key);
    const content = this.extractContent(response);
    const existing: string[] = Array.isArray(content) ? content : [];
    if (!existing.includes(edgeId)) {
      existing.push(edgeId);
      await this.smallstore.set(key, existing, { mode: 'overwrite' });
    }
  }

  /**
   * Remove an edge ID from an adjacency index
   */
  private async removeFromIndex(
    collection: string,
    nodeId: string,
    edgeId: string
  ): Promise<void> {
    const key = `${collection}/${nodeId}`;
    const response = await this.smallstore.get(key);
    const content = this.extractContent(response);
    const existing: string[] = Array.isArray(content) ? content : [];
    const filtered = existing.filter((id: string) => id !== edgeId);
    if (filtered.length > 0) {
      await this.smallstore.set(key, filtered, { mode: 'overwrite' });
    } else {
      await this.smallstore.delete(key);
    }
  }

  /**
   * Get edge IDs from an adjacency index
   */
  private async getFromIndex(collection: string, nodeId: string): Promise<string[]> {
    const key = `${collection}/${nodeId}`;
    const response = await this.smallstore.get(key);
    const content = this.extractContent(response);
    return Array.isArray(content) ? content : [];
  }

  /**
   * Extract content from a Smallstore response
   *
   * Smallstore wraps responses in a StorageFileResponse object.
   * This helper extracts the actual content.
   */
  private extractContent<T>(response: any): T | null {
    if (response === null || response === undefined) {
      return null;
    }

    // If response has a 'content' property, extract it (wrapped response)
    if (typeof response === 'object' && 'content' in response) {
      const content = response.content;
      if (content === null || content === undefined) return null;
      return content as T;
    }

    // Otherwise return as-is (raw data)
    return response as T;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new GraphStore instance
 *
 * @param smallstore - Smallstore instance
 * @param options - GraphStore options
 * @returns GraphStore instance
 */
export function createGraphStore(
  smallstore: Smallstore,
  options?: GraphStoreOptions
): GraphStore {
  return new GraphStore(smallstore, options);
}
