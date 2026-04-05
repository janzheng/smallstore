/**
 * Slim Factory for Smallstore
 *
 * Creates a Smallstore instance without importing the barrel mod.ts.
 * Use this when you only need specific adapters (e.g., Memory + Upstash)
 * to avoid pulling in ALL adapters and their heavy dependencies.
 *
 * @example
 * ```typescript
 * import { createSmallstore } from './factory-slim.ts';
 * import { createMemoryAdapter } from './adapters/memory.ts';
 * import { createUpstashAdapter } from './adapters/upstash.ts';
 *
 * const store = createSmallstore({
 *   adapters: { memory: createMemoryAdapter(), upstash: createUpstashAdapter({...}) },
 *   defaultAdapter: 'memory',
 * });
 * ```
 */

import type { SmallstoreConfig, Smallstore } from './types.ts';
import { createSmartRouter } from './router.ts';

export function createSmallstore(config: SmallstoreConfig): Smallstore {
  return createSmartRouter({
    adapters: config.adapters,
    defaultAdapter: config.defaultAdapter,
    metadataAdapter: config.metadataAdapter || 'memory',
    typeRouting: config.typeRouting,
    routing: config.routing,
    mounts: config.mounts,
    smartRouting: config.smartRouting ?? false,
    caching: config.caching,
  });
}
