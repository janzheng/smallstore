#!/usr/bin/env -S deno run --allow-all
/**
 * Mini CRM — Simulation Mode
 *
 * Simulates realistic CRM usage: contacts arriving, deals progressing,
 * interactions logged, graph relationships built, episodic memories
 * recalled. Data stored as pretty-printed JSON files for easy inspection.
 *
 * Storage: local-json (one .json file per item, human-readable)
 *
 * Run:
 *   deno task crm:sim           # simulate usage
 *   deno task crm:sim --clean   # wipe and re-simulate
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createLocalJsonAdapter,
} from '../../mod.ts';
import { createGraphStore } from '../../src/graph/mod.ts';
import { createEpisodicStore } from '../../src/episodic/mod.ts';

// ============================================================================
// Config
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const JSON_DIR = join(DATA_DIR, 'json');

if (Deno.args.includes('--clean')) {
  try { await Deno.remove(DATA_DIR, { recursive: true }); } catch { /* ok */ }
  console.log('Cleaned data directory.\n');
}
await Deno.mkdir(DATA_DIR, { recursive: true });

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
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

function log(icon: string, msg: string) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`  [${time}] ${icon} ${msg}`);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================================
// Simulation data pools
// ============================================================================

const FIRST_NAMES = ['Alex', 'Jordan', 'Morgan', 'Casey', 'Taylor', 'Riley', 'Avery', 'Quinn', 'Harper', 'Sage', 'Rowan', 'Blake'];
const LAST_NAMES = ['Chen', 'Patel', 'Kim', 'Santos', 'Johansson', 'Dubois', 'Nakamura', 'Silva', 'Fischer', 'Okafor', 'Larsen', 'Reed'];
const COMPANIES = ['NovaTech', 'Meridian AI', 'Bright Systems', 'Vertex Labs', 'Atlas Digital', 'Prism Data', 'Flux Studio', 'Echo Works', 'Cipher Inc', 'Summit SaaS'];
const INDUSTRIES = ['AI', 'SaaS', 'Fintech', 'Healthcare', 'EdTech', 'DevTools', 'Cybersecurity', 'IoT'];
const ROLES = ['CEO', 'CTO', 'VP Engineering', 'Head of Product', 'Design Lead', 'Founder', 'COO', 'VP Sales'];
const DEAL_STAGES = ['discovery', 'qualification', 'proposal', 'negotiation', 'closed-won', 'closed-lost'];
const INTERACTION_TYPES = ['meeting', 'email', 'call', 'demo', 'lunch', 'conference'];
const SENTIMENTS = ['positive', 'neutral', 'negative'];

const INTERACTION_NOTES = [
  'Great conversation about product roadmap, very aligned with their needs',
  'Discussed pricing structure, asked for enterprise discount',
  'Technical deep dive on API capabilities, team was impressed',
  'Follow-up on last week\'s demo, answered integration questions',
  'Quarterly business review, NPS score improved to 9',
  'Initial discovery call, strong interest in platform capabilities',
  'Contract negotiation, legal team reviewing terms',
  'Cold outreach via email, no response yet',
  'Warm intro from existing customer, scheduled follow-up',
  'Product feedback session, collected 5 feature requests',
  'Renewal discussion, considering upgrade to enterprise tier',
  'Competitive analysis meeting, compared vs. three alternatives',
];

