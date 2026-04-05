#!/usr/bin/env -S deno run --allow-all --no-check
// Live test with real Groq API (llama-3.3-70b-versatile)
// Tests full conversation flow with real AI responses, tool calling, LCM summarization

import "jsr:@std/dotenv/load";

// Suppress smallstore debug logging
const origLog = console.log;
const SUPPRESS = /\[Smallstore\]|\[KeyIndex\]/;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && SUPPRESS.test(args[0])) return;
  origLog(...args);
};

import { createSmallstore, createSQLiteAdapter, createMemoryAdapter } from "../../mod.ts";
import { InterviewEngine } from "./engine.ts";
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
// Groq API
// ============================================================================

const apiKey = Deno.env.get("GROQ_API_KEY");
if (!apiKey) {
  console.error(`${RED}GROQ_API_KEY not set${RESET}`);
  Deno.exit(1);
}

const model = "llama-3.3-70b-versatile";

// ============================================================================
// Test
// ============================================================================

async function runLiveTest() {
  const testDir = "/tmp/self-interview-live-test";
  const dbPath = `${testDir}/store.db`;
  try { await Deno.remove(testDir, { recursive: true }); } catch { /* ok */ }
  await Deno.mkdir(testDir, { recursive: true });

  origLog(`\n${MAGENTA}${BOLD}Live Interview Test${RESET} ${DIM}— Groq ${model}${RESET}`);
  origLog(`${DIM}DB: ${dbPath}${RESET}\n`);

  const store = createSmallstore({
    adapters: {
      sqlite: createSQLiteAdapter({ path: dbPath }),
      memory: createMemoryAdapter(),
    },
    defaultAdapter: "sqlite",
  });

  const complete = createOpenAICompleteFn({
    apiKey,
    baseUrl: "https://api.groq.com/openai/v1",
    model,
  });
  const engine = new InterviewEngine({ store, complete, verbose: true });

  // ---- Phase 1: Start session ----
  origLog(`${CYAN}${BOLD}Phase 1: Start project-discovery session${RESET}`);

  const { isNew, greeting } = await engine.startSession({
    session: "test-project",
    mission: "project-discovery",
    fresh: true,
  });

  origLog(`${DIM}  New: ${isNew}${RESET}`);
  origLog(`${GREEN}AI: ${greeting}${RESET}\n`);

  // ---- Phase 2: Multi-turn conversation ----
  origLog(`${CYAN}${BOLD}Phase 2: Conversation (12 turns)${RESET}\n`);

  const userMessages = [
    "I'm building a tool called Smallstore — it's a universal key-value storage abstraction for Deno and Node.",
    "The problem is that developers have to learn different APIs for SQLite, Redis, Notion, Google Sheets, Airtable, S3, etc. Smallstore gives them one API that works with all of them.",
    "The main audience is indie hackers and small teams who prototype fast. They start with SQLite locally, then swap to Notion or Google Sheets for collaboration without changing code.",
    "We have 17 adapters right now — SQLite, memory, Redis, Notion, Airtable, Sheetlog, R2, Obsidian, and more. Plus a VFS layer that gives you bash-like commands.",
    "Success looks like: a developer can build a full app in a weekend using just smallstore for all their data needs. No database setup, no ORM, just get/set/delete with paths.",
    "The biggest risk is that the abstraction leaks. Each backend has different capabilities — SQLite supports queries, Notion has rich text, Sheets has row limits. We handle this with adapter-specific options.",
    "Our differentiator is the 'messy desk' philosophy — you can just throw data at it and it figures out the best place to store it. Smart routing based on data type.",
    "Timeline: we're in beta now with about 50 users. Want to hit 1.0 by end of Q2 with full documentation and a plugin ecosystem.",
    "Budget is essentially zero — it's open source. I'm funding it myself while working on other projects. The monetization play is hosted adapters.",
    "The biggest constraint is that I'm the only developer. I need to prioritize ruthlessly — docs, adapters, and developer experience over features.",
    "One thing I haven't figured out: should we support real-time sync between adapters? Like auto-syncing SQLite to Notion? We have a prototype but it adds complexity.",
    "Actually, let me revise — the real question is whether to focus on the storage layer or build more apps on top of it to showcase what's possible. Like this interview app we're building right now.",
  ];

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    origLog(`${CYAN}You [${i + 1}/${userMessages.length}]:${RESET} ${msg.slice(0, 80)}${msg.length > 80 ? "..." : ""}`);

    const result = await engine.turn(msg);
    origLog(`${GREEN}AI:${RESET} ${result.response.slice(0, 200)}${result.response.length > 200 ? "..." : ""}`);
    origLog(`${DIM}  [msgs: ${result.messageCount}, notes: ${result.noteCount}, tokens: ${result.activeTokens}]${RESET}\n`);

    // Rate limit (Groq free tier)
    await new Promise((r) => setTimeout(r, 2000));
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
  origLog(`\n  ${lcmWorked ? GREEN + "✓" : RED + "✗"} LCM summarization ${lcmWorked ? "triggered" : "not triggered"}${RESET}`);
  origLog(`  ${status.noteCount > 0 ? GREEN + "✓" : RED + "✗"} Notes captured: ${status.noteCount}${RESET}`);

  // ---- Phase 4: Show notes ----
  origLog(`\n${CYAN}${BOLD}Phase 4: Captured notes${RESET}`);

  const notes = engine.getNotes();
  if (notes.length === 0) {
    origLog(`${YELLOW}  No notes captured (AI may not have used tools)${RESET}`);
  } else {
    for (const note of notes) {
      origLog(`  ${YELLOW}[${note.category}]${RESET} ${note.text}`);
      if (note.quote) origLog(`    ${DIM}> "${note.quote}"${RESET}`);
    }
  }

  // ---- Phase 5: Search ----
  origLog(`\n${CYAN}${BOLD}Phase 5: Search history${RESET}`);

  const searchResults = engine.search("SQLite");
  origLog(`  Found ${searchResults.length} results for "SQLite"`);
  for (const r of searchResults.slice(0, 3)) {
    origLog(`  ${DIM}[${r.role}] ${r.content.slice(0, 100)}...${RESET}`);
  }

  // ---- Phase 6: Persistence ----
  origLog(`\n${CYAN}${BOLD}Phase 6: Persistence test${RESET}`);

  const engine2 = new InterviewEngine({ store, complete, verbose: false });
  const resumeResult = await engine2.startSession({ session: "test-project" });

  origLog(`  ${!resumeResult.isNew ? GREEN + "✓" : RED + "✗"} Session resumed from SQLite${RESET}`);

  const status2 = engine2.getStatus();
  origLog(`  ${status2.noteCount === status.noteCount ? GREEN + "✓" : RED + "✗"} Notes persisted: ${status2.noteCount}${RESET}`);
  origLog(`  ${status2.stats.totalMessages >= status.stats.totalMessages ? GREEN + "✓" : RED + "✗"} Messages persisted: ${status2.stats.totalMessages}${RESET}`);
  origLog(`  ${status2.stats.summaryNodes >= status.stats.summaryNodes ? GREEN + "✓" : RED + "✗"} Summaries persisted: ${status2.stats.summaryNodes}${RESET}`);

  origLog(`\n${GREEN}AI resume greeting:${RESET} ${resumeResult.greeting.slice(0, 200)}...`);

  // ---- Phase 7: Export ----
  origLog(`\n${CYAN}${BOLD}Phase 7: Export${RESET}`);
  const md = engine2.exportMarkdown();
  origLog(`\n${md}\n`);

  // ---- Phase 8: Summary ----
  origLog(`${CYAN}${BOLD}Phase 8: Session summary${RESET}`);
  const summary = await engine2.summarize();
  origLog(`\n${GREEN}${summary}${RESET}\n`);

  // DB size
  const fileInfo = await Deno.stat(dbPath);
  origLog(`${DIM}SQLite DB size: ${(fileInfo.size / 1024).toFixed(1)} KB${RESET}\n`);

  // Cleanup
  try { await Deno.remove(testDir, { recursive: true }); } catch { /* ok */ }
}

runLiveTest().catch((err) => {
  origLog(`${RED}Fatal: ${err.message}${RESET}`);
  origLog(err.stack);
  Deno.exit(1);
});
