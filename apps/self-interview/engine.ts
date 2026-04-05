// Interview Engine
//
// Core interview logic: manages sessions, runs the agent loop with LCM + notes.
// Storage-agnostic — takes a smallstore instance for persistence.

import type { Smallstore } from "./store.ts";
import type {
  LCMConfig,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  NotesData,
  LCMStoreData,
  SessionMeta,
  TurnResponse,
} from "./types.ts";
import { DEFAULT_LCM_CONFIG } from "./types.ts";
import {
  LCMStore,
  assembleContext,
  runIncrementalSummarization,
  runEscalationProtocol,
  stripScaffolding,
  stripThinkTokens,
  type CompleteFn,
} from "./lcm.ts";
import {
  InterviewNotes,
  createNotesToolDefs,
  executeNotesTool,
} from "./notes.ts";
import {
  getMission,
  createCustomMission,
  type Mission,
} from "./missions.ts";

// ============================================================================
// Storage keys
// ============================================================================

function lcmKey(session: string): string {
  return `interviews/lcm/${session}`;
}
function notesKey(session: string): string {
  return `interviews/notes/${session}`;
}
function metaKey(session: string): string {
  return `interviews/meta/${session}`;
}

// ============================================================================
// LCM grep tool definition
// ============================================================================

const LCM_GREP_TOOL: ToolDefinition = {
  name: "lcm_grep",
  description:
    "Search the full conversation history by keyword. Returns matching messages. " +
    "Use 'bm25' mode for relevance-ranked results.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term" },
      mode: { type: "string", enum: ["regex", "bm25"], description: "Search mode (default: bm25)" },
    },
    required: ["query"],
  },
};

// ============================================================================
// Interview Engine
// ============================================================================

export interface EngineConfig {
  /** Smallstore instance for persistence */
  store: Smallstore;
  /** AI completion function */
  complete: CompleteFn;
  /** LCM configuration */
  lcm?: LCMConfig;
  /** Show verbose LCM diagnostics */
  verbose?: boolean;
}

export class InterviewEngine {
  private store: Smallstore;
  private complete: CompleteFn;
  private lcmConfig: LCMConfig;
  private verbose: boolean;

  // In-memory state for the active session
  private sessionName: string | null = null;
  private mission: Mission | null = null;
  private lcmStore: LCMStore | null = null;
  private notes: InterviewNotes | null = null;
  private directive = "";

  constructor(config: EngineConfig) {
    this.store = config.store;
    this.complete = config.complete;
    this.lcmConfig = config.lcm || DEFAULT_LCM_CONFIG;
    this.verbose = config.verbose || false;
  }

  // ---------- Session management ----------

  /** Start or resume a session */
  async startSession(options: {
    session: string;
    mission?: string;
    customMission?: string;
    fresh?: boolean;
    directive?: string;
  }): Promise<{ isNew: boolean; greeting: string }> {
    this.sessionName = options.session;
    this.directive = options.directive || "";

    // Clear existing data if fresh
    if (options.fresh) {
      await this.store.delete(lcmKey(options.session));
      await this.store.delete(notesKey(options.session));
      await this.store.delete(metaKey(options.session));
    }

    // Load existing data (parallel)
    const [existingNotes, existingLcm] = await Promise.all([
      this.store.get(notesKey(options.session)),
      this.store.get(lcmKey(options.session)),
    ]);

    // Determine mission
    if (options.customMission) {
      this.mission = createCustomMission(options.customMission, options.session);
    } else if (options.mission) {
      this.mission = getMission(options.mission) || null;
      if (!this.mission) throw new Error(`Unknown mission: ${options.mission}`);
    } else if (existingNotes?.content) {
      const data = existingNotes.content as NotesData;
      this.mission = getMission(data.missionSlug) || null;
      if (!this.mission && data.customMissionContext) {
        this.mission = createCustomMission(data.customMissionContext, data.missionSlug);
      }
    }

    if (!this.mission) {
      throw new Error("No mission specified and no existing session found");
    }

    // Initialize stores
    if (existingLcm?.content) {
      this.lcmStore = LCMStore.fromJSON(existingLcm.content as LCMStoreData);
    } else {
      this.lcmStore = new LCMStore();
    }

    if (existingNotes?.content) {
      this.notes = InterviewNotes.fromJSON(existingNotes.content as NotesData);
    } else {
      this.notes = new InterviewNotes(this.mission.slug);
    }

    // Save custom mission context
    if (this.mission.name === "Custom" && !this.notes.getCustomMissionContext()) {
      const match = this.mission.systemPrompt.match(/---\n([\s\S]*?)\n---/);
      if (match) {
        this.notes.setCustomMissionContext(match[1]);
        await this._saveNotes();
      }
    }

    const isNew = !existingLcm?.content;

    // Capture history BEFORE generating greeting (so it's not duplicated)
    const priorHistory = isNew ? [] : this.getHistory();

    // Generate greeting — skip tools for new sessions (nothing to look up)
    const greeting = await this._agentTurn(
      isNew
        ? this._buildInitMessage(true)
        : this._buildInitMessage(false),
      { skipTools: isNew },
    );

    // Save session meta
    await this._saveMeta();

    return { isNew, greeting, history: priorHistory };
  }

