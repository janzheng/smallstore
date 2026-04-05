import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function cd(ctx: VfsContext): Promise<VfsCommandResult> {
  const target = ctx.args[0];

  // cd with no args → go to root
  if (!target || target === '/') {
    return { output: '', newState: { cwd: '' } };
  }

  const newCwd = resolvePath(ctx.state.cwd, target);
  return { output: '', newState: { cwd: newCwd } };
}
