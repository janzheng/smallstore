/**
 * Cloudflare D1 — messaging-mode schema + migrations
 *
 * Isolated from the main adapter to keep the migration SQL and row-shape
 * helpers reviewable on their own. Activated only when the adapter is
 * constructed with `{ messaging: true }`.
 *
 * Design notes:
 *
 * - D1's `binding.exec()` splits SQL on newlines and each line must be a
 *   complete statement (bug `ad1182d` in this repo). Every DDL string
 *   produced here is **single-line**; migrations are applied one
 *   `binding.prepare(sql).run()` at a time.
 *
 * - D1 DO runtime forbids SQL-level BEGIN/COMMIT. Each migration step is
 *   tracked individually in `d1_migrations` so a partial failure is
 *   resumable on the next boot (idempotent CREATE ... IF NOT EXISTS +
 *   per-step tracking).
 *
 * - The messaging schema denormalizes the InboxItem shape: columns for
 *   indexable fields (id, received_at, from_email, from_display, subject,
 *   thread_id, channel), JSON blob for everything else (fields, labels).
 *   FTS5 indexes summary + body + from_display + subject.
 *
 * - `from_email` is the bare lowercased address (matches cf-email channel's
 *   `fields.from_email`); `from_display` uses `fields.from_addr` (the
 *   "Name <addr>" form). Subject is duplicated from `summary` so the FTS
 *   column set is explicit.
 *
 * - Triggers mirror INSERT/UPDATE/DELETE into the FTS virtual table using
 *   the `content=<table>, content_rowid=rowid` external-content pattern,
 *   which is the SQLite FTS5 documentation-recommended approach:
 *   https://sqlite.org/fts5.html#external_content_tables
 *
 * See `.brief/mailroom-pipeline.md` § FTS5 for the product-level rationale.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Structural row type this file works with.
 *
 * Intentionally NOT imported from `src/messaging/types.ts` — the adapter
 * layer must stay plugin-independent (see `docs/design/PLUGIN-AUTHORING.md`
 * invariant 1). This shape is a subset of `InboxItem` by design; callers
 * that have a real `InboxItem` pass it through structurally.
 */
export interface MessagingRowInput {
  id: string;
  received_at: string;
  source?: string;
  source_version?: string;
  sent_at?: string;
  summary?: string | null;
  body?: string | null;
  body_ref?: string;
  raw_ref?: string;
  thread_id?: string;
  fields?: Record<string, any>;
  labels?: string[];
}

/**
 * Shape `decodeItemRow` returns. Matches `MessagingRowInput` but with
 * `fields` always present.
 */
export interface MessagingRowOutput extends MessagingRowInput {
  fields: Record<string, any>;
}

/**
 * Minimal D1 binding shape required by migration/query helpers.
 *
 * Kept as a structural type so this file has no hard dependency on the
 * `D1Database` stub in `cloudflare-d1.ts`.
 */
export interface D1BindingLike {
  prepare(sql: string): {
    bind(...args: any[]): {
      run(): Promise<any>;
      first(): Promise<any>;
      all(): Promise<{ results: any[] }>;
    };
    run(): Promise<any>;
    first(): Promise<any>;
    all(): Promise<{ results: any[] }>;
  };
}

// ============================================================================
// Table/name sanitization
// ============================================================================

/**
 * SQL identifiers can't be parameterized, so we hard-validate table names.
 * Matches `CloudflareD1Adapter.sanitizeTableName` — only `[a-zA-Z0-9_]` survives.
 */
export function sanitizeTableName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

// ============================================================================
// Migration DDL — each entry is a SINGLE-LINE statement
// ============================================================================

export interface MessagingMigration {
  name: string;
  sql: string;
}

/**
 * Build the full list of messaging-mode migrations for a given table.
 *
 * Every `sql` is a single-line statement (no embedded newlines) so it's
 * safe for both `binding.exec()` and `binding.prepare().run()`.
 */
