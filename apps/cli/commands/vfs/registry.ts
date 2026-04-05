/**
 * VFS Command Registry — maps command names to handlers
 */

import type { VfsCommandFn } from '../../vfs.ts';
import { pwd } from './pwd.ts';
import { cd } from './cd.ts';
import { ls } from './ls.ts';
import { cat } from './cat.ts';
import { write } from './write.ts';
import { rm } from './rm.ts';
import { cp } from './cp.ts';
import { mv } from './mv.ts';
import { stat } from './stat.ts';
import { find } from './find.ts';
import { tree } from './tree.ts';
import { du } from './du.ts';
import { wc } from './wc.ts';
import { grep } from './grep.ts';
import { exportCmd } from './export.ts';
import { overlayStatus } from './overlay-status.ts';
import { overlayDiff } from './overlay-diff.ts';
import { overlayCommit } from './overlay-commit.ts';
import { overlayDiscard } from './overlay-discard.ts';
import { snapshot } from './snapshot.ts';
import { retrieve } from './retrieve.ts';

export const COMMANDS: Record<string, VfsCommandFn> = {
  pwd,
  cd,
  ls,
  cat,
  write,
  rm,
  cp,
  mv,
  stat,
  find,
  tree,
  du,
  wc,
  grep,
  export: exportCmd,
  // Overlay commands
  status: overlayStatus,
  vdiff: overlayDiff,
  vcommit: overlayCommit,
  vdiscard: overlayDiscard,
  snapshot,
  retrieve,
};

export const ALIASES: Record<string, string> = {
  dir: 'ls',
  read: 'cat',
  echo: 'write',
  delete: 'rm',
  remove: 'rm',
  copy: 'cp',
  move: 'mv',
  search: 'grep',
  commit: 'vcommit',
  discard: 'vdiscard',
  diff: 'vdiff',
};
