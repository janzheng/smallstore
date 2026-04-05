import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function write(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length < 2) {
    return { output: 'usage: write <path> <json|string>' };
  }

  const path = resolvePath(ctx.state.cwd, ctx.args[0]);
  if (!path) {
    return { output: 'write: cannot write to root' };
  }

  const raw = ctx.args.slice(1).join(' ');

  // Try to parse as JSON, fall back to string
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  await ctx.store.set(path, data);
  return { output: `wrote: ${path}` };
}
