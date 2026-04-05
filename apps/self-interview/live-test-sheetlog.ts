#!/usr/bin/env -S deno run --allow-all --no-check
// Live test with Groq API + Sheetlog (Google Sheets) storage
// Long conversation (20 turns) to stress-test LCM summarization with sheet persistence

import "jsr:@std/dotenv/load";

const origLog = console.log;
const SUPPRESS = /\[Smallstore\]|\[KeyIndex\]|\[Sheetlog/;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && SUPPRESS.test(args[0])) return;
  origLog(...args);
};

import { InterviewEngine } from "./engine.ts";
import { createSheetlogKV } from "./sheetlog-kv.ts";
import { createOpenAICompleteFn } from "./ai.ts";

const DIM = "\x1b[90m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

// ============================================================================
// Config
// ============================================================================

const groqKey = Deno.env.get("GROQ_API_KEY");
if (!groqKey) {
  console.error(`${RED}GROQ_API_KEY not set${RESET}`);
  Deno.exit(1);
}

const sheetUrl = Deno.env.get("SM_SHEET_URL");
if (!sheetUrl) {
  console.error(`${RED}SM_SHEET_URL not set${RESET}`);
  Deno.exit(1);
}

const sheetName = "self-interview";
const model = "llama-3.3-70b-versatile";

// ============================================================================
// Test
// ============================================================================

