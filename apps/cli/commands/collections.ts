import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  let pattern: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--pattern=')) pattern = arg.split('=')[1];
    else if (!arg.startsWith('--')) pattern = arg;
  }

  const collections = await store.listCollections(pattern);

  if (flags.json) {
    output(collections, flags);
  } else {
    if (collections.length === 0) {
      console.log('(no collections)');
    } else {
      for (const col of collections) {
        console.log(col);
      }
    }
  }
}
