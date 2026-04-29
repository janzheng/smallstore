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
    name: 'sm_inbox_set_note',
    description:
      "Set, append to, or surgically edit `fields.forward_note` on an already-stored item — the after-the-fact annotation flow. Mode `replace` (default) overwrites with `note`; `append` joins to existing via a markdown thematic break; `edit` does a line-level rewrite (find one line by exact trimmed match, replace with `replace`, leave the rest of the note untouched). The `edit` mode is the right tool for marking a single todo line `[x]` done — pass the matched_line from sm_inbox_todos as `find`, and `'- [x] ' + line` as `replace`. The /todos skip rule for `[x]` lines means the todo self-cleans on the next call. Stamps `fields.note_updated_at` every call; identity, labels, body all preserved.",
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to annotate.' },
        mode: {
          type: 'string',
          enum: ['replace', 'append', 'edit'],
          description: '`replace` (default) overwrites; `append` joins via thematic break; `edit` does line-level find/replace.',
        },
        note: {
          type: 'string',
          description: 'Required for `replace` and `append` modes. Use empty string in `replace` to clear.',
        },
        find: {
          type: 'string',
          description: 'Required for `edit` mode. Exact trimmed line content to find in the existing note.',
        },
        replace: {
          type: 'string',
          description: 'Required for `edit` mode. New line content (empty string deletes the line entirely).',
        },
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
    name: 'sm_inbox_mark_spam',
    description:
      'Mark an item as spam. Adds the `spam` label, updates the attributed sender\'s spam_count, and writes marked_at. Idempotent — calling twice on the same item returns `{ already_spam: true }` without double-counting. Attribution per `.brief/spam-layers.md` § decision #2: if the item is forwarded AND the forwarder is `trusted`, the forwarder gets the bump (their curation choice ≠ original sender\'s fault); else the original sender; else the item\'s from_email. Response includes a sender summary `{ count, spam_count, not_spam_count, spam_rate, trusted }` plus `consider_demote: true` when a trusted sender accumulates ≥5 user-marks AND spam_rate > 0.5 — operator should revisit the trust call.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to mark spam.' },
        reason: { type: 'string', description: 'Optional human reason for the mark — recorded in the operator log only, not surfaced.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_mark_not_spam',
    description:
      'Mark an item as NOT spam — the inverse of `sm_inbox_mark_spam` and the recovery path for false positives. Removes both `spam` and `quarantined` labels, bumps the attributed sender\'s not_spam_count, writes marked_at. Idempotent — `{ already_not_spam: true }` when item carries neither label. **Auto-confirm revocation (decision #3):** if the item carries `auto-confirmed`, finds the matching pattern in `auto-confirm-senders` and revokes it; response includes `revoked_auto_confirm: { pattern, source }` for the undo path (`sm_auto_confirm_add(pattern, { source: "runtime" })` to restore). The same attribution rules as mark-spam apply.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        id: { type: 'string', description: 'Item id to mark not-spam.' },
        reason: { type: 'string', description: 'Optional human reason for the mark.' },
      },
      required: ['inbox', 'id'],
    },
  },
  {
    name: 'sm_inbox_spam_stats',
    description:
      'Spam triage rankings derived from the sender index. Returns four lists for an inbox: `senders_top_spam` (highest absolute spam_count), `senders_recently_marked` (any sender marked spam OR not-spam within window_days), `suggested_blocklist` (count >= 5 AND spam_rate >= 0.7, trusted excluded — feed these into `sm_inbox_promote_spam_rule(kind: "blocklist")`), and `suggested_whitelist` (>= 3 explicit marks AND not_spam > spam, trusted excluded). Each row includes spam_rate, marked_at, and tags. Use this after a few rounds of mark-spam/mark-not-spam to find what to promote into a rule. Optional `window_days` (default 30) and `limit` (default 50, max 500).',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        window_days: { type: 'integer', description: 'Recency window for senders_recently_marked. Default 30.', minimum: 1 },
        limit: { type: 'integer', description: 'Max items per ranked list. Default 50, max 500.', minimum: 1 },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_promote_spam_rule',
    description:
      'Promote a sender to a permanent rule based on spam-stats decisions. `kind: "blocklist"` creates a priority-100 quarantine rule for `from_email: <sender>` (future mail from that sender lands quarantined; quarantine is terminal so retroactive apply is a no-op — manually quarantine existing items if needed). `kind: "whitelist"` creates a priority-0 tag rule that stamps `trusted` on every match — runs `applyRetroactive` so existing items pick up the tag immediately, and from then on the trusted-bypass short-circuits every spam layer for that sender. Sender is normalized to lowercase before storage. Returns the created rule + items_affected (whitelist) or 0 (blocklist).',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        sender: { type: 'string', description: 'Sender email address (lowercased on insert).' },
        kind: { type: 'string', enum: ['blocklist', 'whitelist'], description: 'Rule shape to create.' },
      },
      required: ['inbox', 'sender', 'kind'],
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
  {
    name: 'sm_inbox_todos',
    description:
      'Derived todo view — scans every item with a `forward_note` for action-shaped lines via a small regex set (markdown unchecked checkboxes, `TODO:` / `Action:` prefixes, "remind/remember", "sub me to", "follow up"). Pure read-side, no schema change. Use when the user says "what do I need to do", "show my todos", "action items from my notes", or wants to triage things they wrote in forwarded newsletters. Each todo includes `matched_pattern` (which rule fired) and `full_note` (entire note for context). Multiple matching lines per note → multiple todos. Skips quoted-reply lines and checked checkboxes.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        slug: { type: 'string', description: 'Optional — scope to one newsletter slug.' },
        since: { type: 'string', description: 'Optional ISO timestamp — only items received after this.' },
        limit: { type: 'number', description: 'Max todos returned. Default 100, max 500.' },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_notes',
    description:
      'Cross-newsletter notes view — every item with a non-empty `forward_note`, regardless of slug. Returns a slim `{id, newsletter_slug, newsletter_display, original_sent_at, received_at, subject, from, note}` projection. Use when the user says "show all my notes", "search my notes for X", "what have I written about", "aggregate my notes", or wants to see / search annotations across every newsletter at once. `text` filter does case-insensitive substring match on the note text only (NOT body — that path uses `sm_inbox_query` with `text=`). For per-publisher reading-list semantics use `sm_newsletter_notes` instead — that defaults to chronological-by-original-send-date; this defaults to newest-by-received-date.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        text: { type: 'string', description: 'Optional substring filter on `forward_note` (case-insensitive).' },
        slug: { type: 'string', description: 'Optional — scope to one newsletter slug. Equivalent to sm_newsletter_notes.' },
        since: { type: 'string', description: 'Optional ISO timestamp — only items received after this.' },
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default `newest` by received_at.' },
        limit: { type: 'number', description: 'Max notes returned. Default 100, max 500.' },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_mirror',
    description:
      "Trigger the cron-driven markdown mirror on demand. Same engine the scheduled() cron runs every 30 minutes; use this when the user wants the mirror to flush right now (e.g. just after annotating a note and wanting it reflected in tigerflare immediately). Pushes per-newsletter markdown to every peer registered with `metadata.mirror_config`, optionally scoped to one peer. Per-peer skip reasons (auth missing, inbox not registered) and per-slug failures are reported in the response without throwing. Pure outbound write — does NOT mutate inbox state. Use when the user says \"flush the mirror\", \"sync to tigerflare now\", \"push notes to obsidian\", \"refresh the mirror\", \"update the markdown export\".",
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name (e.g. "mailroom").' },
        peer: {
          type: 'string',
          description: 'Optional — restrict to one peer name. Default: all peers with mirror_config.',
        },
      },
      required: ['inbox'],
    },
  },
  {
    name: 'sm_inbox_replay_hook',
    description:
      'Retroactively re-run a registered hook (e.g. `forward-detect`) over existing items in an inbox, merging any new fields and labels into stored items. The system version of "running a backfill script" — generic over any hook the deploy registers. ALWAYS dry-run first (`dry_run: true`) to preview the field/label diffs before applying. Common use: a forward-detect upgrade adds new fields (e.g. `original_sent_at`) — replay populates them on items that landed before the upgrade. Identity (id, received_at, source) and the index are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Registered inbox name.' },
        hook: {
          type: 'string',
          description: 'Hook name as registered by the deploy (e.g. `forward-detect`, `sender-aliases`, `newsletter-name`). The deploy decides which hooks are replayable.',
        },
        filter: {
          type: 'object',
          description: 'Optional InboxFilter to scope the replay (e.g. `{ labels: ["forwarded"] }`, `{ fields_regex: { subject: "IP Digest|Pipes " } }`). Omit to replay over all items.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, no writes — returns up to 10 representative diffs in `samples`. Strongly recommended for the first call.',
        },
        limit: {
          type: 'number',
          description: 'Cap on items processed. Default 10000.',
        },
      },
      required: ['inbox', 'hook'],
    },
  },
  // --------------------------------------------------------------------------
  // Admin (runtime inbox lifecycle — wraps /admin/inboxes)
  // --------------------------------------------------------------------------
  {
    name: 'sm_inbox_create',
    description:
      'Spin up a new runtime inbox. Wraps `POST /admin/inboxes`. Pass `name` (the inbox slug — must be unique among registered inboxes) plus an `InboxConfig`-shaped payload (channel + storage, optionally channel_config / schedule / keyPrefix). Runtime inboxes auto-namespace their storage via `keyPrefix: "inbox/<name>/"` unless one is supplied, so multiple runtime inboxes can share a single D1 table without `_index` rows colliding. 409 if `name` already exists. The created inbox shows up in `sm_inbox_list_admin` immediately and is usable from the rest of the `sm_inbox_*` family.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Inbox slug. Must be unique. URL-safe.' },
        channel: {
          type: 'string',
          description: 'Channel name (must be registered server-side — e.g. `cf-email`, `rss`, `webhook`).',
        },
        storage: {
          description:
            'Storage adapter reference. Either a bare adapter name (string) for items-only, or `{ items: "<name>", blobs?: "<name>" }` to split body/attachments off to a blob adapter.',
        },
        channel_config: {
          type: 'object',
          description: 'Channel-specific config (HMAC secret env name, feed URL, etc). Shape depends on the channel.',
        },
        schedule: {
          type: 'string',
          description: 'Cron schedule for pull channels (e.g. `"*/5 * * * *"`). Ignored for push channels.',
        },
        keyPrefix: {
          type: 'string',
          description: 'Storage key prefix. Defaults to `inbox/<name>/` when omitted.',
        },
        ttl: {
          type: 'number',
          description: 'Optional TTL in seconds — runtime inbox is reaped after this many seconds idle.',
        },
      },
      required: ['name', 'channel', 'storage'],
    },
  },
  {
    name: 'sm_inbox_list_admin',
    description:
      'List ALL registered inboxes — boot-time + runtime — with their channel, storage, and origin. Wraps `GET /admin/inboxes`. Use this to see what inboxes exist on the server (per-item `sm_inbox_list` lists items inside ONE inbox; this lists the inboxes themselves). Returns `{ inboxes: [{ name, channel, origin: "boot"|"runtime", created_at, config }] }`.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'sm_inbox_delete_inbox',
    description:
      'Unregister an inbox from the server. Wraps `DELETE /admin/inboxes/:name`. Disambiguated from `sm_inbox_delete` (which removes a single item from inside an inbox). The unregister is in-memory only — the inbox storage rows under the registered keyPrefix remain in the underlying adapter so a re-registration can pick up where it left off (or a separate cleanup task can reap them). 404 if the inbox name is not registered.',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: { type: 'string', description: 'Inbox name to unregister.' },
      },
      required: ['inbox'],
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

    case 'sm_inbox_set_note': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const mode = args.mode ?? 'replace';
      if (mode !== 'replace' && mode !== 'append' && mode !== 'edit') {
        throw new Error('sm_inbox_set_note: `mode` must be "replace", "append", or "edit"');
      }
      let body: Record<string, unknown>;
      if (mode === 'edit') {
        if (typeof args.find !== 'string' || args.find.length === 0) {
          throw new Error('sm_inbox_set_note: edit mode requires non-empty `find` (string)');
        }
        if (typeof args.replace !== 'string') {
          throw new Error(
            'sm_inbox_set_note: edit mode requires `replace` (string; "" to delete the line)',
          );
        }
        body = { mode: 'edit', find: args.find, replace: args.replace };
      } else {
        if (typeof args.note !== 'string') {
          throw new Error(
            `sm_inbox_set_note: ${mode} mode requires \`note\` (string; "" to clear)`,
          );
        }
        body = { note: args.note, mode };
      }
      const r = await http('POST', `/inbox/${encName(inbox)}/items/${encId(id)}/note`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_set_note failed', r));
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

    case 'sm_inbox_mark_spam': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const body: Record<string, unknown> = {};
      if (typeof args.reason === 'string') body.reason = args.reason;
      const r = await http('POST', `/inbox/${encName(inbox)}/items/${encId(id)}/mark-spam`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_mark_spam failed', r));
      return r.body;
    }

    case 'sm_inbox_mark_not_spam': {
      const inbox = requireString(args, 'inbox');
      const id = requireString(args, 'id');
      const body: Record<string, unknown> = {};
      if (typeof args.reason === 'string') body.reason = args.reason;
      const r = await http('POST', `/inbox/${encName(inbox)}/items/${encId(id)}/mark-not-spam`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_mark_not_spam failed', r));
      return r.body;
    }

    case 'sm_inbox_spam_stats': {
      const inbox = requireString(args, 'inbox');
      const params = new URLSearchParams();
      if (typeof args.window_days === 'number' && args.window_days > 0) {
        params.set('window_days', String(Math.floor(args.window_days)));
      }
      if (typeof args.limit === 'number' && args.limit > 0) {
        params.set('limit', String(Math.floor(args.limit)));
      }
      const qs = params.toString();
      const path = `/inbox/${encName(inbox)}/spam-stats${qs ? `?${qs}` : ''}`;
      const r = await http('GET', path);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_spam_stats failed', r));
      return r.body;
    }

    case 'sm_inbox_promote_spam_rule': {
      const inbox = requireString(args, 'inbox');
      const sender = requireString(args, 'sender');
      const kindRaw = args.kind;
      if (kindRaw !== 'blocklist' && kindRaw !== 'whitelist') {
        throw new Error('sm_inbox_promote_spam_rule: kind must be "blocklist" or "whitelist"');
      }
      const r = await http(
        'POST',
        `/inbox/${encName(inbox)}/spam-stats/promote-rule`,
        { sender, kind: kindRaw },
      );
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_promote_spam_rule failed', r));
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

    case 'sm_inbox_todos': {
      const inbox = requireString(args, 'inbox');
      const slug = typeof args.slug === 'string' ? args.slug : undefined;
      const since = typeof args.since === 'string' ? args.since : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const r = await http(
        'GET',
        `/inbox/${encName(inbox)}/todos${qs({ slug, since, limit })}`,
      );
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_todos failed', r));
      return r.body;
    }

    case 'sm_inbox_notes': {
      const inbox = requireString(args, 'inbox');
      const text = typeof args.text === 'string' ? args.text : undefined;
      const slug = typeof args.slug === 'string' ? args.slug : undefined;
      const since = typeof args.since === 'string' ? args.since : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const order = parseOrderArg(args.order, 'sm_inbox_notes');
      const r = await http(
        'GET',
        `/inbox/${encName(inbox)}/notes${qs({ text, slug, since, limit, order })}`,
      );
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_notes failed', r));
      return r.body;
    }

    case 'sm_inbox_mirror': {
      const inbox = requireString(args, 'inbox');
      const peer = typeof args.peer === 'string' ? args.peer : undefined;
      const path = peer
        ? `/admin/inboxes/${encName(inbox)}/mirror/${encName(peer)}`
        : `/admin/inboxes/${encName(inbox)}/mirror`;
      const r = await http('POST', path, {});
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_mirror failed', r));
      return r.body;
    }

    case 'sm_inbox_replay_hook': {
      const inbox = requireString(args, 'inbox');
      const hook = requireString(args, 'hook');
      const body: Record<string, unknown> = { hook };
      if (args.filter !== undefined) {
        if (typeof args.filter !== 'object' || Array.isArray(args.filter)) {
          throw new Error('sm_inbox_replay_hook: `filter` must be an InboxFilter object');
        }
        body.filter = args.filter;
      }
      if (args.dry_run !== undefined) body.dry_run = args.dry_run === true;
      if (typeof args.limit === 'number') body.limit = args.limit;
      const r = await http('POST', `/admin/inboxes/${encName(inbox)}/replay`, body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_replay_hook failed', r));
      return r.body;
    }

    case 'sm_inbox_create': {
      const inboxName = requireString(args, 'name');
      // Validate the slug shape via validateName (same regex /admin/inboxes accepts).
      validateName(inboxName, 'name');
      const channel = requireString(args, 'channel');
      const storage = args.storage;
      if (storage === undefined || storage === null) {
        throw new Error('sm_inbox_create: `storage` (string or { items, blobs? }) required');
      }
      const body: Record<string, unknown> = { name: inboxName, channel, storage };
      if (args.channel_config !== undefined) body.channel_config = args.channel_config;
      if (typeof args.schedule === 'string') body.schedule = args.schedule;
      if (typeof args.keyPrefix === 'string') body.keyPrefix = args.keyPrefix;
      if (typeof args.ttl === 'number') body.ttl = args.ttl;
      const r = await http('POST', '/admin/inboxes', body);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_create failed', r));
      return r.body;
    }

    case 'sm_inbox_list_admin': {
      const r = await http('GET', '/admin/inboxes');
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_list_admin failed', r));
      return r.body;
    }

    case 'sm_inbox_delete_inbox': {
      const inbox = requireString(args, 'inbox');
      const r = await http('DELETE', `/admin/inboxes/${encName(inbox)}`);
      if (!r.ok) throw new Error(formatHttpError('sm_inbox_delete_inbox failed', r));
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
