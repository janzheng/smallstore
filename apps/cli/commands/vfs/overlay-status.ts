/**
 * VFS `status` command — show pending overlay changes
 */

import type { VfsContext, VfsCommandResult } from '../../vfs.ts';

export async function overlayStatus(ctx: VfsContext): Promise<VfsCommandResult> {
  if (!ctx.overlay) {
    return { output: 'no overlay active — nothing to show' };
  }

  const diff = await ctx.overlay.diff();
  const lines: string[] = [];

  for (const k of diff.added) lines.push(`A  ${k}`);
  for (const k of diff.modified) lines.push(`M  ${k}`);
  for (const k of diff.deleted) lines.push(`D  ${k}`);

  const total = diff.added.length + diff.modified.length + diff.deleted.length;

  if (total === 0) {
    lines.push('clean — no pending changes');
  } else {
    lines.push('');
    const parts: string[] = [];
    if (diff.added.length) parts.push(`${diff.added.length} added`);
    if (diff.modified.length) parts.push(`${diff.modified.length} modified`);
    if (diff.deleted.length) parts.push(`${diff.deleted.length} deleted`);
    lines.push(`${total} changes (${parts.join(', ')})`);
  }

  return { output: lines.join('\n') };
}
