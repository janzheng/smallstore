#!/usr/bin/env -S deno run --allow-all
/**
 * Smallstore VFS Interactive REPL
 *
 * Maintains state between commands. Type 'exit' or Ctrl+D to quit.
 *
 * Usage:
 *   deno task sh         (no args → enters REPL)
 *   deno task vfs        (alias)
 */

import { vfs } from './vfs.ts';
import type { VfsState } from './vfs.ts';
import type { PresetName } from '../../presets.ts';
import { createSmallstore } from '../../mod.ts';

export async function startRepl(preset: PresetName = 'local-sqlite') {
  const store = createSmallstore({ preset });
  let state: VfsState = { cwd: '' };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  console.log('Smallstore VFS Shell');
  console.log(`Preset: ${preset} | Type "help" for commands, "exit" to quit`);
  console.log('');

  const buf = new Uint8Array(4096);

  while (true) {
    const prompt = `smallstore:${state.cwd || '/'}$ `;
    await Deno.stdout.write(encoder.encode(prompt));

    const n = await Deno.stdin.read(buf);
    if (n === null) {
      // EOF (Ctrl+D)
      console.log('');
      break;
    }

    const line = decoder.decode(buf.subarray(0, n)).trim();

    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;

    if (line === 'help') {
      printHelp();
      continue;
    }

    const result = await vfs(line, { store, state });
    state = result.state;

    if (result.output) {
      console.log(result.output);
    }

    if (result.exitCode !== 0) {
      // Show exit code for errors so agents can detect failures
      console.log(`(exit: ${result.exitCode})`);
    }
  }

  // Clean up store resources on exit
  if (typeof store.close === 'function') {
    await store.close();
  }
}

function printHelp() {
  console.log(`
Navigation:  pwd, cd <path>, ls [path], tree [--depth=N]
Read/Write:  cat <path> [--format=json|csv|md|yaml]
             write <path> <json|string>
             rm <path> [-r], cp <src> <dst> [-r], mv <src> <dst>
Inspect:     stat <path>, find [path] [--name=glob], du [path], wc [path]
Search:      grep <query> [path] [--limit=N]
Export:       export <path> [--format=json|csv|md|yaml]

Pipes:       ls | wc          (pipe output to next command)
Chains:      cd notes && ls   (run sequentially, stop on error)

Aliases:     dir=ls, read=cat, echo=write, delete=rm, copy=cp, move=mv, search=grep
  `.trim());
}

// Run if executed directly
if (import.meta.main) {
  const preset = (Deno.args.find(a => a.startsWith('--preset='))?.split('=')[1] || 'local-sqlite') as PresetName;
  await startRepl(preset);
}
