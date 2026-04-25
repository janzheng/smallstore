/**
 * Messaging plugin family — types
 *
 * Three primitives:
 *
 * - **Channel**  — a pipe (no storage). Adapts an external source (CF Email,
 *   webhook, RSS, voice transcript) into a normalized `InboxItem`.
 * - **Inbox**    — a pool (composes Channel + StorageAdapter). Provides
 *   list/read/query/cursor over ingested items.
 * - **Outbox**   — sketched here for symmetry; impl deferred to v2.
 *
 * Channels and Inboxes do NOT replace StorageAdapter. They are higher-level
 * patterns that compose adapters. Storage lives in the adapter; semantics
 * live in the inbox; transport lives in the channel.
 *
 * See `.brief/messaging-plugins.md` and `TASKS-MESSAGING.md` for the design.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';

// ============================================================================
// InboxItem — the normalized message shape
// ============================================================================

/**
 * Inbox item — the canonical normalized message stored by an Inbox.
 *
 * Channels parse their raw input into this shape. Consumers only ever read
 * items in this shape; they should not have to know what channel produced
 * a given item.
 *
 * `id` is content-addressed (sha256 of message_id || canonicalized raw)
 * so the same message arriving twice through the same channel produces
 * the same id (idempotent ingest).
 */
export interface InboxItem {
  /** Content-addressed id (sha256 hex, truncated to 32 chars). Stable across re-deliveries. */
  id: string;

  /** Channel that produced this item (e.g. "cf-email", "webhook", "rss"). */
  source: string;

  /** Channel schema version (e.g. "email/v1"). Lets channels evolve their `fields` shape additively. */
  source_version?: string;

  /** ISO-8601 UTC. When the message was received by the channel (NOT when it was sent). */
  received_at: string;

  /** Optional ISO-8601 UTC. When the original message claims to have been sent. */
  sent_at?: string;

  /** Short human-readable line (subject for email, title for RSS, etc). */
  summary?: string;

  /** Inline body when small enough; otherwise null and `body_ref` points to storage. */
  body?: string | null;

  /** Reference to body in adapter storage when body too large to inline (e.g. "r2:html/<id>.html"). */
  body_ref?: string;

  /** Channel-specific structured fields (from_email, to_addrs, etc). Channels MUST namespace by source_version when shape changes. */
  fields: Record<string, any>;

  /** Free-form labels: 'spam', 'bounce', 'newsletter'. Used by filters. */
  labels?: string[];

  /** Conversation grouping key. Email: derived from References/In-Reply-To. RSS: feed url. */
  thread_id?: string;

  /** Reference to raw original message in adapter storage (e.g. "r2:raw/<id>.eml"). */
  raw_ref?: string;
}

/**
 * Full inbox item — InboxItem + attachments + (optionally) inflated body.
 *
 * Returned by `Inbox.read(id, { full: true })`. Attachments are NOT included
 * by default in `list` / `query` results — they require an extra read.
 */
export interface InboxItemFull extends InboxItem {
  /** Attachment metadata. Binaries themselves live in adapter storage. */
  attachments?: Attachment[];

  /** If body was stored by ref, this is the inflated content. */
  body_inflated?: string;
}

/**
 * Result of `Inbox.readAttachment(itemId, filename)`. The `content` field
 * is whatever the blobs adapter returns — typically `Uint8Array` for R2
 * and either `Uint8Array` or `string` for `MemoryAdapter` depending on
 * what was set. HTTP routes wrap this in a Response with the metadata's
 * `content_type`.
 */
export interface AttachmentReadResult {
  /** Attachment metadata as stored on `item.fields.attachments[]`. */
  attachment: Attachment;
  /** Raw bytes (or string) from the blobs adapter. */
  content: Uint8Array | string;
}

/**
 * Attachment metadata. Binary content lives in adapter storage at `ref`.
 */
export interface Attachment {
  /** Stable id within the parent item. Usually filename or "att-<n>". */
  id: string;

  /** Original filename. */
  filename: string;

  /** MIME type (e.g. "image/png", "application/pdf"). */
  content_type: string;

  /** Size in bytes. */
  size: number;

  /** Storage reference (e.g. "r2:attachments/<item_id>/<filename>"). */
  ref: string;

  /** Optional content-id for inline images. */
  content_id?: string;
}

// ============================================================================
// Channel — the pipe primitive
// ============================================================================

