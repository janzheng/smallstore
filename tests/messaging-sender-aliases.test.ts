/**
 * Messaging — sender-name alias hook tests.
 *
 * Covers parsing, glob matching, slugification, and PreIngestHook wiring.
 * Uses synthetic InboxItems — no .eml fixtures needed.
 */

import { assert, assertEquals } from 'jsr:@std/assert';
import {
  applySenderAlias,
  createSenderAliasHook,
  matchSenderAlias,
  parseSenderAliases,
  slugifySenderName,
  type SenderAliasRule,
} from '../src/messaging/sender-aliases.ts';
import type { HookContext, InboxItem } from '../src/messaging/types.ts';

const CTX: HookContext = { channel: 'cf-email', registration: 'test' };

function makeItem(
  fields: Record<string, any> = {},
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id: 'item-test',
    source: 'cf-email',
    source_version: 'email/v1',
    received_at: '2026-04-26T12:00:00Z',
    summary: fields.subject ?? 'test',
    body: null,
    fields,
    ...overrides,
  };
}

// B029: parseSenderAliases sorts rules by literal-prefix length (longest
// first) with insertion order as a stable tie-breaker. So even though the
// user wrote `jessica.c.sacher@*` first, the parsed/sorted output puts
// `jan@phage.directory` ahead of it (no `*` → full-length prefix).
const RULES: SenderAliasRule[] = [
  { pattern: 'jan@phage.directory', name: 'Jan' },
  { pattern: 'jessica.c.sacher@*', name: 'Jessica' },
  { pattern: 'janzheng@*', name: 'Jan' },
];

// ============================================================================
// parseSenderAliases
// ============================================================================

Deno.test('parseSenderAliases — undefined → []', () => {
  assertEquals(parseSenderAliases(undefined), []);
});

Deno.test('parseSenderAliases — empty string → []', () => {
  assertEquals(parseSenderAliases(''), []);
});

Deno.test('parseSenderAliases — rule array lowercases patterns, trims names, sorts by specificity (B029)', () => {
  // B029: even though `Jessica.C.Sacher@*` is written first, it has a
  // shorter literal prefix (17 chars before `*`) than the wildcard-free
  // `jan@phage.directory` (full 19 chars). After sort, `jan@...` wins.
  const out = parseSenderAliases([
    { pattern: 'Jessica.C.Sacher@*', name: '  Jessica  ' },
    { pattern: 'jan@phage.directory', name: 'Jan' },
  ]);
  assertEquals(out, [
    { pattern: 'jan@phage.directory', name: 'Jan' },
    { pattern: 'jessica.c.sacher@*', name: 'Jessica' },
  ]);
});

Deno.test('parseSenderAliases — record form sorted by specificity, insertion order is tie-breaker (B029)', () => {
  const out = parseSenderAliases({
    'jessica.c.sacher@*': 'Jessica',
    'jan@phage.directory': 'Jan',
    'janzheng@*': 'Jan',
  });
  assertEquals(out, RULES);
});

Deno.test('parseSenderAliases — CSV string form sorted by specificity (B029)', () => {
  const out = parseSenderAliases(
    'jessica.c.sacher@*:Jessica,jan@phage.directory:Jan,janzheng@*:Jan',
  );
  assertEquals(out, RULES);
});

Deno.test('parseSenderAliases — CSV form tolerates whitespace + ignores malformed entries + specificity sort (B029)', () => {
  const out = parseSenderAliases(
    '  jessica.c.sacher@* : Jessica  , no-colon-entry, :missing-pattern, jan@phage.directory:Jan',
  );
  // After parse + sort: `jan@phage.directory` (no `*`, prefix=19) wins
  // over `jessica.c.sacher@*` (prefix=17).
  assertEquals(out, [
    { pattern: 'jan@phage.directory', name: 'Jan' },
    { pattern: 'jessica.c.sacher@*', name: 'Jessica' },
  ]);
});

// B029 — the bug this fix addresses: a broad pattern added first must
// NOT eat a narrower one added later.
Deno.test('parseSenderAliases — broad pattern first, narrow pattern second → narrow wins after sort (B029)', () => {
  // User-written order: broad first, narrow second. Pre-fix this would
  // make `*@example.com:Generic` shadow `jan@example.com:Jan` since
  // `matchSenderAlias` returned on first match.
  const out = parseSenderAliases([
    { pattern: '*@example.com', name: 'Generic' },
    { pattern: 'jan@example.com', name: 'Jan' },
  ]);
  assertEquals(out, [
    { pattern: 'jan@example.com', name: 'Jan' },
    { pattern: '*@example.com', name: 'Generic' },
  ]);
});

