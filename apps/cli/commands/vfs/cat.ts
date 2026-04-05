import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

/**
 * Unwrap smallstore response to get the actual data.
 * store.get() returns { reference, content, adapter, dataType } wrapper.
 */
function unwrap(data: any): any {
  if (data && typeof data === 'object' && 'content' in data && 'reference' in data) {
    const content = data.content;
    if (Array.isArray(content) && content.length === 1) {
      const item = content[0];
      // Strip trailing newline from kv strings
      if (typeof item === 'string') {
        const trimmed = item.replace(/\n$/, '');
        // Try to parse as JSON
        try {
          return JSON.parse(trimmed);
        } catch {
          return trimmed;
        }
      }
      return item;
    }
    if (Array.isArray(content)) return content;
    return content;
  }
  return data;
}

export async function cat(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length === 0) {
    return { output: 'usage: cat <path> [--format=json|csv|md|yaml]' };
  }

  const path = resolvePath(ctx.state.cwd, ctx.args[0]);
  if (!path) {
    return { output: 'cat: cannot read root (use ls)' };
  }

  const raw = await ctx.store.get(path);
  if (raw === null || raw === undefined) {
    return { output: `cat: ${path}: not found` };
  }

  const data = unwrap(raw);
  const format = ctx.flags.format as string | undefined;

  switch (format) {
    case 'csv':
      return { output: toCsv(data) };
    case 'md':
    case 'markdown':
      return { output: toMarkdown(data, path) };
    case 'yaml':
      return { output: toYaml(data) };
    case 'json':
      return { output: JSON.stringify(data, null, 2) };
    default:
      // No format specified — smart default
      if (typeof data === 'object') {
        return { output: JSON.stringify(data, null, 2) };
      }
      return { output: String(data) };
  }
}

function toCsv(data: any): string {
  if (!Array.isArray(data)) {
    if (typeof data === 'object' && data !== null) data = [data];
    else return String(data);
  }
  if (data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const rows = data.map((row: any) =>
    headers.map((h) => {
      const v = row[h];
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

function toMarkdown(data: any, path: string): string {
  if (typeof data === 'string') return data;
  if (!Array.isArray(data)) {
    if (typeof data === 'object' && data !== null) {
      const lines = [`# ${path}`, ''];
      for (const [k, v] of Object.entries(data)) {
        lines.push(`- **${k}**: ${JSON.stringify(v)}`);
      }
      return lines.join('\n');
    }
    return String(data);
  }
  if (data.length === 0) return `# ${path}\n\n(empty)`;
  const headers = Object.keys(data[0]);
  return [
    `# ${path}`,
    '',
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...data.map((row: any) =>
      '| ' + headers.map((h) => String(row[h] ?? '')).join(' | ') + ' |'
    ),
  ].join('\n');
}

function toYaml(data: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (data === null || data === undefined) return `${pad}null`;
  if (typeof data === 'string') return indent === 0 ? data : `${pad}${data}`;
  if (typeof data === 'number' || typeof data === 'boolean') return `${pad}${data}`;
  if (Array.isArray(data)) {
    return data.map((item) => {
      if (typeof item === 'object' && item !== null) {
        const inner = toYaml(item, indent + 1).trimStart();
        return `${pad}- ${inner}`;
      }
      return `${pad}- ${item}`;
    }).join('\n');
  }
  if (typeof data === 'object') {
    return Object.entries(data).map(([k, v]) => {
      if (typeof v === 'object' && v !== null) {
        return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      }
      return `${pad}${k}: ${v}`;
    }).join('\n');
  }
  return `${pad}${String(data)}`;
}
