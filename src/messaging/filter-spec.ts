/**
 * Filter spec parser.
 *
 * Parses markdown files with YAML frontmatter into `InboxFilter` + metadata.
 *
 * Format (matches mailroom's `filters/<name>.md`):
 *
 * ```markdown
 * ---
 * name: stratechery
 * description: Stratechery weekly + Update
 * match:
 *   from_email_in:
 *     - newsletters@stratechery.com
 *     - update@stratechery.com
 *   since: 2026-01-01
 *   text: invoice
 *   labels: [important]
 *   exclude_labels: [spam]
 * materialize_to: items/newsletters/stratechery/
 * extract: body_text
 * ---
 * ```
 *
 * `match:` keys map to `InboxFilter`:
 * - `<field>_in: [...]`  → `fields.<field>: [...]` (OR-of-array)
 * - `<field>_regex: <value>` → `fields_regex.<field>: <value>` (single or array)
 * - `<field>: value`     → `fields.<field>: value` (single)
 * - `text_regex: <value>` → top-level `text_regex`
 * - `headers.<name>: <value>` → `headers[<name>]: <value>`
 *   ('present' | 'absent' | regex pattern; name preserved as authored —
 *   evaluator lowercases for lookup)
 * - `since`, `until`     → top-level
 * - `text`               → top-level
 * - `labels`, `exclude_labels` → top-level
 * - `source`, `thread_id` → top-level
 *
 * Top-level (outside `match:`) is consumer metadata (name, description,
 * materialize_to, extract) — passed through untouched.
 */

import { parse as parseYaml } from '@std/yaml';
import type { InboxFilter } from './types.ts';

export interface FilterSpec {
  /** Canonical filter for Inbox.query(). */
  filter: InboxFilter;
  /** Spec name. */
  name?: string;
  /** Human description. */
  description?: string;
  /** Consumer-side metadata (e.g. mailroom's materialize_to, extract). Passed through. */
  meta: Record<string, any>;
}

export function parseFilterSpec(markdown: string): FilterSpec {
  const fm = extractFrontmatter(markdown);
  if (!fm) {
    throw new Error('Filter spec must have YAML frontmatter (between --- markers)');
  }

  const data = parseYaml(fm) as Record<string, any> | null;
  if (!data || typeof data !== 'object') {
    throw new Error('Filter spec frontmatter must be a YAML object');
  }

  const filter = parseMatchBlock(data.match);

  const { name, description, match: _match, ...meta } = data;

  return {
    filter,
    name: typeof name === 'string' ? name : undefined,
    description: typeof description === 'string' ? description : undefined,
    meta,
  };
}

// ============================================================================
// Internals
// ============================================================================

function extractFrontmatter(s: string): string | null {
  const m = s.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function parseMatchBlock(match: any): InboxFilter {
  if (match === undefined || match === null) return {};
  if (typeof match !== 'object') {
    throw new Error('`match:` must be an object');
  }

  const filter: InboxFilter = {};
  const fields: Record<string, string | string[]> = {};
  const fieldsRegex: Record<string, string | string[]> = {};
  const headers: Record<string, string> = {};

  for (const [key, raw] of Object.entries(match)) {
    if (raw === undefined || raw === null) continue;

    switch (key) {
      case 'since':
      case 'until':
        // YAML parses `2026-01-01` as a Date; normalize to ISO string
        filter[key] = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw);
        continue;
      case 'text':
        filter[key] = String(raw);
        continue;
      case 'text_regex':
        filter[key] = String(raw);
        continue;
      case 'labels':
      case 'exclude_labels':
        filter[key] = toStringArray(raw, key);
        continue;
      case 'source':
      case 'thread_id':
        filter[key] = Array.isArray(raw) ? toStringArray(raw, key) : String(raw);
        continue;
    }

    // headers.<name>: <value> → filter.headers[<name>]
    if (key.startsWith('headers.')) {
      const name = key.slice('headers.'.length);
      if (!name) throw new Error(`Invalid filter key: '${key}'`);
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        throw new Error(`'${key}' must be a string ('present' | 'absent' | regex)`);
      }
      headers[name] = String(raw);
      continue;
    }

    // <field>_regex suffix → single string or array
    if (key.endsWith('_regex')) {
      const field = key.slice(0, -'_regex'.length);
      if (!field) throw new Error(`Invalid filter key: '${key}'`);
      if (Array.isArray(raw)) {
        fieldsRegex[field] = toStringArray(raw, key);
      } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        fieldsRegex[field] = String(raw);
      } else {
        throw new Error(`Unsupported value type for '${key}' in match block`);
      }
      continue;
    }

    // <field>_in suffix → array
    if (key.endsWith('_in')) {
      const field = key.slice(0, -3);
      if (!field) throw new Error(`Invalid filter key: '${key}'`);
      fields[field] = toStringArray(raw, key);
      continue;
    }

    // bare scalar field
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      fields[key] = String(raw);
      continue;
    }

    if (Array.isArray(raw)) {
      // Bare arrays without `_in` — treat as OR-of-array on that field
      fields[key] = toStringArray(raw, key);
      continue;
    }

    throw new Error(`Unsupported value type for '${key}' in match block`);
  }

  if (Object.keys(fields).length > 0) filter.fields = fields;
  if (Object.keys(fieldsRegex).length > 0) filter.fields_regex = fieldsRegex;
  if (Object.keys(headers).length > 0) filter.headers = headers;
  return filter;
}

function toStringArray(v: any, keyForError: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`'${keyForError}' must be an array`);
  }
  return v.map((entry, i) => {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new Error(`'${keyForError}[${i}]' must be a string/number/boolean`);
    }
    return String(entry);
  });
}