export function messagingMigrations(table: string): MessagingMigration[] {
  const t = sanitizeTableName(table);
  const fts = `${t}_fts`;

  return [
    {
      name: `${t}__01_create_table`,
      sql: `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, channel TEXT, summary TEXT, body TEXT, body_ref TEXT, raw_ref TEXT, thread_id TEXT, fields TEXT, labels TEXT, from_email TEXT, from_display TEXT, subject TEXT, source TEXT, source_version TEXT, sent_at TEXT, created_at INTEGER DEFAULT (strftime('%s', 'now')), updated_at INTEGER DEFAULT (strftime('%s', 'now')))`,
    },
    {
      name: `${t}__02_index_received_at`,
      sql: `CREATE INDEX IF NOT EXISTS idx_${t}_received_at ON ${t}(received_at DESC)`,
    },
    {
      name: `${t}__03_index_from_email`,
      sql: `CREATE INDEX IF NOT EXISTS idx_${t}_from_email ON ${t}(from_email)`,
    },
    {
      name: `${t}__04_index_thread_id`,
      sql: `CREATE INDEX IF NOT EXISTS idx_${t}_thread_id ON ${t}(thread_id)`,
    },
    {
      name: `${t}__05_index_channel`,
      sql: `CREATE INDEX IF NOT EXISTS idx_${t}_channel ON ${t}(channel)`,
    },
    {
      name: `${t}__06_create_fts`,
      sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(summary, body, from_display, subject, content='${t}', content_rowid='rowid')`,
    },
    {
      name: `${t}__07_trigger_ai`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${t}_ai AFTER INSERT ON ${t} BEGIN INSERT INTO ${fts}(rowid, summary, body, from_display, subject) VALUES (new.rowid, new.summary, new.body, new.from_display, new.subject); END`,
    },
    {
      name: `${t}__08_trigger_ad`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${t}_ad AFTER DELETE ON ${t} BEGIN INSERT INTO ${fts}(${fts}, rowid, summary, body, from_display, subject) VALUES ('delete', old.rowid, old.summary, old.body, old.from_display, old.subject); END`,
    },
    {
      name: `${t}__09_trigger_au_delete`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${t}_au_delete AFTER UPDATE ON ${t} BEGIN INSERT INTO ${fts}(${fts}, rowid, summary, body, from_display, subject) VALUES ('delete', old.rowid, old.summary, old.body, old.from_display, old.subject); END`,
    },
    {
      name: `${t}__10_trigger_au_insert`,
      sql: `CREATE TRIGGER IF NOT EXISTS ${t}_au_insert AFTER UPDATE ON ${t} BEGIN INSERT INTO ${fts}(rowid, summary, body, from_display, subject) VALUES (new.rowid, new.summary, new.body, new.from_display, new.subject); END`,
    },
  ];
}

// NOTE on the two update triggers (`_au_delete` + `_au_insert`) instead of
// one trigger with a compound body: SQLite allows multiple statements in a
// trigger body separated by `;`, but D1's parser has been flaky with that
// form at the prepare() boundary. Splitting into two AFTER UPDATE triggers
// produces the same net effect (delete-then-insert into FTS on UPDATE)
// while keeping every migration string to a single-statement shape.

// ============================================================================
// Migration runner
// ============================================================================

