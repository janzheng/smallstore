/**
 * Smallstore MCP — inbox/messaging tool family.
 *
 * Thin HTTP forwarders over the live `/inbox/*` surface exposed by the
 * Smallstore server (see `src/messaging/http-routes.ts`). These let agents
 * inside Claude Code / Cursor operate on the mailroom — list items, tag
 * them, restore quarantined messages, manage mailroom rules — without
 * dropping to curl.
 *
 * The `:name` path segment is a runtime-registered inbox name (see
 * `/admin/inboxes`), NOT a collection. All user-supplied `:name` and `:id`
 * values are `encodeURIComponent`-ed because the server matches them as
 * path params and a stray `/` or `?` would otherwise shift the route.
 *
 * @module
 */
import type { Args, HttpFn, Tool } from './types.ts';
import { formatHttpError, requireString, validateName } from './types.ts';

// ============================================================================
// Tool definitions
// ============================================================================

export const INBOX_TOOLS: Tool[] = [
  {
    name: 'sm_inbox_list',
    description:
      'List items in an inbox, newest-first by default, with cursor-based pagination. Returns `{ inbox, items, next_cursor? }`. Use this for a quick look at the top of a mailroom; for anything filter-shaped (by sender, labels, time range) prefer `sm_inbox_query`. Pass `order_by: "original_sent_at"` for forwards landing chronologically by their original send date (cursor pagination disabled in that mode — use `limit` alone).',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name (see /admin/inboxes).' },
        cursor: { type: 'string', description: 'Opaque cursor returned by a prior `sm_inbox_list` call. Omit for the first page.' },
        limit: { type: 'number', description: 'Max items per page. Server-enforced upper bound.' },
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default: `newest`.' },
        order_by: {
          type: 'string',
          enum: ['received_at', 'sent_at', 'original_sent_at'],
          description: "Sort key. Default `received_at`. `original_sent_at` sorts forwards by their original send date — useful when forwards landed out of order. Cursor pagination disabled for non-default `order_by`.",
        },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_read',
    description:
      'Read a single inbox item by id. Pass `full: true` to inflate the full body (raw email / message content) — by default the body is stored by reference and only the envelope + labels come back.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id (from `sm_inbox_list` / `sm_inbox_query`).' },
        full: { type: 'boolean', description: 'When true, inflate body content from blob storage. Default: false.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_query',
    description:
      'Filter an inbox with an `InboxFilter` object (labels, senders, time windows, etc). Use this instead of `sm_inbox_list` when you need to scope by label (e.g. `{ labels: ["unread"] }` for what\'s new since last sweep — new items auto-stamp `unread` at ingest, cleared by `sm_inbox_mark_read`) or sender. Returns `{ inbox, items, next_cursor? }`. Pass `order_by: "original_sent_at"` to sort forwards by their original send date (cursor disabled in that mode).',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        filter: {
          type: 'object',
          description:
            'InboxFilter object — e.g. `{ labels: ["unread"] }`, `{ labels: ["newsletter", "unread"] }`, `{ senders: ["alice@example.com"], since: "2026-04-01" }`. See `src/messaging/filter-spec.ts` for the full shape.',
        },
        cursor: { type: 'string', description: 'Opaque cursor from a prior page. Sent as a query-string param.' },
        limit: { type: 'number', description: 'Max items per page. Sent as a query-string param.' },
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default: `newest`.' },
        order_by: {
          type: 'string',
          enum: ['received_at', 'sent_at', 'original_sent_at'],
          description: 'Sort key. Default `received_at`. Use `original_sent_at` for chronological reading lists.',
        },
      },
      required: ['inbox', 'filter'],
    },
  },
  {
    name: 'sm_inbox_export',
    description:
      'Bulk-export inbox items as a single JSON response with optional filter, `include=body` inflation, and a row cap. Uses `format=json` (not JSONL) because MCP tool returns are not streamable — for large exports hit `GET /inbox/:name/export?format=jsonl` directly against the HTTP server instead. Always pair with a `filter` or `limit` on big inboxes.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        filter: {
          type: 'object',
          description: 'Optional InboxFilter — URL-encoded to the server as JSON. Same shape as `sm_inbox_query.filter`.',
        },
        include: {
          type: 'string',
          description:
            'Comma-separated inflate flags. Currently only `body` is honored — passing it inflates message bodies from blob storage.',
        },
        limit: { type: 'number', description: 'Hard cap on exported items.' },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_tag',
    description:
      'Add and/or remove labels on a single item — the one-off escape hatch. Use this to upgrade a `manual` forward to `bookmark` after the fact, strip an overzealous `archived` label, or tag with a custom taxonomy. At least one of `add`/`remove` must be non-empty. For pattern-based labeling across many items prefer `sm_inbox_rules_create` with `action: "tag"`.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to mutate.' },
        add: { type: 'array', items: { type: 'string' }, description: 'Labels to add. No-op on duplicates.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Labels to remove. No-op on absent labels.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_delete',
    description:
      'Hard-delete an inbox item. Removes the item record, updates the inbox index, and best-effort deletes blob refs (raw, body, attachments). For *soft* removal that keeps the item queryable via `{ labels: ["archived"] }`, use `sm_inbox_tag` with `add: ["archived"]` or a rules-engine archive action instead.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to delete.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_unsubscribe',
    description:
      'Run the unsubscribe flow for a sender — looks up List-Unsubscribe headers via the inbox sender index and actions them. Returns 501 if the inbox has no sender index wired. Pass `skip_call: true` to log what would happen without firing the HTTP unsubscribe call.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        address: { type: 'string', description: 'Sender address (email) to unsubscribe.' },
        skip_call: { type: 'boolean', description: 'Dry-run — skip the outbound unsubscribe HTTP call. Default: false.' },
        timeout_ms: { type: 'number', description: 'Timeout for the outbound unsubscribe call (ms).' },
      },
      required: ['inbox', 'address'],
    },
  },
  {
    name: 'sm_inbox_quarantine_list',
    description:
      'List items carrying the quarantine label (default: `quarantined`). Thin wrapper over `sm_inbox_query({ labels: ["quarantined"] })` with cursor/limit. Use `label` to scope to a custom quarantine bucket (e.g. `spam`, `phishing`).',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        cursor: { type: 'string', description: 'Opaque cursor from a prior page.' },
        limit: { type: 'number', description: 'Max items per page.' },
        label: { type: 'string', description: 'Custom quarantine label. Default: `quarantined`.' },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_restore',
    description:
      'Restore a quarantined item — strips the quarantine label while preserving every other label (classifier output, reason tags like `spam`, etc). The item stays in storage; this just pulls it out of the quarantine view. 404 if the id is missing OR if the item was never quarantined.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to restore.' },
        label: { type: 'string', description: 'Custom quarantine label to strip. Default: `quarantined`.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_confirm',
    description:
      'Click a double-opt-in subscription confirmation link for an inbox item. Only works on items already tagged `needs-confirm` (set by the confirm-detect hook at ingest time) with a `fields.confirm_url` present — this prevents the tool from being used as an arbitrary URL fetcher. On success: removes `needs-confirm`, adds `confirmed`, writes `fields.confirmed_at`. On upstream failure: labels unchanged so you can retry. Use `dry_run: true` to see the URL without clicking. To list pending confirmations first, call `sm_inbox_query` with `{ labels: ["needs-confirm"] }`.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id carrying the `needs-confirm` label.' },
        dry_run: { type: 'boolean', description: 'Return the URL without following it. Default: false.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_mark_read',
    description:
      'Mark a single item read — removes the `unread` label. Idempotent: returns `{ changed: false }` when the item was already read. Every newly-ingested item carries `unread` until a reader explicitly clears it. Pair with `sm_inbox_query({ labels: ["unread"] })` to find candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to mark read.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_mark_unread',
    description:
      'Re-add the `unread` label to an item — the undo for `sm_inbox_mark_read`. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to mark unread.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_mark_read_many',
    description:
      'Bulk mark-read. Pass `ids: string[]` for an explicit list, OR `filter: InboxFilter` to mark-read everything matching (server intersects with `labels:["unread"]` so already-read items are skipped; empty filter `{}` marks-read every unread item). Exactly one of `ids` / `filter` must be provided. With `ids`, returns `{ total, changed, missing }`. With `filter`, returns `{ matched, changed, capped }` — `capped: true` means the 10k safety cap was hit; page via `sm_inbox_query` + explicit ids for larger batches.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit item ids to mark read. Mutually exclusive with `filter`.',
        },
        filter: {
          type: 'object',
          description:
            'InboxFilter to mark-read in bulk — e.g. `{ labels: ["sender:jessica"] }` marks every Jessica item read. Mutually exclusive with `ids`.',
        },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_rules_list',
    description:
      'List mailroom rules for an inbox with cursor/limit pagination. Returns `{ inbox, rules, next_cursor? }`. Returns 501 if no rules store is wired for this inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        cursor: { type: 'string', description: 'Opaque cursor from a prior page.' },
        limit: { type: 'number', description: 'Max rules per page.' },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_rules_get',
    description: 'Read a single mailroom rule by id. 404 if the rule id is unknown for this inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Rule id.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_rules_create',
    description:
      'Create a mailroom rule: a `match` filter + an `action` applied to every future item that matches. Set `apply_retroactive: true` to also run the rule against every already-stored item immediately — note retroactive apply only supports tag-style actions (`tag`, `archive`, `bookmark`); `drop`/`quarantine` are forward-only. Use this for pattern-based labeling across many items; for one-offs use `sm_inbox_tag`.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        match: {
          type: 'object',
          description: 'Match predicate — an InboxFilter-shaped object (senders, subject patterns, labels, headers).',
        },
        action: {
          type: 'string',
          enum: ['archive', 'bookmark', 'tag', 'drop', 'quarantine'],
          description:
            'What to do on match. `archive`/`bookmark`/`tag` add a label; `drop` prevents ingest; `quarantine` labels + routes to the quarantine view.',
        },
        action_args: {
          type: 'object',
          description: 'Action-specific args. For `action: "tag"`, pass `{ tag: "<label>" }`.',
          properties: {
            tag: { type: 'string' },
          },
        },
        priority: { type: 'number', description: 'Rule priority — higher runs first. Default: 0.' },
        notes: { type: 'string', description: 'Free-form note — shown in rule listings.' },
        disabled: { type: 'boolean', description: 'Create the rule in disabled state. Default: false.' },
        apply_retroactive: {
          type: 'boolean',
          description:
            'Also run the rule against already-stored items. Only tag-style actions (tag/archive/bookmark) actually mutate retroactively.',
        },
      },
      required: ['inbox', 'match', 'action'],
    },
  },
  {
    name: 'sm_inbox_rules_update',
    description:
      'Patch a mailroom rule in place. `patch` is a partial `MailroomRule` — any fields present overwrite, missing fields are untouched. `id` and `created_at` in the patch are ignored. 404 if the rule id is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Rule id to patch.' },
        patch: {
          type: 'object',
          description: 'Partial MailroomRule — e.g. `{ disabled: true }` or `{ priority: 10, notes: "..." }`.',
        },
      },
      required: ['inbox', 'id', 'patch'],
    },
  },
  {
    name: 'sm_inbox_rules_delete',
    description: 'Permanently delete a mailroom rule. Does NOT un-apply prior matches — items already labeled by this rule keep their labels. 404 if the rule id is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Rule id to delete.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_rules_apply_retroactive',
    description:
      'Re-run an existing rule against every already-stored item in the inbox. Only tag-style actions (`tag`, `archive`, `bookmark`) actually mutate; `drop`/`quarantine` are forward-only and will no-op. Returns `{ inbox, rule_id, matched, mutated }`.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Rule id to re-apply.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_attachments_list',
    description:
      "List attachments on a single item. Returns `{ inbox, item_id, attachments: [{ id, filename, content_type, size, content_id?, download_url }] }`. Use the `download_url` (relative path, hit with the same bearer token) to fetch the actual bytes — there's no MCP-side download tool because returning binary content through MCP isn't useful; always download via curl / browser / your tool of choice.",
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_auto_confirm_list',
    description:
      'List the Worker-global auto-confirm sender allowlist (patterns the auto-confirm hook will GET the double-opt-in URL for). Returns `{ senders: [{ pattern, source, created_at, notes? }] }`. `source: "env"` rows are seeded from the `AUTO_CONFIRM_SENDERS` env var on first boot; `source: "runtime"` rows were added via this tool / API.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sm_auto_confirm_add',
    description:
      'Add a sender glob pattern to the Worker-global auto-confirm allowlist (e.g. `*@beehiiv.com`). Idempotent — re-adding the same pattern returns the existing row unchanged. Effect propagates to the running hook within ~30s (the hook caches the allowlist briefly to avoid hammering D1).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'Sender-address glob — `*` is the only wildcard. Lowercased + trimmed before storage. E.g. `*@beehiiv.com`, `*@every.to`.',
        },
        notes: {
          type: 'string',
          description: 'Free-form note ("added because Beehiiv started signing from this domain").',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'sm_auto_confirm_remove',
    description:
      "Remove a pattern from the Worker-global auto-confirm allowlist. 404 if the pattern isn't present. Removing an env-seeded pattern sticks across cold starts (the seed step won't re-add patterns the user explicitly removed).",
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Exact pattern to remove (use `sm_auto_confirm_list` if unsure of casing).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'sm_newsletters_list',
    description:
      'List every newsletter slug present in an inbox (derived from `fields.newsletter_slug` populated by forward-detect). Returns `{ inbox, newsletters: [{ slug, count, latest_at, display }] }`, sorted latest-first by the most recent issue\'s `original_sent_at`. Useful as a directory of "newsletters I have annotations on."',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name. Usually `mailroom`.' },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_newsletter_get',
    description:
      'Get a newsletter profile dashboard — count, first/last seen, notes count, last note + subject. The slug-level identity card. Use after `sm_newsletters_list` to drill in.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        slug: { type: 'string', description: 'Newsletter slug (from `sm_newsletters_list`).' },
      },
      required: ['inbox', 'slug'],
    },
  },
  {
    name: 'sm_newsletter_items',
    description:
      'Chronological reading list for a newsletter — every item with this `newsletter_slug`, sorted by `original_sent_at` (oldest-first by default; pass `order: "newest"` for newest-first). Items missing `original_sent_at` tail. Use this to read a newsletter back through its history without forwards-out-of-order noise.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        slug: { type: 'string', description: 'Newsletter slug.' },
        limit: { type: 'number', description: 'Max items returned. Server-enforced cap.' },
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default `oldest` (chronological reading order).' },
      },
      required: ['inbox', 'slug'],
    },
  },
  {
    name: 'sm_newsletter_notes',
    description:
      'Just the items where you wrote a `forward_note` — your accumulating commentary on a newsletter. Returns a slim `{ id, original_sent_at, received_at, subject, from, note }` projection per item. Cheap to feed into an LLM ("synthesize what I\'ve thought about Internet Pipes over time"). Chronological by default.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        slug: { type: 'string', description: 'Newsletter slug.' },
        limit: { type: 'number', description: 'Max items returned.' },
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default `oldest`.' },
      },
      required: ['inbox', 'slug'],
    },
  },
];

