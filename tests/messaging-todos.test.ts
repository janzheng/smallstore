/**
 * Phase 1 — todo extraction (per `.brief/notes-todos-and-mirror.md`).
 *
 * Covers:
 *   - All 6 pattern shapes match (one fixture each)
 *   - Multi-line note → multi-todo (one per matching line)
 *   - Quoted-reply lines skipped
 *   - Checked checkboxes (`[x]`) NOT matched
 *   - Empty / missing forward_note returns nothing for that item
 *   - `?slug=` filter restricts to one publisher
 *   - `?since=` filter on received_at
 *   - 200 + empty for known inbox with no notes
 *   - 404 for unknown inbox
 *   - First-match-wins ordering when one line matches multiple patterns
 *   - Returns matched_pattern + full_note + newsletter context
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import { scanNoteForTodos } from '../src/messaging/todos.ts';
import type { InboxConfig, InboxItem } from '../src/messaging/types.ts';

interface Fixture {
  app: Hono;
  inbox: ReturnType<typeof createInbox>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  seed: (overrides: Partial<InboxItem>) => Promise<InboxItem>;
}

function buildFixture(): Fixture {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();
  const inbox = createInbox({ name: 'mailroom', channel: 'cf-email', storage: { items } });
  registry.register('mailroom', inbox, { channel: 'cf-email', storage: 'items' } as InboxConfig, 'boot');
  const buildInbox = async (n: string, cfg: InboxConfig) =>
    createInbox({ name: n, channel: cfg.channel, storage: { items } });

  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });

  let counter = 0;
  return {
    app,
    inbox,
    fetch: async (path, init) => await app.request(path, init),
    seed: async (overrides) => {
      const id = overrides.id ?? `item-${++counter}`;
      const item: InboxItem = {
        id,
        source: 'email/v1',
        source_version: 'email/v1',
        received_at: '2026-04-26T10:00:00.000Z',
        summary: 'Test',
        labels: ['forwarded', 'newsletter'],
        fields: { from_email: 'sender@example.com', newsletter_slug: 'test-pub' },
        ...overrides,
      };
      return await inbox._ingest(item, { force: true });
    },
  };
}

// ---------------------------------------------------------------------
// Unit tests for the scanner — small, fast, no HTTP.
// ---------------------------------------------------------------------

Deno.test('scanner: unchecked checkbox matches', () => {
  const out = scanNoteForTodos('- [ ] sub mailroom to rosieland');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'unchecked-checkbox');
});

Deno.test('scanner: bare checkbox without dash matches', () => {
  const out = scanNoteForTodos('[ ] follow up with steph');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'unchecked-checkbox');
});

Deno.test('scanner: TODO prefix matches', () => {
  const out = scanNoteForTodos('TODO: review part 2 next week');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'todo-prefix');
});

Deno.test('scanner: lowercase todo: prefix matches', () => {
  const out = scanNoteForTodos('todo: bookmark this');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'todo-prefix');
});

Deno.test('scanner: Action prefix matches', () => {
  const out = scanNoteForTodos('Action: respond by Friday');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'action-prefix');
});

Deno.test('scanner: "remind me to" matches', () => {
  const out = scanNoteForTodos('remind me to check this on Monday');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'remind');
});

Deno.test('scanner: "reminder to self" matches', () => {
  const out = scanNoteForTodos('reminder to self: sub mailroom to rosieland');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'remind'); // first match wins
});

Deno.test('scanner: "remember to" matches', () => {
  const out = scanNoteForTodos('remember to follow this thread');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'remind');
});

Deno.test('scanner: "sub me to" matches', () => {
  const out = scanNoteForTodos('sub me to this newsletter');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'subscribe');
});

Deno.test('scanner: "sub mailroom to" matches', () => {
  const out = scanNoteForTodos('sub mailroom to rosieland');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'subscribe');
});

Deno.test('scanner: "subscribe me to" matches', () => {
  const out = scanNoteForTodos('please subscribe me to this');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'subscribe');
});

Deno.test('scanner: "follow up" matches', () => {
  const out = scanNoteForTodos('follow up with the author');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'follow-up');
});

Deno.test('scanner: "followup" (no space) matches', () => {
  const out = scanNoteForTodos('followup needed');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'follow-up');
});

Deno.test('scanner: "follow-up" (hyphen) matches', () => {
  const out = scanNoteForTodos('follow-up: read the cited paper');
  assertEquals(out.length, 1);
  // Could match either follow-up or some other; first-match-wins gives follow-up.
  assertEquals(out[0].pattern, 'follow-up');
});

Deno.test('scanner: multi-line note → multi-todo', () => {
  const note = `Some thoughts on this issue.

- [ ] sub mailroom to rosieland
- already subscribed elsewhere
TODO: reread part 2

remind me to check the sources cited`;
  const out = scanNoteForTodos(note);
  assertEquals(out.length, 3);
  assertEquals(out.map((t) => t.pattern), ['unchecked-checkbox', 'todo-prefix', 'remind']);
});

Deno.test('scanner: quoted-reply lines skipped', () => {
  const note = `> remind me to check this
This is my actual note.
> TODO: from the original sender, ignore`;
  const out = scanNoteForTodos(note);
  assertEquals(out.length, 0);
});

Deno.test('scanner: checked checkboxes [x] do NOT match', () => {
  const note = `- [x] already done this
- [ ] still need to do this`;
  const out = scanNoteForTodos(note);
  assertEquals(out.length, 1);
  assertEquals(out[0].line, '- [ ] still need to do this');
});

Deno.test('scanner: empty/missing/non-string note → []', () => {
  assertEquals(scanNoteForTodos(''), []);
  assertEquals(scanNoteForTodos(undefined), []);
  assertEquals(scanNoteForTodos(null), []);
  assertEquals(scanNoteForTodos('   \n  \n '), []);
});

Deno.test('scanner: word boundaries — "subway" does NOT trigger subscribe', () => {
  const out = scanNoteForTodos('went to subway today');
  assertEquals(out.length, 0);
});

Deno.test('scanner: word boundaries — "remembered" matches via the er suffix in pattern', () => {
  // Documented behavior: the `remind` pattern matches remind/reminder/remembered/etc.
  const out = scanNoteForTodos('remembered to send the email');
  assertEquals(out.length, 1);
  assertEquals(out[0].pattern, 'remind');
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

Deno.test('GET /todos: 404 unknown inbox', async () => {
  const f = buildFixture();
  const r = await f.fetch('/inbox/no-such-inbox/todos');
  assertEquals(r.status, 404);
});

Deno.test('GET /todos: empty inbox returns count=0', async () => {
  const f = buildFixture();
  const r = await f.fetch('/inbox/mailroom/todos');
  assertEquals(r.status, 200);
  const body = await r.json();
  assertEquals(body.count, 0);
  assertEquals(body.todos, []);
});

Deno.test('GET /todos: items without forward_note are skipped', async () => {
  const f = buildFixture();
  await f.seed({ id: 'a', fields: { newsletter_slug: 'pub-a', from_email: 'a@a.com' } });
  await f.seed({ id: 'b', fields: { newsletter_slug: 'pub-b', from_email: 'b@b.com' } });

  const r = await f.fetch('/inbox/mailroom/todos');
  const body = await r.json();
  assertEquals(body.count, 0);
});

Deno.test('GET /todos: surfaces todos with full context', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'rosieland-1',
    received_at: '2026-04-27T00:46:38.000Z',
    fields: {
      newsletter_slug: 'rosieland',
      original_from_addr: 'Rosieland',
      original_subject: "The overglorification of 'the pivot'",
      original_sent_at: '2026-04-26T08:16:00.000Z',
      forward_note: 'reminder to self: sub mailroom to rosieland',
    },
  });

  const r = await f.fetch('/inbox/mailroom/todos');
  assertEquals(r.status, 200);
  const body = await r.json();
  assertEquals(body.count, 1);
  const todo = body.todos[0];
  assertEquals(todo.item_id, 'rosieland-1');
  assertEquals(todo.newsletter_slug, 'rosieland');
  assertEquals(todo.newsletter_display, 'Rosieland');
  assertEquals(todo.subject, "The overglorification of 'the pivot'");
  assertEquals(todo.original_sent_at, '2026-04-26T08:16:00.000Z');
  assertEquals(todo.matched_line, 'reminder to self: sub mailroom to rosieland');
  assertEquals(todo.matched_pattern, 'remind');
  assertEquals(todo.full_note, 'reminder to self: sub mailroom to rosieland');
});

Deno.test('GET /todos: ?slug=X scopes to one publisher', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'a',
    fields: { newsletter_slug: 'pub-a', forward_note: 'TODO: read this' },
  });
  await f.seed({
    id: 'b',
    fields: { newsletter_slug: 'pub-b', forward_note: 'TODO: read this too' },
  });

  const allR = await f.fetch('/inbox/mailroom/todos');
  assertEquals((await allR.json()).count, 2);

  const aR = await f.fetch('/inbox/mailroom/todos?slug=pub-a');
  const aBody = await aR.json();
  assertEquals(aBody.count, 1);
  assertEquals(aBody.todos[0].item_id, 'a');
});

Deno.test('GET /todos: ?since filters by received_at', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'old',
    received_at: '2026-04-20T00:00:00.000Z',
    fields: { newsletter_slug: 'p', forward_note: 'TODO: old item' },
  });
  await f.seed({
    id: 'new',
    received_at: '2026-04-26T00:00:00.000Z',
    fields: { newsletter_slug: 'p', forward_note: 'TODO: new item' },
  });

  const r = await f.fetch('/inbox/mailroom/todos?since=2026-04-25T00:00:00.000Z');
  const body = await r.json();
  assertEquals(body.count, 1);
  assertEquals(body.todos[0].item_id, 'new');
});

Deno.test('GET /todos: multi-line note → multiple todo entries on same item', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'multi',
    fields: {
      newsletter_slug: 'p',
      forward_note: '- [ ] first action\nTODO: second action\nfollow up on third',
    },
  });

  const r = await f.fetch('/inbox/mailroom/todos');
  const body = await r.json();
  assertEquals(body.count, 3);
  // All point at the same item but list distinct lines.
  assertEquals(new Set(body.todos.map((t: { item_id: string }) => t.item_id)).size, 1);
  assertEquals(
    body.todos.map((t: { matched_pattern: string }) => t.matched_pattern),
    ['unchecked-checkbox', 'todo-prefix', 'follow-up'],
  );
});

Deno.test('GET /todos: ?limit caps the response', async () => {
  const f = buildFixture();
  await f.seed({
    id: 'multi',
    fields: {
      newsletter_slug: 'p',
      forward_note: '- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four',
    },
  });

  const r = await f.fetch('/inbox/mailroom/todos?limit=2');
  const body = await r.json();
  assertEquals(body.count, 2);
});