/**
 * Channel kind. Determines whether the runtime pulls (cron) or pushes (event).
 *
 * - **push**  — the channel is invoked by an external event (CF Email, webhook).
 * - **pull**  — the channel is polled on a schedule (RSS, API-poll).
 */
export type ChannelKind = 'push' | 'pull';

/**
 * Channel — adapts an external source into normalized `InboxItem`s.
 *
 * Channels are stateless and do NOT store anything. They translate. Storage
 * is the Inbox's job (via its adapter).
 *
 * If the channel needs to stash binaries (raw .eml, html body, attachments)
 * it returns them in `ParseResult.blobs`; the Inbox writes them through its
 * blobs adapter during `_ingest`. The InboxItem references them via
 * `raw_ref` / `body_ref` / `attachments[].ref` (whose values match the keys
 * of `blobs`).
 *
 * @typeParam TRaw    — the raw input shape this channel accepts (e.g. EmailInput).
 * @typeParam TConfig — channel-specific config (HMAC secret, feed url, etc).
 */
export interface Channel<TRaw = unknown, TConfig = unknown> {
  /** Logical name (matches config key, e.g. "cf-email", "webhook", "rss"). */
  readonly name: string;

  /** Push or pull. */
  readonly kind: ChannelKind;

  /** Source tag written into every InboxItem this channel produces (e.g. "email/v1"). */
  readonly source: string;

  /**
   * Parse a raw input into a normalized inbox item plus any blobs to persist.
   *
   * Returns `null` to drop a message silently (e.g. auto-replies a channel
   * wants suppressed; duplicates the channel itself filters).
   */
  parse(raw: TRaw, config?: TConfig): Promise<ParseResult | null>;

  /**
   * For pull-shape channels — fetch new items since `since` watermark.
   *
   * Returns parsed items and the next watermark string. The runner persists
   * the watermark and passes it back on the next tick.
   */
  pull?(since: string | null, config?: TConfig): Promise<PullResult>;

  /**
   * For pull-shape channels with multiple items per feed response (RSS, Atom,
   * api-poll batches). Returns one `ParseResult` per item. Entries with
   * malformed fields should be skipped (logged, not thrown), so N-entry feeds
   * with 1-2 bad entries still return N-2 items rather than failing whole-hog.
   *
   * `parse()` handles the single-item contract (returns the first entry or
   * null); `parseMany()` returns every parseable entry. Runners that batch
   * ingest should prefer this method.
   *
   * Non-breaking extension: channels that only emit one item per input keep
   * using `parse()` and don't implement this.
   */
  parseMany?(raw: TRaw, config?: TConfig): Promise<ParseResult[]>;
}

/**
 * Channel parse output: the normalized item plus any blobs the channel wants
 * persisted alongside it.
 */
export interface ParseResult {
  item: InboxItem;
  /**
   * Blobs to persist before ingest. Keys are storage paths (matching the
   * `*_ref` fields on `item`); values are the bytes/string + content type.
   */
  blobs?: Record<string, BlobPayload>;
}

export interface BlobPayload {
  content: Uint8Array | string;
  content_type?: string;
}

/**
 * Result of a pull-channel tick.
 */
export interface PullResult {
  items: InboxItem[];
  /** Opaque watermark to persist; passed back as `since` on next tick. */
  next_since: string;
}

// ============================================================================
// Inbox — the pool primitive
// ============================================================================

/**
 * Inbox — composes a Channel + StorageAdapter + inbox semantics
 * (cursor, content-addressed dedup, query/filter).
 *
 * Created by config or admin API. Same in-memory registry either way.
 *
 * Read surface (`list`, `read`, `query`, `cursor`) is what consumers see.
 * Write surface (`_ingest`) is called by the channel dispatcher when a
 * push event arrives or a pull tick fires.
 */
export interface Inbox {
  /** Logical inbox name (e.g. "mailroom", "sms-room"). Unique per host. */
  readonly name: string;

  /** Channel name backing this inbox (e.g. "cf-email"). Same channel can back many inboxes. */
  readonly channel: string;

  /** List items newest-first. Optional cursor for resume. Returns next cursor if more. */
  list(options?: ListOptions): Promise<ListResult>;

  /** Read a single item by id. Set `full: true` to inflate body and load attachment metadata. */
  read(id: string, options?: ReadOptions): Promise<InboxItemFull | null>;

  /** Run a filter against items in the inbox. Pagination via cursor. */
  query(filter: InboxFilter, options?: QueryOptions): Promise<ListResult>;