// ============================================================================
// Handlers
// ============================================================================

/** URL-encode a user-supplied `:name` path segment after validating shape. */
function encName(inbox: string): string {
  validateName(inbox, 'inbox');
  return encodeURIComponent(inbox);
}

/** URL-encode a user-supplied `:id` path segment. */
function encId(id: string): string {
  return encodeURIComponent(id);
}

/** Build a query string from a set of optional primitives; returns '' or '?a=b&c=d'. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0);
}

export async function handleInboxTool(
  name: string,
  args: Args,
  http: HttpFn,
): Promise<unknown> {
  switch (name) {
    case 'sm_inbox_list': {
      const inbox = requireString(args, 'inbox');
      const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const orderRaw = args.order;
      let order: 'newest' | 'oldest' | undefined;
      if (orderRaw !== undefined) {
        if (orderRaw !== 'newest' && orderRaw !== 'oldest') {
          throw new Error('sm_inbox_list: `order` must be "newest" or "oldest"');
        }
        order = orderRaw;
      }
      const order_by = parseOrderByArg(args.order_by, 'sm_inbox_list');
      const r = await http('GET', `/inbox/${encName(inbox)}${qs({ cursor, limit, order, order_by })}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_list failed', r));
      return r.body;
    }

    case 'sm_inbox_read': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const full = args.full === true ? true : undefined;
      const r = await http('GET', `/inbox/${encName(inbox)}/items/${encId(id)}${qs({ full })}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_read failed', r));
      return r.body;
    }

    case 'sm_inbox_query': {
      const inbox = requireString(args, 'inbox');
      const filter = args.filter;
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new Error('sm_inbox_query: `filter` must be an InboxFilter object');
      }
      const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const orderRaw = args.order;
      let order: 'newest' | 'oldest' | undefined;
      if (orderRaw !== undefined) {
        if (orderRaw !== 'newest' && orderRaw !== 'oldest') {
          throw new Error('sm_inbox_query: `order` must be "newest" or "oldest"');
        }
        order = orderRaw;
      }
      const order_by = parseOrderByArg(args.order_by, 'sm_inbox_query');
      const path = `/inbox/${encName(inbox)}/query${qs({ cursor, limit, order, order_by })}`;
      const r = await http('POST', path, filter);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_query failed', r));
      return r.body;
    }

    case 'sm_inbox_export': {
      const inbox = requireString(args, 'inbox');
      const sp = new URLSearchParams();
      // Force format=json — MCP tool returns are not streamable, so JSONL
      // would be mangled. Large exports should hit the HTTP endpoint directly.
      sp.set('format', 'json');
      if (args.filter !== undefined) {
        if (typeof args.filter !== 'object' || args.filter === null || Array.isArray(args.filter)) {
          throw new Error('sm_inbox_export: `filter` must be an object');
        }
        sp.set('filter', JSON.stringify(args.filter));
      }
      if (typeof args.include === 'string' && args.include.length > 0) {
        sp.set('include', args.include);
      }
      if (typeof args.limit === 'number') {
        sp.set('limit', String(args.limit));
      }
      const r = await http('GET', `/inbox/${encName(inbox)}/export?${sp.toString()}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_export failed', r));
      return r.body;
    }

    case 'sm_inbox_tag': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const add = args.add;
      const remove = args.remove;
      const addOk = add === undefined || isNonEmptyStringArray(add);
      const removeOk = remove === undefined || isNonEmptyStringArray(remove);
      if (!addOk) throw new Error('sm_inbox_tag: `add` must be a non-empty array of non-empty strings');
      if (!removeOk) throw new Error('sm_inbox_tag: `remove` must be a non-empty array of non-empty strings');
      if (!isNonEmptyStringArray(add) && !isNonEmptyStringArray(remove)) {
        throw new Error('sm_inbox_tag: at least one of `add` or `remove` must be a non-empty string array');
      }
      const body: { add?: string[]; remove?: string[] } = {};
      if (isNonEmptyStringArray(add)) body.add = add;
      if (isNonEmptyStringArray(remove)) body.remove = remove;
      const r = await http('POST', `/inbox/${encName(inbox)}/items/${encId(id)}/tag`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_tag failed', r));
      return r.body;
    }

    case 'sm_inbox_delete': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('DELETE', `/inbox/${encName(inbox)}/items/${encId(id)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_delete failed', r));
      return r.body;
    }

    case 'sm_inbox_unsubscribe': {
      const inbox = requireString(args, 'inbox');
      const address = requireString(args, 'address');
      const body: { address: string; skipCall?: boolean; timeoutMs?: number } = { address };
      if (args.skip_call === true) body.skipCall = true;
      if (typeof args.timeout_ms === 'number') body.timeoutMs = args.timeout_ms;
      const r = await http('POST', `/inbox/${encName(inbox)}/unsubscribe`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_unsubscribe failed', r));
      return r.body;
    }

    case 'sm_inbox_quarantine_list': {
      const inbox = requireString(args, 'inbox');
      const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const label = typeof args.label === 'string' ? args.label : undefined;
      const r = await http('GET', `/inbox/${encName(inbox)}/quarantine${qs({ cursor, limit, label })}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_quarantine_list failed', r));
      return r.body;
    }

    case 'sm_inbox_restore': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const label = typeof args.label === 'string' ? args.label : undefined;
      const r = await http('POST', `/inbox/${encName(inbox)}/restore/${encId(id)}${qs({ label })}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_restore failed', r));
      return r.body;
    }

    case 'sm_inbox_confirm': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const dryRun = args.dry_run === true ? 'true' : undefined;
      const r = await http('POST', `/inbox/${encName(inbox)}/confirm/${encId(id)}${qs({ 'dry-run': dryRun })}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_confirm failed', r));
      return r.body;
    }

    case 'sm_inbox_mark_read': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('POST', `/inbox/${encName(inbox)}/items/${encId(id)}/read`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_mark_read failed', r));
      return r.body;
    }

    case 'sm_inbox_mark_unread': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('POST', `/inbox/${encName(inbox)}/items/${encId(id)}/unread`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_mark_unread failed', r));
      return r.body;
    }

    case 'sm_inbox_mark_read_many': {
      const inbox = requireString(args, 'inbox');
      const ids = args.ids;
      const filter = args.filter;
      const hasIds = ids !== undefined;
      const hasFilter = filter !== undefined;
      if (hasIds === hasFilter) {
        throw new Error('sm_inbox_mark_read_many: pass exactly one of `ids` or `filter`');
      }
      if (hasIds) {
        if (!isNonEmptyStringArray(ids)) {
          throw new Error('sm_inbox_mark_read_many: `ids` must be a non-empty array of non-empty strings');
        }
        const r = await http('POST', `/inbox/${encName(inbox)}/read`, { ids });
        if (!r.ok) throw new Error(formatHttpError('sm_inbox_mark_read_many failed', r));
        return r.body;
      }
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
        throw new Error('sm_inbox_mark_read_many: `filter` must be an InboxFilter object');
      }
      const r = await http('POST', `/inbox/${encName(inbox)}/read-all`, filter);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_mark_read_many failed', r));
      return r.body;
    }

    case 'sm_inbox_rules_list': {
      const inbox = requireString(args, 'inbox');
      const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const r = await http('GET', `/inbox/${encName(inbox)}/rules${qs({ cursor, limit })}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_rules_list failed', r));
      return r.body;
    }

    case 'sm_inbox_rules_get': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('GET', `/inbox/${encName(inbox)}/rules/${encId(id)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_rules_get failed', r));
      return r.body;
    }

    case 'sm_inbox_rules_create': {
      const inbox = requireString(args, 'inbox');
      const match = args.match;
      if (!match || typeof match !== 'object' || Array.isArray(match)) {
        throw new Error('sm_inbox_rules_create: `match` must be an object');
      }
      const action = args.action;
      const validActions = ['archive', 'bookmark', 'tag', 'drop', 'quarantine'];
      if (typeof action !== 'string' || !validActions.includes(action)) {
        throw new Error(`sm_inbox_rules_create: \`action\` must be one of ${validActions.join(', ')}`);
      }
      const body: Record<string, unknown> = { match, action };
      if (args.action_args !== undefined) {
        if (typeof args.action_args !== 'object' || args.action_args === null || Array.isArray(args.action_args)) {
          throw new Error('sm_inbox_rules_create: `action_args` must be an object');
        }
        body.action_args = args.action_args;
      }
      if (typeof args.priority === 'number') body.priority = args.priority;
      if (typeof args.notes === 'string') body.notes = args.notes;
      if (typeof args.disabled === 'boolean') body.disabled = args.disabled;

      const applyRetro = args.apply_retroactive === true;
      const path = `/inbox/${encName(inbox)}/rules${applyRetro ? '?apply_retroactive=true' : ''}`;
      const r = await http('POST', path, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_rules_create failed', r));
      return r.body;
    }

    case 'sm_inbox_rules_update': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const patch = args.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('sm_inbox_rules_update: `patch` must be an object');
      }
      const r = await http('PUT', `/inbox/${encName(inbox)}/rules/${encId(id)}`, patch);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_rules_update failed', r));
      return r.body;
    }

    case 'sm_inbox_rules_delete': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('DELETE', `/inbox/${encName(inbox)}/rules/${encId(id)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_rules_delete failed', r));
      return r.body;
    }

    case 'sm_inbox_rules_apply_retroactive': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('POST', `/inbox/${encName(inbox)}/rules/${encId(id)}/apply-retroactive`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_rules_apply_retroactive failed', r));
      return r.body;
    }

    case 'sm_inbox_attachments_list': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const r = await http('GET', `/inbox/${encName(inbox)}/items/${encId(id)}/attachments`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_attachments_list failed', r));
      return r.body;
    }

    case 'sm_auto_confirm_list': {
      const r = await http('GET', `/admin/auto-confirm/senders`);
      if (!r.ok) throw new Error(formatHttpError('sm_auto_confirm_list failed', r));
      return r.body;
    }

    case 'sm_auto_confirm_add': {
      const pattern = requireString(args, 'pattern');
      const body: Record<string, unknown> = { pattern };
      if (typeof args.notes === 'string') body.notes = args.notes;
      const r = await http('POST', `/admin/auto-confirm/senders`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_auto_confirm_add failed', r));
      return r.body;
    }

    case 'sm_auto_confirm_remove': {
      const pattern = requireString(args, 'pattern');
      const r = await http('DELETE', `/admin/auto-confirm/senders/${encodeURIComponent(pattern)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_auto_confirm_remove failed', r));
      return r.body;
    }

    case 'sm_newsletters_list': {
      const inbox = requireString(args, 'inbox');
      const r = await http('GET', `/inbox/${encName(inbox)}/newsletters`);
      if (!r.ok) throw new Error(formatHttpError('sm_newsletters_list failed', r));
      return r.body;
    }

    case 'sm_newsletter_get': {
      const inbox = requireString(args, 'inbox');
      const slug = requireString(args, 'slug');
      const r = await http('GET', `/inbox/${encName(inbox)}/newsletters/${encodeURIComponent(slug)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_newsletter_get failed', r));
      return r.body;
    }

    case 'sm_newsletter_items': {
      const inbox = requireString(args, 'inbox');
      const slug = requireString(args, 'slug');
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const order = parseOrderArg(args.order, 'sm_newsletter_items');
      const r = await http(
        'GET',
        `/inbox/${encName(inbox)}/newsletters/${encodeURIComponent(slug)}/items${qs({ limit, order })}`,
      );
      if (!r.ok) throw new Error(formatHttpError('sm_newsletter_items failed', r));
      return r.body;
    }

    case 'sm_newsletter_notes': {
      const inbox = requireString(args, 'inbox');
      const slug = requireString(args, 'slug');
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const order = parseOrderArg(args.order, 'sm_newsletter_notes');
      const r = await http(
        'GET',
        `/inbox/${encName(inbox)}/newsletters/${encodeURIComponent(slug)}/notes${qs({ limit, order })}`,
      );
      if (!r.ok) throw new Error(formatHttpError('sm_newsletter_notes failed', r));
      return r.body;
    }

    default:
      throw new Error(`handleInboxTool: unknown tool "${name}"`);
  }
}

const ORDER_BY_VALUES = new Set(['received_at', 'sent_at', 'original_sent_at']);
function parseOrderByArg(raw: unknown, toolName: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !ORDER_BY_VALUES.has(raw)) {
    throw new Error(`${toolName}: \`order_by\` must be one of received_at | sent_at | original_sent_at`);
  }
  return raw;
}

function parseOrderArg(raw: unknown, toolName: string): 'newest' | 'oldest' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'newest' && raw !== 'oldest') {
    throw new Error(`${toolName}: \`order\` must be "newest" or "oldest"`);
  }
  return raw;
}
