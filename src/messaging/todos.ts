/**
 * Note → todo extraction.
 *
 * Scans `forward_note` strings for action-shaped lines using a small set
 * of regex patterns. Pure derived view — no schema change, no LLM, no
 * extraction-at-ingest. Skips quoted-reply lines (`> ...`) and checked
 * checkboxes (`[x]`). First matching pattern per line wins.
 *
 * Pattern set documented in `.brief/notes-todos-and-mirror.md § Phase 1`.
 * To add a pattern, append to `TODO_PATTERNS` and add a fixture in
 * `tests/messaging-todos.test.ts`. Patterns must be ordered by specificity
 * since first-match wins.
 */

export interface TodoLineMatch {
  /** Pattern name that matched first (for UI introspection). */
  pattern: string;
  /** The matched line, trimmed. */
  line: string;
}

interface TodoPattern {
  name: string;
  regex: RegExp;
}

/** Patterns are tried in order; first match wins per line. */
const TODO_PATTERNS: ReadonlyArray<TodoPattern> = [
  // Markdown unchecked checkbox: "- [ ] foo" / "[ ] foo"
  { name: 'unchecked-checkbox', regex: /^\s*-?\s*\[\s\]\s+/ },
  // Explicit "TODO: foo" / "todo: foo"
  { name: 'todo-prefix', regex: /^\s*todo[:.]/i },
  // Explicit "Action: foo"
  { name: 'action-prefix', regex: /^\s*action[:.]/i },
  // "remind me to ..." / "reminder to self ..." / "remember to ..."
  { name: 'remind', regex: /\b(remind(?:er)?s?|remember(?:ed)?s?)\b/i },
  // "sub me to" / "sub mailroom to" / "subscribe X to"
  // \bsub\b ensures we don't match "subway"; the optional "scribe" extension
  // covers the full word too.
  { name: 'subscribe', regex: /\bsubs?(?:cribe)?\s+(?:me|us|\w+)\s+to\b/i },
  // "follow up" / "followup" / "follow-up"
  { name: 'follow-up', regex: /\bfollow[\s-]?ups?\b/i },
];

/** Lines we always skip even if they otherwise match. */
const SKIP_PATTERNS: ReadonlyArray<RegExp> = [
  // Quoted reply — original publisher content, not user notes.
  /^\s*>/,
  // Checked checkbox — that's a "done" line, not a todo.
  /^\s*-?\s*\[x\]\s+/i,
];

/**
 * Scan a free-text note for todo-shaped lines.
 *
 * Returns one `TodoLineMatch` per matching line. A note with multiple
 * matching lines emits multiple matches. Empty input or non-string input
 * returns `[]`.
 */
export function scanNoteForTodos(note: string | undefined | null): TodoLineMatch[] {
  if (typeof note !== 'string' || note.length === 0) return [];

  const out: TodoLineMatch[] = [];
  for (const rawLine of note.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) continue;
    if (SKIP_PATTERNS.some((p) => p.test(line))) continue;
    for (const { name, regex } of TODO_PATTERNS) {
      if (regex.test(line)) {
        out.push({ pattern: name, line: line.trim() });
        break; // first match wins
      }
    }
  }
  return out;
}
