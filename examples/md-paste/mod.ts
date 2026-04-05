#!/usr/bin/env -S deno run --allow-all
/**
 * md-paste — Demo Script
 *
 * Exercises all md-paste features using Google Sheets as the database.
 * Requires SHEET_URL or SM_SHEET_URL env var.
 * Needs two sheet tabs: "md-docs" and "md-checkpoints" (create manually first).
 *
 * Run:
 *   deno run --allow-all examples/md-paste/mod.ts
 */

import { Sheetlog } from '../../src/clients/sheetlog/client.ts';
import { createMdPaste } from './core.ts';

// ============================================================================
// Setup
// ============================================================================

const sheetUrl = Deno.env.get('SHEET_URL') || Deno.env.get('SM_SHEET_URL');
if (!sheetUrl) {
  console.error('Error: SHEET_URL or SM_SHEET_URL env var required.');
  Deno.exit(1);
}

const docsClient = new Sheetlog({ sheetUrl, sheet: 'md-docs' });
const checkpointsClient = new Sheetlog({ sheetUrl, sheet: 'md-checkpoints' });
const paste = createMdPaste(docsClient, checkpointsClient);

// ============================================================================
// Helpers
// ============================================================================

let checks = 0;
function ok(label: string) { checks++; console.log(`  \u2713 ${label}`); }
function section(label: string) { console.log(`\n\u2500\u2500 ${label} ${'─'.repeat(60 - label.length)}`); }
function assert(condition: boolean, msg: string) { if (!condition) throw new Error(`FAIL: ${msg}`); }

// ============================================================================
// Demo
// ============================================================================

console.log('md-paste — Markdown Pastebin (Google Sheets backend)\n');

section('Create documents');

const doc1 = await paste.createDoc('Getting Started with Deno', `# Getting Started with Deno

Deno is a modern runtime for JavaScript and TypeScript.

## Installation

\`\`\`bash
curl -fsSL https://deno.land/install.sh | sh
\`\`\`

## Hello World

\`\`\`typescript
console.log("Hello from Deno!");
\`\`\`
`);
ok(`Created "${doc1.title}" → ${doc1.slug} (v${doc1.version})`);

const doc2 = await paste.createDoc('Project Ideas', `# Project Ideas

- [ ] Build a CLI tool for markdown linting
- [ ] Create a webhook relay service
- [ ] Design a personal knowledge graph
`);
ok(`Created "${doc2.title}" → ${doc2.slug} (v${doc2.version})`);

const doc3 = await paste.createDoc('Meeting Notes 2024-02-17', `# Team Sync — Feb 17

**Attendees:** Alice, Bob, Carol

## Decisions
- Ship v2 API by end of month
- Deprecate legacy endpoints

## Action Items
- [ ] Alice: Draft migration guide
- [ ] Bob: Update client SDK
`);
ok(`Created "${doc3.title}" → ${doc3.slug} (v${doc3.version})`);

section('Save checkpoints (edits)');

const { doc: doc1v2 } = await paste.saveCheckpoint(doc1.slug, `# Getting Started with Deno

Deno is a modern runtime for JavaScript and TypeScript.

## Installation

\`\`\`bash
curl -fsSL https://deno.land/install.sh | sh
\`\`\`

## Hello World

\`\`\`typescript
console.log("Hello from Deno!");
\`\`\`

## Why Deno?

- Built-in TypeScript support
- Secure by default
- Modern standard library
- Built on web standards
`);
ok(`Checkpoint v${doc1v2.version} for "${doc1v2.title}" (${doc1v2.checkpointCount} total)`);

const { doc: doc1v3 } = await paste.saveCheckpoint(doc1.slug, `# Getting Started with Deno 2

Deno is a modern, secure runtime for JavaScript and TypeScript.

## Installation

\`\`\`bash
curl -fsSL https://deno.land/install.sh | sh
\`\`\`

## Hello World

\`\`\`typescript
console.log("Hello from Deno 2!");
\`\`\`

## Why Deno?

- Built-in TypeScript support
- Secure by default (permissions system)
- Modern standard library
- Built on web standards
- npm compatibility
`);
ok(`Checkpoint v${doc1v3.version} for "${doc1v3.title}" (${doc1v3.checkpointCount} total)`);

const { doc: doc2v2 } = await paste.saveCheckpoint(doc2.slug, `# Project Ideas

## Active
- [ ] Build a CLI tool for markdown linting
- [x] Create a webhook relay service — DONE

## Backlog
- [ ] Design a personal knowledge graph
- [ ] Markdown pastebin with version history
- [ ] AI-powered code review bot
`);
ok(`Checkpoint v${doc2v2.version} for "${doc2v2.title}" (${doc2v2.checkpointCount} total)`);

section('Read documents');

const fetched = await paste.getDoc(doc1.slug);
assert(fetched !== null, 'doc1 should exist');
assert(fetched!.version === 3, `doc1 should be v3, got v${fetched!.version}`);
ok(`Read "${fetched!.title}" — v${fetched!.version}, ${fetched!.checkpointCount} checkpoints`);

section('List documents');

const allDocs = await paste.listDocs();
ok(`Found ${allDocs.length} documents`);

section('View checkpoint history');

const cps = await paste.getCheckpoints(doc1.slug);
ok(`"${doc1v3.title}" has ${cps.length} checkpoints:`);
for (const cp of cps) {
  const delta = cp.bytesDelta >= 0 ? `+${cp.bytesDelta}` : `${cp.bytesDelta}`;
  console.log(`    v${cp.version} — ${cp.savedAt} (${delta} bytes)`);
}

section('Diff between versions');

const diff12 = await paste.diffVersions(doc1.slug, 1, 2);
ok(`Diff v1 → v2: ${diff12.length} changed lines`);
for (const line of diff12.slice(0, 8)) console.log(`    ${line}`);
if (diff12.length > 8) console.log(`    ... and ${diff12.length - 8} more`);

const diff23 = await paste.diffVersions(doc1.slug, 2, 3);
ok(`Diff v2 → v3: ${diff23.length} changed lines`);

section('Delete document');

await paste.deleteDoc(doc3.slug);
assert(await paste.getDoc(doc3.slug) === null, 'doc3 should be deleted');
ok(`Deleted "${doc3.title}"`);

section('Done');
console.log(`\n  ${checks} checks passed.`);
console.log(`\n  All data stored in Google Sheets.`);
console.log(`  Run serve.ts to browse at http://localhost:4444\n`);
