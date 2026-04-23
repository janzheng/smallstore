/**
 * Mailroom rules — runtime-editable rule store.
 *
 * Curation workstream: users can create rules that match incoming items and
 * apply tag-style (additive) or terminal (drop/quarantine) actions. Rules
 * reuse the existing `InboxFilter` DSL + `evaluateFilter` evaluator so they
 * share semantics with query/export routes.
 *
 * Storage: adapter-agnostic. Rules live under `keyPrefix` (default `rules/`)
 * in any `StorageAdapter` — `MemoryAdapter` in tests, D1/R2 in production.
 *
 * Semantics (see `apply` docs below + `.brief/mailroom-curation.md` § D3):
 *
 * - **Tag-style** actions (`archive`, `bookmark`, `tag`) — every matching
 *   enabled rule contributes its derived label; labels stack + dedup.
 * - **Terminal** actions (`drop`, `quarantine`) — first-match-by-priority
 *   wins; later terminal matches are ignored. Lower `priority` = earlier.
 * - When terminal + tag-style both match, terminal wins the `action` slot
 *   but tag-style labels are still returned so the caller (hook) can
 *   decide whether to attach them to the item.
 *
 * Retroactive apply (`applyRetroactive`) iterates existing items matching a
 * rule and re-ingests each with the rule's derived label added. Only
 * tag-style actions are supported retroactively — dropping/quarantining
 * items that already exist doesn't make sense (the item is stored; the
 * caller can delete or label-to-hide instead).
 *
 * See `.brief/mailroom-curation.md` § UC2 / UC3 and design decision D3 for
 * the full walkthrough.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import { evaluateFilter } from './filter.ts';
import type { Inbox, InboxFilter, InboxItem } from './types.ts';

// ============================================================================
// Types
// ============================================================================

/** Supported rule actions. Tag-style: archive/bookmark/tag. Terminal: drop/quarantine. */
export type RuleAction = 'archive' | 'bookmark' | 'tag' | 'drop' | 'quarantine';

/**
 * A mailroom rule — matches items via the shared `InboxFilter` DSL and
 * applies an action when matched.
 */
export interface MailroomRule {
  /** Stable id (uuid by default). */
  id: string;
  /** Filter expression — reuses `InboxFilter` so rule matching == query matching. */
  match: InboxFilter;
  /** Action verb. See `RuleAction`. */
  action: RuleAction;
  /** Extra args: for `action: 'tag'`, `{ tag: 'read-later' }` etc. */
  action_args?: { tag?: string };
  /** Lower wins on terminal actions (first-match by priority). Default 100. */
  priority: number;
  /** Free-form human annotation. */
  notes?: string;
  /** ISO timestamp. */
  created_at: string;
  /** ISO timestamp of last mutation, when present. */
  updated_at?: string;
  /** Soft-disable — rule persists but is skipped by `apply`. */
  disabled?: boolean;
}

/**
 * Aggregate result of evaluating all rules against a single item.
 *
 * Callers (typically the `createRulesHook` preIngest factory) combine these
 * into pipeline verdicts — `terminal === 'drop'` maps to the `'drop'` verdict;
 * `'quarantine'` to `'quarantine'`; otherwise labels are merged onto the item.
 */
export interface RulesApplyResult {
  /** First terminal action matched (by priority ascending). Absent when no terminal matched. */
  terminal?: 'drop' | 'quarantine';
  /** Deduped labels from all matching tag-style rules (in priority order). */
  labelsToAdd: string[];
  /** Ids of every rule that matched (both terminal and tag-style), in priority order. */
  matchedRuleIds: string[];
}

