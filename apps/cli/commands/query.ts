import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output, fail } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  const collection = args[0];
  if (!collection) fail('Usage: smallstore query <collection> [--where=field:op:value] [--limit=N]');

  let limit = 100;
  const filters: Array<{ field: string; op: string; value: string }> = [];

  for (const arg of args.slice(1)) {
    if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--where=')) {
      const parts = arg.split('=')[1].split(':');
      if (parts.length >= 3) {
        filters.push({ field: parts[0], op: parts[1], value: parts.slice(2).join(':') });
      }
    }
  }

  const results = await store.query(collection, { filters, limit });
  output(results, flags);
}
