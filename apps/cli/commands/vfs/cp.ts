import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function cp(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length < 2) {
    return { output: 'usage: cp <source> <dest>' };
  }

  const src = resolvePath(ctx.state.cwd, ctx.args[0]);
  const dst = resolvePath(ctx.state.cwd, ctx.args[1]);

  if (!src || !dst) {
    return { output: 'cp: source and dest must be non-root paths' };
  }

  const recursive = ctx.flags.r === true || ctx.flags.recursive === true;

  if (recursive) {
    await ctx.store.copyNamespace(src, dst);
    return { output: `copied: ${src}/ → ${dst}/` };
  }

  await ctx.store.copy(src, dst);
  return { output: `copied: ${src} → ${dst}` };
}
