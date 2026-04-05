import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function stat(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length === 0) {
    return { output: 'usage: stat <path>' };
  }

  const path = resolvePath(ctx.state.cwd, ctx.args[0]);
  if (!path) {
    return { output: 'stat: cannot stat root (use ls)' };
  }

  try {
    const s = await ctx.store.stat(path);
    const lines = [
      `  path: ${s.path}`,
      `  type: ${s.type}`,
      `  items: ${s.itemCount}`,
      `  children: ${s.children.length > 0 ? s.children.join(', ') : '(none)'}`,
      `  adapters: ${s.adapters.join(', ')}`,
    ];
    return { output: lines.join('\n') };
  } catch {
    return { output: `stat: ${path}: not found` };
  }
}
