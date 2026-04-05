#!/usr/bin/env -S deno run --allow-all
/**
 * Live Multi-Adapter Network Test (Notion + Sheetlog)
 *
 * People live in Notion, meetings in Sheetlog, graph connects them.
 * Demonstrates cross-adapter data with graph relationships.
 *
 * Features: GraphStore + Namespace + Notion + Sheetlog adapters
 *
 * Prerequisites:
 * - Working Notion adapter (run `deno task live:notion` first)
 * - Working Sheetlog adapter (run `deno task live:sheets` first)
 *
 * Run: deno task live:multi-adapter
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import {
  createSmallstore,
  createNotionAdapter,
  createSheetlogAdapter,
  createMemoryAdapter,
  createGraphStore,
} from '../../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const NOTION_SECRET = Deno.env.get('SM_NOTION_SECRET');
const NOTION_DB = Deno.env.get('SM_NOTION_DATABASE_ID');
const SHEET_URL = Deno.env.get('SM_SHEET_URL');
const SHEET_NAME = Deno.env.get('SM_SHEET_NAME') || 'SmallstoreTest';

const missingNotion = !NOTION_SECRET || !NOTION_DB || NOTION_SECRET.startsWith('secret_XXX');
const missingSheets = !SHEET_URL;

if (missingNotion || missingSheets) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Multi-Adapter Network Live Test — Setup Required            ║
╚══════════════════════════════════════════════════════════════╝

${missingNotion ? `Missing Notion credentials:
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_DATABASE_ID=your-database-id
` : '  Notion: OK'}
${missingSheets ? `Missing Sheetlog credentials:
  SM_SHEET_URL=https://script.google.com/macros/s/.../exec
  SM_SHEET_NAME=SmallstoreTest (optional)
` : '  Sheetlog: OK'}

Run again: deno task live:multi-adapter
`);
  Deno.exit(0);
}

// ============================================================================
// Helpers
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

async function delay(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// Test
// ============================================================================

async function main() {
  const testId = `test-${Date.now()}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Multi-Adapter Network — Notion + Sheetlog Live Test         ║
║  Notion DB: ${NOTION_DB!.slice(0, 8)}...${NOTION_DB!.slice(-4)}${' '.repeat(36)}║
║  Sheet: ${SHEET_NAME}${' '.repeat(Math.max(0, 50 - SHEET_NAME.length))}║
║  Test ID: ${testId}${' '.repeat(Math.max(0, 47 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup: Two stores + graph ──────────────────────────────
  const notionStore = createSmallstore({
    adapters: {
      notion: createNotionAdapter({
        notionSecret: NOTION_SECRET!,
        databaseId: NOTION_DB!,
        introspectSchema: true,
        unmappedStrategy: 'auto-create',
      }),
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'notion',
    mounts: { '_graph/*': 'memory' },
  });

  const sheetsStore = createSmallstore({
    adapters: {
      sheets: createSheetlogAdapter({ sheetUrl: SHEET_URL!, sheet: SHEET_NAME }),
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'sheets',
    metadataAdapter: 'memory',
  });

  const graph = createGraphStore(notionStore);

  // ── Step 1: Create people in Notion ────────────────────────
  console.log('── Step 1: Create people in Notion ──');

  const people = [
    { name: 'Alice', role: 'Engineer', email: 'alice@acme.com' },
    { name: 'Bob', role: 'Designer', email: 'bob@acme.com' },
    { name: 'Carol', role: 'PM', email: 'carol@globex.com' },
  ];

  const personNodes: any[] = [];
  for (const p of people) {
    await notionStore.set(`people/${p.name.toLowerCase()}-${testId}`, {
      Name: `${p.name}-${testId}`,
      Role: p.role,
      Email: p.email,
    }, { mode: 'replace' });

    const node = await graph.addNode({
      collection: 'people',
      path: `${p.name.toLowerCase()}-${testId}`,
      type: 'person',
      metadata: { role: p.role, storeKey: `people/${p.name.toLowerCase()}-${testId}` },
    });
    personNodes.push(node);
    log('👤', `${p.name} → Notion + graph node ${node.id}`);
  }

  // ── Step 2: Create meetings in Sheetlog ────────────────────
  console.log('\n── Step 2: Create meetings in Sheetlog ──');

  const meetings = [
    { name: 'Standup', date: '2026-02-17', attendees: ['Alice', 'Bob'], topic: 'Sprint planning' },
    { name: 'Design Review', date: '2026-02-18', attendees: ['Bob', 'Carol'], topic: 'UI redesign feedback' },
    { name: 'All Hands', date: '2026-02-19', attendees: ['Alice', 'Bob', 'Carol'], topic: 'Q1 review' },
  ];

  const meetingNodes: any[] = [];
  for (const m of meetings) {
    const meetingKey = `meetings/${m.name.toLowerCase().replace(/\s/g, '-')}-${testId}`;
    await sheetsStore.set(meetingKey, {
      Name: `${m.name}-${testId}`,
      Date: m.date,
      Attendees: m.attendees.join(', '),
      Topic: m.topic,
    }, { mode: 'replace' });
    await delay(500);  // Rate limit for Sheetlog

    const node = await graph.addNode({
      collection: 'meetings',
      path: `${m.name.toLowerCase().replace(/\s/g, '-')}-${testId}`,
      type: 'meeting',
      metadata: { sheetsKey: meetingKey, date: m.date },
    });
    meetingNodes.push(node);
    log('📅', `${m.name} → Sheetlog + graph node ${node.id}`);
  }

  // ── Step 3: Link with graph edges ──────────────────────────
  console.log('\n── Step 3: Link people → meetings with graph edges ──');

  // Alice attended Standup and All Hands
  await graph.addEdge({ source: personNodes[0].id, target: meetingNodes[0].id, relationship: 'attended' });
  await graph.addEdge({ source: personNodes[0].id, target: meetingNodes[2].id, relationship: 'attended' });
  log('🔗', 'Alice → attended → Standup, All Hands');

  // Bob attended all 3
  await graph.addEdge({ source: personNodes[1].id, target: meetingNodes[0].id, relationship: 'attended' });
  await graph.addEdge({ source: personNodes[1].id, target: meetingNodes[1].id, relationship: 'attended' });
  await graph.addEdge({ source: personNodes[1].id, target: meetingNodes[2].id, relationship: 'attended' });
  log('🔗', 'Bob → attended → Standup, Design Review, All Hands');

  // Carol attended Design Review and All Hands
  await graph.addEdge({ source: personNodes[2].id, target: meetingNodes[1].id, relationship: 'attended' });
  await graph.addEdge({ source: personNodes[2].id, target: meetingNodes[2].id, relationship: 'attended' });
  log('🔗', 'Carol → attended → Design Review, All Hands');

  // ── Step 4: Traverse — What meetings did Alice attend? ─────
  console.log('\n── Step 4: Traverse — What meetings did Alice attend? ──');

  const aliceMeetings = await graph.getRelated(personNodes[0].id, 'attended');
  log('🔍', `Alice attended ${aliceMeetings.length} meetings:`);
  for (const m of aliceMeetings) {
    log('  ', `${m.path} (${m.metadata?.date || 'no date'})`);
    // Cross-store lookup: get meeting details from Sheetlog
    if (m.metadata?.sheetsKey) {
      const details = await sheetsStore.get(m.metadata.sheetsKey);
      if (details?.content) {
        const data = Array.isArray(details.content) ? details.content[0] : details.content;
        log('  ', `  Topic: ${data.Topic || data.topic || 'n/a'}`);
      }
    }
  }

  // ── Step 5: List keys from both stores ─────────────────────
  console.log('\n── Step 5: List keys from both stores ──');

  const notionKeys = await notionStore.keys('people');
  const testNotionKeys = notionKeys.filter(k => k.includes(testId));
  log('📁', `Notion people keys: ${testNotionKeys.length}`);
  for (const k of testNotionKeys) log('  ', k);

  const sheetsKeys = await sheetsStore.keys('meetings');
  const testSheetsKeys = sheetsKeys.filter(k => k.includes(testId));
  log('📁', `Sheetlog meeting keys: ${testSheetsKeys.length}`);
  for (const k of testSheetsKeys) log('  ', k);

  // ── Step 6: Graph stats ────────────────────────────────────
  console.log('\n── Step 6: Graph stats ──');

  const stats = await graph.getStats();
  log('📊', `Nodes: ${stats.nodeCount} (${people.length} people + ${meetings.length} meetings)`);
  log('📊', `Edges: ${stats.edgeCount}`);
  log('📊', `Relationships: ${Object.keys(stats.edgesByRelationship).join(', ')}`);

  // ── Summary ────────────────────────────────────────────────
  console.log(`
── Done ──

  People in Notion: ${people.length}
  Meetings in Sheetlog: ${meetings.length}
  Graph edges: ${stats.edgeCount} (attended relationships)
  Cross-store traversal: Alice's meetings resolved from Sheetlog

  Data LEFT in Notion + Sheets so you can inspect it.
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
