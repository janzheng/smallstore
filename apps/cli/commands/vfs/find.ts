import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function find(ctx: VfsContext): Promise<VfsCommandResult> {
  const target = ctx.args[0]
    ? resolvePath(ctx.state.cwd, ctx.args[0])
    : ctx.state.cwd;

  const namePattern = ctx.flags.name as string | undefined;

  // At root, search all collections
  if (!target) {
    const collections = await ctx.store.listCollections();
    const results: string[] = [];
    for (const col of collections) {
      const keys = await ctx.store.keys(col);
      for (const key of keys) {
        const fullPath = `${col}/${key}`;
        if (!namePattern || globMatch(key, namePattern)) {
          results.push(fullPath);
        }
      }
    }
    return { output: results.join('\n') || '(no matches)' };
  }

  // Inside a collection
  const parts = target.split('/');
  const collection = parts[0];
  const prefix = parts.slice(1).join('/') || undefined;

  try {
    const keys = await ctx.store.keys(collection, prefix);
    const results: string[] = [];
    for (const key of keys) {
      const fullPath = `${target}/${key}`;
      if (!namePattern || globMatch(key, namePattern)) {
        results.push(fullPath);
      }
    }
    return { output: results.join('\n') || '(no matches)' };
  } catch {
    return { output: `find: ${target}: not found` };
  }
}

/** Simple glob match supporting * and ? */
function globMatch(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(str);
}