async function runSheetlogTest() {
  origLog(`\n${MAGENTA}${BOLD}Sheetlog Interview Test${RESET} ${DIM}— Groq ${model}${RESET}`);
  origLog(`${DIM}Sheet: ${sheetName} via ${sheetUrl!.slice(0, 60)}...${RESET}\n`);

  const store = createSheetlogKV({ sheetUrl: sheetUrl!, sheet: sheetName });
  const complete = createOpenAICompleteFn({
    apiKey: groqKey!,
    baseUrl: "https://api.groq.com/openai/v1",
    model,
  });
  const engine = new InterviewEngine({ store, complete, verbose: true });

  // ---- Phase 1: Start session ----
  origLog(`${CYAN}${BOLD}Phase 1: Start project-discovery session${RESET}`);

  const { isNew, greeting } = await engine.startSession({
    session: "sheetlog-test",
    mission: "project-discovery",
    fresh: true,
  });

  origLog(`${DIM}  New: ${isNew}${RESET}`);
  origLog(`${GREEN}AI: ${greeting}${RESET}\n`);

  // ---- Phase 2: Long conversation (20 turns — designed to trigger multiple LCM summarization rounds) ----
  origLog(`${CYAN}${BOLD}Phase 2: Conversation (20 turns, ~12k tokens target)${RESET}\n`);

  const userMessages = [
    // Turn 1 — project intro (~200 words)
    "I'm building a tool called Smallstore. It's a universal key-value storage abstraction layer that works across Deno and Node.js. The core idea is simple: you write your code against one API — get, set, delete, list — and Smallstore handles the translation to whatever backend you're actually using. Whether that's SQLite for local development, Redis for production caching, Notion for collaborative databases, Google Sheets for quick prototyping, Airtable for structured data, S3/R2 for file storage, or Obsidian for personal knowledge management. The developer never has to learn 17 different APIs. They learn one. The project started about 8 months ago when I was building a personal bookmarking tool and realized I kept rewriting the same storage abstraction over and over. Every project needed slightly different backends but the operations were always the same: save this data, get it back later, maybe search it. I figured other developers had the same problem.",

    // Turn 2 — problem space (~200 words)
    "Let me explain the problem in more depth. Say you're an indie developer building a side project on a weekend. You start with SQLite because it's fast and local. Your app works great. Now your co-founder wants to see the data, so you need to move to something shared. Traditionally, that means rewriting your data layer — new ORM, new connection strings, new query syntax, maybe even a new schema. With Smallstore, you literally change one line: swap the adapter from SQLite to Notion or Google Sheets. Your co-founder can now see and even edit the data directly in Notion, while your app keeps running unchanged. The same pattern applies at scale: you might start with Google Sheets for a prototype, then graduate to Redis or PostgreSQL when you need performance, then add R2 for binary assets. Each transition is just swapping an adapter config. No code changes, no data migration scripts, no downtime.",

    // Turn 3 — audience & users (~200 words)
    "The primary audience is indie hackers and small development teams who need to move fast. These are people building MVPs, internal tools, personal projects, and side businesses. They don't have time to set up a proper database infrastructure. They don't want to learn yet another ORM. They just want to store data and retrieve it. Our secondary audience is developers building AI applications — there's a huge overlap because AI workflows constantly need to stash intermediate results, conversation histories, embeddings, and config data somewhere. Smallstore's simple KV interface is perfect for that. We have about 50 beta users right now. Most of them found us through Deno's module registry or through word of mouth. The most active users are building things like personal CRMs, bookmark managers, note-taking apps, and AI agent frameworks. One user is using it to sync data between Obsidian and Notion for a personal knowledge management system. Another is using the Sheetlog adapter to log sensor data from IoT devices directly to Google Sheets.",

    // Turn 4 — technical architecture (~250 words)
    "The architecture is layered. At the bottom you have adapter implementations — each one knows how to talk to a specific backend. SQLite uses better-sqlite3, Notion uses their REST API, Sheetlog uses Google Apps Script endpoints, Redis uses ioredis, and so on. Above that is the Smallstore interface which defines the contract: get(key), set(key, value, options), delete(key), has(key), keys(prefix), clear(). Every adapter must implement this interface. The options parameter on set() is important — it supports modes like 'overwrite', 'append', 'merge', and adapter-specific options. Above the raw KV layer, we have the VFS (Virtual File System) layer. This gives you bash-like commands: ls, cd, cat, write, rm, cp, mv, find, grep, tree, du, wc. It's designed for AI agents that think in terms of file operations. You can pipe commands together with |, chain with &&, and format output as JSON, CSV, markdown, or YAML. The VFS makes Smallstore feel like a filesystem but backed by any storage engine. We also have a snapshot system that lets you take point-in-time snapshots of your entire store and restore them later. This is built on top of the VFS layer. The whole thing is about 12,000 lines of TypeScript across 30+ files.",

    // Turn 5 — adapter deep dive (~250 words)
    "Let me walk through the adapters in detail. We have 17 right now, grouped into categories. Local adapters: Memory (for testing and ephemeral data), SQLite (our workhorse for local development, supports full-text search), and JSON file (simple file-based storage). Cloud adapters: Notion (full rich-text support, database properties, page body content), Airtable (structured records with field types), Google Sheets via Sheetlog (row-based storage with formula support), Cloudflare R2 (S3-compatible object storage), and Cloudflare KV (edge key-value). Specialized adapters: Obsidian (reads/writes to an Obsidian vault's markdown files), Redis (with TTL and pub/sub support), and HTTP (proxies to any Smallstore-compatible API endpoint). We also have overlay adapters that compose: VFS overlay (adds filesystem semantics), Snapshot overlay (adds point-in-time snapshots), and Cache overlay (adds in-memory caching with TTL). Each adapter has its own quirks. For example, Notion has a 2000-character limit on database properties, so we added a 'contentProperty' option that stores content in the page body instead. Sheetlog has eventual consistency because Google Sheets isn't a real database. SQLite supports transactions but most cloud adapters don't. We handle these differences through the options parameter and adapter-specific configuration.",

    // Turn 6 — VFS layer details (~200 words)
    "The VFS layer deserves special attention because it's one of our most innovative features. The idea came from observing how AI agents interact with data. When you give an AI agent a filesystem, it immediately knows what to do — ls to explore, cat to read, write to create. These are universal metaphors that every developer and every AI model understands. So we built a virtual filesystem on top of Smallstore. You can do things like: 'cd projects/smallstore && ls' to browse, 'cat README.md --format=json' to read with formatting, 'find . --name \"*.ts\" | wc -l' to count files, 'grep -r \"TODO\" --format=md' to search, 'tree --depth=2' to visualize structure. The VFS maintains a current working directory and supports both absolute and relative paths. It has a REPL mode where you can interactively explore your data, and a one-shot mode for scripts. We also built an agent interface where an AI can programmatically call vfs(command, options) and get structured output with exit codes.",

    // Turn 7 — competition & differentiation (~200 words)
    "In terms of competition, there are a few players in adjacent spaces but nobody doing exactly what we do. Prisma and Drizzle are ORMs that abstract databases, but they're SQL-focused — they don't work with Notion, Google Sheets, or Obsidian. Keyv is a simple KV store with adapters for Redis, MongoDB, and SQL, but it's much more limited — no VFS, no rich content support, no sync between backends. UnifiedDB tried something similar years ago but died because they tried to do too much SQL abstraction. Our differentiator is what I call the 'messy desk' philosophy. Traditional databases force you to define schemas upfront. Smallstore lets you just throw data at it — JSON objects, markdown documents, binary files, nested structures — and it figures out the best way to store it in whatever backend you're using. Each adapter has its own serialization strategy. SQLite uses JSON columns, Notion maps to its property types, Sheets flatten to rows. The developer doesn't need to think about any of this.",

    // Turn 8 — the interview app itself (~200 words)
    "Let me tell you about the app we're building right now — the Self-Interview App. It's both a real product and a showcase for what Smallstore can do. The idea is that you can have a long, structured interview with an AI interviewer that remembers everything you've said across sessions. It uses a technique called Lossless Context Management — LCM — which is a system for managing long conversations without losing information. As the conversation grows, older messages get summarized into a DAG (directed acyclic graph) of summaries. Recent messages stay in full, while older context is compressed but still searchable. The AI can use tools to search the full history via BM25 or regex, take structured notes with categories, and reference back to things you said hours or days ago. All of this state — the message log, the summary DAG, the notes, the session metadata — is persisted through Smallstore. So you can back it with SQLite for local use, or Google Sheets if you want to inspect the raw data in a spreadsheet.",

    // Turn 9 — LCM details (~250 words)
    "The LCM system is the heart of the interview engine. Here's how it works in detail. Every message — user and assistant — gets appended to an immutable store with a sequence number and token estimate. When the active message count exceeds a threshold (keepLastN + chunkSize, default 16), the oldest chunk of messages gets summarized by the AI into a summary node. The summary preserves key facts, names, dates, quotes, emotions, and insights. The original messages are marked as 'archived by' the summary ID but never deleted — they're still searchable via the grep tool. As summaries accumulate, they get compacted: when 3+ level-1 summaries exist, the older ones are merged into a level-2 summary. This creates a hierarchical DAG where the top-level nodes cover broader time ranges. There's also an escalation protocol as a safety net. If the assembled context exceeds the soft threshold (8000 tokens), level-1 escalation triggers aggressive summarization. If it exceeds the hard threshold (16000 tokens), a deterministic fallback truncates messages. The whole system ensures that even after hours of conversation, the AI always has access to the full history through summaries and search, while keeping the active context window manageable. The context assembly process puts summaries in the system prompt under 'Earlier Conversation' and recent messages as the conversation tail.",

    // Turn 10 — notes system (~200 words)
    "The notes system is the other key piece. During the conversation, the AI interviewer has access to tools for managing structured notes. There are five tools: note_write (create a note with category, text, and optional verbatim quote), note_read (list notes by category or all), note_update (modify an existing note), note_delete (remove a note), and note_search (search notes by keyword). Notes are categorized — for a project discovery interview, categories might be 'goal', 'risk', 'audience', 'timeline', 'budget', 'differentiator', 'constraint'. The AI is instructed to proactively take notes during the conversation, capturing key facts, decisions, and insights. Notes serve a dual purpose: they're the primary output of an interview session (exportable as markdown), and they help the AI maintain awareness of what's been covered. When resuming a session, the AI reads its notes to recall what topics have been discussed and what gaps remain. The note_search tool uses simple substring matching, while the lcm_grep tool searches the full conversation history using BM25 ranking.",

    // Turn 11 — missions system (~200 words)
    "Interviews are guided by 'missions' — pre-configured profiles that define the interviewer's persona, expertise, and question strategy. We ship with several built-in missions. 'life-story' is for personal memoir interviews — the AI acts as a warm, experienced biographer drawing out stories and memories. 'project-discovery' is for understanding a software project's goals, architecture, and constraints — the AI acts as a senior technical PM. 'founder-story' captures the origin story and vision of a startup founder. 'technical-deep-dive' goes deep on architecture, system design, and technical decisions. You can also create custom missions by providing a description, and the system generates an appropriate persona and question strategy. Each mission defines: a system prompt (the interviewer's full instructions and persona), a set of opener questions (randomly selected for new sessions), and suggested note categories. The mission system is extensible — you can add new missions by creating a simple object with these fields. We're planning to add a 'mission builder' that lets you iteratively refine an interview mission through conversation.",

    // Turn 12 — technical challenges (~250 words)
    "The biggest technical challenge has been making the abstraction not leak. Every backend has fundamentally different capabilities and performance characteristics. SQLite gives you ACID transactions, full-text search, and sub-millisecond reads. Notion gives you rich text with formatting, inline databases, and real-time collaboration, but API calls take 200-500ms and have rate limits. Google Sheets via Sheetlog has eventual consistency — writes take 1-3 seconds to propagate, reads might not see the latest write, and there's a hard limit of 10 million cells per spreadsheet. Redis is blazing fast but ephemeral by default. R2 is great for large objects but terrible for small key-value pairs. We handle this through a combination of adapter-specific options, graceful degradation, and documentation. For example, the Notion adapter automatically chunks large content into page body blocks when it exceeds the 2000-character property limit. The Sheetlog adapter wraps all values as JSON strings in a 'content' column because Sheets can't natively store nested objects. The SQLite adapter supports optional full-text search indexes. But we explicitly don't try to provide query capabilities across all adapters — that would be a fool's errand. If you need complex queries, use SQLite or a real database. Smallstore is for simple key-value access patterns.",

    // Turn 13 — real-world usage story (~200 words)
    "Let me tell you about a real user story that shaped our development. A developer named Marcus was building a personal CRM to track his professional network. He started with SQLite locally, which worked great for him. But then he wanted his virtual assistant (an AI agent) to also access and update the contact data. The agent was running on a different server. His first thought was to set up a PostgreSQL instance, but that felt like overkill for what was essentially a contacts list. Instead, he pointed his app at Smallstore's Notion adapter. Now both his local app and his AI agent could read and write contacts through Notion's API. Even better, he could open Notion in his browser and see all the contact data in a nice table with filters and sorts. When a contact's data exceeded Notion's property limits, the contentProperty feature seamlessly moved the overflow to the page body. Marcus's story validated our core thesis: developers want simple storage that 'just works' across different contexts without infrastructure overhead.",

    // Turn 14 — sync & consistency (~200 words)
    "One of the hardest unsolved problems is cross-adapter sync. Right now, you can use Smallstore to read from one backend and write to another, but there's no built-in automatic synchronization. We have a prototype sync system that uses a 'syncId' for three-way merge — it tracks what each adapter has seen and reconciles differences. The demo syncs an Obsidian vault with a Notion database bidirectionally. It works, but it's complex and fragile. The fundamental challenge is that different backends have different consistency models. SQLite is strongly consistent. Notion has version conflicts. Google Sheets has eventual consistency with potential data races. Redis might evict data. Trying to synchronize all of these while preserving data integrity is a distributed systems problem that major companies spend years solving. My current thinking is to not build general-purpose sync into the core library. Instead, offer it as an optional overlay adapter that users can opt into with clear documentation about the tradeoffs and limitations. The sync overlay would support configurable conflict resolution strategies: last-write-wins, manual merge, or custom resolver functions.",

    // Turn 15 — developer experience & DX (~200 words)
    "Developer experience is everything for an open-source tool like this. If it's not delightful to use in the first 5 minutes, nobody will stick around. We've invested heavily in DX. The getting-started experience is: install from JSR (Deno's module registry), import createSmallstore, choose a preset, and start calling get/set. Three lines of code to go from zero to working storage. The VFS REPL lets you interactively explore your data like a filesystem — it's great for debugging and quick data manipulation. The CLI supports all CRUD operations plus batch import/export. Error messages are detailed and actionable — instead of 'connection failed', you get 'Notion API returned 401: check that NOTION_API_KEY is set and the integration has access to the database'. We auto-detect environment variables for common configurations so you don't need config files for simple cases. The TypeScript types are comprehensive with JSDoc on every public method. We generate API documentation automatically. The test suite has over 200 tests across all adapters. Every adapter has both unit tests with mocks and live integration tests against real services.",

    // Turn 16 — roadmap & priorities (~200 words)
    "Here's the roadmap for the next 6 months. Priority one is documentation — we need proper getting-started guides, adapter-specific tutorials, and a cookbook with common patterns. Priority two is stabilizing the adapter APIs for a 1.0 release — right now some adapters have slightly different behavior around edge cases like empty values, large payloads, and concurrent writes. Priority three is the plugin ecosystem — we want third-party developers to be able to create adapters for new backends. This means a well-documented adapter interface, a testing harness that validates adapter compliance, and a registry where people can publish and discover adapters. Lower priority items include: performance benchmarks across adapters, a migration tool for moving data between backends, a web dashboard for monitoring storage usage, and the sync overlay I mentioned earlier. We're explicitly not building: a query language, a schema system, transactions across adapters, or real-time subscriptions. Those are scope creep traps that would dilute our core value proposition of simple, universal key-value storage.",

    // Turn 17 — monetization (~200 words)
    "The monetization strategy is still evolving. Smallstore itself will always be free and open source — that's non-negotiable. The revenue play is hosted adapter services. Imagine a managed Smallstore endpoint where you don't need to set up any backends at all — just get an API key and start storing data. We'd handle the infrastructure, scaling, backups, and monitoring. The first hosted offering would be a multi-tenant KV store with a generous free tier and usage-based pricing for higher volumes. Think Vercel KV or Upstash, but designed specifically for the Smallstore interface. Beyond hosting, there's potential for enterprise features: audit logging, access controls, encryption at rest, compliance certifications. But that's way down the road. Right now, the focus is on building a strong open-source community and proving the core technology. The business model only works if the open-source project has real traction. So every decision we make should optimize for developer adoption first, revenue second. We're following the playbook of tools like Prisma, Supabase, and Vercel — build something developers love, then monetize the managed version.",

    // Turn 18 — personal motivation (~200 words)
    "On a personal level, I'm building Smallstore because I'm tired of infrastructure complexity. I've been a developer for over a decade, and every project I build involves the same tedious decisions: which database? which ORM? how to set up migrations? how to handle schema changes? how to deal with different environments? These decisions eat up a huge chunk of development time and cognitive load, especially for small projects. Smallstore is my answer to that problem. I want building a data-backed application to be as easy as writing to a file. No setup, no schemas, no migrations, no connection strings. Just store your data and build your app. The broader vision is that storage should be invisible. You shouldn't have to think about where your data lives or how it's structured. You should just be able to say 'remember this' and 'give me that back' and the system handles the rest. That's what the 'messy desk' philosophy is about — your data is just there when you need it, organized enough to find things but flexible enough to handle anything. I think AI is going to make this vision even more important. AI agents need simple, flexible storage that works across many contexts. Smallstore is built for that world.",

    // Turn 19 — biggest risk & worry (~200 words)
    "My biggest worry is scope creep. Every week I get feature requests that would pull Smallstore in a different direction. 'Can you add SQL query support?' 'Can you do real-time sync?' 'Can you handle transactions across adapters?' 'Can you add a web UI for data management?' Each request is reasonable in isolation, but together they'd turn Smallstore from a focused tool into a bloated platform. The second biggest risk is that I'm the only developer. If I burn out or get distracted by other projects, development stalls. I've been trying to mitigate this by keeping the codebase clean and well-documented so that contributors can eventually help. But right now, I'm the bottleneck for everything — bug fixes, new adapters, documentation, community management. The third risk is that a big company builds something similar. If Vercel or Supabase decided to build a universal storage abstraction, they'd have more resources and distribution. But I think the open-source, adapter-based approach gives us a defensible position — our value comes from the breadth of backend support and the community of adapter authors, which is hard to replicate overnight.",

    // Turn 20 — wrap up & reflection (~200 words)
    "Looking back at everything we've discussed, I think the core insight behind Smallstore is that storage is a solved problem at the individual backend level — SQLite is great, Redis is great, Notion is great — but the integration layer between them is broken. Developers spend too much time on storage plumbing and not enough time on their actual applications. If I could change one thing about how the project has evolved, I'd have invested in documentation much earlier. The code works well, but discoverability and onboarding are our biggest bottlenecks for adoption. People can't use what they can't understand. For the interview app specifically, I'm excited about the LCM system. It proves that you can have genuinely long-running conversations — spanning days or weeks — without losing context, using nothing more than a key-value store for persistence. The summary DAG is elegant because it's just data — you can inspect it, debug it, even manually edit it. And because it's backed by Smallstore, you can literally open Google Sheets and see the conversation history and notes right there in a spreadsheet. That's the kind of 'visible data' experience I want for all of Smallstore.",
  ];

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    origLog(`${CYAN}You [${i + 1}/${userMessages.length}]:${RESET} ${msg.slice(0, 80)}${msg.length > 80 ? "..." : ""}`);

    const result = await engine.turn(msg);
    origLog(`${GREEN}AI:${RESET} ${result.response.slice(0, 200)}${result.response.length > 200 ? "..." : ""}`);
    origLog(`${DIM}  [msgs: ${result.messageCount}, notes: ${result.noteCount}, tokens: ${result.activeTokens}]${RESET}\n`);

    // Rate limit
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ---- Phase 3: Check state ----
  origLog(`${CYAN}${BOLD}Phase 3: Verify state${RESET}`);

  const status = engine.getStatus();
  origLog(`${DIM}  Session: ${status.session}${RESET}`);
  origLog(`${DIM}  Mission: ${status.mission}${RESET}`);
  origLog(`${DIM}  Total messages: ${status.stats.totalMessages}${RESET}`);
  origLog(`${DIM}  Active messages: ${status.stats.activeMessages}${RESET}`);
  origLog(`${DIM}  Archived messages: ${status.stats.archivedMessages}${RESET}`);
  origLog(`${DIM}  Summary nodes: ${status.stats.summaryNodes}${RESET}`);
  origLog(`${DIM}  Active tokens: ${status.stats.activeTokens}${RESET}`);
  origLog(`${DIM}  Notes: ${status.noteCount}${RESET}`);
  origLog(`${DIM}  Categories: ${status.categories.join(", ")}${RESET}`);

  const lcmWorked = status.stats.archivedMessages > 0;
  const multiSummary = status.stats.summaryNodes >= 2;
  const highArchive = status.stats.archivedMessages >= 10;
  origLog(`\n  ${lcmWorked ? GREEN + "✓" : RED + "✗"} LCM summarization ${lcmWorked ? "triggered" : "not triggered"}${RESET}`);
  origLog(`  ${multiSummary ? GREEN + "✓" : YELLOW + "~"} Multiple summary nodes: ${status.stats.summaryNodes}${RESET}`);
  origLog(`  ${highArchive ? GREEN + "✓" : YELLOW + "~"} High archive count (≥10): ${status.stats.archivedMessages}${RESET}`);
  origLog(`  ${status.noteCount > 0 ? GREEN + "✓" : RED + "✗"} Notes captured: ${status.noteCount}${RESET}`);

  // ---- Phase 4: Notes ----
  origLog(`\n${CYAN}${BOLD}Phase 4: Captured notes${RESET}`);

  const notes = engine.getNotes();
  if (notes.length === 0) {
    origLog(`${YELLOW}  No notes captured${RESET}`);
  } else {
    for (const note of notes) {
      origLog(`  ${YELLOW}[${note.category}]${RESET} ${note.text}`);
      if (note.quote) origLog(`    ${DIM}> "${note.quote}"${RESET}`);
    }
  }

  // ---- Phase 5: Persistence from Sheetlog ----
  origLog(`\n${CYAN}${BOLD}Phase 5: Persistence test (reload from Google Sheets)${RESET}`);

  const engine2 = new InterviewEngine({ store, complete, verbose: false });
  const resumeResult = await engine2.startSession({ session: "sheetlog-test" });

  origLog(`  ${!resumeResult.isNew ? GREEN + "✓" : RED + "✗"} Session resumed from Sheetlog${RESET}`);

  const status2 = engine2.getStatus();
  origLog(`  ${status2.noteCount === status.noteCount ? GREEN + "✓" : RED + "✗"} Notes persisted: ${status2.noteCount}${RESET}`);
  origLog(`  ${status2.stats.totalMessages >= status.stats.totalMessages ? GREEN + "✓" : RED + "✗"} Messages persisted: ${status2.stats.totalMessages}${RESET}`);
  origLog(`  ${status2.stats.summaryNodes >= status.stats.summaryNodes ? GREEN + "✓" : RED + "✗"} Summaries persisted: ${status2.stats.summaryNodes}${RESET}`);

  origLog(`\n${GREEN}AI resume greeting:${RESET} ${resumeResult.greeting.slice(0, 200)}...`);

  // ---- Phase 6: Export ----
  origLog(`\n${CYAN}${BOLD}Phase 6: Export${RESET}`);
  const md = engine2.exportMarkdown();
  origLog(`\n${md}\n`);

  // ---- No cleanup — leaving data in sheet for inspection ----
  origLog(`\n${DIM}Data left in sheet for inspection${RESET}\n`);
}

runSheetlogTest().catch((err) => {
  origLog(`${RED}Fatal: ${err.message}${RESET}`);
  origLog(err.stack);
  Deno.exit(1);
});
