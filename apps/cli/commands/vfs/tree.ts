import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function tree(ctx: VfsContext): Promise<VfsCommandResult> {
  const target = ctx.args[0]
    ? resolvePath(ctx.state.cwd, ctx.args[0])
    : ctx.state.cwd;

  const depth = ctx.flags.depth ? parseInt(ctx.flags.depth as string, 10) : 3;

  // At root → show all collections + keys
  if (!target) {
    const collections = await ctx.store.listCollections();
    if (collections.length === 0) {
      return { output: '(empty store)' };
    }

    const lines: string[] = ['/'];
    for (let ci = 0; ci < collections.length; ci++) {
      const col = collections[ci];
      const isLastCol = ci === collections.length - 1;
      const colPrefix = isLastCol ? '└── ' : '├── ';
      lines.push(`${colPrefix}${col}/`);

      if (depth > 1) {
        const keys = await ctx.store.keys(col);
        const childIndent = isLastCol ? '    ' : '│   ';
        for (let ki = 0; ki < keys.length; ki++) {
          const isLastKey = ki === keys.length - 1;
          const keyPrefix = isLastKey ? '└── ' : '├── ';
          lines.push(`${childIndent}${keyPrefix}${keys[ki]}`);
        }
      }
    }
    return { output: lines.join('\n') };
  }

  // Inside a collection
  const parts = target.split('/');
  const collection = parts[0];
  const prefix = parts.slice(1).join('/') || undefined;

  try {
    const keys = await ctx.store.keys(collection, prefix);
    const lines: string[] = [`${target}/`];
    for (let i = 0; i < keys.length; i++) {
      const isLast = i === keys.length - 1;
      const p = isLast ? '└── ' : '├── ';
      lines.push(`${p}${keys[i]}`);
    }
    return { output: lines.join('\n') };
  } catch {
    return { output: `tree: ${target}: not found` };
  }
}
