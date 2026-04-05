/**
 * VFS `vdiff` command — show content differences in the overlay
 */

import type { VfsContext, VfsCommandResult } from '../../vfs.ts';

export async function overlayDiff(ctx: VfsContext): Promise<VfsCommandResult> {
  if (!ctx.overlay) {
    return { output: 'no overlay active — nothing to diff' };
  }

  const diff = await ctx.overlay.diff();
  const lines: string[] = [];

  for (const key of diff.modified) {
    const baseVal = await ctx.overlay.getBaseValue(key);
    const overlayVal = await ctx.overlay.get(key);
    lines.push(`--- base: ${key}`);
    lines.push(`+++ overlay: ${key}`);
    lines.push(`- ${JSON.stringify(baseVal)}`);
    lines.push(`+ ${JSON.stringify(overlayVal)}`);
    lines.push('');
  }

  for (const key of diff.added) {
    const val = await ctx.overlay.get(key);
    lines.push(`+++ new: ${key}`);
    lines.push(`+ ${JSON.stringify(val)}`);
    lines.push('');
  }

  for (const key of diff.deleted) {
    lines.push(`--- deleted: ${key}`);
    lines.push('');
  }

  if (lines.length === 0) {
    lines.push('no differences');
  }

  return { output: lines.join('\n').trimEnd() };
}
