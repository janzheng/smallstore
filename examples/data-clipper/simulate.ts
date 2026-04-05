#!/usr/bin/env -S deno run --allow-all
/**
 * Data Clipper — Simulation Mode
 *
 * Simulates realistic usage: clips arriving over time, emails forwarded,
 * events webhooks firing. Data stored as pretty-printed JSON files so you
 * can browse them directly in your editor or file manager.
 *
 * Storage: local-json (one .json file per item, human-readable)
 *
 * Run:
 *   deno task clipper:sim           # simulate usage
 *   deno task clipper:sim --clean   # wipe and re-simulate
 */

import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';
import {
  createSmallstore,
  createMemoryAdapter,
  createLocalJsonAdapter,
} from '../../mod.ts';

// ============================================================================
// Config
// ============================================================================

const APP_DIR = import.meta.dirname!;
const DATA_DIR = join(APP_DIR, 'data');
const JSON_DIR = join(DATA_DIR, 'json');

const NS = 'design-stuff';

if (Deno.args.includes('--clean')) {
  try { await Deno.remove(DATA_DIR, { recursive: true }); } catch { /* ok */ }
  console.log('Cleaned data directory.\n');
}
await Deno.mkdir(DATA_DIR, { recursive: true });

// ============================================================================
// Helpers
// ============================================================================

