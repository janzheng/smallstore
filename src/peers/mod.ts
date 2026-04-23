/**
 * Peer registry — public entry point.
 *
 * Plugin discipline (see `docs/design/PLUGIN-AUTHORING.md`):
 *   1. Core never imports peers ✓
 *   2. No heavy npm deps (uses only built-in `fetch`, `crypto.randomUUID`, `btoa`)
 *   3. Sub-entry self-contained (only imports from `./*.ts` + `../adapters/adapter.ts` type + `./types.ts`) ✓
 *   4. Plugin is deletable (`rm -rf src/peers/` + `deno test` on core passes) ✓
 *
 * See `.brief/peer-registry.md` for the design (levels 1/2/3, roadmap,
 * auth model, success criteria) and `TASKS.md` for the task queue.
 */

export type {
  // Core types
  Peer,
  PeerAuth,
  PeerType,
  PeerStore,
  PeerQueryFilter,
  PeerQueryResult,
  CreatePeerStoreOptions,
  // Proxy types
  ProxyGetArgs,
  ProxyPostArgs,
  ProxyResult,
  ResolvedAuth,
  HealthResult,
} from './types.ts';

export { createPeerStore } from './peer-registry.ts';
export { resolvePeerAuth, proxyGet, proxyPost, probePeer } from './proxy.ts';
export { registerPeersRoutes, type RegisterPeersRoutesOptions, type RequireAuth } from './http-routes.ts';
