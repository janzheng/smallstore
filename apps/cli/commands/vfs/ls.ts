import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function ls(ctx: VfsContext): Promise<VfsCommandResult> {
  const target = ctx.args[0]
    ? resolvePath(ctx.state.cwd, ctx.args[0])
    : ctx.state.cwd;

  // At root → list collections
  if (!target) {
    const collections = await ctx.store.listCollections();
    if (collections.length === 0) {
      return { output: '(empty store)' };
    }
    return { output: collections.map((c) => c + '/').join('\n') };
  }

  // Inside a collection → list keys + sub-namespaces
  const parts = target.split('/');
  const collection = parts[0];
  const prefix = parts.slice(1).join('/');

  try {
    const allKeys = await ctx.store.keys(collection, prefix || undefined);

    if (allKeys.length === 0) {
      return { output: `(empty: ${target})` };
    }

    // Separate into direct items and sub-namespaces
    const dirs = new Set<string>();
    const files: string[] = [];

    for (const key of allKeys) {
      // key is relative to collection; if we have a prefix, strip it
      const relative = prefix ? key.replace(new RegExp(`^${escapeRegex(prefix)}/?`), '') : key;
      if (!relative) continue;

      const slashIdx = relative.indexOf('/');
      if (slashIdx > 0) {
        dirs.add(relative.slice(0, slashIdx));
      } else {
        files.push(relative);
      }
    }

    const lines: string[] = [];
    for (const d of [...dirs].sort()) lines.push(d + '/');
    for (const f of files.sort()) lines.push(f);

    return { output: lines.join('\n') };
  } catch {
    // Collection might not exist — show empty
    return { output: `(not found: ${target})` };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
