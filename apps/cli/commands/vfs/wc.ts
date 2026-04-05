import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function wc(ctx: VfsContext): Promise<VfsCommandResult> {
  // If we have piped stdin, count its lines
  if (ctx.stdin && ctx.args.length === 0) {
    const lines = ctx.stdin.split('\n').filter(Boolean);
    return { output: String(lines.length) };
  }

  const target = ctx.args[0]
    ? resolvePath(ctx.state.cwd, ctx.args[0])
    : ctx.state.cwd;

  // At root → count all keys
  if (!target) {
    const collections = await ctx.store.listCollections();
    let total = 0;
    for (const col of collections) {
      const keys = await ctx.store.keys(col);
      total += keys.length;
    }
    return { output: String(total) };
  }

  // Specific path — could be a collection or an item with array data
  const parts = target.split('/');
  const collection = parts[0];

  if (parts.length === 1) {
    // Collection — count keys
    try {
      const keys = await ctx.store.keys(collection);
      return { output: String(keys.length) };
    } catch {
      return { output: `wc: ${target}: not found` };
    }
  }

  // Deeper path — try to get data and count if array
  const data = await ctx.store.get(target);
  if (data === null || data === undefined) {
    return { output: `wc: ${target}: not found` };
  }

  // Unwrap smallstore response
  const content = unwrapContent(data);
  if (Array.isArray(content)) {
    return { output: String(content.length) };
  }
  if (typeof content === 'object' && content !== null) {
    return { output: String(Object.keys(content).length) };
  }
  // String — count lines
  if (typeof content === 'string') {
    return { output: String(content.split('\n').filter(Boolean).length) };
  }

  return { output: '1' };
}

function unwrapContent(data: any): any {
  if (data && typeof data === 'object' && 'content' in data && 'reference' in data) {
    const content = data.content;
    if (Array.isArray(content) && content.length === 1) {
      const item = content[0];
      if (typeof item === 'string') {
        try { return JSON.parse(item.replace(/\n$/, '')); } catch { return item.replace(/\n$/, ''); }
      }
      return item;
    }
    return content;
  }
  return data;
}
