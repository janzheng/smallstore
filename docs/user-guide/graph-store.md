---
title: Graph Store
description: Relationship tracking and graph traversal on any backend.
---

# Graph Store

GraphStore adds graph operations on top of any Smallstore instance. Track nodes, edges, and relationships — like a mini Neo4j that runs on whatever backend you choose.

## Setup

```typescript
import { createSmallstore, createGraphStore } from '@smallstore/core';

const store = createSmallstore({ preset: 'local-sqlite' });
const graph = createGraphStore(store, { namespace: 'crm' });
```

The graph data is stored in your Smallstore instance under the given namespace. Switch from SQLite to Notion or Upstash without changing graph code.

## Adding Nodes

```typescript
const jan = await graph.addNode({
  type: 'person',
  data: { name: 'Jan Zheng', role: 'Engineer' },
});

const acme = await graph.addNode({
  type: 'company',
  data: { name: 'Acme Corp', industry: 'Tech' },
});

const project = await graph.addNode({
  type: 'project',
  data: { name: 'Smallstore', status: 'active' },
});
```

## Adding Edges

```typescript
await graph.addEdge({
  source: jan.id,
  target: acme.id,
  relationship: 'works_at',
  weight: 1.0,
  metadata: { since: '2024-01' },
});

await graph.addEdge({
  source: jan.id,
  target: project.id,
  relationship: 'maintains',
});

await graph.addEdge({
  source: acme.id,
  target: project.id,
  relationship: 'sponsors',
});
```

## Querying Relationships

```typescript
// Direct relationships
const colleagues = await graph.getRelated(jan.id, 'works_at');
const maintained = await graph.getRelated(jan.id, 'maintains');
```

## Graph Traversal

Use the query builder for multi-hop traversal:

```typescript
const result = await graph.query()
  .from(jan.id)
  .traverse('works_at', 'out')   // Jan → companies
  .traverse('sponsors', 'out')   // Companies → projects
  .depth(3)
  .includePaths()
  .execute();

console.log(result.nodes);  // All reachable nodes
console.log(result.paths);  // Paths taken
```

## Built-in Algorithms

```typescript
import { bfs, dfs, shortestPath } from '@smallstore/core';

// Breadth-first search
const reachable = await bfs(graph, jan.id, { maxDepth: 3 });

// Depth-first search
const deep = await dfs(graph, jan.id);

// Shortest path between two nodes
const path = await shortestPath(graph, jan.id, project.id);
```

## Use Cases

- **CRM** — People, companies, deals, relationships
- **Knowledge graph** — Documents referencing other documents
- **Dependency tracking** — Packages, modules, imports
- **Social graph** — Users, follows, interactions
- **Recommendations** — "Users who liked X also liked Y"
