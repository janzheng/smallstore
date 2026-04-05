/**
 * VFS `vcommit` command — materialize overlay changes to base
 */

import type { VfsContext, VfsCommandResult } from '../../vfs.ts';

export async function overlayCommit(ctx: VfsContext): Promise<VfsCommandResult> {
  if (!ctx.overlay) {
    return { output: 'no overlay active — nothing to commit' };
  }

  const result = await ctx.overlay.commit();
  const total = result.added + result.modified + result.deleted;

  if (total === 0) {
    return { output: 'nothing to commit' };
  }

  const parts: string[] = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.modified) parts.push(`${result.modified} modified`);
  if (result.deleted) parts.push(`${result.deleted} deleted`);

  return { output: `committed: ${parts.join(', ')}` };
}
