import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function du(ctx: VfsContext): Promise<VfsCommandResult> {
  const target = ctx.args[0]
    ? resolvePath(ctx.state.cwd, ctx.args[0])
    : ctx.state.cwd;

  // At root → count per collection
  if (!target) {
    const collections = await ctx.store.listCollections();
    if (collections.length === 0) {
      return { output: '0\ttotal' };
    }

    const lines: string[] = [];
    let total = 0;
    for (const col of collections) {
      const keys = await ctx.store.keys(col);
      lines.push(`${keys.length}\t${col}/`);
      total += keys.length;
    }
    lines.push(`${total}\ttotal`);
    return { output: lines.join('\n') };
  }

  // Specific path
  const parts = target.split('/');
  const collection = parts[0];
  const prefix = parts.slice(1).join('/') || undefined;

  try {
    const keys = await ctx.store.keys(collection, prefix);
    return { output: `${keys.length}\t${target}/` };
  } catch {
    return { output: `du: ${target}: not found` };
  }
}