Deno.test('matchSenderAlias — narrower pattern wins regardless of insertion order (B029)', () => {
  const aliases = parseSenderAliases([
    { pattern: '*@example.com', name: 'Generic' },
    { pattern: 'jan@example.com', name: 'Jan' },
  ]);
  // jan@example.com matches the specific rule, not the broad fallback.
  assertEquals(matchSenderAlias('jan@example.com', aliases)?.name, 'Jan');
  // Other addresses still hit the broad fallback.
  assertEquals(matchSenderAlias('alice@example.com', aliases)?.name, 'Generic');
});

Deno.test('matchSenderAlias — equal-specificity ties broken by insertion order (B029)', () => {
  // Both patterns have prefix length 0 (start with `*`). Sort is stable,
  // so insertion order wins — first-listed `*@a.com` matches both.
  const aliases = parseSenderAliases([
    { pattern: '*@a.com', name: 'First' },
    { pattern: '*@a.com', name: 'Second' },
  ]);
  assertEquals(matchSenderAlias('foo@a.com', aliases)?.name, 'First');
});

Deno.test('parseSenderAliases — drops rules missing pattern or name', () => {
  const out = parseSenderAliases([
    { pattern: '', name: 'Empty' },
    { pattern: 'ok@*', name: '' },
    { pattern: 'keep@*', name: 'Keep' },
  ]);
  assertEquals(out, [{ pattern: 'keep@*', name: 'Keep' }]);
});

// ============================================================================
// slugifySenderName
// ============================================================================

Deno.test('slugifySenderName — basic lowercase', () => {
  assertEquals(slugifySenderName('Jessica'), 'jessica');
});

Deno.test('slugifySenderName — spaces and punctuation → dashes', () => {
  assertEquals(slugifySenderName('Jan C.'), 'jan-c');
  assertEquals(slugifySenderName('  foo  bar  '), 'foo-bar');
});

Deno.test('slugifySenderName — collapses runs of punctuation', () => {
  assertEquals(slugifySenderName('a...b,,,c'), 'a-b-c');
});

Deno.test('slugifySenderName — non-ASCII letters preserved', () => {
  assertEquals(slugifySenderName('María'), 'maría');
});

Deno.test('slugifySenderName — empty / whitespace-only input → empty string', () => {
  assertEquals(slugifySenderName(''), '');
  assertEquals(slugifySenderName('   '), '');
});

// ============================================================================
// matchSenderAlias
// ============================================================================

Deno.test('matchSenderAlias — wildcard domain matches any subdomain', () => {
  const m = matchSenderAlias('jessica.c.sacher@gmail.com', RULES);
  assertEquals(m?.name, 'Jessica');
});

Deno.test('matchSenderAlias — exact pattern matches exact address', () => {
  const m = matchSenderAlias('jan@phage.directory', RULES);
  assertEquals(m?.name, 'Jan');
});

Deno.test('matchSenderAlias — first-match-wins even if later rule would also match', () => {
  const rules: SenderAliasRule[] = [
    { pattern: 'jan@phage.directory', name: 'Jan' },
    { pattern: '*@phage.directory', name: 'PhageTeam' },
  ];
  assertEquals(matchSenderAlias('jan@phage.directory', rules)?.name, 'Jan');
  assertEquals(matchSenderAlias('other@phage.directory', rules)?.name, 'PhageTeam');
});

Deno.test('matchSenderAlias — case-insensitive match', () => {
  assertEquals(
    matchSenderAlias('Jessica.C.Sacher@Gmail.COM', RULES)?.name,
    'Jessica',
  );
});

Deno.test('matchSenderAlias — no match → null', () => {
  assertEquals(matchSenderAlias('stranger@nowhere.io', RULES), null);
});

Deno.test('matchSenderAlias — empty / null address → null', () => {
  assertEquals(matchSenderAlias('', RULES), null);
  assertEquals(matchSenderAlias(undefined, RULES), null);
  assertEquals(matchSenderAlias(null, RULES), null);
});

Deno.test('matchSenderAlias — regex metachars in pattern are escaped (only * is wildcard)', () => {
  // If "." were treated as a regex metachar, "janxphage.directory" would match.
  const rules: SenderAliasRule[] = [{ pattern: 'jan@phage.directory', name: 'Jan' }];
  assertEquals(matchSenderAlias('jan@phagexdirectory', rules), null);
  assertEquals(matchSenderAlias('jan@phage.directory', rules)?.name, 'Jan');
});

Deno.test('matchSenderAlias — anchored match (no substring hits)', () => {
  const rules: SenderAliasRule[] = [{ pattern: 'jan@phage.directory', name: 'Jan' }];
  // A suffix past the pattern should NOT match.
  assertEquals(matchSenderAlias('jan@phage.directory.co', rules), null);
  // A prefix before the pattern should NOT match.
  assertEquals(matchSenderAlias('not-jan@phage.directory', rules), null);
});

