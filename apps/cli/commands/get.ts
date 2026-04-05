import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output, fail } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  const path = args[0];
  if (!path) fail('Usage: smallstore get <path>');

  const result = await store.get(path);
  if (result === null) {
    if (flags.json) {
      output(null, flags);
    } else {
      console.log(`(not found: ${path})`);
    }
    return;
  }

  output(result, flags);
}