  /** Current high-water cursor. Callers persist this to resume incremental syncs. */
  cursor(): Promise<string>;

  /**
   * Fetch a single attachment's raw bytes. Returns `null` if the item is
   * missing, the filename isn't in the item's `fields.attachments[]`, or
   * the inbox has no blobs adapter wired.
   *
   * The filename is validated against the item's metadata before the
   * adapter read — arbitrary path components are rejected to prevent
   * blob-store traversal.
   */
  readAttachment?(
    itemId: string,
    filename: string,
  ): Promise<AttachmentReadResult | null>;

  /**
   * Ingest a parsed item. Called by the channel dispatcher; rarely called by consumers.
   * Idempotent: same `id` (content-hash) → no-op.
   *
   * Returns the canonical item (with id assigned if not already set).
   */
  _ingest(item: InboxItem, options?: IngestOptions): Promise<InboxItem>;

  /** Optional live subscription (for streaming consumers). */
  watch?(filter?: InboxFilter): AsyncIterable<InboxItem>;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
  /** Stable order. Default 'newest'. */
  order?: 'newest' | 'oldest';
}

export interface ReadOptions {
  /** Inflate body refs and load attachment metadata. */
  full?: boolean;
}

export interface QueryOptions extends ListOptions {
  /** Include full body / attachments in results (expensive). Default false. */
  full?: boolean;
}

export interface ListResult {
  items: InboxItem[];
  /** Pass back as `cursor` to continue. Absent = end of stream. */
  next_cursor?: string;
  /** Total matching count when cheaply available. */
  total?: number;
}

export interface IngestOptions {
  /** Bypass content-hash dedup check (e.g. forced reprocessing). Default false. */
  force?: boolean;
  /** Storage refs to attach (raw_ref, body_ref, attachment refs). */
  refs?: {
    raw_ref?: string;
    body_ref?: string;
    attachments?: Array<{ id: string; ref: string }>;
  };
  /**
   * Blobs to persist (via the inbox's blobs adapter) before storing the item.
   * Keys are storage paths (matching the `*_ref` fields on the item).
   * If no blobs adapter is configured and `blobs` is provided, the inbox throws.
   */
  blobs?: Record<string, BlobPayload>;
}

// ============================================================================
// InboxFilter — predicate evaluator over items
// ============================================================================

/**
 * Filter spec — declarative predicate over inbox items.
 *
 * Semantics:
 * - All top-level keys AND together
 * - Within an array value (e.g. `from: ["a@x", "b@x"]`), entries OR
 * - `fields.<key>` matches partial substring (case-insensitive) on string values
 * - `text` substring-matches across `summary` + `body`
 * - `labels`/`exclude_labels` test the `labels` array
 * - `since`/`until` compare ISO timestamps against `received_at`
 *
 * Mirrors mailroom collection's filters/*.md format. Authored as YAML
 * frontmatter; parsed by `filter-spec.ts`.
 */
export interface InboxFilter {
  /** Match against InboxItem.fields.<key>. Value can be a single string or array (OR within). */
  fields?: Record<string, string | string[]>;

  /** Substring search across summary + body (case-insensitive). */
  text?: string;

  /** Item must have ALL of these labels. */
  labels?: string[];

  /** Item must have NONE of these labels. */
  exclude_labels?: string[];

  /** ISO timestamp lower bound (received_at >= since). */
  since?: string;

  /** ISO timestamp upper bound (received_at <= until). */
  until?: string;

  /** Match by source channel (e.g. "cf-email", "webhook"). */
  source?: string | string[];

  /** Match by thread_id. */
  thread_id?: string | string[];

  /**
   * Regex match on InboxItem.fields.<key>. Key = field name; value = regex pattern
   * (JavaScript regex source, case-insensitive by default). Array value = OR.
   * Invalid regex patterns are skipped (treated as no-match) rather than throwing.
   *
   * Example: { fields_regex: { from_email: "^.*@(mailer-daemon|noreply)\\." } }
   */
  fields_regex?: Record<string, string | string[]>;

  /**
   * Regex match on summary + body (case-insensitive by default). Invalid regex
   * is skipped. Same ergonomics as `text` but with pattern matching.
   */
  text_regex?: string;

  /**
   * Header matching on item.fields.headers (lowercase-keyed map).
   * - 'present'  : header key must exist
   * - 'absent'   : header key must NOT exist
   * - any other string: treated as regex to match against the header value
   */
  headers?: Record<string, 'present' | 'absent' | string>;
}

