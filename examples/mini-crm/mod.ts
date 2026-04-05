#!/usr/bin/env -S deno run --allow-all
/**
 * Mini CRM — Example App
 *
 * Contact/deal tracker with relationship graph and interaction memory.
 * Exercises graph store, episodic memory, structured queries, and
 * collections listing.
 *
 * Data persists in ./data/ between runs. Use --clean to reset.
 *
 * Run:
 *   deno task crm           # run tests (data persists)
 *   deno task crm --clean   # wipe data and re-run
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createSQLiteAdapter,
} from '../../mod.ts';
import { createGraphStore } from '../../src/graph/mod.ts';
import { createEpisodicStore } from '../../src/episodic/mod.ts';

// ============================================================================
// Config — data lives in this folder
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const DB_PATH = join(DATA_DIR, 'store.db');

// Handle --clean flag
if (Deno.args.includes('--clean')) {
  try { await Deno.remove(DATA_DIR, { recursive: true }); } catch { /* ok */ }
  console.log('Cleaned data directory.\n');
}

// Ensure data dir exists
await Deno.mkdir(DATA_DIR, { recursive: true });

// ============================================================================
// Helpers
// ============================================================================

let checkCount = 0;

function ok(label: string) {
  checkCount++;
  console.log(`  \u2713 ${label}`);
}