function randomContact() {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const company = pick(COMPANIES);
  return {
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}@${company.toLowerCase().replace(/\s/g, '')}.com`,
    company,
    role: pick(ROLES),
    tags: [pick(['warm-lead', 'cold-lead', 'active', 'churned']), pick(['enterprise', 'startup', 'mid-market'])].join(','),
  };
}

function randomDeal(company: string) {
  const dealTypes = ['Series A', 'Partnership', 'Enterprise License', 'Pilot Program', 'Annual Renewal', 'Expansion'];
  return {
    name: `${pick(dealTypes)} \u2014 ${company}`,
    stage: pick(DEAL_STAGES.slice(0, 4)),
    value: Math.floor(Math.random() * 500000) + 10000,
    company,
  };
}

// ============================================================================
// Simulation
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  Mini CRM \u2014 Simulation (local-json)                        \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  const jsonAdapter = createLocalJsonAdapter({ baseDir: JSON_DIR, prettyPrint: true });
  const store = createSmallstore({
    adapters: {
      json: jsonAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'json',
  });
  const memStore = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  const graph = createGraphStore(memStore);
  const episodic = createEpisodicStore(memStore);

  // ── Phase 1: Build contacts + companies ─────────────────────
  console.log('\n\u2500\u2500 Phase 1: Adding contacts and companies \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const contacts: any[] = [];
  const companies = new Set<string>();

  for (let i = 0; i < 8; i++) {
    const c = randomContact();
    contacts.push(c);
    companies.add(c.company);

    await store.set(`crm/contacts/${slugify(c.name)}`, c, { mode: 'replace' });
    log('\ud83d\udc64', `Contact: ${c.name} (${c.role} @ ${c.company})`);

    const node = await graph.addNode({
      collection: 'crm', path: `contacts/${slugify(c.name)}`,
      type: 'contact', metadata: { name: c.name, email: c.email },
    });
    c._nodeId = node.id;
    await sleep(30);
  }

  const companyNodes: Record<string, string> = {};
  for (const co of companies) {
    await store.set(`crm/companies/${slugify(co)}`, {
      name: co, industry: pick(INDUSTRIES), size: pick(['startup', 'mid-market', 'enterprise']),
    }, { mode: 'replace' });

    const node = await graph.addNode({
      collection: 'crm', path: `companies/${slugify(co)}`,
      type: 'company', metadata: { name: co },
    });
    companyNodes[co] = node.id;
    log('\ud83c\udfe2', `Company: ${co}`);
  }

  for (const c of contacts) {
    if (companyNodes[c.company]) {
      await graph.addEdge({
        source: c._nodeId,
        target: companyNodes[c.company],
        relationship: 'related_to',
        weight: 1.0,
        metadata: { label: 'works_at' },
      });
    }
  }
  log('\ud83d\udd17', `Linked ${contacts.length} contacts to ${companies.size} companies`);

  // ── Phase 2: Create deals ───────────────────────────────────
  console.log('\n\u2500\u2500 Phase 2: Creating deals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const deals: any[] = [];
  for (const co of [...companies].slice(0, 4)) {
    const deal = randomDeal(co);
    deals.push(deal);

    await store.set(`crm/deals/${slugify(deal.name)}`, deal, { mode: 'replace' });
    log('\ud83d\udcb0', `Deal: "${deal.name}" ($${deal.value.toLocaleString()}, ${deal.stage})`);

    const dealNode = await graph.addNode({
      collection: 'crm', path: `deals/${slugify(deal.name)}`,
      type: 'deal', metadata: { name: deal.name, value: deal.value },
    });
    if (companyNodes[co]) {
      await graph.addEdge({
        source: dealNode.id,
        target: companyNodes[co],
        relationship: 'related_to',
        weight: 0.9,
        metadata: { label: 'deal_with' },
      });
    }
    await sleep(30);
  }

  // ── Phase 3: Log interactions (episodic memory) ─────────────
  console.log('\n\u2500\u2500 Phase 3: Logging interactions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (let i = 0; i < 10; i++) {
    const contact = pick(contacts);
    const type = pick(INTERACTION_TYPES);
    const notes = pick(INTERACTION_NOTES);
    const sentiment = pick(SENTIMENTS);

    await episodic.remember(
      { contact: contact.name, type, notes },
      {
        source: 'crm',
        tags: [sentiment, type, slugify(contact.name)],
        importance: sentiment === 'positive' ? 0.8 : sentiment === 'negative' ? 0.3 : 0.5,
      },
    );
    log('\ud83d\udcac', `[${type}] ${contact.name}: "${notes.slice(0, 50)}..."`);
    await sleep(20);
  }

  // ── Phase 4: Progress some deals ────────────────────────────
  console.log('\n\u2500\u2500 Phase 4: Progressing deals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  for (const deal of deals.slice(0, 2)) {
    const currentIdx = DEAL_STAGES.indexOf(deal.stage);
    if (currentIdx < DEAL_STAGES.length - 2) {
      const newStage = DEAL_STAGES[currentIdx + 1];
      const existing = unwrap(await store.get(`crm/deals/${slugify(deal.name)}`));
      if (existing) {
        await store.set(`crm/deals/${slugify(deal.name)}`, {
          ...existing, stage: newStage, updatedAt: ts(),
        }, { mode: 'replace' });
        log('\ud83d\udcc8', `Deal "${deal.name}": ${deal.stage} \u2192 ${newStage}`);
      }
    }
  }

  // Flush all writes to disk
  await jsonAdapter.flush();

  // ── Phase 5: Browse & recall ────────────────────────────────
  console.log('\n\u2500\u2500 Phase 5: Browsing the CRM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const contactKeys = await store.keys('crm/contacts');
  const companyKeys = await store.keys('crm/companies');
  const dealKeys = await store.keys('crm/deals');
  log('\ud83d\udcca', `Contacts: ${contactKeys.length}`);
  log('\ud83d\udcca', `Companies: ${companyKeys.length}`);
  log('\ud83d\udcca', `Deals: ${dealKeys.length}`);

  // Graph stats
  const nodes = await graph.listNodes();
  const edges = await graph.listEdges();
  log('\ud83d\udd17', `Graph: ${nodes.length} nodes, ${edges.length} edges`);

  const randomCo = pick([...companies]);
  if (companyNodes[randomCo]) {
    const related = await graph.getRelated(companyNodes[randomCo], 'related_to');
    log('\ud83d\udd17', `Related to ${randomCo}: ${related.length} nodes`);
  }

  // Episodic recall
  const recentMemories = await episodic.recall({ limit: 3 });
  log('\ud83e\udde0', `Recent memories: ${recentMemories.length}`);
  for (const m of recentMemories) {
    const data = m.data || m;
    log('  ', `\u2192 [${data.type}] ${data.contact}: "${(data.notes || '').slice(0, 50)}..."`);
  }

  const positiveMemories = await episodic.recall({ tags: ['positive'], limit: 5 });
  log('\ud83d\ude0a', `Positive interactions: ${positiveMemories.length}`);

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log('  CRM Simulation complete!');
  console.log(`  Data: ${JSON_DIR}`);
  console.log(`  Contacts: ${contactKeys.length}, Companies: ${companyKeys.length}, Deals: ${dealKeys.length}`);
  console.log(`  Graph: ${nodes.length} nodes, ${edges.length} edges (in-memory)`);
  console.log('');
  console.log('  Browse your data:');
  console.log(`    ls ${JSON_DIR}/smallstore/crm/`);
  console.log(`    cat ${JSON_DIR}/smallstore/crm/contacts/*.json`);
  console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);
  console.log('  Run again to add more data. Use --clean to reset.\n');
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
