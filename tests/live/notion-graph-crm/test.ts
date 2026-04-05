#!/usr/bin/env -S deno run --allow-all
/**
 * Live Graph CRM Test (Notion)
 *
 * A personal CRM where contacts, companies, and introductions form a
 * relationship graph backed by Notion.
 *
 * Features: GraphStore + Notion adapter
 *
 * Prerequisites:
 * - Working Notion adapter (run `deno task live:notion` first)
 *
 * Run: deno task live:notion-graph-crm
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { createSmallstore, createNotionAdapter, createMemoryAdapter, createGraphStore } from '../../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SECRET = Deno.env.get('SM_NOTION_SECRET');
const DATABASE_ID = Deno.env.get('SM_NOTION_DATABASE_ID');

if (!SECRET || !DATABASE_ID || SECRET.startsWith('secret_XXX') || DATABASE_ID.startsWith('xxx')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Graph CRM Live Test — Setup Required                        ║
╚══════════════════════════════════════════════════════════════╝

Missing Notion credentials. Set in .env:
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_DATABASE_ID=your-database-id

Run again: deno task live:notion-graph-crm
`);
  Deno.exit(0);
}

// ============================================================================
// Helpers
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

// ============================================================================
// Test
// ============================================================================

async function main() {
  const testId = `test-${Date.now()}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Graph CRM — Notion Live Test                                ║
║  Database: ${DATABASE_ID!.slice(0, 8)}...${DATABASE_ID!.slice(-4)}${' '.repeat(37)}║
║  Test ID:  ${testId}${' '.repeat(Math.max(0, 46 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup ──────────────────────────────────────────────────
  const notionAdapter = createNotionAdapter({
    notionSecret: SECRET!,
    databaseId: DATABASE_ID!,
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
  });

  const store = createSmallstore({
    adapters: { notion: notionAdapter, memory: createMemoryAdapter() },
    defaultAdapter: 'notion',
    mounts: { '_graph/*': 'memory' },  // graph indexes stay in-memory
  });

  const graph = createGraphStore(store);

  // ── Step 1: Create people and company nodes ────────────────
  console.log('── Step 1: Create people and company nodes ──');

  const alice = await graph.addNode({ collection: 'crm', path: `people/alice-${testId}`, type: 'person', metadata: { role: 'engineer' } });
  log('👤', `Alice: ${alice.id}`);

  const bob = await graph.addNode({ collection: 'crm', path: `people/bob-${testId}`, type: 'person', metadata: { role: 'designer' } });
  log('👤', `Bob: ${bob.id}`);

  const carol = await graph.addNode({ collection: 'crm', path: `people/carol-${testId}`, type: 'person', metadata: { role: 'pm' } });
  log('👤', `Carol: ${carol.id}`);

  const dan = await graph.addNode({ collection: 'crm', path: `people/dan-${testId}`, type: 'person', metadata: { role: 'cto' } });
  log('👤', `Dan: ${dan.id}`);

  const eve = await graph.addNode({ collection: 'crm', path: `people/eve-${testId}`, type: 'person', metadata: { role: 'founder' } });
  log('👤', `Eve: ${eve.id}`);

  const acme = await graph.addNode({ collection: 'crm', path: `companies/acme-${testId}`, type: 'company', metadata: { industry: 'tech' } });
  log('🏢', `Acme Corp: ${acme.id}`);

  const globex = await graph.addNode({ collection: 'crm', path: `companies/globex-${testId}`, type: 'company', metadata: { industry: 'biotech' } });
  log('🏢', `Globex: ${globex.id}`);

  // ── Step 2: Add relationship edges ─────────────────────────
  console.log('\n── Step 2: Add relationship edges ──');

  await graph.addEdge({ source: alice.id, target: acme.id, relationship: 'works_at' });
  log('🔗', 'Alice → works_at → Acme');

  await graph.addEdge({ source: bob.id, target: acme.id, relationship: 'works_at' });
  log('🔗', 'Bob → works_at → Acme');

  await graph.addEdge({ source: carol.id, target: globex.id, relationship: 'works_at' });
  log('🔗', 'Carol → works_at → Globex');

  await graph.addEdge({ source: alice.id, target: bob.id, relationship: 'knows', weight: 0.9 });
  log('🔗', 'Alice ↔ knows ↔ Bob (weight: 0.9)');

  await graph.addEdge({ source: bob.id, target: carol.id, relationship: 'knows', weight: 0.7 });
  log('🔗', 'Bob ↔ knows ↔ Carol (weight: 0.7)');

  await graph.addEdge({ source: carol.id, target: dan.id, relationship: 'knows', weight: 0.8 });
  log('🔗', 'Carol ↔ knows ↔ Dan');

  await graph.addEdge({ source: dan.id, target: eve.id, relationship: 'introduced_by', metadata: { event: 'YC Demo Day' } });
  log('🔗', 'Dan → introduced_by → Eve (YC Demo Day)');

  await graph.addEdge({ source: eve.id, target: globex.id, relationship: 'founded' });
  log('🔗', 'Eve → founded → Globex');

  // ── Step 3: Traverse relationships ─────────────────────────
  console.log('\n── Step 3: Traverse — Who does Alice know? ──');

  const aliceKnows = await graph.getRelated(alice.id, 'knows');
  log('🔍', `Alice knows ${aliceKnows.length} people:`);
  for (const node of aliceKnows) {
    log('  ', `${node.path} (${node.type})`);
  }

  console.log('\n── Step 3b: Who works at Acme? ──');

  const acmeWorkers = await graph.getRelated(acme.id, 'works_at');
  log('🔍', `Acme has ${acmeWorkers.length} connections:`);
  for (const node of acmeWorkers) {
    log('  ', `${node.path} (${node.metadata?.role || 'unknown'})`);
  }

  // ── Step 4: Find path ──────────────────────────────────────
  console.log('\n── Step 4: Path finding — Alice → Dan ──');

  const path = await graph.findPath(alice.id, dan.id);
  if (path && path.nodes.length > 0) {
    log('🛤️', `Found path with ${path.nodes.length} nodes, ${path.edges.length} edges:`);
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i];
      const edge = i < path.edges.length ? path.edges[i] : null;
      log('  ', `${node.path}${edge ? ` --[${edge.relationship}]-->` : ''}`);
    }
  } else {
    log('⚠️', 'No path found between Alice and Dan');
  }

  // ── Step 5: Graph stats ────────────────────────────────────
  console.log('\n── Step 5: Graph statistics ──');

  const stats = await graph.getStats();
  log('📊', `Nodes: ${stats.nodeCount}`);
  log('📊', `Edges: ${stats.edgeCount}`);
  log('📊', `Relationships: ${Object.entries(stats.edgesByRelationship).map(([k, v]) => `${k}(${v})`).join(', ')}`);

  // ── Summary ────────────────────────────────────────────────
  console.log(`
── Done ──

  Nodes created: 7 (5 people + 2 companies)
  Edges created: ${stats.edgeCount}
  Relationships: ${Object.keys(stats.edgesByRelationship).join(', ')}
  Graph data stored in memory (_graph/* mount).
  CRM data stored in Notion.
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
