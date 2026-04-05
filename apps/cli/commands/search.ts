import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output, fail } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  const collection = args[0];
  const query = args[1];
  if (!collection || !query) fail('Usage: smallstore search <collection> <query> [--limit=N]');

  let limit = 20;
  for (const arg of args.slice(2)) {
    if (arg.startsWith('--limit=')) limit = parseInt(arg.split('=')[1], 10);
  }

  const results = await store.search(collection, query, { limit });
  output(results, flags);
}
