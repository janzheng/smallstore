/**
 * Peer registry — types.
 *
 * Peers are to adapters what symlinks are to files: smallstore knows a data
 * source exists over there and has a standard way to reach it, without
 * owning the data. Distinct from the library-level `StorageAdapter`
 * concept which is bundled at deploy-time.
 *
 * See `.brief/peer-registry.md` for motivation, three-level roadmap,
 * auth model, and the MVP (level-2 = metadata + authenticated proxy)
 * success criteria.
 *
 * Key design calls captured in these types:
 *
 * - **Secrets via env-ref, never inline.** Auth stores `{ token_env: 'TF_TOKEN' }`;
 *   the actual token lives in Worker env vars. Resolution happens at proxy time.
 *   Rationale: D1 rows are backup-able + queryable in plaintext; secrets shouldn't be.
 * - **Type is a label + future-resolver hint.** In MVP all types share the same
 *   proxy code path; `type` is metadata for UX + the hook point for level-3
 *   compound-adapter resolution. `webdav` and `tigerflare` are the likely first
 *   level-3 graduations.
 * - **`path_mapping` ignored in MVP.** Reserved for level-3 when a peer is used
 *   as a routing target (`tf/*` → `peer:tigerflare-prod` with path rewrite).
 */

// ============================================================================
// Peer types + auth
// ============================================================================

/**
 * Well-known peer types. `generic` is the fallback for arbitrary HTTP
 * JSON endpoints. MVP treats all types with the same proxy code path;
 * the label drives UX + reserved level-3 resolver plumbing.
 */
export type PeerType =
  | 'smallstore'
  | 'tigerflare'
  | 'sheetlog'
  | 'rss'        // RSS / Atom feed. Peer-as-feed pattern: external pollers
                 // (valtown etc.) read `GET /peers?type=rss`, poll each on
                 // their own schedule, POST parsed items to the inbox named
                 // in `metadata.feed_config.target_inbox`. Smallstore stays
                 // pull-agnostic; the type is a label + future-resolver hint.
  | 'webhook'    // Inbound HTTP webhook. External tools POST to
                 // `/webhook/<peer-name>`; peer's `metadata.webhook_config`
                 // describes HMAC verification, JSON-path field mapping, and
                 // the target_inbox to ingest into. The peer `url` is the
                 // smallstore-side inbound URL (descriptor only — webhooks
                 // arrive, smallstore doesn't dial out).
  | 'http-json'
  | 'webdav'
  | 'generic';

/**
 * Auth config on a peer. All secret-bearing variants reference an env-var
 * name rather than embedding the secret. At proxy time, the worker looks up
 * the env value and injects into the outbound request.
 *
 * - `none` — no auth injection. Use for fully public endpoints.
 * - `bearer` — `Authorization: Bearer ${env[token_env]}`.
 * - `header` — arbitrary single header: `${name}: ${env[value_env]}`.
 * - `query` — auth via query-string param (sheetlog-style apps-script keys).
 *   Appends `${name}=${env[value_env]}` to the outbound URL.
 * - `basic` — HTTP Basic: `Authorization: Basic ${base64(user:pass)}`, where
 *   user + pass are both env-resolved. Used for webdav-style peers.
 *
 * When the referenced env var is missing at proxy time, the proxy returns
 * an error with a clear "env var <name> not set" message rather than
 * silently proceeding with missing auth.
 */
export type PeerAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token_env: string }
  | { kind: 'header'; name: string; value_env: string }
  | { kind: 'query'; name: string; value_env: string }
  | { kind: 'basic'; user_env: string; pass_env: string };

// ============================================================================
// Peer record
// ============================================================================

/**
 * A single peer registration — the unit of "here's a data source I know
 * about, here's how to reach it." Stored as a D1 row (or any
 * `StorageAdapter`) via the `PeerStore` surface.
 */
export interface Peer {
  /** Stable id — uuid by default; also acceptable as a slug for manually-created peers. */
  id: string;

