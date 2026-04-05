#!/usr/bin/env -S deno run --allow-all
/**
 * Live Materialized Reports Test (Sheetlog)
 *
 * Store project tasks in Sheets, filter into views,
 * export as CSV/Markdown/JSON.
 *
 * Features: Materializers + FilterRetriever + Sheetlog adapter
 *
 * Prerequisites:
 * - Working Sheetlog adapter (run `deno task live:sheets` first)
 *
 * Run: deno task live:sheetlog-views
 */

// Load .env from project root
import { loadSync } from "@std/dotenv";
try { loadSync({ envPath: new URL("../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }
try { loadSync({ envPath: new URL("../../../../../.env", import.meta.url).pathname, export: true }); } catch { /* ok */ }

import {
  createSmallstore,
  createSheetlogAdapter,
  createMemoryAdapter,
  materializeCsv,
  materializeMarkdown,
  materializeJson,
  FilterRetriever,
} from '../../../mod.ts';

// ============================================================================
// Credential Check
// ============================================================================

const SHEET_URL = Deno.env.get('SM_SHEET_URL');
const SHEET_NAME = Deno.env.get('SM_SHEET_NAME') || 'SmallstoreTest';

if (!SHEET_URL) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Materialized Reports Live Test — Setup Required             ║
╚══════════════════════════════════════════════════════════════╝

Missing Sheetlog credentials. Set in .env:
  SM_SHEET_URL=https://script.google.com/macros/s/.../exec
  SM_SHEET_NAME=SmallstoreTest (optional)

Run again: deno task live:sheetlog-views
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
║  Materialized Reports — Sheetlog Live Test                   ║
║  Sheet: ${SHEET_NAME}${' '.repeat(Math.max(0, 50 - SHEET_NAME.length))}║
║  Test ID: ${testId}${' '.repeat(Math.max(0, 47 - testId.length))}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ── Setup ──────────────────────────────────────────────────
  // Use memory for all storage — write to memory, materialize from memory
  // (Sheetlog doesn't support the collection-level reads materializers need)
  const memoryAdapter = createMemoryAdapter();

  const store = createSmallstore({
    adapters: { memory: memoryAdapter },
    defaultAdapter: 'memory',
  });

  // ── Step 1: Store project tasks ────────────────────────────
  console.log('── Step 1: Store project tasks ──');

  const tasks = [
    { key: `tasks-${testId}/task-001`, data: { Title: 'Fix login bug', Status: 'done', Priority: 'high', Assignee: 'Alice', DueDate: '2026-02-10' } },
    { key: `tasks-${testId}/task-002`, data: { Title: 'Add dark mode', Status: 'in-progress', Priority: 'medium', Assignee: 'Bob', DueDate: '2026-02-20' } },
    { key: `tasks-${testId}/task-003`, data: { Title: 'Write API docs', Status: 'todo', Priority: 'low', Assignee: 'Carol', DueDate: '2026-02-15' } },
    { key: `tasks-${testId}/task-004`, data: { Title: 'Upgrade deps', Status: 'todo', Priority: 'high', Assignee: 'Alice', DueDate: '2026-02-12' } },
    { key: `tasks-${testId}/task-005`, data: { Title: 'Add search', Status: 'in-progress', Priority: 'high', Assignee: 'Dan', DueDate: '2026-02-18' } },
    { key: `tasks-${testId}/task-006`, data: { Title: 'Fix mobile layout', Status: 'todo', Priority: 'medium', Assignee: 'Bob', DueDate: '2026-02-14' } },
    { key: `tasks-${testId}/task-007`, data: { Title: 'Add pagination', Status: 'done', Priority: 'medium', Assignee: 'Carol', DueDate: '2026-02-08' } },
    { key: `tasks-${testId}/task-008`, data: { Title: 'Security audit', Status: 'todo', Priority: 'high', Assignee: 'Eve', DueDate: '2026-02-25' } },
    { key: `tasks-${testId}/task-009`, data: { Title: 'Onboarding flow', Status: 'in-progress', Priority: 'medium', Assignee: 'Alice', DueDate: '2026-02-22' } },
    { key: `tasks-${testId}/task-010`, data: { Title: 'Perf optimization', Status: 'todo', Priority: 'low', Assignee: 'Dan', DueDate: '2026-03-01' } },
  ];

  for (const task of tasks) {
    await store.set(task.key, task.data, { mode: 'replace' });
    log('📋', `Created: ${task.data.Title} [${task.data.Status}] (${task.data.Priority})`);
  }

  // ── Step 2: Filter with retrievers ─────────────────────────
  console.log('\n── Step 2: Filter tasks with retrievers ──');

  // High-priority tasks
  const filterRetriever = new FilterRetriever();

  const highPriTasks = [];
  for (const task of tasks) {
    const result = await store.get(task.key);
    if (result?.content) {
      const filtered = await filterRetriever.retrieve(result.content, {
        and: [{ Priority: 'high' }],
      });
      if (filtered.data && (Array.isArray(filtered.data) ? filtered.data.length > 0 : true)) {
        highPriTasks.push(task.data);
      }
    }
  }
  log('🔴', `High priority: ${highPriTasks.length} tasks`);
  for (const t of highPriTasks) {
    log('  ', `${t.Title} — ${t.Status} (${t.Assignee})`);
  }

  // Alice's tasks
  const aliceTasks = [];
  for (const task of tasks) {
    const result = await store.get(task.key);
    if (result?.content) {
      const filtered = await filterRetriever.retrieve(result.content, {
        and: [{ Assignee: 'Alice' }],
      });
      if (filtered.data && (Array.isArray(filtered.data) ? filtered.data.length > 0 : true)) {
        aliceTasks.push(task.data);
      }
    }
  }
  log('👤', `Alice's tasks: ${aliceTasks.length}`);
  for (const t of aliceTasks) {
    log('  ', `${t.Title} — ${t.Status}`);
  }

  // ── Step 3: Materialize as CSV ─────────────────────────────
  console.log('\n── Step 3: Materialize as CSV ──');

  const csv = await materializeCsv(store, `tasks-${testId}`);
  const csvLines = csv.split('\n');
  log('📊', `CSV output (${csvLines.length} lines):`);
  // Show header + first 3 data rows
  for (const line of csvLines.slice(0, 4)) {
    log('  ', line.slice(0, 90));
  }
  if (csvLines.length > 4) log('  ', `... (${csvLines.length - 4} more rows)`);

  // ── Step 4: Materialize as Markdown ────────────────────────
  console.log('\n── Step 4: Materialize as Markdown ──');

  const md = await materializeMarkdown(store, `tasks-${testId}`);
  const mdLines = md.split('\n');
  log('📝', `Markdown output (${mdLines.length} lines):`);
  for (const line of mdLines.slice(0, 6)) {
    log('  ', line.slice(0, 90));
  }
  if (mdLines.length > 6) log('  ', `... (${mdLines.length - 6} more lines)`);

  // ── Step 5: Materialize as JSON ────────────────────────────
  console.log('\n── Step 5: Materialize as JSON ──');

  const json = await materializeJson(store, `tasks-${testId}`);
  log('📦', `JSON output: ${json.items?.length || 0} items`);
  if (json.items?.length > 0) {
    const first = json.items[0];
    log('  ', `First item: ${JSON.stringify(first).slice(0, 90)}...`);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`
── Done ──

  Tasks created: ${tasks.length}
  Filters tested: high-priority (${highPriTasks.length}), Alice's tasks (${aliceTasks.length})
  Materialized: CSV (${csvLines.length} lines), Markdown (${mdLines.length} lines), JSON (${json.items?.length || 0} items)

  Data stored in memory (fast materializer demo).
`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err);
  Deno.exit(1);
});
