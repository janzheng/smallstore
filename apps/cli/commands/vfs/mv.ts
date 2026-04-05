import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function mv(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length < 2) {
    return { output: 'usage: mv <source> <dest>' };
  }

  const src = resolvePath(ctx.state.cwd, ctx.args[0]);
  const dst = resolvePath(ctx.state.cwd, ctx.args[1]);

  if (!src || !dst) {
    return { output: 'mv: source and dest must be non-root paths' };
  }

  await ctx.store.move(src, dst);
  return { output: `moved: ${src} → ${dst}` };
}
