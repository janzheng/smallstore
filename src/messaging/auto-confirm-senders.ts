/**
 * Auto-confirm senders — runtime-editable allowlist for `auto-confirm.ts`.
 *
 * Motivation: the `AUTO_CONFIRM_SENDERS` env var (`*@substack.com`,
 * `*@convertkit.com`, ...) lives in `wrangler.toml`, so adding a new
 * newsletter platform means editing the file + redeploying. This store
 * persists patterns in D1 (or any StorageAdapter) so callers can add /
 * remove patterns at runtime without touching the deploy.
 *
 * Storage shape: one row per pattern, keyed by the lowercased pattern
 * itself (so adds are idempotent). Each row carries `source` ('env' or
 * 'runtime') so the env-seed step can tell which patterns it owns.
 *
 * ## Env seeding
 *
 * `seedFromEnv(envValue, store)` is intended to run once at boot. For
 * each pattern in the env var, it adds a `source: 'env'` row only if no
 * row exists for that pattern. Subsequent runtime DELETE wins — the seed
 * does NOT re-add a pattern the user explicitly removed. (Re-add is
 * trivial via `POST /admin/auto-confirm/senders` if needed.)
 *
 * ## Why patterns-as-keys (not uuid ids)
 *
 * The hook only cares about the pattern string. Keying by pattern makes
 * GET/DELETE single-shot (`store.get('*@substack.com')`,
 * `store.delete('*@substack.com')`) without a "first list to find the id"
 * round-trip — matches how a human thinks about the allowlist.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * One row in the auto-confirm allowlist.
 *
 * `pattern` is the canonical (lowercased, trimmed) glob string. `source`
 * lets the seed step distinguish "I added this from env" from "the user
 * added this via API"; both behave identically at hook time.
 */
export interface AutoConfirmSender {
  /** Lowercased glob pattern (e.g. `'*@substack.com'`). Primary key. */
  pattern: string;
  /** Where the row originated. `'env'` for boot seeds; `'runtime'` for admin API. */
  source: 'env' | 'runtime';
  /** ISO timestamp of creation. */
  created_at: string;
  /** Optional human note ("added because Beehiiv migrated to this domain"). */
  notes?: string;
}

export interface AutoConfirmSendersStore {
  /** List all patterns, sorted oldest-first by `created_at` for stable display. */
  list(): Promise<AutoConfirmSender[]>;
  /** Fetch one pattern. Returns null when missing. */
  get(pattern: string): Promise<AutoConfirmSender | null>;
  /**
   * Add a pattern. Idempotent — calling twice with the same pattern
   * returns the existing row unchanged (no `created_at` reset).
   * Pattern is lowercased + trimmed before storage.
   */
  add(input: { pattern: string; source?: 'env' | 'runtime'; notes?: string }): Promise<AutoConfirmSender>;
  /** Remove a pattern. Returns true when a row existed. */
  delete(pattern: string): Promise<boolean>;
  /** Convenience for the auto-confirm hook — just the pattern strings. */
  patterns(): Promise<string[]>;
  /**
   * Subscribe to mutation events. The listener fires after every successful
   * `add` or `delete` (whether the pattern actually changed or not — the
   * hook just needs a "something happened" signal to invalidate its cache).
   * Returns an unsubscribe function. Audit finding B015.
   */
  subscribe(listener: () => void): () => void;
}