  /**
   * URL-safe human slug. Must be unique within a peer store.
   * Used in HTTP paths (`/peers/:name/fetch`) so dash/lowercase/no-spaces only.
   * Enforced by `createPeerStore` via a validation regex on create/update.
   */
  name: string;

  /** Well-known type (drives UX + future level-3 resolver). */
  type: PeerType;

  /**
   * Base URL of the peer. No trailing slash — the proxy concatenates
   * `peer.url + path` at fetch time. Validated as an absolute `http(s)://` URL.
   */
  url: string;

  /** Optional human note — what is this? why did I register it? */
  description?: string;

  /**
   * Auth config. Optional — defaults to `{ kind: 'none' }` when absent.
   * Secret values are env-referenced (never inline).
   */
  auth?: PeerAuth;

  /**
   * Static headers to forward on every outbound request. Merged with any
   * client headers forwarded through the proxy. Useful for `User-Agent`,
   * `Accept`, custom tenant IDs, etc.
   */
  headers?: Record<string, string>;

  /**
   * Free-form tags for filtering via `GET /peers?tags=prod,personal`.
   * All tags must match (AND) — use the Set-intersection pattern of
   * `Inbox.query` labels for consistency.
   */
  tags?: string[];

  /**
   * Advertised capabilities — informational, not enforced.
   * Examples: `['read', 'write', 'list', 'query']`.
   * Callers can inspect to know "can I write to this peer?"
   */
  capabilities?: string[];

  /** Soft-disable — peer persists but is 404'd at the proxy. */
  disabled?: boolean;

  /** ISO timestamp. */
  created_at: string;

  /** ISO timestamp of last mutation. */
  updated_at?: string;

  /**
   * Reserved for level-3 compound-adapter use. Maps smallstore-side path
   * prefixes to peer-side path prefixes. Ignored in MVP.
   *
   * Example: `{ 'tf/': '/', 'tf/inbox/': '/inbox/mailroom/' }` so
   * `smallstore.set('tf/inbox/foo', ...)` writes to tigerflare's
   * `/inbox/mailroom/foo`.
   */
  path_mapping?: Record<string, string>;

  /**
   * Free-form per-peer metadata. Smallstore doesn't interpret this — it's a
   * convention surface for callers to attach their own config to a peer row
   * without needing a smallstore code change for every new field shape.
   *
   * Conventions in use today:
   *
   * - For `type: 'rss'` peers — `metadata.feed_config = { target_inbox,
   *   schedule, default_labels?, media_policy? }`. The poller (valtown,
   *   future in-Worker pull-runner) reads this to know where to POST
   *   parsed items + how often to poll. Smallstore itself doesn't poll,
   *   just stores the config so pollers have one source of truth.
   *
   * - Other peer types can claim their own `metadata.<key>` namespaces as
   *   needed. Document conventions in `.brief/peer-registry.md`.
   *
   * Validated as a plain object (no nested type checks); store anything
   * JSON-serializable.
   */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// PeerStore interface
// ============================================================================

/**
 * Options for listing peers. Mirrors the sender-index / rules-store shape
 * so agents see consistent pagination semantics across smallstore
 * runtime stores.
 */
export interface PeerQueryFilter {
  /** Substring match on name. Case-insensitive. */
  name?: string;
  /** Exact match on type. */
  type?: PeerType;
  /** All listed tags must be present on the peer (AND semantics). */
  tags?: string[];
  /** Include disabled peers? Default false. */
  include_disabled?: boolean;
  /** Paging cursor — last peer id seen. */
  cursor?: string;
  /** Page size. Server caps at 500. */
  limit?: number;
}

export interface PeerQueryResult {
  peers: Peer[];
  /** Absent = end of stream. */
  next_cursor?: string;
}

/**
 * The CRUD surface over peer storage. Adapter-agnostic: implementations
 * wrap any `StorageAdapter` (MemoryAdapter in tests, cloudflare-d1 in
 * production).
 *
 * Constructed via `createPeerStore(adapter, opts)` — see
 * `src/peers/peer-registry.ts`.
 */
export interface PeerStore {
  /** List peers (optionally filtered + paged). */
  list(filter?: PeerQueryFilter): Promise<PeerQueryResult>;

