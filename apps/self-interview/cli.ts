#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-ffi

// Self-Interview CLI
//
// Standalone CLI that uses the interview engine directly with smallstore.
// Can also talk to a remote API server via --api-url.
//
// Usage:
//   deno task interview                    # interactive mission picker
//   deno task interview -m life-story      # start life story interview
//   deno task interview -r                 # resume last session
//   deno task interview -e -s my-session   # export notes

import "jsr:@std/dotenv/load";
import { parseArgs } from "@std/cli/parse-args";
import { createSmallstore, createSQLiteAdapter, createMemoryAdapter } from "../../mod.ts";
import { InterviewEngine } from "./engine.ts";
import { createSheetlogKV } from "./sheetlog-kv.ts";
import type { Smallstore } from "./store.ts";
import { MISSIONS, getMission, createCustomMission } from "./missions.ts";
import type { Mission } from "./missions.ts";
import { createCompleteFn as createSharedCompleteFn } from "./ai.ts";

// ============================================================================
// Args
// ============================================================================

const args = parseArgs(Deno.args, {
  string: ["mission", "session", "directive", "provider", "model", "api-url", "data-dir"],
  boolean: ["help", "new", "resume", "export", "missions", "verbose", "list", "sessions"],
  default: { "data-dir": "./data/self-interview" },
  alias: { h: "help", m: "mission", s: "session", n: "new", r: "resume", e: "export", v: "verbose", d: "directive" },
});

if (args.help) {
  console.log(`
self-interview — a proactive interviewer powered by smallstore

Usage: deno task interview [options]

Options:
  -m, --mission NAME     Interview mission (default: pick interactively)
  -s, --session NAME     Session name (default: mission slug)
  -d, --directive TEXT   Extra focus directive (e.g., "focus on WWII years")
  -n, --new              Start fresh session
  -r, --resume           Resume most recent session
  -e, --export           Export notes as markdown and exit
  --missions, --list     List available missions
  --sessions             List saved sessions
  --provider NAME        AI provider (groq, openai, anthropic)
  --model NAME           Model override
  --data-dir PATH        Data directory (default: ./data/self-interview)
  --api-url URL          Use remote API server instead of local engine
  -v, --verbose          Show LCM diagnostics
  -h, --help             Show this help

In-chat commands:
  /notes [category]   Show notes (optionally filtered)
  /gaps               Show coverage gaps
  /summarize          Generate a session summary
  /done               Summarize, export notes, and exit
  /export             Export notes as markdown
  /search <query>     Search conversation history
  /status             Memory stats
  /directive <text>   Change interview focus
  /sessions           List all sessions
  /quit               Exit
`);
  Deno.exit(0);
}

if (args.missions || args.list) {
  console.log("\nAvailable interview missions:\n");
  for (const m of MISSIONS) {
    console.log(`  ${m.slug.padEnd(18)} ${m.description}`);
  }
  console.log('\nUsage: deno task interview --mission <slug>\n');
  Deno.exit(0);
}

/** Create store matching the web server logic: sheetlog if SM_SHEET_URL is set, otherwise SQLite */
function createStore(dataDir: string): Smallstore {
  const sheetUrl = Deno.env.get("SM_SHEET_URL") || Deno.env.get("SHEET_URL");
  const sheetName = Deno.env.get("INTERVIEW_SHEET_NAME") || "self-interview";
  if (sheetUrl) {
    return createSheetlogKV({ sheetUrl, sheet: sheetName });
  }
  return createSmallstore({
    adapters: {
      sqlite: createSQLiteAdapter({ path: `${dataDir}/store.db` }),
      memory: createMemoryAdapter(),
    },
    defaultAdapter: "sqlite",
  });
}

if (args.sessions) {
  const store = createStore(args["data-dir"]);
  const engine = new InterviewEngine({ store, complete: async () => ({ content: null }), verbose: false });
  const sessions = await engine.listSessions();
  if (sessions.length === 0) {
    console.log("\nNo sessions found.\n");
  } else {
    console.log("\nSaved sessions:\n");
    for (const s of sessions) {
      console.log(`  ${s.name.padEnd(24)} ${s.missionName} (${s.noteCount} notes, ${s.updatedAt?.slice(0, 10) || "?"})`);
    }
    console.log(`\nResume: deno task interview -s <name>\n`);
  }
  Deno.exit(0);
}

// ============================================================================
// Colors
// ============================================================================

const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