export interface RulesStore {
  /** List rules newest-first by `created_at`. Paginated via cursor (the last id seen). */
  list(opts?: { limit?: number; cursor?: string }): Promise<{ rules: MailroomRule[]; next_cursor?: string }>;
  /** Fetch a single rule by id. Returns null when missing. */
  get(id: string): Promise<MailroomRule | null>;
  /** Create a new rule. Generates id, sets `created_at`, applies defaults. */
  create(input: Omit<MailroomRule, 'id' | 'created_at'>): Promise<MailroomRule>;
  /** Partial update. Returns null when the rule id is unknown. */
  update(id: string, patch: Partial<Omit<MailroomRule, 'id' | 'created_at'>>): Promise<MailroomRule | null>;
  /** Delete a rule. Returns true when a row existed. */
  delete(id: string): Promise<boolean>;
  /**
   * Evaluate all enabled rules against an item and return the aggregate
   * action + labels to apply.
   *
   * Semantics:
   * - Tag-style actions (`archive`, `bookmark`, `tag`) — ADDITIVE: every
   *   matching rule contributes its derived label; labels are deduped.
   * - Terminal actions (`drop`, `quarantine`) — first-match-wins by priority
   *   (lower `priority` wins). Subsequent terminal matches are noted in
   *   `matchedRuleIds` but do not override the terminal slot.
   * - Terminal + tag-style both matching: `terminal` is set AND
   *   `labelsToAdd` still contains tag-style labels. The caller decides
   *   what to do with them (the provided hook in `rules-hook.ts` merges
   *   them + the quarantine label for `quarantine`, drops the item entirely
   *   for `drop`).
   */
  apply(item: InboxItem): Promise<RulesApplyResult>;
  /**
   * Iterate all items in the inbox matching `rule.match` and re-ingest each
   * with the rule's derived label merged in. Returns count of items touched.
   *
   * Only tag-style actions are supported — terminal (`drop`/`quarantine`)
   * retroactive is a no-op + error (the item is already stored; the right
   * knob is delete or label-to-hide, not terminal).
   */
  applyRetroactive(rule: MailroomRule, inbox: Inbox): Promise<{ affected: number; error?: string }>;
}

