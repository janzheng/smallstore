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
      'List items in an inbox, newest-first by default, with cursor-based pagination. Returns `{ inbox, items, next_cursor? }`. Use this for a quick look at the top of a mailroom; for anything filter-shaped (by sender, labels, time range) prefer `sm_inbox_query`.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name (see /admin/inboxes).' },
        cursor: { type: 'string', description: 'Opaque cursor returned by a prior `sm_inbox_list` call. Omit for the first page.' },
        limit: { type: 'number', description: 'Max items per page. Server-enforced upper bound.' },
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default: `newest`.' },
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
      'Filter an inbox with an `InboxFilter` object (labels, senders, time windows, etc). Use this instead of `sm_inbox_list` when you need to scope by label (e.g. `{ labels: ["unread"] }`) or sender. Returns `{ inbox, items, next_cursor? }`.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        filter: {
          type: 'object',
          description:
            'InboxFilter object — e.g. `{ labels: ["unread"], senders: ["alice@example.com"], since: "2025-01-01" }`. See `src/messaging/filter-spec.ts` for the full shape.',
        },
        cursor: { type: 'string', description: 'Opaque cursor from a prior page. Sent as a query-string param.' },
        limit: { type: 'number', description: 'Max items per page. Sent as a query-string param.' },
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
      const r = await http('GET', `/inbox/${encName(inbox)}${qs({ cursor, limit, order })}`);
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
      const path = `/inbox/${encName(inbox)}/query${qs({ cursor, limit })}`;
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

    default:
      throw new Error(`handleInboxTool: unknown tool "${name}"`);
  }
}