// ============================================================================
// Readline (same as original)
// ============================================================================

async function readInputLine(prompt: string): Promise<string | null> {
  const encoder = new TextEncoder();
  Deno.stdout.writeSync(encoder.encode(prompt));

  if (Deno.stdin.isTerminal()) {
    const bytes: number[] = [];
    Deno.stdin.setRaw(true);
    try {
      while (true) {
        const buf = new Uint8Array(1);
        const n = await Deno.stdin.read(buf);
        if (n === null) return bytes.length > 0 ? new TextDecoder().decode(Uint8Array.from(bytes)) : null;
        const b = buf[0];
        if (b === 13 || b === 10) { Deno.stdout.writeSync(encoder.encode("\n")); return new TextDecoder().decode(Uint8Array.from(bytes)); }
        if (b === 3) { Deno.stdout.writeSync(encoder.encode("^C\n")); return null; }
        if (b === 8 || b === 127) { if (bytes.length > 0) { bytes.pop(); Deno.stdout.writeSync(encoder.encode("\b \b")); } continue; }
        if (b === 27) continue;
        bytes.push(b);
        Deno.stdout.writeSync(buf);
      }
    } finally { Deno.stdin.setRaw(false); }
  }

  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const idx = pending.indexOf("\n");
    if (idx !== -1) return pending.slice(0, idx).replace(/\r$/, "");
    const buf = new Uint8Array(1024);
    const n = await Deno.stdin.read(buf);
    if (n === null) return pending.length > 0 ? pending.replace(/\r$/, "") : null;
    pending += decoder.decode(buf.subarray(0, n), { stream: true });
  }
}

async function readLine(prompt: string): Promise<string | null> {
  const line = await readInputLine(prompt);
  return line === null ? null : line.trim();
}

async function readMultiLine(prompt: string, contPrompt?: string): Promise<string | null> {
  const cont = contPrompt || `${DIM}...${RESET} `;
  const lines: string[] = [];
  let isFirst = true;

  while (true) {
    const raw = await readInputLine(isFirst ? prompt : cont);
    if (raw === null) return lines.length > 0 ? lines.join("\n") : null;
    const line = raw.trimEnd();
    if (line === "" && lines.length > 0) return lines.join("\n").trim();
    if (line === "" && lines.length === 0) continue;
    lines.push(line);
    isFirst = false;
  }
}

async function withLoading<T>(label: string, task: () => Promise<T>): Promise<T> {
  const frames = ["-", "\\", "|", "/"];
  let idx = 0;
  const encoder = new TextEncoder();
  const render = () => { Deno.stdout.writeSync(encoder.encode(`\r${DIM}${label} ${frames[idx++ % 4]}${RESET}`)); };
  render();
  const timer = setInterval(render, 120);
  try { return await task(); }
  finally { clearInterval(timer); Deno.stdout.writeSync(encoder.encode("\r" + " ".repeat(60) + "\r")); }
}

// ============================================================================
// Mission picker
// ============================================================================

async function pickMission(): Promise<Mission> {
  console.log(`\n${BOLD}Choose an interview mission:${RESET}\n`);
  MISSIONS.forEach((m, i) => {
    console.log(`  ${CYAN}${i + 1}${RESET}  ${BOLD}${m.name}${RESET}`);
    console.log(`     ${DIM}${m.description}${RESET}`);
  });
  const customIdx = MISSIONS.length + 1;
  console.log(`  ${CYAN}${customIdx}${RESET}  ${BOLD}Custom${RESET}`);
  console.log(`     ${DIM}Describe your own mission — anything goes${RESET}`);
  console.log();

  while (true) {
    const input = await readLine(`${CYAN}Pick (1-${customIdx}): ${RESET}`);
    if (input === null) Deno.exit(0);
    const num = parseInt(input);
    if (num >= 1 && num <= MISSIONS.length) return MISSIONS[num - 1];
    if (num === customIdx || input.toLowerCase() === "custom") return await promptCustomMission();
    const bySlug = getMission(input);
    if (bySlug) return bySlug;
    console.log(`${RED}Invalid choice. Try a number or slug.${RESET}`);
  }
}