function section(label: string) {
  console.log(`\n\u2500\u2500 ${label} ${'\u2500'.repeat(60 - label.length)}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function unwrap(result: any): any {
  if (result === null || result === undefined) return null;
  if (result.content !== undefined) {
    const c = result.content;
    if (Array.isArray(c) && c.length === 1) return c[0];
    return c;
  }
  return result;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// ============================================================================
// Seed Data
// ============================================================================

const CONTACTS = [
  { name: 'Alice Smith', email: 'alice@acme.com', company: 'Acme Corp', role: 'CTO', tags: 'investor,warm-lead' },
  { name: 'Bob Johnson', email: 'bob@widgets.io', company: 'Widgets Inc', role: 'CEO', tags: 'partner,active' },
  { name: 'Carol Davis', email: 'carol@acme.com', company: 'Acme Corp', role: 'VP Engineering', tags: 'technical,warm-lead' },
  { name: 'Dave Wilson', email: 'dave@startup.co', company: 'StartupCo', role: 'Founder', tags: 'investor,cold-lead' },
  { name: 'Eve Brown', email: 'eve@widgets.io', company: 'Widgets Inc', role: 'CTO', tags: 'technical,active' },
];

const COMPANIES = [
  { name: 'Acme Corp', industry: 'Technology', size: 'enterprise', location: 'San Francisco' },
  { name: 'Widgets Inc', industry: 'SaaS', size: 'mid-market', location: 'New York' },
  { name: 'StartupCo', industry: 'AI', size: 'startup', location: 'Austin' },
];

const DEALS = [
  { name: 'Series A \u2014 Acme Corp', stage: 'negotiation', value: 500000, company: 'Acme Corp' },
  { name: 'Partnership \u2014 Widgets', stage: 'proposal', value: 120000, company: 'Widgets Inc' },
  { name: 'Seed Round \u2014 StartupCo', stage: 'discovery', value: 50000, company: 'StartupCo' },
];

const INTERACTIONS = [
  { contact: 'Alice Smith', type: 'meeting', notes: 'Discussed Series A terms, interested in leading', sentiment: 'positive' },
  { contact: 'Bob Johnson', type: 'email', notes: 'Sent partnership proposal, awaiting response', sentiment: 'neutral' },
  { contact: 'Carol Davis', type: 'call', notes: 'Technical deep dive on our architecture, very impressed', sentiment: 'positive' },
  { contact: 'Alice Smith', type: 'meeting', notes: 'Follow-up on term sheet, legal review in progress', sentiment: 'positive' },
  { contact: 'Dave Wilson', type: 'email', notes: 'Initial outreach about seed round, no response yet', sentiment: 'neutral' },
];

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  Mini CRM \u2014 Smallstore Example App                        \u2551');
  console.log(`\u2551  Data: ${DATA_DIR}`);
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  // SQLite for search + query (data persists), memory for metadata + graph + episodic
  const store = createSmallstore({
    adapters: {
      sqlite: createSQLiteAdapter({ path: DB_PATH }),
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'sqlite',
  });
  const memStore = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  const graph = createGraphStore(memStore);
  const episodic = createEpisodicStore(memStore);

  try {
    // ──────────────────────────────────────────────────────────────
    // 1. CRUD + Patch
    // ──────────────────────────────────────────────────────────────
    section('1. Core CRUD');

    for (const c of CONTACTS) {
      await store.set(`crm/contacts/${slugify(c.name)}`, c, { mode: 'replace' });
    }
    ok(`set: stored ${CONTACTS.length} contacts`);

    for (const co of COMPANIES) {
      await store.set(`crm/companies/${slugify(co.name)}`, co, { mode: 'replace' });
    }
    ok(`set: stored ${COMPANIES.length} companies`);

    for (const d of DEALS) {
      await store.set(`crm/deals/${slugify(d.name)}`, d, { mode: 'replace' });
    }
    ok(`set: stored ${DEALS.length} deals`);

    // Get a contact
    const aliceRaw = await store.get('crm/contacts/alice-smith');
    const alice = unwrap(aliceRaw);
    assert(alice !== null && alice.name === 'Alice Smith', 'get should return Alice');
    ok(`get: retrieved "${alice.name}"`);

    // Patch a deal stage
    await store.patch('crm/deals/series-a-acme-corp', { stage: 'closed-won', closedDate: '2024-06-01' });
    const dealRaw = await store.get('crm/deals/series-a-acme-corp');
    const deal = unwrap(dealRaw);
    assert(deal.stage === 'closed-won', 'patch should update deal stage');
    ok('patch: updated deal stage to closed-won');

    // Delete a contact
    await store.delete('crm/contacts/dave-wilson');
    const daveExists = await store.has('crm/contacts/dave-wilson');
    assert(daveExists === false, 'delete should remove Dave');
    ok('delete: removed Dave Wilson');

    // Re-add for subsequent tests
    await store.set('crm/contacts/dave-wilson', CONTACTS[3], { mode: 'replace' });

    // ──────────────────────────────────────────────────────────────
    // 2. Full-Text Search
    // ──────────────────────────────────────────────────────────────
    section('2. Full-Text Search');

    const nameSearch = await store.search('crm/contacts', {
      type: 'bm25', query: 'Alice',
    });
    assert(nameSearch.length > 0, 'search should find Alice');
    ok(`search "Alice" in contacts: ${nameSearch.length} result(s)`);

    const companySearch = await store.search('crm', {
      type: 'bm25', query: 'Widgets',
    });
    ok(`search "Widgets" across all CRM: ${companySearch.length} result(s)`);

    // ──────────────────────────────────────────────────────────────
    // 3. Structured Query
    // ──────────────────────────────────────────────────────────────
    section('3. Structured Query');

    const warmLeads = await store.query('crm/contacts', {
      filter: { tags: { $contains: 'warm-lead' } },
    });
    assert(warmLeads.data.length > 0, 'query should find warm leads');
    ok(`query tags contains "warm-lead": ${warmLeads.data.length} contact(s)`);

    const acmeDeals = await store.query('crm/deals', {
      filter: { company: { $eq: 'Acme Corp' } },
    });
    ok(`query company=Acme Corp: ${acmeDeals.data.length} deal(s)`);

    // ──────────────────────────────────────────────────────────────
    // 4. Collections Listing
    // ──────────────────────────────────────────────────────────────
    section('4. Collections');

    const allCols = await store.listCollections();
    assert(allCols.length > 0, 'should have collections');
    ok(`listCollections: [${allCols.join(', ')}]`);

    // ──────────────────────────────────────────────────────────────
    // 5. Graph Store (Relationship Tracking)
    // ──────────────────────────────────────────────────────────────
    section('5. Graph Store');

    // Add nodes
    const contactNodes: Record<string, any> = {};
    for (const c of CONTACTS) {
      contactNodes[c.name] = await graph.addNode({
        collection: 'crm', path: `contacts/${slugify(c.name)}`,
        type: 'contact', metadata: { name: c.name, email: c.email },
      });
    }
    ok(`addNode: ${Object.keys(contactNodes).length} contact nodes`);

    const companyNodes: Record<string, any> = {};
    for (const co of COMPANIES) {
      companyNodes[co.name] = await graph.addNode({
        collection: 'crm', path: `companies/${slugify(co.name)}`,
        type: 'company', metadata: { name: co.name, industry: co.industry },
      });
    }
    ok(`addNode: ${Object.keys(companyNodes).length} company nodes`);

    const dealNodes: Record<string, any> = {};
    for (const d of DEALS) {
      dealNodes[d.name] = await graph.addNode({
        collection: 'crm', path: `deals/${slugify(d.name)}`,
        type: 'deal', metadata: { name: d.name, value: d.value },
      });
    }
    ok(`addNode: ${Object.keys(dealNodes).length} deal nodes`);

    // Add edges: contact \u2192 company (works_at)
    for (const c of CONTACTS) {
      if (companyNodes[c.company]) {
        await graph.addEdge({
          source: contactNodes[c.name].id,
          target: companyNodes[c.company].id,
          relationship: 'related_to',
          weight: 1.0,
          metadata: { label: 'works_at' },
        });
      }
    }
    ok('addEdge: contact \u2192 company relationships');

    // Add edges: deal \u2192 company
    for (const d of DEALS) {
      if (companyNodes[d.company]) {
        await graph.addEdge({
          source: dealNodes[d.name].id,
          target: companyNodes[d.company].id,
          relationship: 'related_to',
          weight: 0.9,
          metadata: { label: 'deal_with' },
        });
      }
    }
    ok('addEdge: deal \u2192 company relationships');

    // getRelated: who works at Acme Corp?
    const acmeRelated = await graph.getRelated(companyNodes['Acme Corp'].id, 'related_to');
    assert(acmeRelated.length > 0, 'getRelated should find Acme relationships');
    ok(`getRelated (Acme Corp): ${acmeRelated.length} related node(s)`);

    // listNodes / listEdges
    const allNodes = await graph.listNodes();
    const allEdges = await graph.listEdges();
    ok(`listNodes: ${allNodes.length}, listEdges: ${allEdges.length}`);

    // findPath: from Alice \u2192 Acme Corp
    const path = await graph.findPath(
      contactNodes['Alice Smith'].id,
      companyNodes['Acme Corp'].id,
    );
    assert(path !== null, 'findPath should find Alice \u2192 Acme path');
    ok(`findPath (Alice \u2192 Acme): ${path!.length} hop(s)`);

    // Graph query builder
    const queryResult = await graph.query()
      .from(contactNodes['Alice Smith'].id)
      .traverse('related_to', 'out')
      .depth(2)
      .execute();
    assert(queryResult.nodes.length > 0, 'query builder should return nodes');
    ok(`query builder (from Alice, depth 2): ${queryResult.nodes.length} node(s), ${queryResult.edges.length} edge(s)`);

    // Export graph
    const exported = await graph.export();
    assert(exported.nodes.length > 0, 'export should have nodes');
    assert(exported.edges.length > 0, 'export should have edges');
    ok(`export: ${exported.nodes.length} nodes, ${exported.edges.length} edges`);

    // Import graph (into a fresh graph store)
    const memStore2 = createSmallstore({
      adapters: { memory: createMemoryAdapter() },
      defaultAdapter: 'memory',
    });
    const graph2 = createGraphStore(memStore2);
    await graph2.import(exported);
    const imported = await graph2.listNodes();
    assert(imported.length === exported.nodes.length, 'import should restore all nodes');
    ok(`import: restored ${imported.length} nodes`);

    // ──────────────────────────────────────────────────────────────
    // 6. Episodic Memory (Interaction History)
    // ──────────────────────────────────────────────────────────────
    section('6. Episodic Memory');

    for (let i = 0; i < INTERACTIONS.length; i++) {
      const interaction = INTERACTIONS[i];
      await episodic.remember(
        { contact: interaction.contact, type: interaction.type, notes: interaction.notes },
        {
          source: 'crm',
          tags: [interaction.sentiment, interaction.type, slugify(interaction.contact)],
          importance: interaction.sentiment === 'positive' ? 0.8 : 0.5,
        },
      );
      await new Promise(r => setTimeout(r, 10));
    }
    ok(`remember: stored ${INTERACTIONS.length} interactions`);

    const recent = await episodic.recall({ limit: 3 });
    assert(recent.length > 0, 'recall should return recent memories');
    ok(`recall (recent): ${recent.length} interaction(s)`);

    const positive = await episodic.recall({ tags: ['positive'], limit: 10 });
    assert(positive.length > 0, 'recall should find positive interactions');
    ok(`recall (positive): ${positive.length} interaction(s)`);

    const timeline = await episodic.getTimeline({ limit: 10 });
    assert(timeline.length > 0, 'getTimeline should return entries');
    ok(`getTimeline: ${timeline.length} entries (chronological)`);

    // ──────────────────────────────────────────────────────────────
    // 7. Edge Cases
    // ──────────────────────────────────────────────────────────────
    section('7. Edge Cases');

    // --- Graph: self-loop ---
    const selfNode = await graph.addNode({
      collection: 'test', path: 'self',
      type: 'test', metadata: { name: 'SelfRef' },
    });
    await graph.addEdge({
      source: selfNode.id,
      target: selfNode.id,
      relationship: 'related_to',
      weight: 1.0,
      metadata: { label: 'self_loop' },
    });
    const selfRelated = await graph.getRelated(selfNode.id, 'related_to');
    assert(selfRelated.length >= 1, 'self-loop should appear in getRelated');
    ok('graph: self-loop edge works');

    // --- Graph: duplicate edges ---
    await graph.addEdge({
      source: contactNodes['Alice Smith'].id,
      target: companyNodes['Acme Corp'].id,
      relationship: 'related_to',
      weight: 0.5,
      metadata: { label: 'duplicate_test' },
    });
    const dupeRelated = await graph.getRelated(companyNodes['Acme Corp'].id, 'related_to');
    ok(`graph: duplicate edge \u2014 ${dupeRelated.length} related to Acme`);

    // --- Graph: remove non-existent node ---
    try {
      await graph.removeNode('nonexistent-node-id-12345');
      ok('graph: removeNode non-existent \u2014 no error');
    } catch (e: any) {
      ok(`graph: removeNode non-existent \u2014 threw: ${e.message.slice(0, 50)}`);
    }

    // --- Graph: remove non-existent edge ---
    try {
      await graph.removeEdge('nonexistent-edge-id-12345');
      ok('graph: removeEdge non-existent \u2014 no error');
    } catch (e: any) {
      ok(`graph: removeEdge non-existent \u2014 threw: ${e.message.slice(0, 50)}`);
    }

    // --- Graph: findPath \u2014 no path exists ---
    const isolatedNode = await graph.addNode({
      collection: 'test', path: 'isolated',
      type: 'test', metadata: { name: 'Isolated' },
    });
    const noPath = await graph.findPath(
      isolatedNode.id,
      companyNodes['Acme Corp'].id,
    );
    assert(noPath === null || noPath.length === 0, 'findPath should return null/empty for disconnected nodes');
    ok('graph: findPath \u2014 disconnected nodes returns null/empty');

    // --- Graph: query builder with depth 0 ---
    const depth0 = await graph.query()
      .from(contactNodes['Alice Smith'].id)
      .traverse('related_to', 'out')
      .depth(0)
      .execute();
    ok(`graph: query depth 0 \u2014 ${depth0.nodes.length} node(s)`);

    // --- Graph: export empty graph ---
    const emptyMemStore = createSmallstore({
      adapters: { memory: createMemoryAdapter() },
      defaultAdapter: 'memory',
    });
    const emptyGraph = createGraphStore(emptyMemStore);
    const emptyExport = await emptyGraph.export();
    assert(emptyExport.nodes.length === 0, 'empty graph export should have 0 nodes');
    assert(emptyExport.edges.length === 0, 'empty graph export should have 0 edges');
    ok('graph: export empty graph \u2014 0 nodes, 0 edges');

    // --- Graph: import into non-empty graph ---
    const preImportCount = (await graph.listNodes()).length;
    await graph.import(emptyExport);
    const postImportCount = (await graph.listNodes()).length;
    ok(`graph: import empty into populated \u2014 before: ${preImportCount}, after: ${postImportCount}`);

    // --- Episodic: recall with no memories (empty store) ---
    const freshMemStore = createSmallstore({
      adapters: { memory: createMemoryAdapter() },
      defaultAdapter: 'memory',
    });
    const freshEpisodic = createEpisodicStore(freshMemStore);
    const emptyRecall = await freshEpisodic.recall({ limit: 5 });
    assert(emptyRecall.length === 0, 'recall on empty store should return 0');
    ok('episodic: recall empty store \u2014 0 results');

    // --- Episodic: timeline with no memories ---
    const emptyTimeline = await freshEpisodic.getTimeline({ limit: 5 });
    assert(emptyTimeline.length === 0, 'timeline on empty store should return 0');
    ok('episodic: empty timeline \u2014 0 entries');

    // --- Episodic: remember with high importance ---
    await episodic.remember(
      { contact: 'VIP Contact', type: 'escalation', notes: 'Critical deal about to close' },
      { source: 'crm', tags: ['critical', 'urgent'], importance: 1.0 },
    );
    const critical = await episodic.recall({ tags: ['critical'], limit: 1 });
    assert(critical.length > 0, 'should recall critical memory');
    ok('episodic: high importance recall works');

    // --- Episodic: remember with zero importance ---
    await episodic.remember(
      { contact: 'Low Priority', type: 'note', notes: 'Background context' },
      { source: 'crm', tags: ['low-priority'], importance: 0.0 },
    );
    const lowPriority = await episodic.recall({ tags: ['low-priority'], limit: 1 });
    ok(`episodic: zero importance \u2014 ${lowPriority.length} recalled`);

    // --- Episodic: many memories (stress test) ---
    for (let i = 0; i < 50; i++) {
      await episodic.remember(
        { contact: `Batch-${i}`, type: 'auto', notes: `Auto-generated note ${i}` },
        { source: 'batch', tags: ['batch-test'], importance: 0.5 },
      );
    }
    const batchRecall = await episodic.recall({ tags: ['batch-test'], limit: 100 });
    assert(batchRecall.length === 50, `batch recall should get 50, got ${batchRecall.length}`);
    ok(`episodic: batch 50 memories \u2014 recalled ${batchRecall.length}`);

    // --- Query: $in operator ---
    const inQuery = await store.query('crm/contacts', {
      filter: { company: { $in: ['Acme Corp', 'Widgets Inc'] } },
    });
    assert(inQuery.data.length > 0, '$in query should find contacts at Acme or Widgets');
    ok(`query $in: ${inQuery.data.length} contacts at Acme or Widgets`);

    // --- Query: $exists operator ---
    const existsQuery = await store.query('crm/contacts', {
      filter: { email: { $exists: true } },
    });
    assert(existsQuery.data.length > 0, '$exists should find contacts with email');
    ok(`query $exists: ${existsQuery.data.length} contacts with email field`);

    // --- Query: combined filters ---
    const combinedQ = await store.query('crm/contacts', {
      filter: {
        company: { $eq: 'Acme Corp' },
        tags: { $contains: 'warm-lead' },
      },
    });
    ok(`query combined: ${combinedQ.data.length} Acme warm-leads`);

    // --- Query: $startsWith ---
    const startsWith = await store.query('crm/contacts', {
      filter: { name: { $startsWith: 'Alice' } },
    });
    assert(startsWith.data.length >= 1, '$startsWith should find Alice');
    ok(`query $startsWith: ${startsWith.data.length} names starting with Alice`);

    // --- Query: $endsWith ---
    const endsWith = await store.query('crm/contacts', {
      filter: { email: { $endsWith: '@acme.com' } },
    });
    ok(`query $endsWith: ${endsWith.data.length} @acme.com emails`);

    // --- Query: sort ---
    const sorted = await store.query('crm/deals', {
      filter: {},
      sort: { value: -1 },
    });
    if (sorted.data.length >= 2) {
      const firstVal = unwrap(sorted.data[0]).value;
      const secondVal = unwrap(sorted.data[1]).value;
      assert(firstVal >= secondVal, 'sort DESC should order by value descending');
      ok(`query sort: deals sorted by value DESC (${firstVal} >= ${secondVal})`);
    } else {
      ok('query sort: not enough deals to verify ordering');
    }

    // --- Query: limit + skip (pagination) ---
    const page1 = await store.query('crm/contacts', {
      filter: {},
      limit: 2,
    });
    assert(page1.data.length <= 2, 'limit 2 should return at most 2');
    ok(`query pagination: page1 got ${page1.data.length} of ${page1.total}`);

    const page2 = await store.query('crm/contacts', {
      filter: {},
      limit: 2,
      skip: 2,
    });
    ok(`query pagination: page2 got ${page2.data.length} (skip 2)`);

    // --- Query: no filter (return all) ---
    const allContacts = await store.query('crm/contacts', { filter: {} });
    assert(allContacts.data.length === CONTACTS.length, `no-filter should return all ${CONTACTS.length} contacts`);
    ok(`query no filter: ${allContacts.data.length} contacts`);

    // --- Search: unicode content ---
    await store.set('crm/contacts/unicode-test', {
      name: 'M\u00fcller Stra\u00dfe', email: 'muller@m\u00fcnchen.de',
      company: '\u00dcn\u00efc\u00f6d\u00eb Corp', role: 'CEO', tags: 'international',
    }, { mode: 'replace' });
    const unicodeSearch = await store.search('crm/contacts', {
      type: 'bm25', query: 'M\u00fcller',
    });
    ok(`search unicode: ${unicodeSearch.length} result(s) for "M\u00fcller"`);

    // --- CRUD: patch merge behavior ---
    await store.set('crm/contacts/patch-test', {
      name: 'Patch Test', email: 'patch@test.com',
      company: 'Test Corp', role: 'Tester', tags: 'test',
    }, { mode: 'replace' });
    await store.patch('crm/contacts/patch-test', { role: 'Senior Tester', phone: '+1234567890' });
    const patchedContact = unwrap(await store.get('crm/contacts/patch-test'));
    assert(patchedContact.name === 'Patch Test', 'patch should preserve existing fields');
    assert(patchedContact.role === 'Senior Tester', 'patch should update changed fields');
    assert(patchedContact.phone === '+1234567890', 'patch should add new fields');
    ok('patch merge: preserves old, updates changed, adds new');

    // ──────────────────────────────────────────────────────────────
    // 8. Cleanup
    // ──────────────────────────────────────────────────────────────
    section('8. Cleanup');

    // Clean up SQLite data
    for (const col of ['crm/contacts', 'crm/companies', 'crm/deals']) {
      const ks = await store.keys(col);
      for (const k of ks) {
        await store.delete(`${col}/${k}`);
      }
    }

    // Clean up graph (including edge case nodes)
    await graph.clear();
    await graph2.clear();
    await emptyGraph.clear();
    ok('cleaned up all CRM data');

    console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
    console.log(`  All ${checkCount} checks passed!`);
    console.log(`  Data: ${DATA_DIR}`);
    console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);

  } finally {
    // Data persists in DATA_DIR — only clean up if --clean on next run
  }
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