// ============================================================================
// applySenderAlias
// ============================================================================

Deno.test('applySenderAlias — prefers original_from_email over from_email', () => {
  const item = makeItem({
    from_email: 'me@example.com',
    original_from_email: 'jessica.c.sacher@gmail.com',
  });
  const r = applySenderAlias(item, RULES);
  assertEquals(r.name, 'Jessica');
  assertEquals(r.label, 'sender:jessica');
  assertEquals(r.matched_address, 'jessica.c.sacher@gmail.com');
});

Deno.test('applySenderAlias — falls back to from_email when no original_from_email', () => {
  const item = makeItem({ from_email: 'jan@phage.directory' });
  const r = applySenderAlias(item, RULES);
  assertEquals(r.name, 'Jan');
  assertEquals(r.label, 'sender:jan');
});

Deno.test('applySenderAlias — no match → name and label both null', () => {
  const item = makeItem({ from_email: 'stranger@nowhere.io' });
  const r = applySenderAlias(item, RULES);
  assertEquals(r.name, null);
  assertEquals(r.label, null);
});

// ============================================================================
// createSenderAliasHook
// ============================================================================

Deno.test('createSenderAliasHook — empty aliases → accept verdict', async () => {
  const hook = createSenderAliasHook({ aliases: [] });
  const item = makeItem({ from_email: 'jessica.c.sacher@gmail.com' });
  assertEquals(await hook(item, CTX), 'accept');
});

Deno.test('createSenderAliasHook — miss → accept verdict (pass-through)', async () => {
  const hook = createSenderAliasHook({ aliases: RULES });
  const item = makeItem({ from_email: 'stranger@nowhere.io' });
  assertEquals(await hook(item, CTX), 'accept');
});

Deno.test('createSenderAliasHook — hit → returns new item with sender_name + sender:<slug> label', async () => {
  const hook = createSenderAliasHook({ aliases: RULES });
  const item = makeItem({ from_email: 'jessica.c.sacher@gmail.com' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.sender_name, 'Jessica');
  assertEquals(verdict.labels, ['sender:jessica']);
});

Deno.test('createSenderAliasHook — merges with pre-existing labels (no duplicate)', async () => {
  const hook = createSenderAliasHook({ aliases: RULES });
  const item = makeItem(
    { from_email: 'jan@phage.directory' },
    { labels: ['newsletter', 'sender:jan'] }, // sender:jan already present
  );
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.labels, ['newsletter', 'sender:jan']); // no duplicate
  assertEquals(verdict.fields.sender_name, 'Jan');
});

Deno.test('createSenderAliasHook — does not mutate input item', async () => {
  const hook = createSenderAliasHook({ aliases: RULES });
  const item = makeItem(
    { from_email: 'jessica.c.sacher@gmail.com' },
    { labels: ['pre'] },
  );
  const snapshot = JSON.stringify(item);
  await hook(item, CTX);
  assertEquals(JSON.stringify(item), snapshot);
});

Deno.test('createSenderAliasHook — applies to forwarded items via original_from_email', async () => {
  const hook = createSenderAliasHook({ aliases: RULES });
  const item = makeItem({
    from_email: 'me@example.com',
    original_from_email: 'jessica.c.sacher@phage.directory',
  });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.sender_name, 'Jessica');
  assert(verdict.labels?.includes('sender:jessica'));
});

Deno.test('createSenderAliasHook — accepts record-form alias config', async () => {
  const hook = createSenderAliasHook({
    aliases: {
      'jan@phage.directory': 'Jan',
      'janzheng@*': 'Jan',
    },
  });
  const item = makeItem({ from_email: 'janzheng@gmail.com' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.sender_name, 'Jan');
  assertEquals(verdict.labels, ['sender:jan']);
});

Deno.test('createSenderAliasHook — malformed patterns are skipped, valid ones still fire', async () => {
  // An invalid glob shouldn't break the hook — the matcher catches internally.
  const hook = createSenderAliasHook({
    aliases: [
      // All patterns go through String() + toLowerCase() in parse, so a
      // regex-unsafe string still ends up safe after escaping — which is
      // exactly what we want. This test verifies that plus mixing with a
      // valid second rule.
      { pattern: '[[[invalid(((', name: 'Ghost' },
      { pattern: 'jan@phage.directory', name: 'Jan' },
    ],
  });
  const item = makeItem({ from_email: 'jan@phage.directory' });
  const verdict = await hook(item, CTX);
  if (typeof verdict === 'string') throw new Error('expected mutated item');
  assertEquals(verdict.fields.sender_name, 'Jan');
});
