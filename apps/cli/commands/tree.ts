import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  let depth = 3;

  for (const arg of args) {
    if (arg.startsWith('--depth=')) depth = parseInt(arg.split('=')[1], 10);
  }

  const collections = await store.listCollections();

  if (flags.json) {
    // Build a tree object
    const tree: Record<string, string[]> = {};
    for (const col of collections) {
      const keys = await store.keys(col);
      tree[col] = keys;
    }
    output(tree, flags);
    return;
  }

  // Pretty print tree
  if (collections.length === 0) {
    console.log('(empty store)');
    return;
  }

  let shown = 0;
  for (const col of collections) {
    if (shown > 0) console.log();
    console.log(`${col}/`);
    const keys = await store.keys(col);

    for (let i = 0; i < keys.length; i++) {
      const isLast = i === keys.length - 1;
      const prefix = isLast ? '  \u2514\u2500 ' : '  \u251C\u2500 ';
      console.log(`${prefix}${keys[i]}`);
    }
    shown++;
  }
}
