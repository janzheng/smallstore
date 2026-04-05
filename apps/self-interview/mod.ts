// Self-Interview App — powered by smallstore
//
// API-first interview system with Lossless Context Management (LCM).
// Uses smallstore for persistence — swap between local-sqlite, sheetlog, etc.
//
// Usage:
//   deno run --allow-all apps/self-interview/mod.ts
//
// Or import and mount in your own Hono app:
//   import { createInterviewApp } from "./mod.ts";
//   const app = await createInterviewApp({ preset: "local-sqlite" });

import { load as loadEnv } from "@std/dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fromFileUrl, dirname, join } from "@std/path";

// Load .env — check app dir, CWD, and walk up to project root
const appDir = dirname(fromFileUrl(import.meta.url));
for (const dir of [appDir, Deno.cwd()]) {
  await loadEnv({ envPath: join(dir, ".env"), export: true }).catch(() => {});
}
// Walk up from CWD to find project root .env (handles running from subdirs)
let searchDir = Deno.cwd();
for (let i = 0; i < 6; i++) {
  const envPath = join(searchDir, ".env");
  try {
    await Deno.stat(envPath);
    await loadEnv({ envPath, export: true }).catch(() => {});
    break;
  } catch { searchDir = dirname(searchDir); }
}
import { MemoryStore, type Smallstore } from "./store.ts";
import { createSheetlogKV } from "./sheetlog-kv.ts";
import { createInterviewRoutes, type RouterConfig } from "./routes.ts";
import { createCompleteFn } from "./ai.ts";
import type { CompleteFn } from "./lcm.ts";

// ============================================================================
// App Factory
// ============================================================================

export interface InterviewAppConfig {
  /** Smallstore preset (default: "local-sqlite") */
  preset?: string;
  /** Existing smallstore instance (overrides preset) */
  store?: Smallstore;
  /** Custom AI completion function (overrides default) */
  complete?: CompleteFn;
  /** Data directory for local storage */
  dataDir?: string;
  /** Port to serve on */
  port?: number;
  /** Verbose LCM diagnostics */
  verbose?: boolean;
}

export async function createInterviewApp(config: InterviewAppConfig = {}): Promise<Hono> {
  // Setup smallstore — use sheetlog if SM_SHEET_URL is set, otherwise SQLite
  const sheetUrl = Deno.env.get("SM_SHEET_URL") || Deno.env.get("SHEET_URL");
  const sheetName = Deno.env.get("INTERVIEW_SHEET_NAME") || "self-interview";

  let store: Smallstore;
  if (config.store) {
    store = config.store;
  } else if (sheetUrl) {
    store = createSheetlogKV({ sheetUrl, sheet: sheetName });
  } else {
    // Memory-only fallback (works on Deno Deploy; for local dev with SQLite, pass config.store)
    store = new MemoryStore();
    console.warn("  [interview] No SM_SHEET_URL set — using in-memory store (data is ephemeral)");
  }

  // Preload sheetlog cache (triggers the single network fetch)
  if (sheetUrl && !config.store) {
    // Calling any method triggers preload; use a no-op get
    store.get("__preload__").catch(() => {});
  }

  // Setup AI
  const complete = config.complete || await createCompleteFn();

  // Build Hono app
  const app = new Hono();
  app.use("*", cors());

  // Health check
  app.get("/health", (c) => c.json({ ok: true }));

  // Mount interview API routes
  const interviewRoutes = createInterviewRoutes({
    store,
    complete,
    verbose: config.verbose,
  });
  app.route("/api", interviewRoutes);

  // Serve static files from ./static/
  const baseDir = dirname(fromFileUrl(import.meta.url));
  const staticDir = join(baseDir, "static");

  app.get("/static/*", async (c) => {
    const filePath = join(staticDir, c.req.path.replace("/static/", ""));
    try {
      const content = await Deno.readFile(filePath);
      const ext = filePath.split(".").pop();
      const types: Record<string, string> = {
        html: "text/html", css: "text/css", js: "application/javascript",
        json: "application/json", svg: "image/svg+xml", png: "image/png",
      };
      return new Response(content, {
        headers: { "Content-Type": types[ext || ""] || "application/octet-stream" },
      });
    } catch {
      return c.notFound();
    }
  });

  // Serve index.html for root
  app.get("/", async (c) => {
    const html = await Deno.readTextFile(join(staticDir, "index.html"));
    return c.html(html);
  });

  return app;
}

// ============================================================================
// Standalone server
// ============================================================================

if (import.meta.main) {
  const port = parseInt(Deno.env.get("INTERVIEW_PORT") || "9998");
  const verbose = Deno.env.get("INTERVIEW_VERBOSE") === "true";
  const dataDir = Deno.env.get("INTERVIEW_DATA_DIR") || "./data/self-interview";

  const hasCustom = !!Deno.env.get("INTERVIEW_API_KEY");
  const hasGroq = !!Deno.env.get("GROQ_API_KEY");
  const hasOpenAI = !!Deno.env.get("OPENAI_API_KEY");
  const provider = hasCustom ? "custom" : hasGroq ? "groq" : hasOpenAI ? "openai" : "none (set INTERVIEW_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY)";
  const model = Deno.env.get("INTERVIEW_MODEL") || (hasGroq && !hasCustom ? "llama-3.3-70b-versatile" : "gpt-4o-mini");

  const sheetUrl = Deno.env.get("SM_SHEET_URL") || Deno.env.get("SHEET_URL");
  const storage = sheetUrl ? `sheetlog (${Deno.env.get("INTERVIEW_SHEET_NAME") || "self-interview"})` : `sqlite (${dataDir})`;

  console.log(`\n  self-interview server`);
  console.log(`  Storage: ${storage}`);
  console.log(`  Port: ${port}`);
  console.log(`  Provider: ${provider}`);
  console.log(`  Model: ${model}\n`);

  const app = await createInterviewApp({ dataDir, verbose, port });

  console.log(`  Web UI:  http://localhost:${port}`);
  console.log(`  API:     http://localhost:${port}/api\n`);

  Deno.serve({ port }, app.fetch);
}

// Re-export for library use
export { InterviewEngine } from "./engine.ts";
export { InterviewNotes } from "./notes.ts";
export { LCMStore } from "./lcm.ts";
export { MISSIONS, getMission, createCustomMission } from "./missions.ts";
export { createCompleteFn, createOpenAICompleteFn } from "./ai.ts";
export type { Mission } from "./missions.ts";
export type { CompleteFn } from "./lcm.ts";
