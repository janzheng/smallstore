/**
 * VFS `vdiscard` command — throw away overlay changes
 */

import type { VfsContext, VfsCommandResult } from '../../vfs.ts';

export async function overlayDiscard(ctx: VfsContext): Promise<VfsCommandResult> {
  if (!ctx.overlay) {
    return { output: 'no overlay active — nothing to discard' };
  }

  const count = await ctx.overlay.pendingCount();
  await ctx.overlay.discard();

  if (count === 0) {
    return { output: 'nothing to discard' };
  }

  return { output: `discarded ${count} pending changes` };
}