export interface CreateAutoConfirmSendersStoreOptions {
  /** Key prefix for stored patterns. Default `'auto-confirm/'`. */
  keyPrefix?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_PREFIX = 'auto-confirm/';

/**
 * Canonical form of a pattern as stored: trimmed + lowercased. Empty
 * input returns `''` so callers can guard with `if (!normalized)`.
 */
export function normalizePattern(input: string | undefined | null): string {
  return String(input ?? '').trim().toLowerCase();
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build an `AutoConfirmSendersStore` backed by any `StorageAdapter`.
 *
 * Designed to share a D1 binding with other messaging stores via a
 * dedicated table — see `deploy/src/index.ts` for the wiring pattern.
 */
export function createAutoConfirmSendersStore(
  adapter: StorageAdapter,
  opts: CreateAutoConfirmSendersStoreOptions = {},
): AutoConfirmSendersStore {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const keyFor = (pattern: string) => keyPrefix + pattern;

  async function loadAll(): Promise<AutoConfirmSender[]> {
    const keys = await adapter.keys(keyPrefix);
    const rows: AutoConfirmSender[] = [];
    for (const key of keys) {
      const row = (await adapter.get(key)) as AutoConfirmSender | null;
      if (row) rows.push(row);
    }
    rows.sort((a, b) => {
      if (a.created_at < b.created_at) return -1;
      if (a.created_at > b.created_at) return 1;
      return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
    });
    return rows;
  }

  // In-process listeners. Mutations fire all listeners synchronously after
  // the storage write settles. Listener errors are swallowed + logged so a
  // misbehaving subscriber can't poison the mutation path.
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.warn('[auto-confirm-senders] listener threw:', err);
      }
    }
  };

  return {
    async list(): Promise<AutoConfirmSender[]> {
      return await loadAll();
    },

    async get(pattern: string): Promise<AutoConfirmSender | null> {
      const normalized = normalizePattern(pattern);
      if (!normalized) return null;
      return (await adapter.get(keyFor(normalized))) as AutoConfirmSender | null;
    },

    async add(input): Promise<AutoConfirmSender> {
      const normalized = normalizePattern(input.pattern);
      if (!normalized) {
        throw new Error('auto-confirm pattern is required (non-empty after trim)');
      }
      const key = keyFor(normalized);
      const existing = (await adapter.get(key)) as AutoConfirmSender | null;
      if (existing) return existing;
      const row: AutoConfirmSender = {
        pattern: normalized,
        source: input.source ?? 'runtime',
        created_at: new Date().toISOString(),
        notes: input.notes,
      };
      await adapter.set(key, row);
      notify();
      return row;
    },

    async delete(pattern: string): Promise<boolean> {
      const normalized = normalizePattern(pattern);
      if (!normalized) return false;
      const key = keyFor(normalized);
      const existed = await adapter.has(key);
      if (existed) {
        await adapter.delete(key);
        notify();
      }
      return existed;
    },

    async patterns(): Promise<string[]> {
      const all = await loadAll();
      return all.map((r) => r.pattern);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ============================================================================
// Env seeding
// ============================================================================

/**
 * Seed an `AutoConfirmSendersStore` from a comma-separated env-var value.
 *
 * Semantics:
 * - On first ever boot, every env pattern is added with `source: 'env'`.
 * - A per-pattern sentinel ("we've seeded this before") is recorded
 *   alongside each add. The sentinel survives row deletes — so if the
 *   user later removes a pattern via `DELETE /admin/auto-confirm/senders`,
 *   the next cold-start seed will SKIP it (delete wins).
 * - Adding a brand-new pattern to the env var on an existing deploy still
 *   works: it has no sentinel yet, so the seeder will add it on next boot.
 *
 * Returns the patterns added by THIS call (skipped patterns aren't
 * counted). Empty array on a no-op pass.
 *
 * Usage in deploy:
 * ```
 * const adapter = createCloudflareD1Adapter({ ... });
 * const store = createAutoConfirmSendersStore(adapter);
 * await seedAutoConfirmFromEnv(env.AUTO_CONFIRM_SENDERS, store, adapter);
 * ```
 *
 * The third argument MUST be the same adapter the store is built on so
 * the seed sentinels live alongside the rows. This is intentional — the
 * sentinels are part of the seed contract, not the public store API.
 */
export async function seedAutoConfirmFromEnv(
  envValue: string | undefined,
  store: AutoConfirmSendersStore,
  adapter: StorageAdapter,
  opts: { sentinelPrefix?: string } = {},
): Promise<string[]> {
  if (!envValue) return [];
  const sentinelPrefix = opts.sentinelPrefix ?? '_seeded-auto-confirm/';
  const patterns = envValue
    .split(',')
    .map((p) => normalizePattern(p))
    .filter((p) => p.length > 0);
  const added: string[] = [];
  for (const pattern of patterns) {
    const sentinelKey = sentinelPrefix + pattern;
    if (await adapter.has(sentinelKey)) continue; // already seeded once — delete wins
    // Add the row + the sentinel together. Order: row first, then sentinel,
    // so a partial failure leaves the row reachable via the API but the
    // pattern eligible for re-seeding (better than the inverse: marked-
    // seeded but no row).
    await store.add({ pattern, source: 'env' });
    await adapter.set(sentinelKey, { seeded_at: new Date().toISOString() });
    added.push(pattern);
  }
  return added;
}
