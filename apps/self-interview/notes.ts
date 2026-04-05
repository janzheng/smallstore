// Interview Notes backed by smallstore
//
// Structured note-taking that persists alongside LCM conversation memory.
// Notes are organized by category and exported as markdown.

import type { Note, NotesData, ToolDefinition } from "./types.ts";

// ============================================================================
// InterviewNotes — in-memory with smallstore persistence
// ============================================================================

export class InterviewNotes {
  private data: NotesData;

  constructor(missionSlug: string, initial?: NotesData) {
    this.data = initial || InterviewNotes.emptyData(missionSlug);
  }

  static emptyData(missionSlug: string): NotesData {
    return {
      notes: [],
      nextId: 1,
      missionSlug,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Export data for persistence to smallstore */
  toJSON(): NotesData {
    this.data.updatedAt = new Date().toISOString();
    return this.data;
  }

  /** Load from smallstore data */
  static fromJSON(data: NotesData): InterviewNotes {
    const notes = new InterviewNotes(data.missionSlug, data);
    return notes;
  }

  setName(name: string): void {
    this.data.intervieweeName = name;
  }

  getName(): string | undefined {
    return this.data.intervieweeName;
  }

  setCustomMissionContext(context: string): void {
    this.data.customMissionContext = context;
  }

  getCustomMissionContext(): string | undefined {
    return this.data.customMissionContext;
  }

  getMissionSlug(): string {
    return this.data.missionSlug;
  }

  add(category: string, text: string, quote?: string): Note {
    const note: Note = {
      id: this.data.nextId++,
      category: category.toLowerCase().trim(),
      text,
      timestamp: new Date().toISOString(),
      quote,
    };
    this.data.notes.push(note);
    return note;
  }

  update(id: number, text: string): boolean {
    const note = this.data.notes.find((n) => n.id === id);
    if (!note) return false;
    note.text = text;
    return true;
  }

  remove(id: number): boolean {
    const idx = this.data.notes.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    this.data.notes.splice(idx, 1);
    return true;
  }

  list(category?: string): Note[] {
    if (category) {
      return this.data.notes.filter(
        (n) => n.category === category.toLowerCase().trim(),
      );
    }
    return this.data.notes;
  }

  categories(): string[] {
    const cats = new Set(this.data.notes.map((n) => n.category));
    return Array.from(cats).sort();
  }

  count(): number {
    return this.data.notes.length;
  }

  toMarkdown(): string {
    const lines: string[] = [];
    const name = this.data.intervieweeName || "Interview";
    lines.push(`# ${name} — Interview Notes`);
    lines.push(`\n_Mission: ${this.data.missionSlug}_`);
    lines.push(`_Last updated: ${this.data.updatedAt}_\n`);

    const byCat = new Map<string, Note[]>();
    for (const note of this.data.notes) {
      const arr = byCat.get(note.category) || [];
      arr.push(note);
      byCat.set(note.category, arr);
    }

    for (const [cat, notes] of Array.from(byCat.entries()).sort()) {
      lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n`);
      for (const note of notes) {
        lines.push(`- ${note.text}`);
        if (note.quote) {
          lines.push(`  > "${note.quote}"`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

// ============================================================================
// Tool definitions for LLM function calling
// ============================================================================

export function createNotesToolDefs(): ToolDefinition[] {
  return [
    {
      name: "note_write",
      description:
        "Save an interview note. Use this after learning something significant. " +
        "Organize by category (e.g., 'childhood', 'career', 'problem', 'achievements'). " +
        "Optionally include a direct quote from the interviewee.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Note category for organization (e.g., 'childhood', 'career', 'problem')",
          },
          text: {
            type: "string",
            description: "The note content — key fact, story summary, or insight",
          },
          quote: {
            type: "string",
            description: "Optional direct quote from the interviewee worth preserving",
          },
        },
        required: ["category", "text"],
      },
    },
    {
      name: "note_read",
      description:
        "Read your interview notes, optionally filtered by category. " +
        "Use this before asking questions to see what you already know.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Filter to a specific category (optional)",
          },
        },
        required: [],
      },
    },
    {
      name: "note_list",
      description: "List all note categories and their counts. Use to identify gaps in coverage.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "note_update",
      description: "Update an existing note by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Note ID to update" },
          text: { type: "string", description: "New note text" },
        },
        required: ["id", "text"],
      },
    },
    {
      name: "note_set_name",
      description: "Set the interviewee's name. Call this as soon as you learn their name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The interviewee's name" },
        },
        required: ["name"],
      },
    },
  ];
}

/** Execute a notes tool call */
export function executeNotesTool(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  notes: InterviewNotes,
): string {
  const a = args || {};
  switch (toolName) {
    case "note_write": {
      if (!a.category || !a.text) {
        return JSON.stringify({ error: "category and text are required" });
      }
      const note = notes.add(
        a.category as string,
        a.text as string,
        a.quote as string | undefined,
      );
      return JSON.stringify({ saved: true, id: note.id, totalNotes: notes.count() });
    }
    case "note_read": {
      const list = notes.list(a.category as string | undefined);
      if (list.length === 0) {
        return JSON.stringify({
          notes: [],
          message: a.category ? `No notes in category "${a.category}"` : "No notes yet",
        });
      }
      return JSON.stringify({
        notes: list.map((n) => ({ id: n.id, category: n.category, text: n.text, quote: n.quote })),
        count: list.length,
      });
    }
    case "note_list": {
      const cats = notes.categories();
      const summary: Record<string, number> = {};
      for (const cat of cats) summary[cat] = notes.list(cat).length;
      return JSON.stringify({ categories: summary, totalNotes: notes.count() });
    }
    case "note_update": {
      if (!a.id || !a.text) return JSON.stringify({ error: "id and text are required" });
      const ok = notes.update(a.id as number, a.text as string);
      return JSON.stringify({ updated: ok });
    }
    case "note_set_name": {
      if (!a.name) return JSON.stringify({ error: "name is required" });
      notes.setName(a.name as string);
      return JSON.stringify({ name: a.name, set: true });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}
