import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function grep(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length === 0 && !ctx.stdin) {
    return { output: 'usage: grep <query> [path]' };
  }

  // If piped stdin, filter lines by pattern
  if (ctx.stdin && ctx.args.length >= 1) {
    const pattern = ctx.args[0].toLowerCase();
    const caseInsensitive = ctx.flags.i === true;
    const lines = ctx.stdin.split('\n').filter((line) => {
      const haystack = caseInsensitive ? line.toLowerCase() : line;
      const needle = caseInsensitive ? pattern : ctx.args[0];
      return haystack.includes(needle);
    });
    return { output: lines.join('\n') || '(no matches)' };
  }

  const query = ctx.args[0];
  const target = ctx.args[1]
    ? resolvePath(ctx.state.cwd, ctx.args[1])
    : ctx.state.cwd;

  const limit = ctx.flags.limit ? parseInt(ctx.flags.limit as string, 10) : 20;

  // Need a collection to search in
  if (!target) {
    // Search all collections
    const collections = await ctx.store.listCollections();
    const allResults: string[] = [];

    for (const col of collections) {
      try {
        const results = await ctx.store.search(col, { query, limit, type: 'bm25' });
        for (const r of results) {
          allResults.push(`${col}/${r.path}: ${r.score || '(match)'}`);
        }
      } catch {
        // search not implemented for this adapter — fallback to key scan
        const keys = await ctx.store.keys(col);
        for (const key of keys) {
          if (key.toLowerCase().includes(query.toLowerCase())) {
            allResults.push(`${col}/${key}`);
          }
        }
      }
    }

    return { output: allResults.join('\n') || '(no matches)' };
  }

  // Search specific collection
  const parts = target.split('/');
  const collection = parts[0];

  try {
    const results = await ctx.store.search(collection, { query, limit, type: 'bm25' });
    const lines = results.map((r: any) =>
      `${target}/${r.path}: ${r.score || '(match)'}`
    );
    return { output: lines.join('\n') || '(no matches)' };
  } catch {
    // Fallback: scan keys for substring match
    const keys = await ctx.store.keys(collection);
    const matches = keys.filter((k: string) =>
      k.toLowerCase().includes(query.toLowerCase())
    );
    return { output: matches.map((k: string) => `${target}/${k}`).join('\n') || '(no matches)' };
  }
}
