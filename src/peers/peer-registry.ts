/**
 * Peer registry — adapter-agnostic CRUD store for peers.
 *
 * Peers are registered data sources smallstore "knows about" but doesn't own.
 * See `.brief/peer-registry.md` § "MVP design (level 2)" for motivation +
 * `src/peers/types.ts` for the `Peer` / `PeerStore` surfaces.
 *
 * Storage layout (matches the rules-store shape for consistency):
 *
 * ```
 * ${keyPrefix}<name>            → Peer JSON (primary record, keyed by slug)
 * ${keyPrefix}_by_id/<id>       → string alias pointing at the primary slug
 *                                 so `getById(id)` is O(1)
 * ```
 *
 * The secondary alias lets `getById` avoid scanning the whole prefix. Both
 * keys are kept in sync on create/update(-name)/delete; `list()` filters
 * alias keys back out so they don't surface as peers.
 *
 * Validation (performed on `create` + `update`):
 *
 * - **`name`** — URL-safe slug: `/^[a-z0-9][a-z0-9_-]{0,63}$/`. Used in HTTP
 *   paths (`/peers/:name/...`), so no uppercase, no spaces, no leading dash.
 * - **`url`** — must parse as an absolute URL with `http:` or `https:`
 *   protocol. `file://`, `ftp://`, bare paths all reject.
 * - **`tags`** — must be an array of lowercase-ish strings; each ≤32 chars,
 *   ≤16 total. Rejects obvious garbage (objects, numbers, empties) but does
 *   not aggressively normalize — tags are user-facing filter labels.
 *
 * Adapter-agnostic: any `StorageAdapter` (MemoryAdapter in tests,
 * `cloudflare-d1` in production) works. Mirrors the
 * `createRulesStore(adapter, opts)` factory shape in `src/messaging/rules.ts`.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type {
  CreatePeerStoreOptions,
  Peer,
  PeerQueryFilter,
  PeerQueryResult,
  PeerStore,
} from './types.ts';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PREFIX = 'peers/';
const ALIAS_SUBPREFIX = '_by_id/';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** URL-safe slug: starts with lowercase/digit, 1-64 chars of lowercase/digit/dash/underscore. */
const NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MAX_TAGS = 16;
const MAX_TAG_LEN = 32;

// ============================================================================
// Validation helpers (module-local; not exported — create/update are the API)
// ============================================================================

/** Throw on invalid slug. Shared between create + update(rename). */
function validateName(name: string): void {
  if (typeof name !== 'string' || !NAME_REGEX.test(name)) {
    throw new Error(
      `Peer name must match [a-z0-9][a-z0-9_-]{0,63}: got "${name}"`,
    );
  }
}

/** Throw on non-http(s) URL. Uses `new URL()` for parse, then protocol check. */
function validateUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`Peer url must be a non-empty http(s) URL: got "${url}"`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Peer url must be a valid absolute URL: got "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Peer url must use http: or https: protocol, got "${parsed.protocol}" in "${url}"`,
    );
  }
}

