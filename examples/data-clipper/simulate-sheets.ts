#!/usr/bin/env -S deno run --allow-all
/**
 * Data Clipper — Google Sheets Simulation
 *
 * Same random data as simulate.ts, but rows land in a Google Sheet
 * via Sheetlog (Apps Script proxy). You can watch items appear live
 * in your spreadsheet while this runs.
 *
 * Requires:
 *   SHEET_URL env var = your Sheetlog Apps Script deployment URL
 *
 * Run:
 *   SHEET_URL=https://script.google.com/macros/s/.../exec deno task clipper:sheets
 *   deno task clipper:sheets --sheet=MyClips    # custom tab name
 *   deno task clipper:sheets --clean            # clear sheet first
 */

import { Sheetlog } from '../../src/clients/sheetlog/client.ts';

// ============================================================================
// Config
// ============================================================================

const SHEET_URL = Deno.env.get('SHEET_URL');
if (!SHEET_URL) {
  console.error(`
  Missing SHEET_URL environment variable.

  Set it to your Sheetlog Apps Script deployment URL:
    SHEET_URL=https://script.google.com/macros/s/.../exec deno task clipper:sheets

  Don't have one? Deploy sheetlog:
    https://github.com/yawnxyz/sheetlog
`);
  Deno.exit(1);
}

// Parse flags
const sheetName = Deno.args.find(a => a.startsWith('--sheet='))?.split('=')[1] || 'Clips';
const shouldClean = Deno.args.includes('--clean');

const client = new Sheetlog({ sheetUrl: SHEET_URL, sheet: sheetName });

// ============================================================================
// Helpers
// ============================================================================

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
}

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function log(icon: string, msg: string) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`  [${time}] ${icon} ${msg}`);
}

// ============================================================================
// Same data pools as the local simulation
// ============================================================================

const BOOKMARK_POOL = [
  { title: 'Variable Fonts: A Complete Guide', url: 'https://fonts.google.com/knowledge/variable-fonts', tags: 'typography,fonts,css', excerpt: 'Everything you need to know about variable fonts.' },
  { title: 'Design Tokens in Figma', url: 'https://blog.figma.com/design-tokens', tags: 'figma,design-tokens,systems', excerpt: 'How to set up and maintain design tokens in Figma.' },
  { title: 'Container Queries Are Here', url: 'https://web.dev/container-queries', tags: 'css,responsive,web', excerpt: 'Style elements based on container size.' },
  { title: 'The UX of AI Assistants', url: 'https://nngroup.com/ai-ux', tags: 'ai,ux,research', excerpt: 'Research on how users interact with AI interfaces.' },
  { title: 'Radix UI Primitives', url: 'https://radix-ui.com', tags: 'react,components,a11y', excerpt: 'Unstyled, accessible UI primitives.' },
  { title: 'Motion Design Principles', url: 'https://material.io/motion', tags: 'motion,animation,material', excerpt: 'How motion enhances user experience.' },
  { title: 'Micro-Interactions That Delight', url: 'https://uxdesign.cc/micro-interactions', tags: 'ux,animation,delight', excerpt: 'Small interactions that make a big difference.' },
];

const NOTE_POOL = [
  { title: 'Brainstorm: New Onboarding Flow', content: 'Progressive disclosure, gamification, personalized paths', tags: 'brainstorm,onboarding,ux' },
  { title: 'Research: Dark Mode Best Practices', content: 'Desaturated colors, avoid pure black, test contrast', tags: 'research,dark-mode,a11y' },
  { title: 'Quick Note: Typography Scale', content: '1.25 major third: 12, 15, 18.75, 23.4, 29.3, 36.6', tags: 'typography,scale,quick' },
  { title: 'Competitive Analysis: Notion vs Linear', content: 'Speed: Linear wins. Design: Linear cleaner. Mobile: Linear.', tags: 'analysis,tools,comparison' },
  { title: 'Idea: AI-Powered Color Suggestions', content: 'LLM + color theory for mood-based palette generation', tags: 'idea,ai,color' },
];

