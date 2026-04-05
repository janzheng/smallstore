import type { VfsContext, VfsCommandResult } from '../../vfs.ts';
import { resolvePath } from '../../vfs.ts';

export async function exportCmd(ctx: VfsContext): Promise<VfsCommandResult> {
  if (ctx.args.length === 0) {
    return { output: 'usage: export <path> [--format=json|csv|md|yaml]' };
  }

  const path = resolvePath(ctx.state.cwd, ctx.args[0]);
  if (!path) {
    return { output: 'export: cannot export root' };
  }

  const format = (ctx.flags.format as string) || 'json';
  const data = await ctx.store.get(path);

  if (data === null || data === undefined) {
    return { output: `export: ${path}: not found` };
  }

  const content = unwrapContent(data);

  switch (format) {
    case 'json':
      return { output: JSON.stringify(content, null, 2) };
    case 'csv':
      return { output: toCsv(content) };
    case 'md':
    case 'markdown':
      return { output: toMarkdown(content, path) };
    case 'yaml':
      return { output: toYaml(content) };
    default:
      return { output: `export: unknown format: ${format}` };
  }
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
  const lines = [
    `# ${path}`,
    '',
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...data.map((row: any) =>
      '| ' + headers.map((h) => String(row[h] ?? '')).join(' | ') + ' |'
    ),
  ];
  return lines.join('\n');
}

function toYaml(data: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (data === null || data === undefined) return `${pad}null`;
  if (typeof data === 'string') return `${pad}${data}`;
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