async function promptCustomMission(): Promise<Mission> {
  console.log(`\n${BOLD}Describe your interview mission.${RESET}`);
  console.log(`${DIM}What should the interviewer focus on? What are you trying to capture?${RESET}`);
  console.log(`${DIM}(Multi-line OK — press Enter twice to submit)${RESET}\n`);

  while (true) {
    const desc = await readMultiLine(`${CYAN}Mission${RESET} ${DIM}>${RESET} `);
    if (desc === null) Deno.exit(0);
    if (!desc || desc.length < 10) { console.log(`${RED}Please describe in at least a sentence.${RESET}`); continue; }

    const defaultSlug = desc.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const slugInput = await readLine(`${DIM}Session name [${defaultSlug}]: ${RESET}`);
    const slug = (slugInput && slugInput.length > 0) ? slugInput.toLowerCase().replace(/[^a-z0-9]+/g, "-") : defaultSlug;

    return createCustomMission(desc, slug);
  }
}

// ============================================================================
// AI Setup
// ============================================================================

async function createCompleteFn() {
  return createSharedCompleteFn({
    provider: args.provider,
    model: args.model,
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`\n${MAGENTA}${BOLD}self-interview${RESET} ${DIM}— powered by smallstore${RESET}`);

  // Determine mission
  let mission: Mission;
  if (args.mission) {
    const m = getMission(args.mission);
    if (!m) {
      console.error(`${RED}Unknown mission: ${args.mission}${RESET}`);
      Deno.exit(1);
    }
    mission = m;
  } else if (args.resume) {
    // Will be resolved from stored data
    mission = MISSIONS[4]; // placeholder, engine will override
  } else {
    mission = await pickMission();
  }

  const sessionName = args.session || mission.slug;

  // Setup smallstore (sheetlog if SM_SHEET_URL set, otherwise SQLite)
  const store = createStore(args["data-dir"]);

  // Setup AI
  const complete = await createCompleteFn();

  // Create engine
  const engine = new InterviewEngine({
    store,
    complete,
    verbose: args.verbose,
  });

  // Handle --export
  if (args.export) {
    try {
      await engine.startSession({ session: sessionName });
      const md = engine.exportMarkdown();
      const status = engine.getStatus();
      if (status.noteCount === 0) {
        console.log(`${YELLOW}No notes to export for "${sessionName}".${RESET}`);
        Deno.exit(0);
      }
      console.log(`\n${GREEN}${status.noteCount} notes:${RESET}\n`);
      console.log(md);
    } catch {
      console.log(`${RED}Session "${sessionName}" not found.${RESET}`);
    }
    Deno.exit(0);
  }

  // Start session
  console.log(`${DIM}  Starting session...${RESET}`);

  let greeting: string;
  try {
    const result = await withLoading("thinking", () =>
      engine.startSession({
        session: sessionName,
        mission: mission.slug,
        customMission: mission.name === "Custom" ? mission.systemPrompt.match(/---\n([\s\S]*?)\n---/)?.[1] : undefined,
        fresh: args.new,
        directive: args.directive,
      }),
    );
    greeting = result.greeting;
  } catch (err) {
    console.log(`${RED}Error: ${(err as Error).message}${RESET}`);
    Deno.exit(1);
  }

  const status = engine.getStatus();
  console.log(`${DIM}  Mission: ${BOLD}${status.mission}${RESET}`);
  console.log(`${DIM}  Session: ${BOLD}${status.session}${RESET}`);
  console.log(`${DIM}  Notes: ${status.noteCount} captured${RESET}`);
  if (status.categories.length > 0) {
    console.log(`${DIM}  Topics: ${status.categories.join(", ")}${RESET}`);
  }
  console.log(`\n${DIM}  Multi-line: press Enter twice to send. Commands: /notes /gaps /done /export /search /status /quit${RESET}\n`);

  console.log(`${GREEN}${greeting}${RESET}\n`);

  let turnCount = 0;

  // ---------- REPL ----------
  while (true) {
    const input = await readMultiLine(`${CYAN}you${RESET} ${DIM}>${RESET} `, `${DIM} .. (Enter sends)${RESET} `);
    if (input === null) break;
    if (!input) continue;

    // Slash commands
    if (input.startsWith("/")) {
      const spaceIdx = input.indexOf(" ");
      const cmd = spaceIdx === -1 ? input.slice(1).toLowerCase() : input.slice(1, spaceIdx).toLowerCase();
      const cmdArg = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1).trim();

      switch (cmd) {
        case "quit": case "exit": case "q":
          console.log(`\n${DIM}${turnCount} turns. ${engine.getStatus().noteCount} notes. Memory persisted in smallstore.${RESET}\n`);
          Deno.exit(0);
          break;

        case "notes": {
          const list = engine.getNotes(cmdArg || undefined);
          if (list.length === 0) {
            console.log(`\n${DIM}${cmdArg ? `No notes in "${cmdArg}"` : "No notes yet"}${RESET}\n`);
          } else {
            console.log();
            for (const n of list) {
              console.log(`${DIM}[${n.id}]${RESET} ${YELLOW}${n.category}${RESET}: ${n.text}`);
              if (n.quote) console.log(`     ${DIM}> "${n.quote}"${RESET}`);
            }
            console.log();
          }
          break;
        }

        case "gaps": {
          const gaps = engine.getGaps();
          const st = engine.getStatus();
          console.log(`\n${BOLD}Coverage:${RESET} ${st.noteCount} notes`);
          const cats = Object.keys(gaps);
          if (cats.length > 0) {
            for (const cat of cats) console.log(`  ${YELLOW}${cat}${RESET}: ${gaps[cat]}`);
          } else {
            console.log(`  ${DIM}No notes yet.${RESET}`);
          }
          console.log();
          break;
        }

        case "export": {
          const st = engine.getStatus();
          if (st.noteCount === 0) { console.log(`\n${YELLOW}No notes yet.${RESET}\n`); break; }
          const md = engine.exportMarkdown();
          console.log(`\n${md}\n`);
          break;
        }

        case "summarize": {
          const summary = await withLoading("summarizing", () => engine.summarize());
          console.log(`\n${GREEN}${summary}${RESET}\n`);
          turnCount++;
          break;
        }

        case "done": {
          const summary = await withLoading("summarizing", () => engine.summarize());
          console.log(`\n${GREEN}${summary}${RESET}\n`);
          turnCount++;
          const st = engine.getStatus();
          if (st.noteCount > 0) {
            console.log(engine.exportMarkdown());
          }
          console.log(`\n${DIM}${turnCount} turns. ${st.noteCount} notes. Memory persisted in smallstore.${RESET}\n`);
          Deno.exit(0);
          break;
        }

        case "search": {
          if (!cmdArg) { console.log(`\n${DIM}Usage: /search <query>${RESET}\n`); break; }
          const results = engine.search(cmdArg);
          if (results.length === 0) {
            console.log(`\n${DIM}No matches for "${cmdArg}"${RESET}\n`);
          } else {
            console.log();
            for (const r of results) console.log(`${DIM}[${r.role}]${RESET} ${r.content}`);
            console.log();
          }
          break;
        }

        case "status": {
          const st = engine.getStatus();
          console.log(
            `\n${DIM}Memory: ${st.stats.totalMessages} msgs (${st.stats.activeMessages} active, ` +
            `${st.stats.archivedMessages} archived) | ${st.stats.summaryNodes} summaries | ${st.stats.activeTokens} tok${RESET}`
          );
          console.log(`${DIM}Notes: ${st.noteCount} across ${st.categories.length} categories${RESET}\n`);
          break;
        }

        case "directive": {
          if (!cmdArg) {
            console.log(`\n${DIM}Usage: /directive <focus>${RESET}\n`);
            break;
          }
          engine.setDirective(cmdArg);
          console.log(`\n${GREEN}Directive: ${cmdArg}${RESET}\n`);
          break;
        }

        case "sessions": {
          const sessions = await engine.listSessions();
          if (sessions.length === 0) { console.log(`\n${DIM}No sessions.${RESET}\n`); break; }
          console.log(`\n${BOLD}Sessions:${RESET}`);
          for (const s of sessions) {
            const marker = s.name === sessionName ? ` ${GREEN}(current)${RESET}` : "";
            console.log(`  ${s.name}${marker} — ${s.missionName} (${s.noteCount} notes)`);
          }
          console.log();
          break;
        }

        default:
          console.log(`\n${DIM}/notes /gaps /summarize /done /export /search /status /directive /sessions /quit${RESET}\n`);
      }
      continue;
    }

    // ---------- Chat ----------
    try {
      const result = await withLoading("thinking", () => engine.turn(input));
      console.log(`\n${GREEN}${result.response}${RESET}\n`);
      turnCount++;
    } catch (err) {
      console.log(`\n${RED}Error: ${(err as Error).message}${RESET}\n`);
    }
  }

  console.log(`\n${DIM}${turnCount} turns. ${engine.getStatus().noteCount} notes. Memory persisted in smallstore.${RESET}\n`);
}

main();