const EMAIL_POOL = [
  { from: 'dense-discovery@newsletter.com', subject: 'Dense Discovery #288', body: 'Open-source design tool, typography generator, sustainable web design', tags: 'newsletter,design' },
  { from: 'bytes@ui.dev', subject: 'Bytes #313 — Server Components', body: 'How server components change React data fetching. Plus Bun 2.0.', tags: 'newsletter,dev,react' },
  { from: 'carol@studio.io', subject: 'Brand Assets — Final Review', body: 'Please review final brand assets. Logo, colors, icons updated. Due Friday.', tags: 'work,brand,review' },
  { from: 'dave@client.co', subject: 'Feedback on Prototype v2', body: 'Team loved the nav! Concerns: search prominence, mobile footer crowded.', tags: 'work,feedback,prototype' },
  { from: 'smashing@newsletter.com', subject: 'Smashing Newsletter #412', body: 'CSS scroll-driven animations, accessible forms, design system content strategy.', tags: 'newsletter,css,a11y' },
  { from: 'alice@agency.com', subject: 'Invoice #012 — February Retainer', body: 'Design consulting. 40 hours. $6,000. Due March 15.', tags: 'work,finance,invoice' },
];

const EVENT_POOL = [
  { source: 'github', event: 'push', description: 'Fix button hover state in dark mode' },
  { source: 'github', event: 'pr_merged', description: 'Implement responsive navigation component' },
  { source: 'github', event: 'issue_opened', description: 'Color contrast fails WCAG AA on card component' },
  { source: 'figma', event: 'file_updated', description: 'Updated tab bar icons and bottom sheet pattern' },
  { source: 'figma', event: 'comment_added', description: 'Carol: Logo spacing needs 2px more padding' },
  { source: 'stripe', event: 'payment_succeeded', description: 'Monthly Figma Team subscription ($49)' },
  { source: 'vercel', event: 'deployment', description: 'Production deployment succeeded (v2.3.1)' },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================================
// Simulation
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log(`\u2551  Data Clipper \u2014 Google Sheets Simulation                    \u2551`);
  console.log(`\u2551  Sheet: "${sheetName}"                                         \u2551`);
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  // ── Phase 0: Clean if requested ─────────────────────────────
  if (shouldClean) {
    console.log('\n\u2500\u2500 Cleaning sheet... \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    try {
      const existing = await client.get();
      if (existing?.data?.length) {
        const ids = existing.data.map((r: any) => r._id).filter(Boolean);
        if (ids.length > 0) {
          await client.bulkDelete(ids);
          log('\ud83d\uddd1\ufe0f', `Deleted ${ids.length} existing rows`);
        }
      }
    } catch (e: any) {
      log('\u26a0\ufe0f', `Clean failed (sheet may be empty): ${e.message}`);
    }
  }

  // ── Phase 1: Simulate incoming data ─────────────────────────
  console.log('\n\u2500\u2500 Phase 1: Posting items to Google Sheet (15 rows) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const rows: any[] = [];

  for (let i = 0; i < 15; i++) {
    const roll = Math.random();
    const now = ts();

    let row: any;
    if (roll < 0.25) {
      const bm = pick(BOOKMARK_POOL);
      row = {
        id: `clip-${slug(bm.title)}-${Date.now()}`,
        type: 'bookmark',
        title: bm.title,
        url: bm.url,
        tags: bm.tags,
        excerpt: bm.excerpt,
        source: 'manual',
        saved: now,
      };
      log('\ud83d\udd17', `Clipped: "${bm.title}"`);
    } else if (roll < 0.45) {
      const note = pick(NOTE_POOL);
      row = {
        id: `note-${slug(note.title)}-${Date.now()}`,
        type: 'note',
        title: note.title,
        content: note.content,
        tags: note.tags,
        created: now,
      };
      log('\ud83d\udcdd', `Note: "${note.title}"`);
    } else if (roll < 0.70) {
      const email = pick(EMAIL_POOL);
      row = {
        id: `email-${slug(email.subject)}-${Date.now()}`,
        type: 'email',
        subject: email.subject,
        from: email.from,
        body: email.body,
        tags: email.tags,
        read: 'false',
        received: now,
      };
      log('\ud83d\udce7', `Email: "${email.subject}"`);
    } else {
      const evt = pick(EVENT_POOL);
      row = {
        id: `event-${slug(evt.description)}-${Date.now()}`,
        type: 'event',
        source: evt.source,
        event: evt.event,
        description: evt.description,
        tags: `${evt.source},${evt.event}`,
        timestamp: now,
      };
      log('\u26a1', `Event: [${evt.source}] ${evt.description}`);
    }

    rows.push(row);
    await sleep(100); // small delay for unique timestamps
  }

  // Batch post all rows at once (dynamicPost auto-creates columns)
  log('\ud83d\udce4', `Posting ${rows.length} rows to sheet "${sheetName}"...`);
  try {
    await client.dynamicPost(rows);
    log('\u2705', `Posted ${rows.length} rows`);
  } catch (e: any) {
    console.error(`  POST failed: ${e.message}`);
    Deno.exit(1);
  }

  // ── Phase 2: Read back and verify ───────────────────────────
  console.log('\n\u2500\u2500 Phase 2: Reading data back from sheet \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  await sleep(1000); // give Sheets a moment to settle
  const response = await client.get();
  const allRows = response?.data || [];
  log('\ud83d\udcca', `Sheet has ${allRows.length} total rows`);

  // Count by type
  const byType: Record<string, number> = {};
  for (const row of allRows) {
    const type = row.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    log('\ud83d\udcca', `  ${type}: ${count} rows`);
  }

  // ── Phase 3: Find/filter items ──────────────────────────────
  console.log('\n\u2500\u2500 Phase 3: Filtering data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Filter emails
  const emails = allRows.filter((r: any) => r.type === 'email');
  log('\u2709\ufe0f', `Found ${emails.length} emails`);

  // Filter by tag
  const designItems = allRows.filter((r: any) => (r.tags || '').includes('design'));
  log('\ud83c\udfa8', `Items tagged "design": ${designItems.length}`);

  // Use Sheetlog's FIND to search by column
  try {
    const found = await client.find('type', 'bookmark', true);
    const bookmarks = found?.data || [];
    log('\ud83d\udd0d', `FIND type=bookmark: ${bookmarks.length} matches`);
  } catch {
    log('\ud83d\udd0d', 'FIND not available (older sheetlog version)');
  }

  // ── Phase 4: Update a row (mark email as read) ──────────────
  console.log('\n\u2500\u2500 Phase 4: Updating data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  if (emails.length > 0) {
    const emailToUpdate = emails[0];
    try {
      await client.upsert('id', emailToUpdate.id, {
        ...emailToUpdate,
        read: 'true',
        readAt: ts(),
      });
      log('\u2705', `Marked "${emailToUpdate.subject}" as read (upsert by id)`);
    } catch {
      // Fallback: update by row _id
      if (emailToUpdate._id) {
        await client.put(emailToUpdate._id, { read: 'true', readAt: ts() });
        log('\u2705', `Marked "${emailToUpdate.subject}" as read (put by _id)`);
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log('  Simulation complete!');
  console.log(`  Sheet: "${sheetName}" — ${allRows.length} total rows`);
  console.log('');
  console.log('  Open your Google Sheet to see the data live.');
  console.log('  Columns are auto-created: id, type, title, url, tags, etc.');
  console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);
  console.log('  Run again to add more rows. Use --clean to clear first.\n');
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
