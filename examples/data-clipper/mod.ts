#!/usr/bin/env -S deno run --allow-all
/**
 * Data Clipper — Unified Data Inbox
 *
 * A personal data inbox that stores anything: bookmarks, notes, emails,
 * events, files — all in a single configurable namespace. Like Apple Notes
 * meets Notion meets a webhook inbox.
 *
 * Everything lives under one namespace (e.g. "design-stuff") with `type`
 * as a field, not a structural boundary. Search, query, and views slice
 * across all types uniformly.
 *
 * Data persists in ./data/ between runs. Use --clean to reset.
 *
 * Run:
 *   deno task clipper           # run tests (data persists)
 *   deno task clipper --clean   # wipe data and re-run
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createSQLiteAdapter,
  createLocalFileAdapter,
  materializeCsv,
  materializeMarkdown,
  materializeJson,
  materializeText,
  materializeYaml,
} from '../../mod.ts';
import { FileExplorer } from '../../src/explorer/mod.ts';

// ============================================================================
// Config — data lives in this folder
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const DB_PATH = join(DATA_DIR, 'store.db');
const FILES_DIR = join(DATA_DIR, 'files');

/** The namespace — change this to whatever you want */
const NS = 'design-stuff';

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

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function ts(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// ============================================================================
// Seed Data — everything has a `type` field
// ============================================================================

const CLIPS = [
  {
    type: 'bookmark',
    title: 'Attention Is All You Need — Revisited',
    url: 'https://arxiv.org/abs/2401.12345',
    excerpt: 'A comprehensive revisit of the transformer architecture with modern optimizations.',
    tags: 'ai,transformers,paper', source: 'manual', saved: '2024-03-10T08:00:00Z',
  },
  {
    type: 'bookmark',
    title: 'Rust + WebAssembly Guide',
    url: 'https://example.com/rust-wasm',
    excerpt: 'Building high-performance web apps with Rust compiled to WebAssembly.',
    tags: 'rust,wasm,web', source: 'extension', saved: '2024-03-12T14:30:00Z',
  },
  {
    type: 'bookmark',
    title: 'Deploying Deno to the Edge',
    url: 'https://blog.example.com/deno-deploy',
    excerpt: 'Step-by-step guide to deploying Deno applications on edge networks.',
    tags: 'deno,edge,deployment', source: 'manual', saved: '2024-03-14T09:15:00Z',
  },
];

const NOTES = [
  {
    type: 'note',
    title: 'Meeting Notes — Project Alpha',
    content: '## Summary\n\nDiscussed timeline for Q2 launch.\n- Use Deno for backend\n- SQLite for local storage\n- Deploy to Cloudflare Workers',
    tags: 'meeting,project-alpha', created: '2024-03-15T10:00:00Z',
  },
  {
    type: 'note',
    title: 'Research: Agent Memory Patterns',
    content: '## Agent Memory\n\nThree patterns:\n1. Episodic — time-decaying memories\n2. Semantic — knowledge graph\n3. Procedural — learned workflows',
    tags: 'ai,agents,research', created: '2024-03-14T15:00:00Z',
  },
  {
    type: 'note',
    title: 'Quick Thought: API Design',
    content: 'REST for CRUD, webhooks for ingestion, views for retrieval. Keep it simple.',
    tags: 'api,design', created: '2024-03-13T08:00:00Z',
  },
];

const EMAILS = [
  {
    type: 'email',
    from: 'dense-discovery@newsletter.com', subject: 'Dense Discovery #287',
    body: 'This week: a gorgeous portfolio site, an AI tool for color palettes, a book on creative leadership, and more design inspiration.',
    tags: 'newsletter,design,inspiration', read: false, received: ts(60),
  },
  {
    type: 'email',
    from: 'sidebar@newsletter.com', subject: 'Sidebar #412 — Best Design Links',
    body: 'Five links: new Figma features, CSS container queries deep dive, accessible color systems, design tokens in practice, and micro-interactions.',
    tags: 'newsletter,design,css,figma', read: false, received: ts(45),
  },
  {
    type: 'email',
    from: 'alice@acme.com', subject: 'Follow-up: Brand Guidelines Review',
    body: 'Here are my notes from the brand review. Color system looks good, typography needs another pass.',
    tags: 'work,design,brand', read: true, received: ts(30),
  },
  {
    type: 'email',
    from: 'bytes@ui.dev', subject: 'Bytes #312 — React 19 and the Future',
    body: 'React 19 is out with server components. Also: Astro 4.5, Tailwind v4 alpha, and a wild CSS trick.',
    tags: 'newsletter,dev,react', read: false, received: ts(15),
  },
  {
    type: 'email',
    from: 'dave@studio.co', subject: 'Invoice #789 — March Design Sprint',
    body: 'Attached invoice for the 3-day design sprint workshop. Total: $4,500.',
    tags: 'work,finance,invoice', read: true, received: ts(5),
  },
];

const EVENTS = [
  {
    type: 'event', source: 'github',
    event: 'push', repo: 'acme/design-system', branch: 'main', commits: 3,
    description: 'Updated color tokens and spacing scale', author: 'alice', timestamp: ts(120),
  },
  {
    type: 'event', source: 'github',
    event: 'pr_opened', repo: 'acme/design-system', branch: 'feat/dark-mode',
    description: 'Implement dark mode variant for all components', author: 'bob', timestamp: ts(90),
  },
  {
    type: 'event', source: 'figma',
    event: 'file_updated', file: 'Brand Guidelines v3', editor: 'carol',
    description: 'Updated logo usage section with new brand mark', timestamp: ts(60),
  },
  {
    type: 'event', source: 'stripe',
    event: 'payment_succeeded', amount: 9900, currency: 'usd',
    description: 'Monthly Figma subscription payment', customer: 'acme', timestamp: ts(30),
  },
];

const FILES = [
  {
    type: 'file', filename: 'brand-guidelines-v3.pdf', mimeType: 'application/pdf',
    sizeBytes: 2400000, tags: 'design,brand,guidelines',
    notes: 'Latest brand guidelines with updated color system',
  },
  {
    type: 'file', filename: 'design-sprint-photos.zip', mimeType: 'application/zip',
    sizeBytes: 15000000, tags: 'design,workshop,photos',
    notes: 'Photos from the March design sprint',
  },
];

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log(`\u2551  Data Clipper \u2014 "${NS}" namespace                   \u2551`);
  console.log(`\u2551  Data: ${DATA_DIR}`);
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  const store = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
      sqlite: createSQLiteAdapter({ path: DB_PATH }),
      files: createLocalFileAdapter({ baseDir: FILES_DIR }),
    },
    defaultAdapter: 'sqlite',
    mounts: {
      'cache/*': 'memory',
      'files/*': 'files',
    },
  });

  // ──────────────────────────────────────────────────────────────
  // 1. Ingest everything into one namespace
  // ──────────────────────────────────────────────────────────────
  section('1. Ingest (all types \u2192 single namespace)');

  for (const clip of CLIPS) {
    await store.set(`${NS}/clips/${slug(clip.title)}`, clip, { mode: 'replace' });
  }
  ok(`stored ${CLIPS.length} bookmarks \u2192 ${NS}/clips/`);

  for (const note of NOTES) {
    await store.set(`${NS}/notes/${slug(note.title)}`, note, { mode: 'replace' });
  }
  ok(`stored ${NOTES.length} notes \u2192 ${NS}/notes/`);

  for (const email of EMAILS) {
    await store.set(`${NS}/emails/${slug(email.subject)}`, email, { mode: 'replace' });
  }
  ok(`stored ${EMAILS.length} emails \u2192 ${NS}/emails/`);

  for (let i = 0; i < EVENTS.length; i++) {
    const evt = EVENTS[i];
    await store.set(`${NS}/events/${slug(evt.description)}-${i}`, evt, { mode: 'replace' });
  }
  ok(`stored ${EVENTS.length} events \u2192 ${NS}/events/`);

  for (const file of FILES) {
    await store.set(`${NS}/files/${slug(file.filename)}`, file, { mode: 'replace' });
  }
  ok(`stored ${FILES.length} file refs \u2192 ${NS}/files/`);

  const totalItems = CLIPS.length + NOTES.length + EMAILS.length + EVENTS.length + FILES.length;
  ok(`total: ${totalItems} items in "${NS}" namespace`);

  // ──────────────────────────────────────────────────────────────
  // 2. Core CRUD
  // ──────────────────────────────────────────────────────────────
  section('2. Core CRUD');

  const clip1 = unwrap(await store.get(`${NS}/clips/${slug(CLIPS[0].title)}`));
  assert(clip1.title === CLIPS[0].title, 'get should return correct clip');
  ok(`get: "${clip1.title}"`);

  const emailKey = `${NS}/emails/${slug(EMAILS[0].subject)}`;
  await store.patch(emailKey, { read: true, readAt: new Date().toISOString() });
  const patched = unwrap(await store.get(emailKey));
  assert(patched.read === true, 'patch should mark as read');
  ok(`patch: marked "${EMAILS[0].subject}" as read`);

  assert(await store.has(`${NS}/notes/${slug(NOTES[0].title)}`) === true, 'has should find note');
  assert(await store.has(`${NS}/notes/nonexistent`) === false, 'has should not find missing');
  ok('has: true for existing, false for missing');

  const clipKeys = await store.keys(`${NS}/clips`);
  assert(clipKeys.length === CLIPS.length, `keys should return ${CLIPS.length} clips`);
  ok(`keys: ${clipKeys.length} clips, ${(await store.keys(`${NS}/emails`)).length} emails`);

  const delKey = `${NS}/clips/${slug(CLIPS[2].title)}`;
  await store.delete(delKey);
  assert(await store.has(delKey) === false, 'delete should remove');
  await store.set(delKey, CLIPS[2], { mode: 'replace' });
  ok('delete + re-add: works');

  // ──────────────────────────────────────────────────────────────
  // 3. Search across ALL types
  // ──────────────────────────────────────────────────────────────
  section('3. Full-Text Search (cross-type)');

  const designSearch = await store.search(NS, { type: 'bm25', query: 'design' });
  assert(designSearch.length > 0, 'search "design" should find results');
  ok(`search "design" across all: ${designSearch.length} result(s)`);

  const emailSearch = await store.search(`${NS}/emails`, { type: 'bm25', query: 'figma' });
  ok(`search "figma" in emails: ${emailSearch.length} result(s)`);

  const noteSearch = await store.search(`${NS}/notes`, { type: 'bm25', query: 'agent' });
  assert(noteSearch.length > 0, 'search "agent" in notes should find result');
  ok(`search "agent" in notes: ${noteSearch.length} result(s)`);

  // ──────────────────────────────────────────────────────────────
  // 4. Structured Query
  // ──────────────────────────────────────────────────────────────
  section('4. Structured Query');

  const allEmails = await store.query(`${NS}/emails`, { filter: { type: { $eq: 'email' } } });
  assert(allEmails.data.length === EMAILS.length, 'should find all emails');
  ok(`query type=email: ${allEmails.data.length}`);

  const unread = await store.query(`${NS}/emails`, { filter: { read: { $eq: false } } });
  ok(`query unread: ${unread.data.length}`);

  const newsletters = await store.query(`${NS}/emails`, { filter: { tags: { $contains: 'newsletter' } } });
  ok(`query newsletters: ${newsletters.data.length}`);

  const ghEvents = await store.query(`${NS}/events`, { filter: { source: { $eq: 'github' } } });
  ok(`query github events: ${ghEvents.data.length}`);

  const multiSource = await store.query(`${NS}/events`, { filter: { source: { $in: ['github', 'figma'] } } });
  ok(`query $in [github,figma]: ${multiSource.data.length}`);

  const combined = await store.query(`${NS}/emails`, {
    filter: { read: { $eq: false }, tags: { $contains: 'newsletter' } },
  });
  ok(`query combined (unread+newsletter): ${combined.data.length}`);

  const page1 = await store.query(`${NS}/emails`, { filter: {}, limit: 2 });
  assert(page1.total === EMAILS.length, `total should be ${EMAILS.length}`);
  ok(`pagination: page1 got ${page1.data.length} of ${page1.total}`);

  // ──────────────────────────────────────────────────────────────
  // 5. Views
  // ──────────────────────────────────────────────────────────────
  section('5. Views');

  const allItems = [...CLIPS, ...NOTES, ...EMAILS, ...EVENTS, ...FILES];
  await store.set(`${NS}/all-items`, allItems, { mode: 'replace' });

  await store.createView('unread-emails', {
    source: `${NS}/all-items`,
    retrievers: [{ type: 'filter', options: { where: { type: 'email', read: false } } }],
  });
  const unreadView = await store.getView('unread-emails');
  ok(`view "unread-emails": ${(unreadView as any[]).length} item(s)`);

  await store.createView('recent-newsletters', {
    source: `${NS}/all-items`,
    retrievers: [
      { type: 'filter', options: { where: { type: 'email' } } },
      { type: 'slice', options: { mode: 'tail', take: 3 } },
    ],
  });
  const nlView = await store.getView('recent-newsletters');
  ok(`view "recent-newsletters": ${(nlView as any[]).length} item(s)`);

  const viewList = await store.listViews();
  ok(`listViews: ${viewList.length} views`);

  // ──────────────────────────────────────────────────────────────
  // 6. Namespace & Tree
  // ──────────────────────────────────────────────────────────────
  section('6. Namespace & Tree');

  const tree = await store.tree(NS, { maxDepth: 2 });
  const children = Object.keys(tree.children || {});
  ok(`tree "${NS}": [${children.join(', ')}]`);

  const noteSlug = slug(NOTES[0].title);
  await store.copy(`${NS}/notes/${noteSlug}`, `archive/${noteSlug}`);
  ok(`copy: ${NS}/notes/... \u2192 archive/...`);

  // ──────────────────────────────────────────────────────────────
  // 7. Content Export
  // ──────────────────────────────────────────────────────────────
  section('7. Content Export');

  const csvLines = (await materializeCsv(store, NS)).split('\n').filter((l: string) => l.trim());
  ok(`CSV: ${csvLines.length} lines`);

  ok(`Markdown: ${(await materializeMarkdown(store, NS)).length} chars`);
  ok(`JSON: ${(await materializeJson(store, NS)).items.length} items`);
  ok(`Text: ${(await materializeText(store, NS)).length} chars`);
  ok(`YAML: ${(await materializeYaml(store, NS)).length} chars`);

  // ──────────────────────────────────────────────────────────────
  // 8. File Explorer
  // ──────────────────────────────────────────────────────────────
  section('8. File Explorer & Collections');

  const explorer = new FileExplorer(store);
  ok(`browse "${NS}/files": ${(await explorer.browse(`${NS}/files`)).length} file(s)`);

  const allCols = await store.listCollections();
  ok(`listCollections: [${allCols.join(', ')}]`);

  // ──────────────────────────────────────────────────────────────
  // 9. Mount Routing
  // ──────────────────────────────────────────────────────────────
  section('9. Mount Routing');

  await store.set('cache/session', { userId: 'u123', theme: 'dark' }, { mode: 'replace' });
  const cacheResp = await store.get('cache/session');
  ok(`cache/* \u2192 "${(cacheResp as any)?.adapter || 'memory'}" adapter`);

  await store.set('files/readme', 'Blob stored on disk.', { mode: 'replace' });
  ok('files/* \u2192 local-file adapter');

  const sqliteResp = await store.get(`${NS}/clips/${slug(CLIPS[0].title)}`);
  ok(`${NS}/* \u2192 "${(sqliteResp as any)?.adapter || 'sqlite'}" adapter`);

  // ──────────────────────────────────────────────────────────────
  // 10. Edge Cases
  // ──────────────────────────────────────────────────────────────
  section('10. Edge Cases');

  // Unicode
  await store.set(`${NS}/notes/caf\u00e9-r\u00e9sum\u00e9`, {
    type: 'note', title: 'Caf\u00e9 Notes', content: '\u00fcber cool design r\u00e9sum\u00e9 \ud83c\udfa8',
    tags: 'design,international',
  }, { mode: 'replace' });
  const cafe = unwrap(await store.get(`${NS}/notes/caf\u00e9-r\u00e9sum\u00e9`));
  assert(cafe.content.includes('\ud83c\udfa8'), 'emoji preserved');
  ok('unicode: key + emoji content');

  // Nulls
  await store.set(`${NS}/notes/null-test`, { type: 'note', title: '', value: null }, { mode: 'replace' });
  const nullData = unwrap(await store.get(`${NS}/notes/null-test`));
  assert(nullData.value === null, 'null preserved');
  ok('null + empty strings');

  // Deep nesting
  await store.set(`${NS}/notes/deep`, {
    type: 'note', l1: { l2: { l3: { l4: { l5: 'deep' } } } },
  }, { mode: 'replace' });
  assert(unwrap(await store.get(`${NS}/notes/deep`)).l1.l2.l3.l4.l5 === 'deep', 'nesting');
  ok('deep nesting: 5 levels');

  // Large value
  await store.set(`${NS}/notes/big`, { type: 'note', content: 'x'.repeat(100_000) }, { mode: 'replace' });
  assert(unwrap(await store.get(`${NS}/notes/big`)).content.length === 100_000, '100K');
  ok('large value: 100K chars');

  // Batch
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    await store.set(`${NS}/batch/item-${i}`, { type: 'event', source: 'batch', index: i }, { mode: 'replace' });
  }
  ok(`batch: 100 writes in ${Date.now() - t0}ms`);

  const batchQ = await store.query(`${NS}/batch`, { filter: { index: { $gt: 90 } } });
  assert(batchQ.data.length === 9, 'batch query');
  ok(`batch query: $gt 90 found ${batchQ.data.length}`);

  // Delete edge cases
  await store.delete(`${NS}/notes/never-existed`);
  ok('delete non-existent: no error');

  const missing = await store.get(`${NS}/notes/nope`);
  assert(missing === null, 'get missing');
  ok('get non-existent: null');

  // ──────────────────────────────────────────────────────────────
  // 11. Cleanup test artifacts (keep seed data)
  // ──────────────────────────────────────────────────────────────
  section('11. Cleanup test artifacts');

  // Remove edge case data, keep the seed data for browsing
  for (const k of ['caf\u00e9-r\u00e9sum\u00e9', 'null-test', 'deep', 'big']) {
    await store.delete(`${NS}/notes/${k}`);
  }
  const batchKeys = await store.keys(`${NS}/batch`);
  for (const k of batchKeys) { await store.delete(`${NS}/${k}`); }
  const archiveKeys = await store.keys('archive');
  for (const k of archiveKeys) { await store.delete(`archive/${k}`); }
  await store.delete('cache/session');
  await store.delete('files/readme');
  for (const v of await store.listViews()) { await store.deleteView(v); }

  ok('cleaned test artifacts (seed data persists in ./data/)');

  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log(`  All ${checkCount} checks passed!`);
  console.log(`  Data persists at: ${DATA_DIR}`);
  console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
