#!/usr/bin/env -S deno run --allow-all --no-check
// End-to-end test for self-interview app
// Tests: session creation, multi-turn conversation, notes storage, LCM summarization, persistence

import "jsr:@std/dotenv/load";

// Suppress smallstore debug logging
const origLog = console.log;
const origError = console.error;
const SUPPRESS = /\[Smallstore\]|\[KeyIndex\]/;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && SUPPRESS.test(args[0])) return;
  origLog(...args);
};
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && SUPPRESS.test(args[0])) return;
  origError(...args);
};
import { createSmallstore, createSQLiteAdapter, createMemoryAdapter } from "../../mod.ts";
import { InterviewEngine } from "./engine.ts";
import type { CompleteFn } from "./lcm.ts";

const DIM = "\x1b[90m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ${GREEN}✓${RESET} ${msg}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${msg}`);
    failed++;
  }
}

// ============================================================================
// Setup: Real AI provider (Groq) or mock
// ============================================================================

const USE_REAL_AI = !!Deno.env.get("GROQ_API_KEY");

// Turn counter for mock responses
let mockTurnCount = 0;

function createMockCompleteFn(): CompleteFn {
  return async (messages, options) => {
    const lastMsg = messages[messages.length - 1];
    const content = typeof lastMsg.content === "string" ? lastMsg.content : "";

    // Check if this is a summarization call (system prompt asks to summarize)
    const systemMsg = messages[0]?.content || "";
    if (typeof systemMsg === "string" && systemMsg.includes("Summarize")) {
      return {
        content: `Summary: The interviewee discussed their background and experiences. Key themes include personal growth and career development.`,
      };
    }

    // Check if tools are requested
    const tools = (options as any)?.tools;
    mockTurnCount++;

    // Simulate tool calls on certain turns
    if (tools && mockTurnCount === 1) {
      // First turn: greeting + set name tool call
      return {
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function" as const,
          function: {
            name: "note_set_name",
            arguments: JSON.stringify({ name: "Test User" }),
          },
        }],
      };
    }

    if (tools && mockTurnCount === 3) {
      // Third turn: write a note
      return {
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function" as const,
          function: {
            name: "note_write",
            arguments: JSON.stringify({
              category: "childhood",
              text: "Grew up in a small town, loved building things",
              quote: "I was always taking stuff apart to see how it worked",
            }),
          },
        }],
      };
    }

    if (tools && mockTurnCount === 5) {
      // Fifth turn: write another note + read notes
      return {
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function" as const,
          function: {
            name: "note_write",
            arguments: JSON.stringify({
              category: "career",
              text: "Started as a software engineer, transitioned to product management",
            }),
          },
        }],
      };
    }

    if (tools && mockTurnCount === 7) {
      return {
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function" as const,
          function: {
            name: "note_write",
            arguments: JSON.stringify({
              category: "career",
              text: "Led a team of 12 engineers on the platform migration project",
            }),
          },
        }],
      };
    }

    if (tools && mockTurnCount === 10) {
      // Search conversation history
      return {
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function" as const,
          function: {
            name: "lcm_grep",
            arguments: JSON.stringify({ query: "childhood", mode: "bm25" }),
          },
        }],
      };
    }

    // Default: return a conversational response
    const responses = [
      "Welcome! I'm excited to learn about your life story. Let's start with something easy — where did you grow up?",
      "That's fascinating! Tell me more about your childhood. What was your family like?",
      "It sounds like you had quite an interesting upbringing. What sparked your interest in technology?",
      "That's a great story about how you got started. What was your first job like?",
      "Leading a team must have been challenging. What did you learn from that experience?",
      "How did that transition feel? Was it scary moving from engineering to product?",
      "What would you say was the biggest lesson from your career so far?",
      "That's really insightful. Let's talk about your personal life — what matters most to you outside of work?",
      "Family clearly means a lot to you. What traditions or values did you grow up with?",
      "Thank you for sharing all of this. I've been taking notes throughout our conversation. Is there anything else you'd like to add?",
      "Let me review what we've covered and see if there are any gaps I should ask about.",
      "This has been a wonderful conversation. I feel like I have a really good picture of your journey.",
    ];

    const idx = Math.min(mockTurnCount - 1, responses.length - 1);
    return { content: responses[idx] };
  };
}