function slug(text: string): string {
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

// ============================================================================
// Simulation data pools — random picks from these
// ============================================================================

const BOOKMARK_POOL = [
  { title: 'Variable Fonts: A Complete Guide', url: 'https://fonts.google.com/knowledge/variable-fonts', tags: 'typography,fonts,css', excerpt: 'Everything you need to know about variable fonts and how to use them on the web.' },
  { title: 'Design Tokens in Figma', url: 'https://blog.figma.com/design-tokens', tags: 'figma,design-tokens,systems', excerpt: 'How to set up and maintain design tokens directly in Figma.' },
  { title: 'Container Queries Are Here', url: 'https://web.dev/container-queries', tags: 'css,responsive,web', excerpt: 'CSS Container Queries let you style elements based on their container size.' },
  { title: 'The UX of AI Assistants', url: 'https://nngroup.com/ai-ux', tags: 'ai,ux,research', excerpt: 'Research findings on how users interact with AI-powered interfaces.' },
  { title: 'Radix UI Primitives', url: 'https://radix-ui.com', tags: 'react,components,a11y', excerpt: 'Unstyled, accessible UI primitives for building high-quality design systems.' },
  { title: 'Motion Design Principles', url: 'https://material.io/motion', tags: 'motion,animation,material', excerpt: 'How motion can enhance user experience and create meaningful transitions.' },
  { title: 'Color Spaces and Gamut Mapping', url: 'https://lea.verou.me/color-spaces', tags: 'color,css,design', excerpt: 'Understanding P3, Lab, and oklch color spaces for modern web design.' },
  { title: 'Micro-Interactions That Delight', url: 'https://uxdesign.cc/micro-interactions', tags: 'ux,animation,delight', excerpt: 'Small interactions that make a big difference in user experience.' },
  { title: 'Building a Design System from Scratch', url: 'https://medium.com/design-system-scratch', tags: 'design-system,components,process', excerpt: 'A practical step-by-step guide to creating your first design system.' },
  { title: 'SVG Animation Techniques', url: 'https://css-tricks.com/svg-animation', tags: 'svg,animation,css', excerpt: 'Advanced SVG animation using CSS and SMIL for rich visual effects.' },
];

const NOTE_POOL = [
  { title: 'Brainstorm: New Onboarding Flow', content: '## Ideas\n\n- Progressive disclosure pattern\n- Gamification elements (badges)\n- Personalized path based on role\n- Skip option for power users', tags: 'brainstorm,onboarding,ux' },
  { title: 'Research: Dark Mode Best Practices', content: '## Key Findings\n\n1. Use desaturated colors\n2. Avoid pure black backgrounds\n3. Test contrast ratios\n4. Provide system preference detection', tags: 'research,dark-mode,a11y' },
  { title: 'Meeting: Q2 Sprint Planning', content: '## Action Items\n\n- [ ] Finalize component library\n- [ ] Ship responsive nav\n- [ ] User testing round 2\n- [ ] Accessibility audit', tags: 'meeting,sprint,planning' },
  { title: 'Quick Note: Typography Scale', content: 'Using a 1.25 major third scale:\n12, 15, 18.75, 23.4, 29.3, 36.6, 45.8\n\nWorks well for body-heavy content.', tags: 'typography,scale,quick' },
  { title: 'Competitive Analysis: Notion vs Linear', content: '## Comparison\n\n| Feature | Notion | Linear |\n|---------|--------|--------|\n| Speed | Slow | Fast |\n| Design | Dense | Clean |\n| Mobile | OK | Great |', tags: 'analysis,tools,comparison' },
  { title: 'Idea: AI-Powered Color Suggestions', content: 'What if the design tool could suggest complementary colors based on the mood/brand keywords you provide? Uses LLM + color theory.', tags: 'idea,ai,color' },
];

const EMAIL_POOL = [
  { from: 'dense-discovery@newsletter.com', subject: 'Dense Discovery #288', body: 'This week: an open-source design tool, a typography specimen generator, sustainable web design practices, and a documentary about Dieter Rams.', tags: 'newsletter,design,inspiration' },
  { from: 'sidebar@newsletter.com', subject: 'Sidebar #413 — Design Links of the Week', body: 'Top picks: animated gradient backgrounds, new Tailwind features, voice UI patterns, design system governance, and ethical AI design.', tags: 'newsletter,design,css' },
  { from: 'bytes@ui.dev', subject: 'Bytes #313 — Server Components Deep Dive', body: 'How server components change everything we know about React data fetching. Plus: Bun 2.0, Vite 6, and CSS nesting goes mainstream.', tags: 'newsletter,dev,react' },
  { from: 'carol@studio.io', subject: 'Brand Assets — Final Review', body: 'Hi! Please review the final brand assets package. Logo, colors, and icon set are all updated per our last meeting. Deadline: Friday.', tags: 'work,brand,review' },
  { from: 'dave@client.co', subject: 'Feedback on Prototype v2', body: 'The team loved the new navigation! Two concerns: (1) search should be more prominent, (2) mobile footer feels crowded. Overall great progress.', tags: 'work,feedback,prototype' },
  { from: 'smashing@newsletter.com', subject: 'Smashing Newsletter #412', body: 'This issue: CSS scroll-driven animations, accessible form patterns, and why your design system needs a content strategy.', tags: 'newsletter,css,a11y' },
  { from: 'alice@agency.com', subject: 'Invoice #012 — February Retainer', body: 'Monthly retainer invoice for design consulting services. Hours: 40. Total: $6,000. Due: March 15.', tags: 'work,finance,invoice' },
  { from: 'hackernews@digest.com', subject: 'HN Daily — AI Design Tools', body: 'Top stories: Figma AI features launch, GitHub Copilot for design, and a debate about whether AI will replace designers (spoiler: no).', tags: 'newsletter,ai,design' },
];

const EVENT_POOL = [
  { source: 'github', event: 'push', repo: 'acme/design-system', branch: 'main', description: 'Fix button hover state in dark mode' },
  { source: 'github', event: 'pr_merged', repo: 'acme/design-system', branch: 'feat/responsive-nav', description: 'Implement responsive navigation component' },
  { source: 'github', event: 'issue_opened', repo: 'acme/web-app', description: 'Color contrast fails WCAG AA on card component' },
  { source: 'figma', event: 'file_updated', file: 'Mobile App v4', description: 'Updated tab bar icons and bottom sheet pattern' },
  { source: 'figma', event: 'comment_added', file: 'Brand Guidelines v3', description: 'Carol commented: "Logo spacing needs 2px more padding"' },
  { source: 'stripe', event: 'payment_succeeded', amount: 4900, description: 'Monthly Figma Team subscription' },
  { source: 'stripe', event: 'payment_succeeded', amount: 2900, description: 'Annual domain renewal — acme.design' },
  { source: 'vercel', event: 'deployment', project: 'design-system-docs', description: 'Production deployment succeeded (v2.3.1)' },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================================
// Simulation
// ============================================================================

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log(`\u2551  Data Clipper \u2014 Simulation (local-json)                     \u2551`);
  console.log(`\u2551  Namespace: "${NS}"                                          \u2551`);
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  // local-json: each item = one pretty-printed .json file
  const jsonAdapter = createLocalJsonAdapter({ baseDir: JSON_DIR, prettyPrint: true });
  const store = createSmallstore({
    adapters: {
      json: jsonAdapter,
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'json',
  });

  // ── Phase 1: Simulate incoming data ─────────────────────────
  console.log('\n\u2500\u2500 Phase 1: Simulating incoming data (20 items) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  let itemCount = 0;

  for (let i = 0; i < 20; i++) {
    const roll = Math.random();

    if (roll < 0.25) {
      const bm = pick(BOOKMARK_POOL);
      const key = `${NS}/clips/${slug(bm.title)}-${Date.now()}`;
      await store.set(key, {
        type: 'bookmark', ...bm, source: 'manual', saved: ts(),
      }, { mode: 'replace' });
      log('\ud83d\udd17', `Clipped: "${bm.title}"`);
    } else if (roll < 0.45) {
      const note = pick(NOTE_POOL);
      const key = `${NS}/notes/${slug(note.title)}-${Date.now()}`;
      await store.set(key, {
        type: 'note', ...note, created: ts(), updated: ts(),
      }, { mode: 'replace' });
      log('\ud83d\udcdd', `Note: "${note.title}"`);
    } else if (roll < 0.70) {
      const email = pick(EMAIL_POOL);
      const key = `${NS}/emails/${slug(email.subject)}-${Date.now()}`;
      await store.set(key, {
        type: 'email', ...email, read: false, received: ts(),
      }, { mode: 'replace' });
      log('\ud83d\udce7', `Email: "${email.subject}"`);
    } else {
      const evt = pick(EVENT_POOL);
      const key = `${NS}/events/${slug(evt.description)}-${Date.now()}`;
      await store.set(key, {
        type: 'event', ...evt, timestamp: ts(),
      }, { mode: 'replace' });
      log('\u26a1', `Event: [${evt.source}] ${evt.description}`);
    }
    itemCount++;
    await sleep(50);
  }

  // Flush all pending writes to disk
  await jsonAdapter.flush();

  log('\u2705', `Ingested ${itemCount} items into "${NS}"`);

  // ── Phase 2: Read back + patch ──────────────────────────────
  console.log('\n\u2500\u2500 Phase 2: Reading and patching data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Mark some emails as read
  const emailKeys = await store.keys(`${NS}/emails`);
  let readCount = 0;
  for (const k of emailKeys.slice(0, 2)) {
    const data = unwrap(await store.get(`${NS}/${k}`));
    if (data) {
      await store.set(`${NS}/${k}`, { ...data, read: true, readAt: ts() }, { mode: 'replace' });
      readCount++;
    }
  }
  await jsonAdapter.flush();
  log('\u2709\ufe0f', `Marked ${readCount} emails as read`);

  // Read a random item back
  const allKeys = await store.keys(NS);
  if (allKeys.length > 0) {
    const randomKey = pick(allKeys);
    const item = unwrap(await store.get(`${NS}/${randomKey}`));
    if (item) {
      log('\ud83d\udd0d', `Read back: [${item.type}] "${item.title || item.subject || item.description || randomKey}"`);
    }
  }

  // ── Phase 3: Browse the data ────────────────────────────────
  console.log('\n\u2500\u2500 Phase 3: Browsing data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Count items per type
  const byType: Record<string, number> = {};
  for (const k of allKeys) {
    const item = unwrap(await store.get(`${NS}/${k}`));
    if (item?.type) {
      byType[item.type] = (byType[item.type] || 0) + 1;
    }
  }
  for (const [type, count] of Object.entries(byType)) {
    log('\ud83d\udcca', `  ${type}: ${count} items`);
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log('  Simulation complete!');
  console.log(`  Data: ${JSON_DIR}`);
  console.log(`  Total: ${allKeys.length} items as .json files`);
  console.log('');
  console.log('  Browse your data:');
  console.log(`    ls ${JSON_DIR}/smallstore/${NS}/`);
  console.log(`    cat ${JSON_DIR}/smallstore/${NS}/clips/*.json`);
  console.log(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);
  console.log('  Run again to add more data. Use --clean to reset.\n');
}

main().catch((err) => {
  console.error(`\n\u2717 FAILED: ${err.message}`);
  console.error(err.stack);
  Deno.exit(1);
});
