#!/usr/bin/env -S deno run --allow-all
/**
 * Smallstore CLI
 *
 * Interactive testing tool for smallstore operations.
 *
 * Usage:
 *   deno task cli get <path>
 *   deno task cli set <path> <json|@file>
 *   deno task cli delete <path>
 *   deno task cli keys [collection] [--prefix=PREFIX]
 *   deno task cli search <collection> <query> [--limit=N]
 *   deno task cli query <collection> [--where=field:op:value] [--limit=N]
 *   deno task cli collections [--pattern=GLOB]
 *   deno task cli tree [--depth=N]
 *
 * Global flags:
 *   --preset=memory|local|local-sqlite|cloud|hybrid|structured  (default: local-sqlite)
 *   --json          Force JSON output
 */

import { parseGlobalFlags, createStore, fail } from './helpers.ts';

import { execute as getCmd } from './commands/get.ts';
import { execute as setCmd } from './commands/set.ts';
import { execute as deleteCmd } from './commands/delete.ts';
import { execute as keysCmd } from './commands/keys.ts';
import { execute as searchCmd } from './commands/search.ts';
import { execute as queryCmd } from './commands/query.ts';
import { execute as collectionsCmd } from './commands/collections.ts';
import { execute as treeCmd } from './commands/tree.ts';
import { vfs } from './vfs.ts';
import { startRepl } from './repl.ts';

const COMMANDS: Record<string, (store: any, args: string[], flags: any) => Promise<void>> = {
  get: getCmd,
  set: setCmd,
  delete: deleteCmd,
  keys: keysCmd,
  search: searchCmd,
  query: queryCmd,
  collections: collectionsCmd,
  tree: treeCmd,
};

const HELP = `
Smallstore CLI

Commands:
  get <path>                              Get data at path
  set <path> <json|@file>                 Store data (JSON string or @filepath)
  delete <path>                           Delete data at path
  keys [collection] [--prefix=PREFIX]     List keys
  search <collection> <query> [--limit=N] Full-text search
  query <collection> [--where=F:op:V]     Structured query
  collections [--pattern=GLOB]            List collections
  tree [--depth=N]                        Tree view of all data
  sh "<cmd>"                              VFS shell (bash-like: ls, cd, cat, write, rm)
  vfs "<cmd>"                             Alias for sh

Global flags:
  --preset=NAME    Storage preset (default: local-sqlite)
                   Options: memory, local, local-sqlite, cloud, hybrid, structured
  --json           Force JSON output
`.trim();

// Parse args
const { flags, rest } = parseGlobalFlags(Deno.args);
const command = rest[0];
const commandArgs = rest.slice(1);

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP);
  Deno.exit(0);
}

// VFS / shell mode
if (command === 'sh' || command === 'vfs') {
  if (commandArgs.length === 0) {
    // No args → interactive REPL
    await startRepl(flags.preset);
    Deno.exit(0);
  }
  const vfsCmd = commandArgs.join(' ');
  if (vfsCmd === 'help' || vfsCmd === '--help') {
    console.log('VFS Shell — bash-like interface for smallstore');
    console.log('Usage: deno task cli sh "<commands>"');
    console.log('       deno task sh              (interactive REPL)');
    console.log('');
    console.log('Navigation:  pwd, cd, ls, tree');
    console.log('Read/Write:  cat [--format=json|csv|md|yaml], write, rm, cp, mv');
    console.log('Inspect:     stat, find [--name=glob], du, wc');
    console.log('Search:      grep');
    console.log('Export:       export --format=json|csv|md|yaml');
    console.log('');
    console.log('Pipes:    ls | wc, ls | grep pattern');
    console.log('Chains:   cd notes && ls && cat todo');
    console.log('Aliases:  dir=ls, read=cat, echo=write, delete=rm, copy=cp, move=mv, search=grep');
    Deno.exit(0);
  }
  const result = await vfs(vfsCmd, { preset: flags.preset });
  if (result.output) console.log(result.output);
  Deno.exit(result.exitCode);
}

const handler = COMMANDS[command];
if (!handler) {
  fail(`Unknown command: "${command}". Run with --help for usage.`);
}

const store = createStore(flags);
await handler(store, commandArgs, flags);
