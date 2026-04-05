// Self-Interview API Routes (Hono)
//
// RESTful API for the interview system.
// All state lives in smallstore — the API is stateless per-request.

import { Hono } from "hono";
import type { Smallstore } from "./store.ts";
import { InterviewEngine, type EngineConfig } from "./engine.ts";
import { MISSIONS } from "./missions.ts";
import { createOpenAICompleteFn } from "./ai.ts";
import type { CompleteFn } from "./lcm.ts";
import type { LCMConfig } from "./types.ts";

export interface RouterConfig {
  store: Smallstore;
  complete: CompleteFn;
  lcm?: LCMConfig;
  verbose?: boolean;
}

/** AI config overrides sent from the frontend */
interface AIConfigOverride {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Create a new engine, optionally with custom AI config from the request */
function makeEngine(config: RouterConfig, aiOverride?: AIConfigOverride): InterviewEngine {
  const complete = (aiOverride?.apiKey || aiOverride?.baseUrl)
    ? createOpenAICompleteFn({ apiKey: aiOverride.apiKey, baseUrl: aiOverride.baseUrl, model: aiOverride.model })
    : config.complete;

  return new InterviewEngine({
    store: config.store,
    complete,
    lcm: config.lcm,
    verbose: config.verbose,
  });
}

/** Extract AI config overrides from request body */
function getAIOverride(body: Record<string, unknown>): AIConfigOverride | undefined {
  const ai = body.ai as AIConfigOverride | undefined;
  if (ai?.apiKey || ai?.baseUrl) return ai;
  return undefined;
}

/** Load a session or return 404 — no AI call */
async function loadOrFail(engine: InterviewEngine, session: string, c: any): Promise<boolean> {
  const found = await engine.loadSession(session);
  if (!found) {
    c.status(404);
    return false;
  }
  return true;
}

export function createInterviewRoutes(config: RouterConfig): Hono {
  const app = new Hono();

  // ---------- Missions ----------

  app.get("/missions", (c) => {
    return c.json({
      missions: MISSIONS.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
      })),
    });
  });

  // ---------- Sessions ----------

  app.get("/sessions", async (c) => {
    const engine = makeEngine(config);
    const sessions = await engine.listSessions();
    return c.json({ sessions });
  });

  app.delete("/sessions/:session", async (c) => {
    const session = c.req.param("session");
    const engine = makeEngine(config);
    await engine.deleteSession(session);
    return c.json({ deleted: true, session });
  });

  // ---------- Start / Resume Session ----------

  app.post("/sessions/:session/start", async (c) => {
    const session = c.req.param("session");
    const body = await c.req.json().catch(() => ({}));
    const engine = makeEngine(config, getAIOverride(body));

    // If no mission specified, try to resume an existing session (no AI call)
    if (!body.mission && !body.customMission) {
      const found = await engine.loadSession(session);
      if (found) {
        return c.json({
          session,
          isNew: false,
          greeting: "",
          status: engine.getStatus(),
          history: engine.getHistory(),
        });
      }
      // Not found — fall through to error
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    // New session — generate AI greeting
    try {
      const result = await engine.startSession({
        session,
        mission: body.mission,
        customMission: body.customMission,
        fresh: body.fresh === true,
        directive: body.directive,
      });

      return c.json({
        session,
        isNew: result.isNew,
        greeting: result.greeting,
        status: engine.getStatus(),
        history: result.history || [],
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- Greet (async welcome-back for resumed sessions) ----------

  app.post("/sessions/:session/greet", async (c) => {
    const session = c.req.param("session");
    const body = await c.req.json().catch(() => ({}));
    const engine = makeEngine(config, getAIOverride(body));

    const found = await engine.loadSession(session);
    if (!found) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    const greeting = await engine.generateGreeting(body.directive);
    return c.json({ greeting });
  });

  // ---------- Chat Turn ----------

  app.post("/sessions/:session/turn", async (c) => {
    const session = c.req.param("session");
    const body = await c.req.json();

    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }

    const engine = makeEngine(config, getAIOverride(body));

    // Load session state without generating a greeting
    const found = await engine.loadSession(session);
    if (!found) {
      return c.json({ error: `Session "${session}" not found. Start it first.` }, 404);
    }

    if (body.directive) engine.setDirective(body.directive);

    const result = await engine.turn(body.message);
    return c.json(result);
  });

  // ---------- Notes ----------

  app.get("/sessions/:session/notes", async (c) => {
    const session = c.req.param("session");
    const category = c.req.query("category");
    const engine = makeEngine(config);

    if (!await loadOrFail(engine, session, c)) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    return c.json({ notes: engine.getNotes(category || undefined) });
  });

  app.get("/sessions/:session/gaps", async (c) => {
    const session = c.req.param("session");
    const engine = makeEngine(config);

    if (!await loadOrFail(engine, session, c)) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    return c.json({ gaps: engine.getGaps(), noteCount: engine.getStatus().noteCount });
  });

  // ---------- History ----------

  app.get("/sessions/:session/history", async (c) => {
    const session = c.req.param("session");
    const engine = makeEngine(config);

    if (!await loadOrFail(engine, session, c)) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    return c.json({ messages: engine.getHistory() });
  });

  // ---------- Search ----------

  app.get("/sessions/:session/search", async (c) => {
    const session = c.req.param("session");
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter required" }, 400);

    const engine = makeEngine(config);

    if (!await loadOrFail(engine, session, c)) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    return c.json({ results: engine.search(query) });
  });

  // ---------- Summary & Export ----------

  app.post("/sessions/:session/summarize", async (c) => {
    const session = c.req.param("session");
    const engine = makeEngine(config);

    // Summarize needs startSession since it makes an AI call
    try {
      await engine.startSession({ session });
    } catch {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    const summary = await engine.summarize();
    return c.json({ summary });
  });

  app.get("/sessions/:session/export", async (c) => {
    const session = c.req.param("session");
    const engine = makeEngine(config);

    if (!await loadOrFail(engine, session, c)) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    const format = c.req.query("format") || "markdown";
    if (format === "json") {
      return c.json({
        notes: engine.getNotes(),
        status: engine.getStatus(),
      });
    }

    const md = engine.exportMarkdown();
    return c.text(md);
  });

  // ---------- Status ----------

  app.get("/sessions/:session/status", async (c) => {
    const session = c.req.param("session");
    const engine = makeEngine(config);

    if (!await loadOrFail(engine, session, c)) {
      return c.json({ error: `Session "${session}" not found` }, 404);
    }

    return c.json(engine.getStatus());
  });

  return app;
}
