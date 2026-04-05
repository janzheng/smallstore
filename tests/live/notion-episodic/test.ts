#!/usr/bin/env -S deno run --allow-all
/**
 * Live Episodic Research Journal Test (Notion)
 *
 * A research journal where findings are stored as episodes with timestamps,
 * importance, and natural decay — older, less-accessed memories fade unless recalled.
 *
 * Features: EpisodicStore + Notion adapter
 *
 * Prerequisites:
 * - Working Notion adapter (run `deno task live:notion` first)
 *
 * Run: deno task live:notion-episodic
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import { createSmallstore, createNotionAdapter, createMemoryAdapter, createEpisodicStore } from '../../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SECRET = Deno.env.get('SM_NOTION_SECRET');
const DATABASE_ID = Deno.env.get('SM_NOTION_DATABASE_ID');

if (!SECRET || !DATABASE_ID || SECRET.startsWith('secret_XXX') || DATABASE_ID.startsWith('xxx')) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Episodic Journal Live Test — Setup Required                 ║
╚══════════════════════════════════════════════════════════════╝

Missing Notion credentials. Set in .env:
  SM_NOTION_SECRET=secret_your-integration-token
  SM_NOTION_DATABASE_ID=your-database-id

Run again: deno task live:notion-episodic
`);
  Deno.exit(0);
}

// ============================================================================
// Helpers
// ============================================================================

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

function ago(hours: number): number {
  return Date.now() - hours * 3600_000;
}

// ============================================================================
// Test
// ============================================================================

async function main() {
  const testId = `test-${Date.now()}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Episodic Research Journal — Notion Live Test                ║
║  Database: ${DATABASE_ID!.slice(0, 8)}...${DATABASE_ID!.slice(-4)}${' '.repeat(37)}║
║  Test ID:  ${testId}${' '.repeat(Math.max(0, 46 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup ──────────────────────────────────────────────────
  // Use collectionPrefix so episodes go to journal/episodes/{id}
  // instead of _episodic/episodes/ (which would route to memory via mount)
  const store = createSmallstore({
    adapters: { notion: createNotionAdapter({
      notionSecret: SECRET!,
      databaseId: DATABASE_ID!,
      introspectSchema: true,
      unmappedStrategy: 'auto-create',
    }), memory: createMemoryAdapter() },
    defaultAdapter: 'memory',  // episodic internals go to memory
    metadataAdapter: 'memory',
  });

  const episodic = createEpisodicStore(store, {
    collectionPrefix: `journal-${testId}`,
  });

  // ── Step 1: Remember research findings ─────────────────────
  console.log('── Step 1: Remember research findings ──');

  const ep1 = await episodic.remember(
    { title: 'Transformer scaling laws', url: 'https://arxiv.org/abs/2001.08361' },
    { source: 'arxiv', tags: ['ml', 'transformers', 'scaling'] },
    { importance: 0.9 }
  );
  log('💾', `Remembered: Transformer scaling laws (importance: 0.9) → ${ep1.id}`);

  const ep2 = await episodic.remember(
    { title: 'RLHF paper', url: 'https://arxiv.org/abs/2204.05862' },
    { source: 'arxiv', tags: ['ml', 'rlhf', 'alignment'] },
    { importance: 0.8 }
  );
  log('💾', `Remembered: RLHF paper (importance: 0.8) → ${ep2.id}`);

  const ep3 = await episodic.remember(
    { title: 'React Server Components', url: 'https://react.dev/blog/2023/03/22/react-labs' },
    { source: 'blog', tags: ['frontend', 'react', 'rsc'] },
    { importance: 0.5 }
  );
  log('💾', `Remembered: React Server Components (importance: 0.5) → ${ep3.id}`);

  const ep4 = await episodic.remember(
    { title: 'Mixture of Experts', url: 'https://arxiv.org/abs/2401.04088' },
    { source: 'arxiv', tags: ['ml', 'moe', 'architecture'] },
    { importance: 0.7 }
  );
  log('💾', `Remembered: Mixture of Experts (importance: 0.7) → ${ep4.id}`);

  const ep5 = await episodic.remember(
    { title: 'Deno 2.0 release notes', url: 'https://deno.com/blog/v2.0' },
    { source: 'blog', tags: ['deno', 'runtime', 'typescript'] },
    { importance: 0.4 }
  );
  log('💾', `Remembered: Deno 2.0 (importance: 0.4) → ${ep5.id}`);

  const ep6 = await episodic.remember(
    { title: 'Constitutional AI', url: 'https://arxiv.org/abs/2212.08073' },
    { source: 'arxiv', tags: ['ml', 'alignment', 'safety'] },
    { importance: 0.85 }
  );
  log('💾', `Remembered: Constitutional AI (importance: 0.85) → ${ep6.id}`);

  // ── Step 2: Recall by tag ──────────────────────────────────
  console.log('\n── Step 2: Recall by tag — "ml" ──');

  const mlMemories = await episodic.recall({ tags: ['ml'], limit: 10 });
  log('🔍', `Found ${mlMemories.length} ML-related memories:`);
  for (const m of mlMemories) {
    log('  ', `${m.content?.title || m.id} (importance: ${m.importance.toFixed(2)})`);
  }

  // ── Step 3: Recall boost ───────────────────────────────────
  console.log('\n── Step 3: Recall boost — access ep1 again ──');

  const before = ep1.importance;
  const recalled = await episodic.recall({ limit: 1 });
  // Access the first episode to boost it
  if (recalled.length > 0) {
    log('📈', `Recalled ${recalled[0].content?.title} — recalled: ${recalled[0].recalled}`);
  }

  // ── Step 4: Timeline ───────────────────────────────────────
  console.log('\n── Step 4: Get timeline (chronological) ──');

  const timeline = await episodic.getTimeline({ limit: 6 });
  log('📅', `Timeline (${timeline.length} episodes):`);
  for (const ep of timeline) {
    const ts = new Date(ep.timestamp).toISOString().slice(0, 19);
    log('  ', `[${ts}] ${ep.content?.title || ep.id} (importance: ${ep.importance.toFixed(2)})`);
  }

  // ── Step 5: Apply decay ────────────────────────────────────
  console.log('\n── Step 5: Apply decay (threshold: 0.3) ──');

  const decayResult = await episodic.applyDecay({ threshold: 0.3 });
  log('⏳', `Decay result: ${decayResult.forgotten} forgotten, ${decayResult.remaining} remaining`);
  log('⏳', `Average importance after decay: ${decayResult.averageImportance.toFixed(2)}`);

  // ── Step 6: Stats ──────────────────────────────────────────
  console.log('\n── Step 6: Episodic store stats ──');

  const stats = await episodic.getStats();
  log('📊', `Total: ${stats.total}`);
  log('📊', `Active: ${stats.active}, Decayed: ${stats.decayed}`);
  log('📊', `Average importance: ${stats.averageImportance.toFixed(2)}`);
  log('📊', `Average recall count: ${stats.averageRecallCount.toFixed(1)}`);
  if (Object.keys(stats.tagDistribution).length > 0) {
    log('📊', `Tags: ${Object.entries(stats.tagDistribution).map(([k, v]) => `${k}(${v})`).join(', ')}`);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`
── Done ──

  Episodes remembered: 6
  ML recalls: ${mlMemories.length}
  Timeline entries: ${timeline.length}
  Decay: ${decayResult.forgotten} forgotten / ${decayResult.remaining} remaining

  Data is stored in memory (episodic store internals).
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