// ============================================================================
// Outbox — sketched for symmetry; not implemented yet
// ============================================================================

/**
 * Outbox draft — message a caller wants to send.
 *
 * Symmetric to `InboxItem`: outbox channels translate this normalized
 * shape into channel-specific send calls (e.g. `env.EMAIL.send`).
 */
export interface OutboxDraft {
  /** Caller-supplied id; if omitted, outbox generates one. Used for idempotency. */
  id?: string;

  /** Caller-supplied idempotency key. Same key → same outbox row, no double-send. */
  idempotency_key?: string;

  /** Output channel (e.g. "cf-email-out", "cf-webhook-out"). */
  channel: string;

  /** Channel-specific send fields (to, subject, body for email; url, payload for webhook). */
  fields: Record<string, any>;

  /** Optional reference back to an inbox item this is replying to (sets headers, threading). */
  reply_to?: { inbox: string; item_id: string };

  /** Optional ISO timestamp — earliest send time. */
  send_after?: string;
}

export type OutboxStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

/**
 * Outbox — pool primitive for outbound messages.
 *
 * Not implemented in v1. Sketched so consumers can plan around the surface.
 * See `.brief/messaging-plugins.md` § Outbox for design.
 */
export interface Outbox {
  readonly name: string;
  readonly channel: string;

  enqueue(draft: OutboxDraft): Promise<{ id: string; status: OutboxStatus }>;
  status(id: string): Promise<{ id: string; status: OutboxStatus; attempts: number; last_error?: string } | null>;
  list(options?: ListOptions): Promise<{ items: Array<{ id: string; status: OutboxStatus; created_at: string }>; next_cursor?: string }>;
  cancel(id: string): Promise<boolean>;
  history(id: string): Promise<Array<{ at: string; status: OutboxStatus; detail?: string }>>;
}

// ============================================================================
// Registry types — config + runtime
// ============================================================================

/**
 * Inbox config entry. Lives under `inboxes:` in `.smallstore.json`,
 * or POSTed at runtime via `/admin/inboxes`.
 */
export interface InboxConfig {
  /** Channel name (must be registered in the channel registry). */
  channel: string;

  /** Storage adapter mount key (e.g. "d1:MAILROOM_D1") OR a structured spec. */
  storage: string | InboxStorageSpec;

  /** Channel-specific config (HMAC secret, feed url, schedule cron, etc). */
  channel_config?: Record<string, any>;

  /** Auth — optional override; default reuses host SMALLSTORE_TOKEN. */
  auth?: { token_env?: string; hmac?: string };

  /** Optional URL slug; default = name. */
  slug?: string;

  /** Pull cron schedule (e.g. "*\/5 * * * *"). Only meaningful for pull channels. */
  schedule?: string;

  /** TTL in seconds (runtime-created inboxes only — gets reaped after this). */
  ttl?: number;

  /**
   * Optional key namespace prefix passed through to the Inbox class. Use to
   * share a single storage adapter between multiple inboxes without their
   * `_index` rows colliding (e.g. `keyPrefix: 'inbox/biorxiv/'`). When omitted
   * for boot-time inboxes, the Inbox uses the bare `_index` + `items/<id>`
   * layout (backwards compat). The runtime-create surface
   * (`POST /admin/inboxes`) auto-defaults this to `inbox/<name>/` so callers
   * don't have to think about isolation.
   */
  keyPrefix?: string;
}

/**
 * Structured storage spec for inboxes that need separate adapters for
 * structured rows vs blobs (e.g. D1 + R2).
 */
export interface InboxStorageSpec {
  /** Adapter for the InboxItem rows themselves. */
  items: string;
  /** Adapter for blobs (raw, html bodies, attachments). */
  blobs?: string;
}

/**
 * Storage handle the Inbox uses internally. Created by the registry from `InboxConfig.storage`.
 */
export interface InboxStorage {
  items: StorageAdapter;
  blobs?: StorageAdapter;
}

// ============================================================================
// Sink — pipeline egress primitive
// ============================================================================

