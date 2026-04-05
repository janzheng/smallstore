/**
 * Smallstore Preset Profiles
 *
 * One-liner configurations for common storage patterns.
 *
 * @example
 * ```typescript
 * import { createSmallstore } from '@smallstore/core';
 *
 * // One-liner: local JSON files on disk
 * const store = createSmallstore({ preset: 'local' });
 *
 * // SQLite for structured/queryable local storage
 * const store = createSmallstore({ preset: 'local-sqlite' });
 *
 * // Preset with overrides
 * const store = createSmallstore({
 *   preset: 'local-sqlite',
 *   mounts: { 'archive/*': 'sqlite-archive' },
 *   adapters: {
 *     'sqlite-archive': createSQLiteAdapter({ path: './data/archive.db' })
 *   }
 * });
 * ```
 */

import type { SmallstoreConfig } from './src/types.ts';
import { createMemoryAdapter } from './src/adapters/memory.ts';
import { createSQLiteAdapter } from './src/adapters/sqlite.ts';
import { createLocalJsonAdapter } from './src/adapters/local-json.ts';
import { createLocalFileAdapter } from './src/adapters/local-file.ts';
import { createUpstashAdapter } from './src/adapters/upstash.ts';
import { R2DirectAdapter } from './src/adapters/r2-direct.ts';
import { createStructuredSQLiteAdapter } from './src/adapters/structured-sqlite.ts';
import { createDenoFsAdapter } from './src/adapters/deno-fs.ts';
import { resolveUpstashEnv, resolveR2Env } from './config.ts';

// ============================================================================
// Types
// ============================================================================

export type PresetName = 'memory' | 'local' | 'local-sqlite' | 'deno-fs' | 'cloud' | 'hybrid' | 'structured';

export interface PresetConfig extends Partial<SmallstoreConfig> {
  /** Use a named preset as the base configuration */
  preset?: PresetName;
}

// ============================================================================
// Preset Definitions
// ============================================================================

/**
 * Build a preset configuration by name.
 *
 * | Preset         | Default   | Adapters                     | Mounts                          | typeRouting (blob/object/kv)          |
 * |--------------- |-----------|------------------------------|---------------------------------|---------------------------------------|
 * | `memory`       | memory    | memory                       | —                               | all → memory                          |
 * | `local`        | local     | memory + local-json + files  | `cache/* → memory`, `files/*`   | blob→files, object→local, kv→local    |
 * | `local-sqlite` | sqlite    | memory + sqlite + files      | `cache/* → memory`, `files/*`   | blob→files, object→sqlite, kv→sqlite  |
 * | `deno-fs`      | fs        | memory + deno-fs             | `cache/* → memory`              | all → deno-fs (real files on disk)    |
 * | `cloud`        | upstash   | memory + upstash + R2? (env) | `cache/* → memory`              | blob→r2/memory, object/kv→upstash     |
 * | `hybrid`       | sqlite    | memory + sqlite + files + ?  | `cache/*`, `files/*`, `session/*`| blob→files, object→sqlite, kv→sqlite  |
 */
