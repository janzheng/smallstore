import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output, fail } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  const path = args[0];
  if (!path) fail('Usage: smallstore delete <path>');

  await store.delete(path);
  output({ ok: true, deleted: path }, flags);
}