  /** Get by slug (`name`). Returns null when missing. */
  get(name: string): Promise<Peer | null>;

  /** Get by id (internal). Returns null when missing. */
  getById(id: string): Promise<Peer | null>;

  /**
   * Create a peer. `id` + `created_at` are assigned by the store.
   * Throws if `name` is already taken (slug uniqueness).
   */
  create(input: Omit<Peer, 'id' | 'created_at'>): Promise<Peer>;

  /**
   * Partial update. Changing `name` fails if the new name is taken.
   * Returns the updated peer, or null if `name` didn't exist.
   * Sets `updated_at` automatically.
   */
  update(name: string, patch: Partial<Omit<Peer, 'id' | 'created_at' | 'name'>> & { name?: string }): Promise<Peer | null>;

  /** Remove by slug. Returns true if it existed. */
  delete(name: string): Promise<boolean>;
}

/**
 * Options passed to `createPeerStore`.
 */
export interface CreatePeerStoreOptions {
  /** Key prefix for stored peer records. Default `peers/`. */
  keyPrefix?: string;
  /**
   * Override the id generator. Defaults to `crypto.randomUUID()`.
   * Used in tests for deterministic ids.
   */
  generateId?: () => string;
}

// ============================================================================
// Proxy — request/response shapes
// ============================================================================

/**
 * Resolved outbound auth material after env lookup. Produced by
 * `resolvePeerAuth(peer, env)` in `src/peers/proxy.ts`.
 */
export interface ResolvedAuth {
  /** Headers to inject on the outbound request. */
  headers: Record<string, string>;
  /** Query-string additions (already URL-encoded). Concatenated to the outbound URL. */
  query_params?: Array<[string, string]>;
  /** Set when resolution failed (env var missing, etc). Proxy should 500 with this message. */
  error?: string;
}

/**
 * Arguments for the proxy-GET helper.
 */
export interface ProxyGetArgs {
  peer: Peer;
  /** Path to append to `peer.url`. Leading `/` recommended. */
  path: string;
  /** Env bag — `Record<string, string>` keyed by env var name. Worker passes `env` here. */
  env: Record<string, string | undefined>;
  /** Optional extra headers from the client (forwarded verbatim). */
  client_headers?: Record<string, string>;
  /** Extra query params from client (preserved on the outbound). */
  client_query?: Record<string, string>;
  /** Timeout in ms. Default 10_000. */
  timeout_ms?: number;
}

/**
 * Arguments for the proxy-POST helper.
 */
export interface ProxyPostArgs extends Omit<ProxyGetArgs, 'path'> {
  /** Path portion (`peer.url + path`). Default `/`. */
  path?: string;
  /** Request body (JSON-encoded if an object; sent as-is if string/Uint8Array). */
  body: unknown;
  /** Content-Type for the body. Default `application/json`. */
  content_type?: string;
}

/**
 * Result of a proxy operation. The proxy helpers return this (never throw on
 * non-2xx — the caller inspects `.ok` + `.status`).
 */
export interface ProxyResult {
  /** HTTP status code; 0 if the request never completed (network/timeout/missing env). */
  status: number;
  /** True when status is 2xx. */
  ok: boolean;
  /** Response headers — lowercase-keyed. */
  headers: Record<string, string>;
  /** Response body as text. Callers decide whether to parse. */
  body: string;
  /** Error message when a network/timeout/resolution failure occurred. */
  error?: string;
  /** Wall-clock milliseconds for the request. */
  latency_ms: number;
}

/**
 * Result of a health probe (`probePeer`).
 */
export interface HealthResult {
  /** True when the peer responded with a 2xx or 3xx status. */
  ok: boolean;
  /** HTTP status code. 0 if unreachable. */
  status?: number;
  /** Wall-clock milliseconds. */
  latency_ms: number;
  /** Error message on failure (timeout, DNS, etc). */
  error?: string;
}
