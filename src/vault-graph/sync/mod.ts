/**
 * Sync protocol module — manifest-based vault synchronization.
 */

export * from './types.ts';
export { buildManifest } from './manifest.ts';
export { computeDiff } from './diff.ts';
export {
  sync,
  getSyncStatus,
  fetchRemoteManifest,
  pullNotes,
  pushNotes,
  deleteNotes,
} from './engine.ts';