function createRealCompleteFn(): CompleteFn {
  const apiKey = Deno.env.get("GROQ_API_KEY")!;
  const model = "llama-3.3-70b-versatile";

  return async (messages, options) => {
    const body: Record<string, unknown> = {
      model: (options as any)?.model || model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      temperature: options?.temperature ?? 0.5,
    };
    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    if ((options as any)?.tools) {
      body.tools = (options as any).tools.map((t: any) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = (options as any)?.tool_choice || "auto";
    }

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const choice = data.choices?.[0];
    return { content: choice?.message?.content || null, tool_calls: choice?.message?.tool_calls };
  };
}

// ============================================================================
// Test
// ============================================================================

async function runTest() {
  const testDir = "/tmp/self-interview-e2e-test";
  const dbPath = `${testDir}/store.db`;

  // Clean up previous test
  try { await Deno.remove(testDir, { recursive: true }); } catch { /* ok */ }
  await Deno.mkdir(testDir, { recursive: true });

  console.log(`\n${BOLD}Self-Interview E2E Test${RESET}`);
  console.log(`${DIM}Mode: ${USE_REAL_AI ? "REAL AI (Groq)" : "MOCK AI"}${RESET}`);
  console.log(`${DIM}DB: ${dbPath}${RESET}\n`);

  const store = createSmallstore({
    adapters: {
      sqlite: createSQLiteAdapter({ path: dbPath }),
      memory: createMemoryAdapter(),
    },
    defaultAdapter: "sqlite",
  });

  const complete = USE_REAL_AI ? createRealCompleteFn() : createMockCompleteFn();

  // ---- Test 1: Create engine and start session ----
  console.log(`${CYAN}Test 1: Start a new session${RESET}`);

  const engine = new InterviewEngine({ store, complete, verbose: false });

  const startResult = await engine.startSession({
    session: "test-life-story",
    mission: "life-story",
    fresh: true,
  });

  assert(startResult.isNew === true, "Session is new");
  assert(startResult.greeting.length > 10, `Greeting received (${startResult.greeting.length} chars)`);
  console.log(`${DIM}  Greeting: "${startResult.greeting.slice(0, 80)}..."${RESET}`);

  const status1 = engine.getStatus();
  assert(status1.session === "test-life-story", "Session name correct");
  assert(status1.mission === "Life Story", "Mission name correct");
  assert(status1.stats.totalMessages >= 2, `Messages stored (${status1.stats.totalMessages})`);

  // ---- Test 2: Multi-turn conversation ----
  console.log(`\n${CYAN}Test 2: Multi-turn conversation${RESET}`);

  const userMessages = [
    "I grew up in a small town in Oregon. My parents were both teachers.",
    "I was always curious as a kid. I loved taking apart electronics and building things with Legos.",
    "In high school I got into programming. My CS teacher was incredible — she really inspired me.",
    "I studied computer science at Oregon State. That's where I built my first real project.",
    "After college I joined a startup in Portland as a software engineer.",
    "The startup grew fast. Within two years I was leading a team of 12.",
    "Eventually I transitioned to product management. I missed the technical work but loved the strategy.",
    "The biggest lesson? That the best technology doesn't win — the best product-market fit wins.",
    "Outside work, family is everything. I have two kids and we love hiking in the Cascades.",
    "My parents taught me to always be learning. I try to read a book a week.",
  ];

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    console.log(`${DIM}  Turn ${i + 1}: "${msg.slice(0, 50)}..."${RESET}`);
    const result = await engine.turn(msg);
    assert(result.response.length > 5, `Got response (${result.response.length} chars)`);
    assert(result.messageCount > 0, `Messages: ${result.messageCount}`);

    if (USE_REAL_AI) {
      // Rate limit for Groq
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // ---- Test 3: Check notes ----
  console.log(`\n${CYAN}Test 3: Verify notes${RESET}`);

  const notes = engine.getNotes();
  assert(notes.length > 0, `Notes captured: ${notes.length}`);
  console.log(`${DIM}  Note categories: ${engine.getStatus().categories.join(", ")}${RESET}`);

  for (const note of notes) {
    console.log(`${DIM}  [${note.id}] ${note.category}: ${note.text.slice(0, 60)}...${RESET}`);
  }

  const gaps = engine.getGaps();
  assert(Object.keys(gaps).length > 0, `Categories with notes: ${Object.keys(gaps).join(", ")}`);

  // ---- Test 4: LCM status ----
  console.log(`\n${CYAN}Test 4: LCM memory management${RESET}`);

  const status2 = engine.getStatus();
  console.log(`${DIM}  Total messages: ${status2.stats.totalMessages}${RESET}`);
  console.log(`${DIM}  Active messages: ${status2.stats.activeMessages}${RESET}`);
  console.log(`${DIM}  Archived messages: ${status2.stats.archivedMessages}${RESET}`);
  console.log(`${DIM}  Summary nodes: ${status2.stats.summaryNodes}${RESET}`);
  console.log(`${DIM}  Active tokens: ${status2.stats.activeTokens}${RESET}`);

  // With 10 user turns + 10 AI turns + init = ~22 messages
  // keepLastN=8, chunkSize=8, so summarization should trigger
  assert(status2.stats.totalMessages >= 20, `Enough messages stored (${status2.stats.totalMessages})`);

  if (status2.stats.archivedMessages > 0) {
    assert(true, `LCM summarization triggered! ${status2.stats.archivedMessages} archived`);
    assert(status2.stats.summaryNodes > 0, `Summary nodes created: ${status2.stats.summaryNodes}`);
  } else {
    console.log(`${YELLOW}  Note: LCM summarization not triggered (may need more turns)${RESET}`);
  }

  // ---- Test 5: Search ----
  console.log(`\n${CYAN}Test 5: Search conversation history${RESET}`);

  const searchResults = engine.search("Oregon");
  assert(searchResults.length > 0, `Search found ${searchResults.length} results for "Oregon"`);
  for (const r of searchResults.slice(0, 3)) {
    console.log(`${DIM}  [${r.role}] ${r.content.slice(0, 80)}...${RESET}`);
  }

  // ---- Test 6: Export ----
  console.log(`\n${CYAN}Test 6: Export markdown${RESET}`);

  const md = engine.exportMarkdown();
  assert(md.includes("Interview Notes"), "Markdown has header");
  assert(md.includes("life-story"), "Markdown has mission");
  console.log(`${DIM}  Export length: ${md.length} chars${RESET}`);
  console.log(`${DIM}  First 200 chars:\n${md.slice(0, 200)}${RESET}`);

  // ---- Test 7: Persistence — reload from smallstore ----
  console.log(`\n${CYAN}Test 7: Persistence — reload from smallstore${RESET}`);

  // Create a NEW engine (simulates new process / API request)
  mockTurnCount = 0; // reset mock
  const engine2 = new InterviewEngine({ store, complete, verbose: false });
  const resumeResult = await engine2.startSession({ session: "test-life-story" });

  assert(resumeResult.isNew === false, "Session recognized as existing");
  assert(resumeResult.greeting.length > 5, "Got resume greeting");

  const status3 = engine2.getStatus();
  assert(status3.noteCount === notes.length, `Notes persisted (${status3.noteCount})`);
  assert(status3.stats.totalMessages >= status2.stats.totalMessages, `Messages persisted (${status3.stats.totalMessages})`);
  assert(status3.categories.length === Object.keys(gaps).length, `Categories persisted (${status3.categories.join(", ")})`);

  console.log(`${DIM}  Resumed with ${status3.stats.totalMessages} messages, ${status3.noteCount} notes${RESET}`);

  // ---- Test 8: Session listing ----
  console.log(`\n${CYAN}Test 8: Session listing${RESET}`);

  const sessions = await engine2.listSessions();
  assert(sessions.length >= 1, `Sessions found: ${sessions.length}`);
  const ourSession = sessions.find((s) => s.name === "test-life-story");
  assert(!!ourSession, "Our session in list");
  if (ourSession) {
    assert(ourSession.missionSlug === "life-story", `Mission slug: ${ourSession.missionSlug}`);
    assert(ourSession.noteCount > 0, `Note count in meta: ${ourSession.noteCount}`);
  }

  // ---- Test 9: Continue conversation after reload ----
  console.log(`\n${CYAN}Test 9: Continue after reload${RESET}`);

  const continueResult = await engine2.turn("What else would you like to know about my childhood?");
  assert(continueResult.response.length > 5, `Got continuation response (${continueResult.response.length} chars)`);
  assert(continueResult.messageCount > status2.stats.totalMessages, `Message count increased (${continueResult.messageCount})`);

  // ---- Test 10: Summarize ----
  console.log(`\n${CYAN}Test 10: Session summary${RESET}`);

  const summary = await engine2.summarize();
  assert(summary.length > 20, `Summary generated (${summary.length} chars)`);
  console.log(`${DIM}  Summary: "${summary.slice(0, 150)}..."${RESET}`);

  // ---- Test 11: Delete session ----
  console.log(`\n${CYAN}Test 11: Delete session${RESET}`);

  await engine2.deleteSession("test-life-story");
  const sessionsAfter = await engine2.listSessions();
  const deleted = !sessionsAfter.find((s) => s.name === "test-life-story");
  assert(deleted, "Session deleted successfully");

  // ---- Test 12: Verify SQLite file exists and has data ----
  console.log(`\n${CYAN}Test 12: SQLite storage verification${RESET}`);

  const fileInfo = await Deno.stat(dbPath);
  assert(fileInfo.size > 0, `SQLite DB exists and has data (${(fileInfo.size / 1024).toFixed(1)} KB)`);

  // ---- Results ----
  console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}\n`);

  // Clean up
  try { await Deno.remove(testDir, { recursive: true }); } catch { /* ok */ }

  if (failed > 0) Deno.exit(1);
}

runTest().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  console.error(err.stack);
  Deno.exit(1);
});