  /** Generate a greeting for an already-loaded session (no startSession needed) */
  async generateGreeting(directive?: string): Promise<string> {
    this._assertSession();
    if (directive) this.directive = directive;
    const greeting = await this._agentTurn(
      this._buildInitMessage(false),
      { skipTools: false },
    );
    return greeting;
  }

  /** Process a user message and return the interviewer's response */
  async turn(message: string): Promise<TurnResponse> {
    this._assertSession();
    const response = await this._agentTurn(message);
    return {
      response,
      noteCount: this.notes!.count(),
      messageCount: this.lcmStore!.getStats().totalMessages,
      activeTokens: this.lcmStore!.getStats().activeTokens,
    };
  }

  /** Get session status */
  getStatus(): {
    session: string;
    mission: string;
    noteCount: number;
    categories: string[];
    stats: ReturnType<LCMStore["getStats"]>;
  } {
    this._assertSession();
    return {
      session: this.sessionName!,
      mission: this.mission!.name,
      noteCount: this.notes!.count(),
      categories: this.notes!.categories(),
      stats: this.lcmStore!.getStats(),
    };
  }

  /** Get notes, optionally filtered by category */
  getNotes(category?: string) {
    this._assertSession();
    return this.notes!.list(category);
  }

  /** Get conversation history (user + assistant messages only, excluding scaffolding) */
  getHistory(): { role: string; content: string }[] {
    this._assertSession();
    return this.lcmStore!.getAllMessages()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => !m.content.startsWith("["))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  /** Get coverage gaps */
  getGaps(): Record<string, number> {
    this._assertSession();
    const summary: Record<string, number> = {};
    for (const cat of this.notes!.categories()) {
      summary[cat] = this.notes!.list(cat).length;
    }
    return summary;
  }

  /** Search conversation history */
  search(query: string) {
    this._assertSession();
    return this.lcmStore!.grep(query, { mode: "bm25" }).slice(0, 8).map((r) => ({
      role: r.message.role,
      content: r.message.content.slice(0, 200),
      seq: r.message.seq,
    }));
  }

  /** Generate a session summary */
  async summarize(): Promise<string> {
    this._assertSession();
    return await this._agentTurn(
      `[The interviewee asked for a final session summary. Write a concise, structured summary with:
1) Key facts captured
2) Timeline / chronology
3) Themes and values
4) Open gaps to ask next
5) Suggested next steps
Base this ONLY on this session's conversation and notes.]`,
    );
  }

  /** Export notes as markdown */
  exportMarkdown(): string {
    this._assertSession();
    return this.notes!.toMarkdown();
  }

  /** Update the interview directive mid-session */
  setDirective(directive: string): void {
    this._assertSession();
    this.directive = directive;
  }