/** Throw on obviously bad tags. Permissive on casing — callers may supply mixed. */
function validateTags(tags: unknown): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) {
    throw new Error(`Peer tags must be an array, got ${typeof tags}`);
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`Peer tags too many: ${tags.length} (max ${MAX_TAGS})`);
  }
  for (const t of tags) {
    if (typeof t !== 'string' || t.length === 0) {
      throw new Error(`Peer tag must be a non-empty string, got ${JSON.stringify(t)}`);
    }
    if (t.length > MAX_TAG_LEN) {
      throw new Error(`Peer tag too long: "${t}" (max ${MAX_TAG_LEN} chars)`);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a `PeerStore` backed by any `StorageAdapter`.
 *
 * @example
 * ```ts
 * const adapter = new MemoryAdapter();
 * const peers = createPeerStore(adapter);
 * await peers.create({
 *   name: 'tigerflare-prod',
 *   type: 'tigerflare',
 *   url: 'https://tigerflare.labspace.ai',
 *   auth: { kind: 'bearer', token_env: 'TF_TOKEN' },
 *   tags: ['prod', 'personal'],
 * });
 * ```
 */
export function createPeerStore(
  adapter: StorageAdapter,
  opts: CreatePeerStoreOptions = {},
): PeerStore {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const generateId = opts.generateId ?? (() => crypto.randomUUID());

  const aliasPrefix = keyPrefix + ALIAS_SUBPREFIX;
  const primaryKey = (name: string) => keyPrefix + name;
  const aliasKey = (id: string) => aliasPrefix + id;

  /** Is this a primary-record key (not an alias) under our prefix? */
  function isPrimaryKey(key: string): boolean {
    return key.startsWith(keyPrefix) && !key.startsWith(aliasPrefix);
  }

  async function readByPrimaryKey(key: string): Promise<Peer | null> {
    const peer = (await adapter.get(key)) as Peer | null;
    return peer ?? null;
  }

  return {
    async create(input): Promise<Peer> {
      // Validate inputs before touching storage.
      validateName(input.name);
      validateUrl(input.url);
      validateTags(input.tags);

      // Uniqueness check — slug is the human-facing PK.
      const existing = await readByPrimaryKey(primaryKey(input.name));
      if (existing) {
        throw new Error(`Peer "${input.name}" already exists`);
      }

      const id = generateId();
      const peer: Peer = {
        id,
        name: input.name,
        type: input.type,
        url: input.url,
        description: input.description,
        auth: input.auth ?? { kind: 'none' },
        headers: input.headers,
        tags: input.tags,
        capabilities: input.capabilities,
        disabled: input.disabled ?? false,
        created_at: new Date().toISOString(),
        path_mapping: input.path_mapping,
        metadata: input.metadata,
      };

      // Primary record + id-alias. Alias is a plain string pointing at the
      // slug, so `getById` is two O(1) reads (alias → slug → record).
      await adapter.set(primaryKey(peer.name), peer);
      await adapter.set(aliasKey(peer.id), peer.name);

      return peer;
    },

    async get(name: string): Promise<Peer | null> {
      if (!name) return null;
      return readByPrimaryKey(primaryKey(name));
    },

    async getById(id: string): Promise<Peer | null> {
      if (!id) return null;
      const name = (await adapter.get(aliasKey(id))) as string | null;
      if (!name) return null;
      return readByPrimaryKey(primaryKey(name));
    },

    async update(name, patch): Promise<Peer | null> {
      const existing = await readByPrimaryKey(primaryKey(name));
      if (!existing) return null;

      // Strip forbidden mutations. `id` + `created_at` are set-once.
      // Cast through `any` because the public patch type already forbids them
      // but we defensively scrub anyway for direct callers.
      const { id: _ignored_id, created_at: _ignored_created, ...rest } = patch as any;

      // If renaming, validate + ensure new name is free.
      let newName = existing.name;
      if (rest.name !== undefined && rest.name !== existing.name) {
        validateName(rest.name);
        const clash = await readByPrimaryKey(primaryKey(rest.name));
        if (clash) {
          throw new Error(`Peer "${rest.name}" already exists`);
        }
        newName = rest.name;
      }

      // Re-validate url + tags if they were touched.
      if (rest.url !== undefined) validateUrl(rest.url);
      if (rest.tags !== undefined) validateTags(rest.tags);

      const merged: Peer = {
        ...existing,
        ...rest,
        id: existing.id,
        created_at: existing.created_at,
        name: newName,
        updated_at: new Date().toISOString(),
      };

      if (newName !== existing.name) {
        // Move primary record to new key; delete old key; update alias.
        await adapter.set(primaryKey(newName), merged);
        await adapter.delete(primaryKey(existing.name));
        await adapter.set(aliasKey(merged.id), newName);
      } else {
        await adapter.set(primaryKey(newName), merged);
      }

      return merged;
    },

    async delete(name: string): Promise<boolean> {
      const existing = await readByPrimaryKey(primaryKey(name));
      if (!existing) return false;
      await adapter.delete(primaryKey(name));
      await adapter.delete(aliasKey(existing.id));
      return true;
    },

    async list(filter: PeerQueryFilter = {}): Promise<PeerQueryResult> {
      const limit = Math.min(
        Math.max(1, filter.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT,
      );

      // Enumerate primary keys only — alias keys live under `_by_id/` and must
      // not surface as peers.
      const allKeys = await adapter.keys(keyPrefix);
      const primaryKeys = allKeys.filter(isPrimaryKey);

      // Load + filter.
      const matching: Peer[] = [];
      for (const key of primaryKeys) {
        const peer = (await adapter.get(key)) as Peer | null;
        if (!peer) continue;

        // Include disabled only when asked.
        if (peer.disabled && !filter.include_disabled) continue;

        // Type: exact match.
        if (filter.type && peer.type !== filter.type) continue;

        // Name substring, case-insensitive.
        if (filter.name) {
          const needle = filter.name.toLowerCase();
          if (!peer.name.toLowerCase().includes(needle)) continue;
        }

        // Tags AND-intersection — every filter tag must be present on the peer.
        if (filter.tags && filter.tags.length > 0) {
          const peerTags = peer.tags ?? [];
          const peerTagSet = new Set(peerTags);
          let ok = true;
          for (const t of filter.tags) {
            if (!peerTagSet.has(t)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
        }

        matching.push(peer);
      }

      // Sort by `name` ascending — stable, predictable, paginatable. Cursor is
      // the last name seen, so ordering has to be total + deterministic.
      matching.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      // Cursor = last name seen. Skip entries up to and including that name.
      let startIdx = 0;
      if (filter.cursor) {
        const found = matching.findIndex((p) => p.name === filter.cursor);
        startIdx = found >= 0 ? found + 1 : matching.length;
      }

      const page = matching.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < matching.length;
      const next_cursor = hasMore && page.length > 0 ? page[page.length - 1].name : undefined;

      return { peers: page, next_cursor };
    },
  };
}
