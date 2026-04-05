/**
 * GraphStore Tests
 *
 * Tests for the graph-based relationship tracking module.
 *
 * Run: deno test --allow-all tests/graph.test.ts
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createSmallstore, createMemoryAdapter } from '../mod.ts';
import { GraphStore, createGraphStore } from '../src/graph/mod.ts';
import type { GraphNode, GraphEdge } from '../src/graph/mod.ts';

// ============================================================================
// Test Setup
// ============================================================================

function createTestGraph(): GraphStore {
  const smallstore = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  return createGraphStore(smallstore);
}

// ============================================================================
// Node Tests
// ============================================================================

Deno.test("GraphStore - addNode creates node with generated fields", async () => {
  const graph = createTestGraph();

  const node = await graph.addNode({
    collection: 'documents',
    path: 'docs/intro.md',
    type: 'document',
    metadata: { title: 'Introduction' },
  });

  assertExists(node.id);
  assertEquals(node.collection, 'documents');
  assertEquals(node.path, 'docs/intro.md');
  assertEquals(node.type, 'document');
  assertEquals(node.metadata?.title, 'Introduction');
  assertExists(node.created);
  assertExists(node.updated);

  await graph.clear();
});

Deno.test("GraphStore - getNode retrieves existing node", async () => {
  const graph = createTestGraph();

  const created = await graph.addNode({
    collection: 'test',
    path: 'test/item',
    type: 'test',
  });

  const retrieved = await graph.getNode(created.id);
  assertExists(retrieved);
  assertEquals(retrieved!.id, created.id);
  assertEquals(retrieved!.collection, 'test');

  await graph.clear();
});

Deno.test("GraphStore - getNode returns null for non-existent node", async () => {
  const graph = createTestGraph();

  const result = await graph.getNode('non-existent-id');
  assertEquals(result, null);
});

Deno.test("GraphStore - updateNode updates node fields", async () => {
  const graph = createTestGraph();

  const node = await graph.addNode({
    collection: 'test',
    path: 'test/item',
    type: 'document',
    metadata: { version: 1 },
  });

  await graph.updateNode(node.id, {
    metadata: { version: 2, updated: true },
  });

  const updated = await graph.getNode(node.id);
  assertExists(updated);
  assertEquals(updated!.metadata?.version, 2);
  assertEquals(updated!.metadata?.updated, true);
  // Original fields should be preserved
  assertEquals(updated!.collection, 'test');
  assertEquals(updated!.created, node.created);

  await graph.clear();
});

Deno.test("GraphStore - removeNode deletes node", async () => {
  const graph = createTestGraph();

  const node = await graph.addNode({
    collection: 'test',
    path: 'test/item',
    type: 'test',
  });

  await graph.removeNode(node.id);
  const result = await graph.getNode(node.id);
  assertEquals(result, null);

  await graph.clear();
});

Deno.test("GraphStore - listNodes returns all nodes", async () => {
  const graph = createTestGraph();

  await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  await graph.addNode({ collection: 'test', path: 'c', type: 'note' });

  const all = await graph.listNodes();
  assertEquals(all.length, 3);

  const docs = await graph.listNodes({ type: 'doc' });
  assertEquals(docs.length, 2);

  await graph.clear();
});

Deno.test("GraphStore - addNodes batch creates multiple nodes", async () => {
  const graph = createTestGraph();

  const result = await graph.addNodes([
    { collection: 'test', path: 'a', type: 'doc' },
    { collection: 'test', path: 'b', type: 'doc' },
    { collection: 'test', path: 'c', type: 'doc' },
  ]);

  assertEquals(result.success.length, 3);
  assertEquals(result.failed.length, 0);
  assertEquals(result.total, 3);

  await graph.clear();
});

// ============================================================================
// Edge Tests
// ============================================================================

Deno.test("GraphStore - addEdge creates edge between nodes", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });

  const edge = await graph.addEdge({
    source: node1.id,
    target: node2.id,
    relationship: 'references',
    weight: 0.8,
    metadata: { context: 'See also' },
  });

  assertExists(edge.id);
  assertEquals(edge.source, node1.id);
  assertEquals(edge.target, node2.id);
  assertEquals(edge.relationship, 'references');
  assertEquals(edge.weight, 0.8);
  assertEquals(edge.metadata?.context, 'See also');
  assertExists(edge.created);

  await graph.clear();
});

Deno.test("GraphStore - addEdge throws for non-existent source", async () => {
  const graph = createTestGraph();

  const node = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });

  await assertRejects(
    async () => {
      await graph.addEdge({
        source: 'non-existent',
        target: node.id,
        relationship: 'references',
      });
    },
    Error,
    'Source node not found'
  );

  await graph.clear();
});

Deno.test("GraphStore - addEdge with autoCreateNodes creates missing nodes", async () => {
  const smallstore = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  const graph = createGraphStore(smallstore, { autoCreateNodes: true });

  const edge = await graph.addEdge({
    source: 'auto-source',
    target: 'auto-target',
    relationship: 'references',
  });

  assertExists(edge.id);

  const source = await graph.getNode('auto-source');
  assertExists(source);
  assertEquals(source!.type, 'auto');

  await graph.clear();
});

Deno.test("GraphStore - getEdge retrieves existing edge", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const created = await graph.addEdge({
    source: node1.id,
    target: node2.id,
    relationship: 'references',
  });

  const retrieved = await graph.getEdge(created.id);
  assertExists(retrieved);
  assertEquals(retrieved!.id, created.id);
  assertEquals(retrieved!.relationship, 'references');

  await graph.clear();
});

Deno.test("GraphStore - removeEdge deletes edge", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const edge = await graph.addEdge({
    source: node1.id,
    target: node2.id,
    relationship: 'references',
  });

  await graph.removeEdge(edge.id);
  const result = await graph.getEdge(edge.id);
  assertEquals(result, null);

  await graph.clear();
});

Deno.test("GraphStore - removeNode cascades to edges", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const edge = await graph.addEdge({
    source: node1.id,
    target: node2.id,
    relationship: 'references',
  });

  await graph.removeNode(node1.id);

  const edgeResult = await graph.getEdge(edge.id);
  assertEquals(edgeResult, null);

  await graph.clear();
});

// ============================================================================
// Traversal Tests
// ============================================================================

Deno.test("GraphStore - getRelated returns connected nodes", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const node3 = await graph.addNode({ collection: 'test', path: 'c', type: 'doc' });

  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });
  await graph.addEdge({ source: node3.id, target: node1.id, relationship: 'related_to' });

  const related = await graph.getRelated(node1.id);
  assertEquals(related.length, 2);

  const referencesOnly = await graph.getRelated(node1.id, 'references');
  assertEquals(referencesOnly.length, 1);
  assertEquals(referencesOnly[0].id, node2.id);

  await graph.clear();
});

Deno.test("GraphStore - getOutgoing returns outgoing edges", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const node3 = await graph.addNode({ collection: 'test', path: 'c', type: 'doc' });

  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });
  await graph.addEdge({ source: node1.id, target: node3.id, relationship: 'references' });
  await graph.addEdge({ source: node2.id, target: node1.id, relationship: 'references' });

  const outgoing = await graph.getOutgoing(node1.id);
  assertEquals(outgoing.length, 2);

  await graph.clear();
});

Deno.test("GraphStore - getIncoming returns incoming edges", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });

  await graph.addEdge({ source: node2.id, target: node1.id, relationship: 'references' });

  const incoming = await graph.getIncoming(node1.id);
  assertEquals(incoming.length, 1);
  assertEquals(incoming[0].source, node2.id);

  await graph.clear();
});

Deno.test("GraphStore - getEdgesBetween returns edges in both directions", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });

  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });
  await graph.addEdge({ source: node2.id, target: node1.id, relationship: 'related_to' });

  const edges = await graph.getEdgesBetween(node1.id, node2.id);
  assertEquals(edges.length, 2);

  await graph.clear();
});

// ============================================================================
// Query Tests
// ============================================================================

Deno.test("GraphStore - queryGraph performs BFS traversal", async () => {
  const graph = createTestGraph();

  // Create a chain: A -> B -> C -> D
  const nodeA = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const nodeB = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const nodeC = await graph.addNode({ collection: 'test', path: 'c', type: 'doc' });
  const nodeD = await graph.addNode({ collection: 'test', path: 'd', type: 'doc' });

  await graph.addEdge({ source: nodeA.id, target: nodeB.id, relationship: 'next' });
  await graph.addEdge({ source: nodeB.id, target: nodeC.id, relationship: 'next' });
  await graph.addEdge({ source: nodeC.id, target: nodeD.id, relationship: 'next' });

  // Query from A with depth 2
  const result = await graph.queryGraph({
    start: nodeA.id,
    traverse: [{ relationship: 'next', direction: 'out' }],
    depth: 2,
  });

  // Should find A, B, C (not D because depth=2)
  assertEquals(result.nodes.length, 3);
  assertExists(result.metadata);

  await graph.clear();
});

Deno.test("GraphStore - query builder creates valid queries", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });

  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });

  const result = await graph.query()
    .from(node1.id)
    .traverse('references', 'out')
    .depth(1)
    .execute();

  assertEquals(result.nodes.length, 2); // node1 and node2

  await graph.clear();
});

Deno.test("GraphStore - findPath finds shortest path", async () => {
  const graph = createTestGraph();

  // Create graph: A -> B -> C, A -> D -> C
  const nodeA = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const nodeB = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const nodeC = await graph.addNode({ collection: 'test', path: 'c', type: 'doc' });
  const nodeD = await graph.addNode({ collection: 'test', path: 'd', type: 'doc' });

  await graph.addEdge({ source: nodeA.id, target: nodeB.id, relationship: 'next', weight: 1 });
  await graph.addEdge({ source: nodeB.id, target: nodeC.id, relationship: 'next', weight: 1 });
  await graph.addEdge({ source: nodeA.id, target: nodeD.id, relationship: 'next', weight: 1 });
  await graph.addEdge({ source: nodeD.id, target: nodeC.id, relationship: 'next', weight: 1 });

  const path = await graph.findPath(nodeA.id, nodeC.id);
  assertExists(path);
  assertEquals(path!.length, 2); // Two edges: A->B->C or A->D->C
  assertEquals(path!.nodes.length, 3); // Three nodes

  await graph.clear();
});

Deno.test("GraphStore - findPath returns null for disconnected nodes", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });

  const path = await graph.findPath(node1.id, node2.id);
  assertEquals(path, null);

  await graph.clear();
});

Deno.test("GraphStore - findNodes filters by pattern", async () => {
  const graph = createTestGraph();

  await graph.addNode({ collection: 'docs', path: 'a', type: 'document', metadata: { lang: 'en' } });
  await graph.addNode({ collection: 'docs', path: 'b', type: 'document', metadata: { lang: 'es' } });
  await graph.addNode({ collection: 'notes', path: 'c', type: 'note', metadata: { lang: 'en' } });

  const docs = await graph.findNodes({ type: 'document' });
  assertEquals(docs.length, 2);

  const english = await graph.findNodes({ metadata: { lang: 'en' } });
  assertEquals(english.length, 2);

  const englishDocs = await graph.findNodes({ type: 'document', metadata: { lang: 'en' } });
  assertEquals(englishDocs.length, 1);

  await graph.clear();
});

// ============================================================================
// Statistics Tests
// ============================================================================

Deno.test("GraphStore - getStats returns correct statistics", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  const node3 = await graph.addNode({ collection: 'test', path: 'c', type: 'note' });

  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });
  await graph.addEdge({ source: node1.id, target: node3.id, relationship: 'related_to' });

  const stats = await graph.getStats();

  assertEquals(stats.nodeCount, 3);
  assertEquals(stats.edgeCount, 2);
  assertEquals(stats.nodesByType['doc'], 2);
  assertEquals(stats.nodesByType['note'], 1);
  assertEquals(stats.edgesByRelationship['references'], 1);
  assertEquals(stats.edgesByRelationship['related_to'], 1);
  assertExists(stats.mostConnected);
  assertEquals(stats.mostConnected!.node.id, node1.id);
  assertEquals(stats.mostConnected!.degree, 2);

  await graph.clear();
});

// ============================================================================
// Export/Import Tests
// ============================================================================

Deno.test("GraphStore - export returns all graph data", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });
  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });

  const exported = await graph.export();

  assertEquals(exported.nodes.length, 2);
  assertEquals(exported.edges.length, 1);

  await graph.clear();
});

Deno.test("GraphStore - import restores graph data", async () => {
  const graph1 = createTestGraph();

  const node1 = await graph1.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph1.addNode({ collection: 'test', path: 'b', type: 'doc' });
  await graph1.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });

  const exported = await graph1.export();

  // Import into fresh graph
  const graph2 = createTestGraph();
  await graph2.import(exported);

  const stats = await graph2.getStats();
  assertEquals(stats.nodeCount, 2);
  assertEquals(stats.edgeCount, 1);

  await graph1.clear();
  await graph2.clear();
});

Deno.test("GraphStore - import with clearExisting replaces data", async () => {
  const graph = createTestGraph();

  // Add initial data
  await graph.addNode({ collection: 'test', path: 'initial', type: 'doc' });

  // Import with clearExisting
  await graph.import({
    nodes: [
      { id: 'imported-1', collection: 'test', path: 'a', type: 'doc', created: '2024-01-01', updated: '2024-01-01' },
      { id: 'imported-2', collection: 'test', path: 'b', type: 'doc', created: '2024-01-01', updated: '2024-01-01' },
    ],
    edges: [],
  }, { clearExisting: true });

  const nodes = await graph.listNodes();
  assertEquals(nodes.length, 2);
  assertEquals(nodes[0].id.startsWith('imported'), true);

  await graph.clear();
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("GraphStore - handles empty graph operations", async () => {
  const graph = createTestGraph();

  const nodes = await graph.listNodes();
  assertEquals(nodes.length, 0);

  const edges = await graph.listEdges();
  assertEquals(edges.length, 0);

  const stats = await graph.getStats();
  assertEquals(stats.nodeCount, 0);
  assertEquals(stats.edgeCount, 0);
  assertEquals(stats.averageDegree, 0);

  const exported = await graph.export();
  assertEquals(exported.nodes.length, 0);
  assertEquals(exported.edges.length, 0);
});

Deno.test("GraphStore - handles self-referential edges", async () => {
  const graph = createTestGraph();

  const node = await graph.addNode({ collection: 'test', path: 'a', type: 'recursive' });
  const edge = await graph.addEdge({
    source: node.id,
    target: node.id,
    relationship: 'self_reference',
  });

  assertExists(edge);
  assertEquals(edge.source, node.id);
  assertEquals(edge.target, node.id);

  const related = await graph.getRelated(node.id);
  assertEquals(related.length, 1);
  assertEquals(related[0].id, node.id);

  await graph.clear();
});

Deno.test("GraphStore - handles multiple edges between same nodes", async () => {
  const graph = createTestGraph();

  const node1 = await graph.addNode({ collection: 'test', path: 'a', type: 'doc' });
  const node2 = await graph.addNode({ collection: 'test', path: 'b', type: 'doc' });

  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'references' });
  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'mentions' });
  await graph.addEdge({ source: node1.id, target: node2.id, relationship: 'cites' });

  const edges = await graph.getEdgesBetween(node1.id, node2.id);
  assertEquals(edges.length, 3);

  const outgoing = await graph.getOutgoing(node1.id);
  assertEquals(outgoing.length, 3);

  await graph.clear();
});

console.log('\n--- GraphStore Tests ---\n');
