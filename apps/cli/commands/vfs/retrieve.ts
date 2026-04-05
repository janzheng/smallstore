/**
 * VFS `retrieve` command — run retrieval pipeline steps on data
 *
 * Usage:
 *   retrieve filter --where.status=published  (filter piped data)
 *   retrieve slice --take=10                   (take first 10 items)
 *   retrieve text --format=plain               (extract text)
 *   retrieve flatten                            (flatten nested arrays)
 *   retrieve metadata                           (get metadata about data)
 *   cat notes | retrieve filter --where.status=published | retrieve slice --take=5
 *
 * This wires VFS pipes into the RetrievalPipeline system, so agents can
 * compose retrieval steps using the same bash-like interface as other VFS commands.
 */

import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function retrieve(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length === 0 && !ctx.stdin) {
    return {
      output: [
        'usage: retrieve <provider> [options]',
        '',
        'Providers:',
        '  filter    --where.<field>=<value>          Filter items',
        '  slice     --take=N [--mode=head|tail]      Slice to N items',
        '  text      [--format=plain|structured]      Extract text',
        '  structured --pick=f1,f2 [--omit=f3]        Pick/omit fields',
        '  flatten                                     Flatten nested arrays',
        '  metadata                                    Get metadata about data',
        '',
        'Data comes from piped input or the current collection:',
        '  cat notes | retrieve filter --where.status=published',
        '  cat notes | retrieve slice --take=10',
        '  cat notes | retrieve filter --where.year=2024 | retrieve slice --take=5',
      ].join('\n'),
    };
  }

  const providerName = ctx.args[0];

  // Get data: from stdin (piped) or from a collection path
  let data: any;
  if (ctx.stdin) {
    try {
      data = JSON.parse(ctx.stdin);
    } catch {
      // Treat as line-delimited text
      data = ctx.stdin.split('\n').filter(Boolean);
    }
  } else if (ctx.args[1]) {
    const path = resolvePath(ctx.state.cwd, ctx.args[1]);
    data = await ctx.store.get(path);
  } else if (ctx.state.cwd) {
    data = await ctx.store.get(ctx.state.cwd);
  } else {
    return { output: 'error: no data — pipe data in or specify a path' };
  }

  if (data == null) {
    return { output: '(no data)' };
  }

  // Build retriever options from flags
  const options = buildOptions(providerName, ctx.flags);

  try {
    // Dynamic import to avoid loading retrieval module until needed
    const { RetrieverWrapper } = await import('../../../../src/retrieval/adapters/retriever-adapter.ts');
    const retrievers = await import('../../../../src/retrievers/mod.ts');

    let retriever: any;
    switch (providerName) {
      case 'filter':
        retriever = new RetrieverWrapper(new retrievers.FilterRetriever());
        break;
      case 'slice':
        retriever = new RetrieverWrapper(new retrievers.SliceRetriever());
        break;
      case 'text':
        retriever = new RetrieverWrapper(new retrievers.TextRetriever());
        break;
      case 'structured':
        retriever = new RetrieverWrapper(new retrievers.StructuredRetriever());
        break;
      case 'flatten':
        retriever = new RetrieverWrapper(new retrievers.FlattenRetriever());
        break;
      case 'metadata':
        retriever = new RetrieverWrapper(new retrievers.MetadataRetriever());
        break;
      default:
        return { output: `error: unknown provider "${providerName}". Use: filter, slice, text, structured, flatten, metadata` };
    }

    const result = await retriever.retrieve({ data }, options);

    // Output as JSON so it can be piped to the next step
    const output = typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data, null, 2);

    return { output };
  } catch (error: any) {
    return { output: `error: ${error.message}` };
  }
}

/**
 * Build retrieval options from VFS flags.
 *
 * Handles dotted keys: --where.status=published → { where: { status: "published" } }
 */
function buildOptions(provider: string, flags: Record<string, any>): Record<string, any> {
  const opts: Record<string, any> = {};

  for (const [key, value] of Object.entries(flags)) {
    if (key === '_') continue; // skip positional args

    // Handle dotted keys like --where.status=published
    const parts = key.split('.');
    if (parts.length === 1) {
      // Simple flag: --take=10
      opts[key] = parseValue(value);
    } else {
      // Dotted flag: --where.status=published
      let target = opts;
      for (let i = 0; i < parts.length - 1; i++) {
        target[parts[i]] = target[parts[i]] || {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = parseValue(value);
    }
  }

  // Provider-specific defaults
  if (provider === 'slice') {
    opts.mode = opts.mode || 'head';
  }

  // Convert comma-separated pick/omit to arrays
  if (typeof opts.pick === 'string') {
    opts.pick = opts.pick.split(',').map((s: string) => s.trim());
  }
  if (typeof opts.omit === 'string') {
    opts.omit = opts.omit.split(',').map((s: string) => s.trim());
  }

  return opts;
}

function parseValue(value: any): any {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  if (typeof value === 'string' && /^\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}