const TRACKING_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`;

/**
 * Apply messaging-mode migrations idempotently.
 *
 * Walks `messagingMigrations(table)`, skipping any migration whose name is
 * already recorded in `d1_migrations`. Each migration is one
 * `prepare(sql).run()` — no SQL-level transactions (DO runtime forbids).
 *
 * Safe to call on every `ensureTable()` — after the first run it's a pure
 * SELECT per migration (~N round-trips). If that ever hurts, cache the
 * "already migrated" bit on the adapter instance.
 */
export async function applyMessagingMigrations(
  binding: D1BindingLike,
  table: string,
): Promise<void> {
  // Ensure the tracking table exists first. Idempotent.
  await binding.prepare(TRACKING_TABLE_DDL).run();

  const migrations = messagingMigrations(table);

  for (const migration of migrations) {
    // Has this migration already been applied?
    const row = await binding
      .prepare(`SELECT 1 AS applied FROM d1_migrations WHERE name = ?`)
      .bind(migration.name)
      .first();
    if (row) continue;

    // Apply the DDL, then record it.
    await binding.prepare(migration.sql).run();
    await binding
      .prepare(`INSERT INTO d1_migrations (name) VALUES (?)`)
      .bind(migration.name)
      .run();
  }
}

// ============================================================================
// Row encode / decode
// ============================================================================

/**
 * Columns written on insert/upsert, in a stable order. Used by the SQL
 * builder and also documents the schema contract in one place.
 */
export const MESSAGING_COLUMNS = [
  'id',
  'received_at',
  'channel',
  'summary',
  'body',
  'body_ref',
  'raw_ref',
  'thread_id',
  'fields',
  'labels',
  'from_email',
  'from_display',
  'subject',
  'source',
  'source_version',
  'sent_at',
] as const;

export type MessagingColumn = typeof MESSAGING_COLUMNS[number];

/**
 * Convert an InboxItem into a row object matching the messaging schema.
 *
 * Extracts `from_email` / `from_display` from `item.fields`, duplicates
 * summary into `subject` for FTS clarity, and JSON-encodes `fields` +
 * `labels` into their string columns.
 *
 * Undefined → null so the bindings pass through cleanly.
 */
export function encodeItemRow(item: MessagingRowInput): Record<MessagingColumn, any> {
  const fields = item.fields ?? {};
  const fromEmail = typeof fields.from_email === 'string' ? fields.from_email : null;
  const fromDisplay = typeof fields.from_addr === 'string'
    ? fields.from_addr
    : (typeof fields.from_display === 'string' ? fields.from_display : null);

  return {
    id: item.id,
    received_at: item.received_at,
    channel: item.source ?? null,
    summary: item.summary ?? null,
    body: item.body ?? null,
    body_ref: item.body_ref ?? null,
    raw_ref: item.raw_ref ?? null,
    thread_id: item.thread_id ?? null,
    fields: JSON.stringify(fields),
    labels: item.labels ? JSON.stringify(item.labels) : null,
    from_email: fromEmail,
    from_display: fromDisplay,
    subject: item.summary ?? null,
    source: item.source ?? null,
    source_version: item.source_version ?? null,
    sent_at: item.sent_at ?? null,
  };
}

/**
 * Reverse of `encodeItemRow` — reconstruct an InboxItem from a raw DB row.
 * Tolerant of missing columns (e.g. from partial SELECTs).
 */
export function decodeItemRow(row: Record<string, any>): MessagingRowOutput {
  let fields: Record<string, any> = {};
  if (row.fields && typeof row.fields === 'string') {
    try {
      fields = JSON.parse(row.fields);
    } catch {
      // Corrupt fields blob: return empty rather than tank the read.
      fields = {};
    }
  } else if (row.fields && typeof row.fields === 'object') {
    fields = row.fields;
  }

  let labels: string[] | undefined;
  if (row.labels && typeof row.labels === 'string') {
    try {
      const parsed = JSON.parse(row.labels);
      if (Array.isArray(parsed)) labels = parsed;
    } catch {
      // ignore
    }
  } else if (Array.isArray(row.labels)) {
    labels = row.labels;
  }

  const item: MessagingRowOutput = {
    id: row.id,
    source: row.source ?? row.channel ?? '',
    received_at: row.received_at,
    fields,
  };

  if (row.source_version) item.source_version = row.source_version;
  if (row.sent_at) item.sent_at = row.sent_at;
  if (row.summary !== null && row.summary !== undefined) item.summary = row.summary;
  if (row.body !== null && row.body !== undefined) item.body = row.body;
  if (row.body_ref) item.body_ref = row.body_ref;
  if (row.raw_ref) item.raw_ref = row.raw_ref;
  if (row.thread_id) item.thread_id = row.thread_id;
  if (labels) item.labels = labels;

  return item;
}

// ============================================================================
// SQL builders
// ============================================================================

/**
 * Build the UPSERT statement for an encoded row.
 *
 * Produces a single-line SQL string (no embedded newlines) — safe for both
 * `binding.exec()` and `binding.prepare().run()`. `ON CONFLICT(id) DO UPDATE`
 * replaces all columns so re-ingest with the same id refreshes the row.
 */
export function buildUpsertSql(table: string): string {
  const t = sanitizeTableName(table);
  const cols = MESSAGING_COLUMNS.join(', ');
  const placeholders = MESSAGING_COLUMNS.map(() => '?').join(', ');
  const updates = MESSAGING_COLUMNS
    .filter(c => c !== 'id')
    .map(c => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${t} (${cols}, updated_at) VALUES (${placeholders}, strftime('%s', 'now')) ON CONFLICT(id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`;
}

/**
 * Build the FTS5 search SQL.
 *
 * Uses the external-content pattern: rowid in `<table>` === rowid in
 * `<table>_fts`. We SELECT the real row via JOIN on rowid so the result
 * has all the columns for decode.
 */
export function buildFtsSql(table: string): string {
  const t = sanitizeTableName(table);
  const fts = `${t}_fts`;
  return `SELECT ${t}.* FROM ${t} JOIN ${fts} ON ${t}.rowid = ${fts}.rowid WHERE ${fts} MATCH ? ORDER BY ${t}.received_at DESC`;
}

/**
 * Build the SELECT for a single row by id.
 */
export function buildSelectByIdSql(table: string): string {
  const t = sanitizeTableName(table);
  return `SELECT * FROM ${t} WHERE id = ?`;
}

/**
 * Build the DELETE by id.
 */
export function buildDeleteByIdSql(table: string): string {
  const t = sanitizeTableName(table);
  return `DELETE FROM ${t} WHERE id = ?`;
}

/**
 * Build the "list all ids" SELECT with optional prefix filter on `id`.
 * Prefix semantics: `id LIKE '<prefix>%'` — preserves the generic
 * k/v-adapter contract where `keys(prefix)` scopes to matching ids.
 */
export function buildKeysSql(table: string, prefix?: string): string {
  const t = sanitizeTableName(table);
  if (prefix !== undefined) {
    return `SELECT id FROM ${t} WHERE id LIKE ? ORDER BY id ASC`;
  }
  return `SELECT id FROM ${t} ORDER BY id ASC`;
}

/**
 * Build a full `SELECT * FROM <table>` with optional prefix filter, used by
 * the non-FTS messaging query path.
 */
export function buildListSql(table: string, prefix?: string): string {
  const t = sanitizeTableName(table);
  if (prefix !== undefined) {
    return `SELECT * FROM ${t} WHERE id LIKE ? ORDER BY received_at DESC`;
  }
  return `SELECT * FROM ${t} ORDER BY received_at DESC`;
}
