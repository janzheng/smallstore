import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function rm(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length === 0) {
    return { output: 'usage: rm <path>' };
  }

  const path = resolvePath(ctx.state.cwd, ctx.args[0]);
  if (!path) {
    return { output: 'rm: cannot remove root' };
  }

  const recursive = ctx.flags.r === true || ctx.flags.recursive === true;

  if (recursive) {
    // Clear everything under this path
    const parts = path.split('/');
    const collection = parts[0];
    const prefix = parts.slice(1).join('/') || undefined;
    await ctx.store.clear(collection, prefix);
    return { output: `removed: ${path}/ (recursive)` };
  }

  await ctx.store.delete(path);
  return { output: `removed: ${path}` };
}
