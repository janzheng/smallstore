import type { Smallstore } from '../../../src/types.ts';
import type { CliOptions } from '../helpers.ts';
import { output, fail, parseJsonArg } from '../helpers.ts';

export async function execute(store: Smallstore, args: string[], flags: CliOptions): Promise<void> {
  const path = args[0];
  const valueArg = args[1];
  if (!path || !valueArg) fail('Usage: smallstore set <path> <json|@file>');

  const value = await parseJsonArg(valueArg);
  await store.set(path, value);

  output({ ok: true, path }, flags);
}
