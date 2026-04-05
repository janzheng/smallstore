/**
 * VFS `snapshot` command — save/restore/list/delete snapshots
 *
 * Usage:
 *   snapshot save <name>       — capture current state
 *   snapshot restore <name>    — restore from snapshot
 *   snapshot list              — list all snapshots
 *   snapshot delete <name>     — delete a snapshot
 */

import type { VfsContext, VfsCommandResult } from '../../vfs.ts';

export async function snapshot(ctx: VfsContext): Promise<VfsCommandResult> {
  if (!ctx.overlay) {
    return { output: 'no overlay active — snapshots require an overlay' };
  }

  const subcmd = ctx.args[0];
  const name = ctx.args[1];

  switch (subcmd) {
    case 'save': {
      if (!name) return { output: 'usage: snapshot save <name>' };
      const info = await ctx.overlay.snapshot(name);
      return { output: `snapshot "${name}" saved (${info.keyCount} keys)` };
    }

    case 'restore': {
      if (!name) return { output: 'usage: snapshot restore <name>' };
      const info = await ctx.overlay.restore(name);
      return { output: `restored from "${name}" (${info.keyCount} keys)` };
    }

    case 'list': {
      const list = ctx.overlay.listSnapshots();
      if (list.length === 0) return { output: 'no snapshots' };
      const lines = list.map(s =>
        `  ${s.id.padEnd(24)} ${s.createdAt}  ${s.keyCount} keys`
      );
      return { output: lines.join('\n') };
    }

    case 'delete': {
      if (!name) return { output: 'usage: snapshot delete <name>' };
      const deleted = ctx.overlay.deleteSnapshot(name);
      return { output: deleted ? `deleted snapshot "${name}"` : `snapshot "${name}" not found` };
    }

    default:
      return { output: 'usage: snapshot <save|restore|list|delete> [name]' };
  }
}