  /** List all sessions */
  async listSessions(): Promise<SessionMeta[]> {
    // Load session index (a list of session names)
    const indexResult = await this.store.get("interviews/session-index");
    const sessionNames: string[] = indexResult?.content || [];

    // Fetch all session meta in parallel
    const results = await Promise.all(
      sessionNames.map((name) => this.store.get(metaKey(name))),
    );
    const sessions = results
      .filter((r) => r?.content)
      .map((r) => r!.content as SessionMeta);
    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /** Load a session without generating an AI greeting (for read-only endpoints) */
  async loadSession(session: string): Promise<boolean> {
    this.sessionName = session;

    const [existingNotes, existingLcm] = await Promise.all([
      this.store.get(notesKey(session)),
      this.store.get(lcmKey(session)),
    ]);

    if (!existingNotes?.content && !existingLcm?.content) {
      this.sessionName = null;
      return false;
    }

    // Determine mission from stored notes
    if (existingNotes?.content) {
      const data = existingNotes.content as NotesData;
      this.mission = getMission(data.missionSlug) || null;
      if (!this.mission && data.customMissionContext) {
        this.mission = createCustomMission(data.customMissionContext, data.missionSlug);
      }
    }

    // Initialize stores
    this.lcmStore = existingLcm?.content
      ? new LCMStore(existingLcm.content as LCMStoreData)
      : new LCMStore();

    this.notes = existingNotes?.content
      ? InterviewNotes.fromJSON(existingNotes.content as NotesData)
      : new InterviewNotes(this.mission?.slug || "unknown");

    return true;
  }

  /** Delete a session */
  async deleteSession(session: string): Promise<void> {
    await this.store.delete(lcmKey(session));
    await this.store.delete(notesKey(session));
    await this.store.delete(metaKey(session));

    // Update session index
    const indexResult = await this.store.get("interviews/session-index");
    const sessionNames: string[] = indexResult?.content || [];
    const idx = sessionNames.indexOf(session);
    if (idx !== -1) {
      sessionNames.splice(idx, 1);
      await this.store.set("interviews/session-index", sessionNames, { mode: "overwrite" });
    }
  }

  // ---------- Internal ----------

  private _assertSession(): void {
    if (!this.sessionName || !this.mission || !this.lcmStore || !this.notes) {
      throw new Error("No active session. Call startSession() first.");
    }
  }

  private _buildSystemPrompt(): string {
    let prompt = this.mission!.systemPrompt;
    if (this.directive) {
      prompt += `\n\n## CURRENT DIRECTIVE\n${this.directive}\nFocus your questions on this area.`;
    }
    if (this.notes!.getName()) {
      prompt += `\n\n## INTERVIEWEE\nTheir name is ${this.notes!.getName()}. Use it naturally.`;
    }
    return prompt;
  }

  private _buildInitMessage(isNew: boolean): string {
    if (isNew) {
      return `[New interview session. Mission: ${this.mission!.name}. ${
        this.directive ? `Directive: ${this.directive}. ` : ""
      }Warmly introduce yourself and ask your first question. Suggested opener (adapt freely): "${
        this.mission!.openers[Math.floor(Math.random() * this.mission!.openers.length)]
      }"]`;
    }
    return `[Resuming interview session. ${
      this.notes!.count() > 0
        ? `You have ${this.notes!.count()} notes across: ${this.notes!.categories().join(", ")}. ` +
          `Use note_read to recall what you've covered, then continue naturally. ` +
          `Reference something specific from before.`
        : "Continue the interview."
    }${this.directive ? ` Directive: ${this.directive}` : ""}]`;
  }

  private async _agentTurn(
    userMessage: string,
    opts?: { skipTools?: boolean },
  ): Promise<string> {
    const store = this.lcmStore!;
    const notes = this.notes!;
    const systemPrompt = this._buildSystemPrompt();
    const useTools = !opts?.skipTools;
    const allTools: ToolDefinition[] = useTools
      ? [LCM_GREP_TOOL, ...createNotesToolDefs()]
      : [];

    // 1. Append user message
    store.appendMessage("user", userMessage);

    // 2. Assemble context from current state (fast — no AI calls)
    const { messages, totalTokens } = assembleContext(
      store, systemPrompt, this.lcmConfig.maxSummariesInContext,
    );
    if (this.verbose) {
      console.log(`  [LCM: ${totalTokens} tok, ${messages.length} msgs]`);
    }

    // 3. If no tools, just do a single completion
    if (!useTools) {
      const response = await this.complete(messages, { temperature: 0.5 });
      const sanitized = stripScaffolding(response.content || "Hello! Let's get started.");
      store.appendMessage("assistant", sanitized);
      // Persist and run LCM maintenance in background
      this._backgroundMaintenance(systemPrompt);
      return stripThinkTokens(sanitized);
    }

    // 4. Agent loop with tool calls
    const workingMessages: ChatMessage[] = [...messages];
    let finalResponse = "";

    for (let i = 0; i < 8; i++) {
      let response;
      try {
        response = await this.complete(workingMessages, {
          temperature: 0.5,
          tools: allTools,
          tool_choice: "auto",
        } as any);
      } catch (err) {
        const msg = (err as Error).message || "";
        if (msg.includes("failed_generation") || msg.includes("Failed to call")) {
          response = await this.complete(workingMessages, { temperature: 0.5 });
        } else {
          throw err;
        }
      }

      let toolCalls: ToolCall[] = (response as any).tool_calls || [];
      let textContent = response.content || "";

      // Parse text-based tool calls from Llama/Groq models
      // e.g. <function=note_write>{"category":"childhood","text":"..."}</function>
      if (toolCalls.length === 0 && textContent) {
        const parsed = this._parseTextToolCalls(textContent);
        if (parsed.length > 0) {
          toolCalls = parsed;
          // Strip the function tags from the text content
          textContent = textContent
            .replace(/<function=\w+>[\s\S]*?<\/function>/g, "")
            .trim();
        }
      }

      if (toolCalls.length === 0) {
        finalResponse = textContent || "...";
        break;
      }

      workingMessages.push({
        role: "assistant",
        content: textContent,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : (call.function.arguments || {});
        } catch {
          toolArgs = {};
        }

        let result: string;
        const toolName = call.function.name;

        if (toolName === "lcm_grep") {
          const mode = (toolArgs.mode as "regex" | "bm25") || "bm25";
          const results = store.grep(String(toolArgs.query), { mode });
          result = results.length === 0
            ? JSON.stringify({ matches: 0, message: "No matches found." })
            : JSON.stringify({
                matches: results.length,
                results: results.slice(0, 10).map((r) => ({
                  role: r.message.role,
                  content: r.message.content.slice(0, 300),
                  seq: r.message.seq,
                })),
              });
        } else if (toolName.startsWith("note_")) {
          result = executeNotesTool(toolName, toolArgs, notes);
        } else {
          result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
        }

        if (this.verbose) {
          console.log(`  [${toolName}] ${result.slice(0, 100)}...`);
        }

        workingMessages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
    }

    if (!finalResponse) {
      const response = await this.complete(workingMessages, { temperature: 0.5 });
      finalResponse = response.content || "Let me think about that...";
    }

    // 5. Clean and store
    const sanitized = stripScaffolding(finalResponse);
    store.appendMessage("assistant", sanitized);

    // 6. Persist + LCM maintenance in background (don't block the response)
    this._backgroundMaintenance(systemPrompt);

    return stripThinkTokens(sanitized);
  }

  /** Run LCM summarization, escalation, and persist — all in background */
  private _backgroundMaintenance(systemPrompt: string): void {
    const run = async () => {
      try {
        const store = this.lcmStore!;

        // Persist immediately (writes go to cache, flush is async)
        await Promise.all([this._saveLcm(), this._saveNotes(), this._saveMeta()]);

        // LCM maintenance — only when there are enough messages
        if (store.getStats().totalMessages > 4) {
          await runIncrementalSummarization(store, this.complete, this.lcmConfig);

          const escalation = await runEscalationProtocol(
            store, this.complete, systemPrompt, this.lcmConfig,
          );
          if (escalation.escalationLevel > 0 && this.verbose) {
            console.log(`  [LCM bg escalation L${escalation.escalationLevel}]`);
          }

          // Save again after LCM changes
          await this._saveLcm();
        }
      } catch (err) {
        console.error("[LCM bg maintenance]", err);
      }
    };
    run(); // fire-and-forget
  }

  /** Parse text-based tool calls emitted by Llama/Groq models as <function=name>{args}</function> */
  private _parseTextToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const regex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      const argsStr = match[2].trim();
      calls.push({
        id: `call_${Date.now()}_${calls.length}`,
        type: "function",
        function: { name, arguments: argsStr },
      });
    }
    return calls;
  }

  private async _saveLcm(): Promise<void> {
    await this.store.set(lcmKey(this.sessionName!), this.lcmStore!.toJSON(), { mode: "overwrite" });
  }

  private async _saveNotes(): Promise<void> {
    await this.store.set(notesKey(this.sessionName!), this.notes!.toJSON(), { mode: "overwrite" });
  }

  private async _saveMeta(): Promise<void> {
    const meta: SessionMeta = {
      name: this.sessionName!,
      missionSlug: this.mission!.slug,
      missionName: this.mission!.name,
      createdAt: this.notes!.toJSON().createdAt,
      updatedAt: new Date().toISOString(),
      noteCount: this.notes!.count(),
      messageCount: this.lcmStore!.getStats().totalMessages,
      directive: this.directive || undefined,
    };
    await this.store.set(metaKey(this.sessionName!), meta, { mode: "overwrite" });

    // Update session index
    const indexResult = await this.store.get("interviews/session-index");
    const sessionNames: string[] = indexResult?.content || [];
    if (!sessionNames.includes(this.sessionName!)) {
      sessionNames.push(this.sessionName!);
      await this.store.set("interviews/session-index", sessionNames, { mode: "overwrite" });
    }
  }
}
