import type { VfsContext, VfsCommandResult } from '../../vfs.ts';

export async function pwd(ctx: VfsContext): Promise<VfsCommandResult> {
  return { output: '/' + ctx.state.cwd };
}
