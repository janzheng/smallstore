# Spam layers + triage feedback loop

**Status:** shipped 2026-04-28 (all three sprints — see `.brief/2026-04-28-spam-sprint.md` for the retrospective)
**From:** preventive design — no real spam yet, but mailroom volume + the audit's "watch this surface" notes mean it'll happen
**Tasks:** `-> TASKS-MESSAGING.md § Spam layers`

## Problem

Mailroom currently has zero spam handling. Today's signal is fine because the inbox is small and senders are mostly known newsletters — but four bad-actor classes are within striking distance:

1. **Newsletter cross-promo** (someone signs the user up to a list they didn't ask for; the auto-confirm allowlist makes this worse, not better, until mark-spam exists)
2. **Phishing / spoofed senders** (low volume but high cost)
3. **Cold outreach** (recruiters, vendor pitches — annoying but not malicious)
4. **Confirmation-loop attacks** (adversary signs the user up to many newsletters → mailroom floods with `needs-confirm` items → buries real signal)

The TASKS-MESSAGING.md `[?]` entry captured the layered shape (regex blocklist → header heuristics → sender reputation → content hash → LLM) but punted on the **triage feedback loop**: who decides what's spam, and how does that decision teach the rules engine. That's the gap this brief fills.

## Investigation

### What primitives already exist

- **`SenderRecord.spam_count`** — auto-incremented when items carry `spam` or `quarantine` labels (`src/messaging/sender-index.ts:31, 45, 214`). This is the foundation of sender reputation; needs the inverse counter (`not_spam_count`) to compute a meaningful ratio.
- **Rules engine** (`src/messaging/rules.ts`) — runtime-editable rules with 5 actions: `archive`, `bookmark`, `tag`, `drop`, `quarantine`. Tag-style rules stack; terminal rules first-match-wins by priority. Filter DSL supports `from_email` / `from_addr` / `labels` / regex / `subject_regex` etc.
- **`createRulesHook`** (`src/messaging/rules-hook.ts`) — wired as a `preIngest` hook in `deploy/src/index.ts:386`. Already runs every email through the rules.
- **`stampUnreadHook`** model — postClassify hook stamping a label. Same pattern fits a `stampSpamScoreHook` (compute score from sender history, attach `spam-score:high` etc).
- **`auto-confirm-senders` allowlist** with delete-wins semantics (`src/messaging/auto-confirm-senders.ts`) — exact shape we want for spam blocklist + whitelist patterns. New stores can copy the structure.
- **MCP tool family** — `sm_inbox_*` (52 tools, all registered). Adding mark-spam / mark-not-spam / suggest-rules slots into the existing dispatch.

### What doesn't exist yet

- `not_spam_count` on `SenderRecord` (needs schema bump + back-compat default 0)
- `spam` / `not-spam` label semantics aren't reserved — anyone can tag with `spam` today, but the upsert hook only treats it as a counter input, not an inbox-surfacing signal
- `mark-spam` / `mark-not-spam` endpoints (the user-facing triage primitive)
- Composite reputation predicate in the rules engine (e.g., `from_email matches sender with spam_rate > 0.5`) — need to extend the filter DSL or add a synthetic label like `spam-suspect:high` injected at ingest
- Header heuristic helpers (`hasMatchingFromReplyTo`, `hasGenericDisplayName`, `looksBulkWithoutListUnsubscribe`) — small pure functions, easy
- Content-hash dedup helper (`sha256(normalize(body))` → check against rolling Bloom or D1 row)
- Spam-stats endpoint + ranked sender output

### What we're explicitly NOT building today

- LLM classifier (Layer 5 in the audit's design) — adds external dep + cost; defer until rule-based + reputation-based catches under-perform
- Adversarial training data (the user marking spam over time IS the training data; we don't pre-curate)
- Anti-spoofing crypto (DMARC/SPF/DKIM) — Cloudflare Email Routing already filters at the edge for the hard cases; we trust their layer
- Cross-user reputation sharing — single-user mailroom; per-instance state is the model

## Recommendation: triage-driven layered spam

Three principles:

1. **The user's mark-spam decision IS the source of truth.** The system never hides items the user hasn't seen. Rules can quarantine future mail from senders the user has marked spam on; nothing pre-emptively kills mail the user might want.
2. **Layers compose, don't replace.** Each layer outputs a label (or counter increment) that downstream layers + the rules engine can read. No layer makes a terminal decision in isolation except hard blocklist (Layer 1).
3. **Allowlist always wins over blocklist.** A `trusted` label on a sender (set explicitly by the user) bypasses every spam layer below. This makes "false positive on a real sender" recoverable in one click.

### Layer 1 — Hard blocklist / allowlist (rules engine, already exists)

User-curated patterns via the existing rules CRUD (`POST /inbox/:name/rules`). Two new conventions:

- **Whitelist rule:** `priority: 0`, `action: 'tag'`, `action_args: { tag: 'trusted' }`. Tag rules stack, so this rides alongside other tags. Downstream layers check for `trusted` and short-circuit.
- **Blocklist rule:** `priority: 100+`, `action: 'quarantine'` (preserves item for review) or `'drop'` (terminal — only for confirmed-malicious patterns).

No code change needed. We just need a UX convention + a rule-suggestion endpoint that proposes these from observed history (Phase 2).

### Layer 2 — Header heuristics (new helpers, run at classify time)

Pure functions, no external deps, run in the classifier or a new `headerHeuristicsHook` (postClassify). Each emits a label rather than a verdict:

- `header:from-replyto-mismatch` — `From` and `Reply-To` headers are different domains. Strong phishing signal.
- `header:generic-display-name` — display name matches `/^(team|updates|newsletter|admin|support|info|noreply)$/i`. Weak signal.
- `header:bulk-without-listunsubscribe` — body matches a "click here to unsubscribe" anchor but no `List-Unsubscribe` header. Lazy-spammer marker.
- `header:dmarc-fail` — if Cloudflare exposes the result via `Authentication-Results` header (it does on free tier per CF docs).

Rules engine acts on these labels (e.g., a user-configured rule: "if any 2 of `header:*` labels present → quarantine").

### Layer 3 — Sender reputation (extend existing primitive)

Schema bump on `SenderRecord`:

```ts
interface SenderRecord {
  // existing fields...
  spam_count: number;
  not_spam_count: number;       // NEW
  marked_at?: string;           // NEW — last user mark-spam/mark-not-spam timestamp
}
```

Composite signal:

- `spam_rate = spam_count / max(1, spam_count + not_spam_count)` (avoids div-by-zero; weighs explicit decisions only — auto-tagged spam doesn't dominate user-confirmed)
- A new `spam-suspect:<level>` label injected at ingest by a `senderReputationHook` (postClassify):
  - `level = 'high'` when `count >= 3` AND `spam_rate >= 0.7`
  - `level = 'medium'` when `count >= 3` AND `spam_rate >= 0.4`
  - `level = 'unknown'` for senders below threshold (no label — don't pollute)

Rules engine acts on the label: a default user rule could be "labels: ['spam-suspect:high'] → quarantine".

The hook does NOT make the quarantine decision — the user (via their rule) does. This keeps mark-not-spam reversible: a single not-spam decision drops `spam_rate` below threshold, the label disappears next ingest.

### Layer 4 — Content-hash dedup (campaign blast detection)

For each item, compute `sha256(normalize(body))`. Store last N hashes per sender in a sliding-window store (D1 table `mailroom_content_hashes` with a 7-day TTL). On ingest, if the same hash from the same sender lands within 24 hours → label `campaign-blast`.

Rules engine acts on the label. Cheap to compute, doesn't fire false positives on first delivery.

`normalize(body)` strips: tracking pixel URLs, unsubscribe links (which carry per-recipient tokens), all whitespace runs, sender-name salutations.

### Layer 5 — LLM classifier — DEFERRED

Document the integration point so a future iteration can slot it in:
- Single LLM call per ingest with a few-shot prompt
- Output: `{ verdict: 'spam' | 'not-spam' | 'uncertain', confidence: 0-1 }`
- Only fire when other layers say `uncertain` (e.g., `spam-suspect:medium` AND no `header:*` labels)
- Cost gate: max N calls/hour to avoid bill blow-up

Skip in v1. Reassess after 4-6 weeks of usage data.

## Triage feedback loop — the operator surface

This is the missing piece the user called out. Without this, spam rules grow only via manual rule-writing — which the user will never bother to do consistently.

### Endpoints

```
POST /inbox/:name/items/:id/mark-spam
  Body: { reason?: string }
  Effect:
    - Adds `spam` label to the item
    - Bumps sender's `spam_count` + writes `marked_at`
    - Returns: { item, sender_summary: { count, spam_count, not_spam_count, spam_rate } }
    - Optional: include rule-suggestion in response if spam_rate crossed a threshold this call

POST /inbox/:name/items/:id/mark-not-spam
  Body: { reason?: string }
  Effect:
    - Removes `spam` + `quarantined` labels (restores to default view)
    - Bumps sender's `not_spam_count` + writes `marked_at`
    - Returns: { item, sender_summary }
    - If sender currently has `spam-suspect:*` label injected → next ingest re-evaluates

GET /inbox/:name/spam-stats
  Returns: {
    senders_top_spam: [{ address, count, spam_count, spam_rate }, ...],  // ranked
    senders_recently_marked: [...],                                       // last 30d
    suggested_blocklist: [...],                                           // spam_rate >= 0.7, count >= 5
    suggested_whitelist: [...],                                           // not_spam_count > spam_count, count >= 3
  }

POST /inbox/:name/spam-stats/promote-rule
  Body: { sender: string, kind: 'blocklist' | 'whitelist' }
  Effect:
    - Creates a rule via the existing rules engine
    - blocklist → priority 100, action 'quarantine', match { from_email: <sender> }
    - whitelist → priority 0,   action 'tag',        match { from_email: <sender> }, action_args { tag: 'trusted' }
    - One-shot promotion. Returns: { created_rule, items_affected: N }
```

### MCP tools

```
sm_inbox_mark_spam(inbox, id, reason?)
sm_inbox_mark_not_spam(inbox, id, reason?)
sm_inbox_spam_stats(inbox)
sm_inbox_promote_spam_rule(inbox, sender, kind)
```

These slot into the `sm_inbox_*` family at `src/mcp/tools/inbox.ts`. Each is a thin HTTP forwarder + MCP test (mock-roundtrip pattern matches the admin tools we just shipped).

### Operator workflow (the user-facing story)

1. Spam lands → user runs `sm_inbox_query({ inbox: 'mailroom', filter: { labels: ['unread'] }})`
2. User sees a clearly-spammy item → `sm_inbox_mark_spam(inbox, id)`
3. After 3 spam marks from the same sender, `spam_stats` shows it as a `suggested_blocklist` candidate
4. User runs `sm_inbox_promote_spam_rule(inbox, sender, 'blocklist')` — creates the rule, retroactively quarantines existing items from that sender
5. Future mail from that sender hits Layer 1 (hard blocklist) → quarantined automatically
6. If the user later changes their mind: `sm_inbox_promote_spam_rule(inbox, sender, 'whitelist')` overrides (priority 0 wins) + retroactively un-quarantines

The system **learns from observed decisions**, not from pre-curated rules. False positives are recoverable in one tool call.

## Implementation sketch

Phasing — three sprints, each independently shippable.

### Sprint 1 — Triage primitives (the foundation)

Order matters: ship the manual triage path first so the system starts collecting data, THEN add the auto-rules that consume it.

**Files touched:**
- `src/messaging/sender-index.ts` — schema bump (`not_spam_count`, `marked_at`); back-compat default 0/undefined for existing rows
- `src/messaging/http-routes.ts` — 4 new endpoints (mark-spam, mark-not-spam, spam-stats, promote-rule)
- `src/mcp/tools/inbox.ts` — 4 new tools + handlers
- `tests/messaging-spam-triage.test.ts` (new) — unit + http-route + mcp roundtrip
- Update `tests/mcp-server.test.ts` tools/list assertion (52 → 56)

**Out of scope this sprint:** any new layers — just the triage surface + counter bumps. Reputation hook comes in Sprint 2 once we have data shape locked.

### Sprint 2 — Reputation + headers + content-hash (the layered defense)

**Files touched:**
- `src/messaging/spam-headers.ts` (new) — pure header-heuristic helpers (4 functions, ~80 lines)
- `src/messaging/spam-reputation.ts` (new) — `senderReputationHook` factory (postClassify), reads from sender-index, emits `spam-suspect:*` label
- `src/messaging/content-hash.ts` (new) — body normalization + hash + sliding-window store
- `src/adapters/cloudflare-d1-messaging-schema.ts` — new `mailroom_content_hashes` table (kv-shaped, with TTL)
- `deploy/src/index.ts` — wire the new hooks into the postClassify pipeline (after `confirm-detect`, before `auto-confirm`)
- Tests for each new file

### Sprint 3 — Rule suggestions + MCP polish (close the loop)

**Files touched:**
- `src/messaging/spam-stats.ts` (new) — `getSpamStats(senderIndex, windowDays)` returns the ranked output for the GET endpoint
- `src/messaging/http-routes.ts` — wire `/spam-stats` + `/spam-stats/promote-rule`
- `src/mcp/tools/inbox.ts` — `sm_inbox_spam_stats`, `sm_inbox_promote_spam_rule`
- Tests + MCP tools/list assertion bump

### Edge case decisions (resolved 2026-04-28 with user)

1. **Duplicate mark-spam on the same item — idempotent.** If the item already carries `spam`, the endpoint is a no-op for the counter; returns 200 with `{ already_spam: true }` so the caller can distinguish from "first mark." Implementation: skip the counter bump when `item.labels.includes('spam')`. No need for a per-sender `marked_items: string[]` — the item's own label IS the dedup key.

2. **Mark-spam on a forwarded item — attribute to the original sender, BUT a trusted forwarder breaks the chain.** Three-step resolution:
   1. If `fields.original_from_email` exists AND the forwarder (`fields.from_email`) carries the `trusted` tag in sender-index → attribute to **the forwarder**. Reasoning: a trusted curator's deliberate forward is signal about *their* curation choice, not a failure of the original sender. The forwarder's `spam_count` increments; the original sender is untouched.
   2. Else if `fields.original_from_email` exists → attribute to the original sender (the normal forward case — user got something gross from someone they don't have a trust relationship with).
   3. Else → attribute to `fields.from_email` (no forward chain).
   The decision logic lives in a small helper `resolveSpamAttribution(item, senderIndex): Promise<string>` and gets unit-tested directly.

3. **Mark-not-spam on an auto-confirmed item — revoke the auto-confirm allowlist entry, with an undo path.** When the item carries `auto-confirmed`, the mark-not-spam endpoint:
   - Removes `spam` + `quarantined` labels (normal mark-not-spam behavior)
   - Looks up the sender's auto-confirm allowlist pattern (if any matches `fields.from_email`)
   - Removes that pattern from `AutoConfirmSendersStore`
   - Returns the response with `{ revoked_auto_confirm: { pattern, source } | null }` so the caller knows what was undone
   - Undo path: re-add via existing `sm_auto_confirm_add(pattern, { source: 'runtime', notes: 'restored after mark-not-spam undo' })`. The response includes the revoked pattern's `source` so the caller can preserve provenance.
   - Documented in `mailroom-inbox/CLAUDE.md` under operator workflows.

4. **Trusted + spam-mark — trusted wins for ingest gating, but counter still increments. Repeats from trusted senders AMPLIFY (don't dedup).** Two parts:
   - **Ingest gating:** `trusted` tag short-circuits every spam layer below — no `spam-suspect:*` label gets emitted, no content-hash dedup applies, no rule-engine quarantine fires (trusted-priority rules win first).
   - **Counter still bumps:** `spam_count` increments normally on a trusted sender, so if the same trusted sender lands ≥5 marks the system can prompt the user to demote (`spam_count + not_spam_count >= 5 && spam_rate > 0.5 && has_trusted_tag` → emit a `consider_demote` field in the next mark-spam response).
   - **Repeat amplification:** Layer 4 (content-hash dedup) does NOT label trusted-sender repeats `campaign-blast`. Instead emits `repeated:trusted` so the caller can surface "this is being repeated, important." Reasoning: trusted senders re-sending the same content usually means "make sure you see this" — the user wants emphasis, not deduplication.

5. **Body normalization for content-hash — strip ESP tracking pixels and per-recipient tokens before hashing.** Explicit pattern list in `content-hash.ts`:
   - **Tracking pixel hosts** to drop entirely from body: `*.list-manage.com/track/*` (Mailchimp), `*.sendgrid.net/track/*` + `email.mg.*` (Mailgun/SendGrid), `*.email.beehiiv.com/c/*`, `*.substackcdn.com/image/*?token=*` (Substack), `*.convertkit.com/click/*`, `*.email.mailerlite.com/lt/*`.
   - **Inline 1×1 pixel tags:** `<img[^>]*(?:width=["']?1["']?|height=["']?1["']?)[^>]*>` — strip the whole tag.
   - **Per-recipient tokens in URLs:** any URL with a query string segment matching `[?&](token|t|c|recipient|email|user|uid)=[^&]+` — drop that single param while keeping the rest of the URL.
   - **Whitespace runs** (newlines + spaces + tabs) collapsed to single spaces.
   - **Sender-name salutations:** `^(Hi|Hello|Hey|Dear)\s+\S+,?\s*` at the start of a paragraph — strip.
   The helper is small (~30 lines) but explicit so future ESP additions are obvious. List grows over time as the user encounters senders we missed.

### Schema change (sender-index, back-compat)

```ts
// Before
interface SenderRecord {
  address: string;
  // ...existing fields
  spam_count: number;
}

// After
interface SenderRecord {
  address: string;
  // ...existing fields unchanged
  spam_count: number;
  not_spam_count: number;        // NEW — default 0 on read for legacy rows
  marked_at?: string;             // NEW — undefined for legacy rows
}
```

The `upsert()` path reads the existing row, sets `not_spam_count: existing?.not_spam_count ?? 0` for the merge — legacy rows pick up the default on first write after deploy. No migration needed.

## What success looks like

After 4 weeks of live usage:
- ≥ 90% of items the user marks spam are from senders that, by then, have a rule auto-quarantining future mail (the suggestion → promote flow works)
- ≤ 1% false-positive rate (items quarantined that the user later marks not-spam)
- Spam-stats endpoint reflects real distribution; `senders_top_spam` ranks senders we'd actually want blocklisted
- Zero LLM calls (Layer 5 still deferred, hasn't been needed)

If we're below those numbers, that's the signal to ship Layer 5.

## See also

- `src/messaging/sender-index.ts` — existing primitive; schema bump above
- `src/messaging/rules.ts` — existing rules engine; spam handling rides on top, no new action verb
- `.brief/mailroom-curation.md` — original curation design; spam is a follow-on use case
- `TASKS-MESSAGING.md § Spam layers` — phased task list
- Audit B027 (already shipped): tightened confirm-detect subject heuristic — adjacent issue, partial defense against confirmation-loop attacks at layer 0