export function getPreset(name: PresetName): Partial<SmallstoreConfig> {
  switch (name) {
    case 'memory':
      return {
        adapters: {
          memory: createMemoryAdapter(),
        },
        defaultAdapter: 'memory',
        typeRouting: {
          blob: 'memory',
          object: 'memory',
          kv: 'memory',
        },
      };

    case 'local':
      return {
        adapters: {
          memory: createMemoryAdapter(),
          local: createLocalJsonAdapter({ baseDir: './data' }),
          files: createLocalFileAdapter({ baseDir: './data/files' }),
        },
        defaultAdapter: 'local',
        typeRouting: {
          blob: 'files',
          object: 'local',
          kv: 'local',
        },
        mounts: {
          'cache/*': 'memory',
          'files/*': 'files',
        },
      };

    case 'local-sqlite':
      return {
        adapters: {
          memory: createMemoryAdapter(),
          sqlite: createSQLiteAdapter({ path: './data/store.db' }),
          files: createLocalFileAdapter({ baseDir: './data/files' }),
        },
        defaultAdapter: 'sqlite',
        typeRouting: {
          blob: 'files',
          object: 'sqlite',
          kv: 'sqlite',
        },
        mounts: {
          'cache/*': 'memory',
          'files/*': 'files',
        },
      };

    case 'deno-fs':
      return {
        adapters: {
          memory: createMemoryAdapter(),
          fs: createDenoFsAdapter({ baseDir: '.' }),
        },
        defaultAdapter: 'fs',
        mounts: {
          'cache/*': 'memory',
        },
      };

    case 'cloud': {
      const upstash = resolveUpstashEnv();
      const hasUpstash = !!(upstash.url && upstash.token);

      const r2 = resolveR2Env();
      const hasR2 = !!(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucketName);

      const adapters: Record<string, any> = {
        memory: createMemoryAdapter(),
      };

      if (hasUpstash) {
        adapters.upstash = createUpstashAdapter({ url: upstash.url!, token: upstash.token! });
      }

      if (hasR2) {
        adapters.r2 = new R2DirectAdapter({
          accountId: r2.accountId!,
          accessKeyId: r2.accessKeyId!,
          secretAccessKey: r2.secretAccessKey!,
          bucketName: r2.bucketName!,
        });
      }

      const defaultAdapterName = hasUpstash ? 'upstash' : 'memory';
      const blobAdapter = hasR2 ? 'r2' : 'memory';

      return {
        adapters,
        defaultAdapter: defaultAdapterName,
        typeRouting: {
          blob: blobAdapter,
          object: defaultAdapterName,
          kv: defaultAdapterName,
        },
        mounts: {
          'cache/*': 'memory',
        },
      };
    }

    case 'hybrid': {
      const upstash = resolveUpstashEnv();

      const adapters: Record<string, any> = {
        memory: createMemoryAdapter(),
        sqlite: createSQLiteAdapter({ path: './data/store.db' }),
        files: createLocalFileAdapter({ baseDir: './data/files' }),
      };

      const mounts: Record<string, string> = {
        'cache/*': 'memory',
        'files/*': 'files',
      };

      if (upstash.url && upstash.token) {
        adapters.upstash = createUpstashAdapter({ url: upstash.url, token: upstash.token });
        mounts['session/*'] = 'upstash';
      }

      return {
        adapters,
        defaultAdapter: 'sqlite',
        typeRouting: {
          blob: 'files',
          object: 'sqlite',
          kv: 'sqlite',
        },
        mounts,
      };
    }

    case 'structured': {
      return {
        adapters: {
          memory: createMemoryAdapter(),
          structured: createStructuredSQLiteAdapter({
            path: './data/structured.db',
            schema: {},  // User MUST override with their schema via config.adapters
          }),
          files: createLocalFileAdapter({ baseDir: './data/files' }),
        },
        defaultAdapter: 'structured',
        typeRouting: {
          blob: 'files',
          object: 'structured',
          kv: 'structured',
        },
        mounts: {
          'cache/*': 'memory',
          'files/*': 'files',
        },
      };
    }

    default:
      throw new Error(`Unknown preset: ${name}`);
  }
}

/**
 * Resolve a PresetConfig into a full SmallstoreConfig.
 *
 * If `config.preset` is set, loads the preset as a base and merges
 * explicit config on top (explicit values win).
 *
 * Adapter merging: explicit adapters are added to (not replacing) preset adapters.
 * Mount merging: explicit mounts are added to (not replacing) preset mounts.
 */
export function resolvePreset(config: PresetConfig): SmallstoreConfig {
  if (!config.preset) {
    // No preset — config must have adapters and defaultAdapter
    return config as SmallstoreConfig;
  }

  const base = getPreset(config.preset);

  // Merge adapters: preset + explicit (explicit wins on conflicts)
  const adapters = {
    ...base.adapters,
    ...config.adapters,
  };

  // Merge mounts: preset + explicit (explicit wins on conflicts)
  const mounts = (base.mounts || config.mounts)
    ? { ...base.mounts, ...config.mounts }
    : undefined;

  return {
    adapters: adapters,
    defaultAdapter: config.defaultAdapter ?? base.defaultAdapter ?? 'memory',
    metadataAdapter: config.metadataAdapter ?? base.metadataAdapter,
    typeRouting: config.typeRouting ?? base.typeRouting,
    routing: config.routing ?? base.routing,
    mounts,
    smartRouting: config.smartRouting ?? base.smartRouting,
    caching: config.caching ?? base.caching,
  };
}