export interface CreateRulesStoreOptions {
  /** Key prefix for stored rules. Default `'rules/'`. */
  keyPrefix?: string;
  /** Id generator — default `crypto.randomUUID()`. Override for deterministic tests. */
  generateId?: () => string;
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_PREFIX = 'rules/';
const DEFAULT_PRIORITY = 100;
const TAG_STYLE_ACTIONS: ReadonlySet<RuleAction> = new Set(['archive', 'bookmark', 'tag']);
const TERMINAL_ACTIONS: ReadonlySet<RuleAction> = new Set(['drop', 'quarantine']);

/**
 * Derive the label a tag-style rule adds to an item.
 *
 * - `archive`  → `'archived'`
 * - `bookmark` → `'bookmark'`
 * - `tag`      → `action_args.tag` (fallback `'tagged'` if not set)
 *
 * Terminal actions return `null` — they don't contribute labels via this
 * path (quarantine's label is attached by the hook, not by the rule).
 */
export function deriveRuleLabel(rule: MailroomRule): string | null {
  switch (rule.action) {
    case 'archive':
      return 'archived';
    case 'bookmark':
      return 'bookmark';
    case 'tag':
      return rule.action_args?.tag ?? 'tagged';
    default:
      return null;
  }
}

/** Is this action tag-style (additive)? */
export function isTagStyleAction(action: RuleAction): boolean {
  return TAG_STYLE_ACTIONS.has(action);
}

/** Is this action terminal (drop/quarantine)? */
export function isTerminalAction(action: RuleAction): boolean {
  return TERMINAL_ACTIONS.has(action);
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a `RulesStore` backed by any `StorageAdapter`.
 *
 * @example
 * ```ts
 * const adapter = new MemoryAdapter();
 * const rules = createRulesStore(adapter);
 * await rules.create({ match: { fields: { from_email: 'news@annoying.com' } }, action: 'archive', priority: 100 });
 * const res = await rules.apply(item);
 * // res.labelsToAdd → ['archived']  (if item matches)
 * ```
 */
export function createRulesStore(
  adapter: StorageAdapter,
  opts: CreateRulesStoreOptions = {},
): RulesStore {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const keyFor = (id: string) => keyPrefix + id;

  /** Load every rule under keyPrefix, sorted by created_at desc then id asc (stable). */
  async function loadAll(): Promise<MailroomRule[]> {
    const keys = await adapter.keys(keyPrefix);
    const rules: MailroomRule[] = [];
    for (const key of keys) {
      const rule = (await adapter.get(key)) as MailroomRule | null;
      if (rule) rules.push(rule);
    }
    // Newest first; deterministic tie-break by id.
    rules.sort((a, b) => {
      if (a.created_at < b.created_at) return 1;
      if (a.created_at > b.created_at) return -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return rules;
  }

  return {
    async list(listOpts = {}): Promise<{ rules: MailroomRule[]; next_cursor?: string }> {
      const all = await loadAll();
      const limit = listOpts.limit;
      const cursor = listOpts.cursor;

      let startIdx = 0;
      if (cursor) {
        const found = all.findIndex((r) => r.id === cursor);
        startIdx = found >= 0 ? found + 1 : all.length; // unknown cursor → empty page
      }

      const sliced = limit !== undefined ? all.slice(startIdx, startIdx + limit) : all.slice(startIdx);
      const hasMore = limit !== undefined && startIdx + limit < all.length;
      const next_cursor = hasMore && sliced.length > 0 ? sliced[sliced.length - 1].id : undefined;

      return { rules: sliced, next_cursor };
    },

    async get(id: string): Promise<MailroomRule | null> {
      if (!id) return null;
      const rule = (await adapter.get(keyFor(id))) as MailroomRule | null;
      return rule ?? null;
    },

    async create(input): Promise<MailroomRule> {
      const id = generateId();
      const rule: MailroomRule = {
        id,
        created_at: new Date().toISOString(),
        priority: input.priority ?? DEFAULT_PRIORITY,
        disabled: input.disabled ?? false,
        match: input.match,
        action: input.action,
        action_args: input.action_args,
        notes: input.notes,
      };
      await adapter.set(keyFor(id), rule);
      return rule;
    },

    async update(id, patch): Promise<MailroomRule | null> {
      const existing = (await adapter.get(keyFor(id))) as MailroomRule | null;
      if (!existing) return null;
      const merged: MailroomRule = {
        ...existing,
        ...patch,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      await adapter.set(keyFor(id), merged);
      return merged;
    },

    async delete(id): Promise<boolean> {
      const key = keyFor(id);
      const existed = await adapter.has(key);
      if (existed) await adapter.delete(key);
      return existed;
    },

    async apply(item: InboxItem): Promise<RulesApplyResult> {
      const rules = await loadAll();
      const enabled = rules.filter((r) => !r.disabled);

      // Evaluate matches, then sort by priority ascending (lower wins for
      // terminal). For tag-style collection the order also determines the
      // stable label order before dedup.
      const matches: MailroomRule[] = [];
      for (const rule of enabled) {
        if (evaluateFilter(rule.match, item)) matches.push(rule);
      }
      matches.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Deterministic tie-break: oldest rule wins (rules created earlier
        // are considered more stable; matches sender-index style ordering).
        if (a.created_at < b.created_at) return -1;
        if (a.created_at > b.created_at) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      const labelSet = new Set<string>();
      const labelsInOrder: string[] = [];
      const matchedRuleIds: string[] = [];
      let terminal: 'drop' | 'quarantine' | undefined;

      for (const rule of matches) {
        matchedRuleIds.push(rule.id);
        if (isTerminalAction(rule.action)) {
          // First terminal wins — later terminals are recorded in
          // matchedRuleIds but do not override.
          if (terminal === undefined) {
            terminal = rule.action as 'drop' | 'quarantine';
          }
          continue;
        }
        if (isTagStyleAction(rule.action)) {
          const label = deriveRuleLabel(rule);
          if (label && !labelSet.has(label)) {
            labelSet.add(label);
            labelsInOrder.push(label);
          }
        }
      }

      return {
        terminal,
        labelsToAdd: labelsInOrder,
        matchedRuleIds,
      };
    },

    async applyRetroactive(
      rule: MailroomRule,
      inbox: Inbox,
    ): Promise<{ affected: number; error?: string }> {
      if (isTerminalAction(rule.action)) {
        return {
          affected: 0,
          error: 'retroactive apply only supports tag-style actions (archive/bookmark/tag)',
        };
      }

      const label = deriveRuleLabel(rule);
      if (!label) {
        return { affected: 0, error: `rule action "${rule.action}" has no derivable label` };
      }

      let affected = 0;
      let cursor: string | undefined;
      const pageLimit = 100;

      // Safety cap — refuse to loop forever if the inbox's `query` signals
      // "more" without actually advancing (shouldn't happen, but cheap to
      // guard).
      const maxPages = 10_000;
      let pages = 0;

      while (pages++ < maxPages) {
        const result = await inbox.query(rule.match, { cursor, limit: pageLimit });
        for (const item of result.items) {
          const existingLabels = item.labels ?? [];
          if (existingLabels.includes(label)) {
            // Already has the label — skip re-ingest to avoid churn on the
            // index. `affected` counts items actually mutated.
            continue;
          }
          const mutated: InboxItem = {
            ...item,
            labels: Array.from(new Set([...existingLabels, label])),
          };
          await inbox._ingest(mutated, { force: true });
          affected++;
        }
        if (!result.next_cursor) break;
        cursor = result.next_cursor;
      }

      return { affected };
    },
  };
}
