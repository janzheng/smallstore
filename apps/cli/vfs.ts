/**
 * Smallstore VFS — Bash-like Virtual Filesystem for Agents
 *
 * Single entry point: vfs(cmd, options) → VfsResult
 * Supports: pwd, cd, ls, cat, write, rm, cp, mv, stat, find, grep, tree, du, wc, export
 * Supports && chaining: "cd notes && ls && cat todo"
 * Supports | pipes: "ls | wc" passes left output as stdin to right command
 */

import { createSmallstore } from '../../mod.ts';
import type { PresetName } from '../../presets.ts';
import type { Smallstore } from '../../src/types.ts';
import type { OverlayAdapter } from '../../src/adapters/overlay.ts';
import { COMMANDS, ALIASES } from './commands/vfs/registry.ts';

// ============================================================================
// Types
// ============================================================================

export interface VfsState {
  /** Current working directory: "" = root, "notes" = inside notes collection */
  cwd: string;
}

export interface VfsResult {
  /** Text output for the agent to read */
  output: string;
  /** Updated state (pass back on next call) */
  state: VfsState;
  /** 0 = ok, 1 = error */
  exitCode: number;
}

export interface VfsOptions {
  store?: Smallstore;
  state?: VfsState;
  preset?: PresetName;
  /** Optional overlay adapter for status/diff/commit/discard commands */
  overlay?: OverlayAdapter;
}

export interface VfsContext {
  store: Smallstore;
  state: VfsState;
  args: string[];
  flags: Record<string, string | boolean>;
  /** Piped input from previous command (via |) */
  stdin?: string;
  /** Optional overlay adapter for overlay commands */
  overlay?: OverlayAdapter;
}

export interface VfsCommandResult {
  output: string;
  newState?: Partial<VfsState>;
}

export type VfsCommandFn = (ctx: VfsContext) => Promise<VfsCommandResult>;

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve a path relative to cwd.
 *   resolvePath("", "notes")          → "notes"
 *   resolvePath("notes", "todo")      → "notes/todo"
 *   resolvePath("notes/work", "..")   → "notes"
 *   resolvePath("notes", "/research") → "research"  (absolute)
 *   resolvePath("", "..")             → ""           (can't go above root)
 */
export function resolvePath(cwd: string, target: string): string {
  // Absolute path
  if (target.startsWith('/')) {
    return normalizePath(target.slice(1));
  }

  const base = cwd ? cwd.split('/') : [];
  const parts = target.split('/');

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (base.length > 0) base.pop();
    } else {
      base.push(part);
    }
  }

  return base.join('/');
}

function normalizePath(p: string): string {
  return p.split('/').filter(Boolean).join('/');
}

// ============================================================================
// Tokenizer
// ============================================================================

/**
 * Parse a command string into { command, args, flags }
 * Handles quoted strings and --flag=value / --flag
 */
export function tokenize(input: string): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const tokens: string[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && input[i] === ' ') i++;
    if (i >= len) break;

    // Quoted string
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      let token = '';
      while (i < len && input[i] !== quote) {
        token += input[i];
        i++;
      }
      if (i < len) i++; // skip closing quote
      tokens.push(token);
    } else {
      // Unquoted token
      let token = '';
      while (i < len && input[i] !== ' ') {
        token += input[i];
        i++;
      }
      tokens.push(token);
    }
  }

  if (tokens.length === 0) {
    return { command: '', args: [], flags: {} };
  }

  const command = tokens[0];
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let j = 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.startsWith('--')) {
      const eqIdx = t.indexOf('=');
      if (eqIdx > 0) {
        flags[t.slice(2, eqIdx)] = t.slice(eqIdx + 1);
      } else {
        flags[t.slice(2)] = true;
      }
    } else if (t.startsWith('-') && t.length === 2) {
      // Short flags: -r, -l, etc.
      flags[t.slice(1)] = true;
    } else {
      args.push(t);
    }
  }

  return { command, args, flags };
}

// ============================================================================
// Core Engine
// ============================================================================

async function executeOne(
  cmdStr: string,
  store: Smallstore,
  state: VfsState,
  stdin?: string,
  overlay?: OverlayAdapter,
): Promise<VfsResult> {
  const { command, args, flags } = tokenize(cmdStr);

  if (!command) {
    return { output: stdin || '', state, exitCode: 0 };
  }

  // Resolve aliases
  const resolved = ALIASES[command] || command;
  const handler = COMMANDS[resolved];

  if (!handler) {
    return {
      output: `vfs: command not found: ${command}`,
      state,
      exitCode: 1,
    };
  }

  try {
    const result = await handler({ store, state, args, flags, stdin, overlay });
    const newState = result.newState
      ? { ...state, ...result.newState }
      : state;
    return { output: result.output, state: newState, exitCode: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `vfs: ${resolved}: ${msg}`, state, exitCode: 1 };
  }
}

/**
 * Split a command line on && (chains) and | (pipes), respecting quoted strings.
 * Returns segments: [{ parts: ["ls", "wc"], join: "|" }, { parts: ["pwd"], join: "&&" }]
 */
function splitPipeline(cmd: string): string[][] {
  // First split on && to get chain segments
  const chains = cmd.split('&&').map((c) => c.trim()).filter(Boolean);
  // Each chain segment may contain pipes
  return chains.map((chain) =>
    chain.split('|').map((p) => p.trim()).filter(Boolean)
  );
}

/**
 * Execute one or more VFS commands.
 * Supports && chaining and | pipes.
 *
 * @example
 * const r = await vfs('ls', { preset: 'local-sqlite' });
 * const r2 = await vfs('cd notes && ls | wc', { state: r.state });
 */
export async function vfs(cmd: string, options?: VfsOptions): Promise<VfsResult> {
  const store = options?.store ?? createSmallstore({ preset: options?.preset ?? 'memory' });
  const overlay = options?.overlay;
  let state: VfsState = options?.state ?? { cwd: '' };

  const chainSegments = splitPipeline(cmd);
  const outputs: string[] = [];

  for (const pipeParts of chainSegments) {
    let pipeOutput: string | undefined;

    for (const subcmd of pipeParts) {
      const result = await executeOne(subcmd, store, state, pipeOutput, overlay);
      if (result.exitCode !== 0) {
        outputs.push(result.output);
        return { output: outputs.join('\n'), state: result.state, exitCode: result.exitCode };
      }
      state = result.state;
      pipeOutput = result.output;
    }

    if (pipeOutput) outputs.push(pipeOutput);
  }

  return { output: outputs.join('\n'), state, exitCode: 0 };
}