/**
 * Sink — a destination for an ingested InboxItem.
 *
 * The Sink abstraction decouples "where an item goes" from "what it is." A
 * channel produces an InboxItem; the pipeline fans it out to N sinks.
 * Adapter-backed inbox is one flavor of sink (see `inboxSink`); HTTP POST,
 * function callback, file write, cross-inbox mirror are others.
 *
 * Design constraints:
 * - Sinks run **independently**: one sink's failure must not prevent others.
 *   The dispatcher should collect results, not abort on first error.
 * - Sinks are **idempotent where possible**: same item hitting the same sink
 *   twice should not double-persist (inbox does this via content-hash dedup;
 *   HTTP sinks rely on downstream idempotency).
 * - Sinks receive the **parsed item + blob payload** (via `SinkContext`) —
 *   the channel already did the parsing; sinks don't re-parse.
 *
 * See `.brief/mailroom-pipeline.md` § "The key abstraction that makes
 * everything else work" for rationale.
 */
export type Sink = (item: InboxItem, ctx: SinkContext) => Promise<SinkResult>;

/**
 * Context passed to every Sink call.
 */
export interface SinkContext {
  /**
   * Blobs the channel produced alongside the item (raw .eml, html, attachments).
   * Sinks that persist binaries (e.g. `inboxSink` with a blobs adapter) use
   * these; sinks that don't (e.g. `httpSink`) can ignore them or forward the
   * blob keys as references.
   */
  blobs?: Record<string, BlobPayload>;

  /** Channel name that produced this item (e.g. "cf-email"). For logging/routing. */
  channel: string;

  /** Registration name this sink belongs to (for error attribution / logging). */
  registration?: string;
}

/**
 * Result of a single Sink call. The dispatcher collects these across all
 * sinks in a registration; non-fatal errors are attached here rather than
 * thrown, so one failing sink doesn't tank the others.
 */
export interface SinkResult {
  /** Did this sink persist/forward the item? */
  stored: boolean;

  /** Sink-assigned id if any (e.g. inbox's canonical id; may differ from item.id). */
  id?: string;

  /** Non-fatal error message. Dispatcher continues to other sinks when present. */
  error?: string;
}

// ============================================================================
// Hooks — pipeline transform/verdict stages
// ============================================================================

/**
 * Verdict returned by a preIngest or postClassify hook.
 *
 * - `'accept'`: continue the pipeline unchanged (same as returning the
 *   input item untouched).
 * - `'drop'`: abort the pipeline for this item; no sinks invoked; the
 *   item is logged but not stored. Use for explicit blocklist / spam
 *   hard-drop. Store-first principle: most rules should return
 *   `'quarantine'` instead so items are recoverable.
 * - `'quarantine'`: continue to sinks but tag the item with a
 *   `quarantined` label first. Consumers can filter these out of their
 *   main inbox view via `exclude_labels: ['quarantined']` and recover
 *   them via a restore flow (see `src/messaging/quarantine.ts`).
 * - `InboxItem`: the hook returned a mutated item — continue the
 *   pipeline with this replacement. Later hooks see the mutation.
 */
export type HookVerdict = 'accept' | 'drop' | 'quarantine' | InboxItem;

/**
 * Context passed to every hook call. Mirrors `SinkContext` so hooks and
 * sinks share the same per-ingest context shape.
 */
export interface HookContext {
  /** Channel name that produced this item. */
  channel: string;
  /** Registration name this hook belongs to (for logging / attribution). */
  registration?: string;
}

/**
 * preIngest hook — runs BEFORE classification + sinks. Typical use:
 * regex blocklists, rate limiters, custom gate logic that can drop or
 * quarantine suspect items before they reach the built-in classifier.
 */
export type PreIngestHook = (item: InboxItem, ctx: HookContext) => Promise<HookVerdict>;

/**
 * postClassify hook — runs AFTER the built-in classifier has merged its
 * labels into the item, BEFORE sinks run. Typical use: sender-index
 * upsert (reads item.labels to decide tags), unsubscribe-URL extraction,
 * or any logic that wants to see the canonical labels before storage.
 */
export type PostClassifyHook = (item: InboxItem, ctx: HookContext) => Promise<HookVerdict>;

/**
 * postStore hook — runs AFTER all sinks complete. Receives sink results
 * for inspection. Cannot alter the item (it's already stored). Typical
 * use: fan-out notifications, metrics, downstream triggers.
 */
export type PostStoreHook = (
  item: InboxItem,
  ctx: HookContext,
  results: SinkResult[],
) => Promise<void>;

/**
 * Optional hook bundle on an `InboxRegistration`. All stages are optional;
 * missing stages simply pass through.
 */
export interface RegistrationHooks {
  preIngest?: PreIngestHook[];
  postClassify?: PostClassifyHook[];
  postStore?: PostStoreHook[];
}
