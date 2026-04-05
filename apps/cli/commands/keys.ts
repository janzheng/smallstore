import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  const collection = args[0];
  let prefix: string | undefined;

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--prefix=')) prefix = arg.split('=')[1];
  }

  const keys = await store.keys(collection);

  const filtered = prefix
    ? keys.filter((k: string) => k.startsWith(prefix!))
    : keys;

  if (flags.json) {
    output(filtered, flags);
  } else {
    if (filtered.length === 0) {
      console.log('(no keys)');
    } else {
      for (const key of filtered) {
        console.log(key);
      }
    }
  }
}
