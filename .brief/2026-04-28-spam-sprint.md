# 2026-04-28 — Spam triage + layered defense sprint

**Status:** shipped (all three sprints, deployed)
**Design brief this built on:** `.brief/spam-layers.md` (preventive design, written same day before code)
**Deployed:** `smallstore.labspace.ai` versions `27873382` (Sprints 1+2) and `15a9a13a` (Sprint 3)

## What shipped

The whole spam-handling design — triage primitives, layered defenses, rule suggestions — went from "no spam handling at all" to "complete operator feedback loop" in one day. **2104/2104 tests green** at finish (started session at 2005, +99 spam tests across three sprints). 6 commits, 2 production deploys.

```
9c03d96  feat(spam): Sprint 3 — spam-stats ranking + promote-rule + MCP tools
0f00d79  feat(spam): Sprint 2 — header heuristics + reputation + content-hash
fa10685  docs: mark spam Sprint 1 [x] in TASKS-MESSAGING + log tests in TASKS-TESTS
0ec354f  feat(spam): Sprint 1 — triage primitives (mark-spam / mark-not-spam + attribution)
ce9215a  brief+tasks: encode 5 spam-design decisions into the implementation plan
7c9dfa5  brief+tasks: spam layers + triage feedback loop (preventive design)
```

## The arc

### Frame: preventive, not reactive

We had **zero spam volume** when the user said "spam layers... this is worth designing and briefing." That's the unusual part — most spam-handling gets shipped reactively after the inbox is on fire. Here we designed five layered defenses + a triage feedback loop with the user's mark-spam decisions as ground truth, before the first piece of real spam landed.

The preventive framing matters because it shaped the architecture: **the user is the source of truth, never the system.** No layer makes a terminal decision in isolation except the user-curated hard blocklist (Layer 1, which is just a rules-engine convention). Every other layer emits *labels* — `header:dmarc-fail`, `spam-suspect:high`, `campaign-blast` — and the rules engine acts on labels later. This makes false positives recoverable in one tool call and makes the system defensible: nothing hides mail the user hasn't seen.

### Five edge-case decisions resolved with the user

The brief asked five hard questions before any code was written:

1. **Idempotent mark-spam** — second call returns `{ already_spam: true }` without double-counting. The item's `spam` label IS the dedup key; no need for a per-sender `marked_items` array.
2. **Forward attribution** — trusted forwarder's deliberate forward is signal about *their* curation choice; the forwarder's `spam_count` bumps, not the original. Untrusted forward → original sender. No forward chain → from_email. Encoded into a small `resolveSpamAttribution()` helper.
3. **Auto-confirm revocation on mark-not-spam** — if the item carried `auto-confirmed`, the matching pattern gets revoked from the runtime allowlist. Response includes `revoked_auto_confirm: { pattern, source }` for the undo path.
4. **Trusted + spam-mark ambiguity** — trusted wins for ingest gating (spam-suspect labels never fire, content-hash dedup never quarantines), BUT the counter still bumps. After 5 marks with spam_rate > 0.5, the next mark-spam response includes `consider_demote: true` so the operator revisits the trust call. Layer 4 amplifies trusted-sender repeats with `repeated:trusted` rather than `campaign-blast` — re-sends from trusted curators are signal, not noise.
5. **Body normalization for content-hash** — explicit ESP pattern list (Mailchimp / SendGrid / Mailgun / Beehiiv / Substack / ConvertKit / MailerLite tracking URLs + per-recipient `?token=` params + 1×1 pixels + salutations + whitespace), not "best-effort regex." The list grows over time; making it explicit means future ESP additions are obvious.

All five resolved in one back-and-forth before code started. The brief's "edge case decisions" section is the durable artifact — those answers survive into the code as inline comments referencing the brief by decision number.

## Sprint 1 — triage primitives

Order matters in this kind of design: **ship the manual triage path first so the system starts collecting data, THEN add the auto-rules that consume it.** Sprint 1 was the foundation — schema bump on `SenderRecord` (`not_spam_count` + `marked_at`, default 0/undefined for legacy rows), `resolveSpamAttribution()` helper, `mark-spam` + `mark-not-spam` endpoints, 2 MCP tools.

The non-obvious bit: the `senderUpsertHook` only fires on the dispatch pipeline, not on `_ingest({ force: true })`. So the mark-spam endpoint can't rely on the deploy's hook to bump `spam_count` — it has to do the bump explicitly + handle the bootstrap case for never-tracked senders. Three tests caught this immediately when the first naive implementation skipped the bump (`spam_count` stayed 0). Fixed by lifting the upsert into the endpoint with a bootstrap path. **19 tests green**, one design subtlety captured for the next person.

Sprint 1 deployed earlier in the prior session. By the time Sprint 2 started, the live Worker was already collecting mark-spam data shape (just no actual marks yet — clean state).

## Sprint 2 — three parallel lanes

This is where fan-out paid off. Three lanes, file-disjoint by construction, ran in parallel:

- **Lane A — header heuristics** (`spam-headers.ts`, 148 lines, 28 tests): pure helpers `hasFromReplyToMismatch`, `hasGenericDisplayName`, `hasBulkWithoutListUnsubscribe`, `hasDmarcFail` (returns `'pass' | 'fail' | 'unknown' | 'none'`). Hook emits `header:*` labels; trusted-sender bypass at the top.
- **Lane B — sender reputation** (`spam-reputation.ts`, 110 lines, 14 tests): `senderReputationHook` reads sender-index, computes `spam_rate = spam_count / max(1, spam_count + not_spam_count)`, emits `spam-suspect:high` (≥0.7) / `spam-suspect:medium` (≥0.4). The denominator is **explicit decisions only**, not total `count` — auto-tagged spam still has weight, but explicit not-spam dilutes the rate as designed. `computeConsiderDemote` extracted as canonical pure function with parity-verified equivalence to the inline copy in `http-routes.ts`.
- **Lane C — content-hash** (`content-hash.ts`, 245 lines, 23 tests): `normalizeBody()` strips ESP tracking artifacts per the explicit pattern list, `hashBody()` does sha256, `ContentHashStore` is kv-shaped on the existing generic D1 adapter (key = `contenthash/<sender>/<sha256>`). 24h sliding window. Trusted-sender repeats label `repeated:trusted` instead of `campaign-blast`.

**~3 minutes wall-clock** for three subagents in parallel vs. ~10 minutes sequential. File-disjoint lanes meant zero merge conflicts.

### One mid-flight regex fix (Lane C)

The brief specified the salutation regex as `^(Hi|Hello|Hey|Dear)\s+\S+,?\s*` — with the comma optional. Lane C implemented exactly that. **Test failure caught it immediately:** the body `Hello <img src="..." width="1" height="1" /> world` was being normalized to empty string. Trace:

- `\S+` (greedy non-whitespace) matched `<img` as the "name" token
- `,?` optional matched the empty string
- Salutation regex consumed `Hello <img` and stripped it
- Then PIXEL_IMG looked for `<img...>` but there was no `<img` left
- Net: the test expected "hello" + "world" in the output; got empty

The agent self-fixed before reporting back: tightened to require comma + `[A-Za-z][\w'.-]*` for the name token (so HTML tags don't match). Documented inline citing the brief. The case is captured in tests so it can't regress: bodies with the same logical content but different per-recipient `?token=` URLs hash to the same sha256.

This is a good example of why writing tests *before* trusting the spec works — the brief said `,?` and the brief was wrong. Tests caught it; agent fixed it; comment explains why we diverged.

### Wiring

`deploy/src/index.ts` postClassify pipeline grew from 5 steps to 8:

```
newsletter-name → confirm-detect → header-heuristics → sender-reputation
                                ↑                                       ↓
                          NEW Sprint 2                    → content-hash
                                                                       ↓
                                                          → auto-confirm
                                                                       ↓
                                                          → stamp-unread
                                                                       ↓
                                                          → sender-upsert
```

Spam layers run **before** auto-confirm by design — high-suspicion senders shouldn't have their confirmation links auto-clicked. Pipeline comment in deploy expanded with the rationale for each step.

## Sprint 3 — close the operator loop

The triage feedback loop was the missing piece. Without it, the only way to grow spam rules is for the user to hand-write them — which they will never bother to do consistently. Sprint 3:

- **`spam-stats.ts`** — `getSpamStats(senderIndex, opts)` returns four ranked lists: top-spam (worst offenders), recently-marked (last 30 days), suggested-blocklist (count ≥ 5 AND spam_rate ≥ 0.7, trusted excluded), suggested-whitelist (≥3 explicit marks AND not_spam > spam, trusted excluded). Pure async, single I/O is the senderIndex.query pagination loop. 17 tests.
- **`GET /inbox/:name/spam-stats`** — auth-gated wrapper. Optional `window_days` and `limit` query params (clamped 1-500).
- **`POST /inbox/:name/spam-stats/promote-rule`** — body `{ sender, kind: 'blocklist' | 'whitelist' }`. blocklist creates priority-100 quarantine; whitelist creates priority-0 tag-with-`{tag: 'trusted'}` AND **runs `applyRetroactive` so existing items pick up the trusted tag immediately**. Quarantine is terminal so its retroactive is a no-op (returns 0 with `retro_error` from the rules engine — surfaced in the response). 13 HTTP integration tests.
- **`sm_inbox_spam_stats` + `sm_inbox_promote_spam_rule`** MCP tools. The promote-rule tool **rejects unknown `kind` locally** before any HTTP call (mock test verifies `mock.requests.length === 0`). 4 MCP roundtrip tests.
- **Operator workflow docs** in `mailroom-inbox/CLAUDE.md` — 5-step loop documented: see-spam → mark → after a few marks check spam-stats → promote → reverse course.

Sequential, not parallel — all four pieces touch `http-routes.ts` and `mcp/tools/inbox.ts`, so fan-out wouldn't have helped.

## Live verification

`smallstore.labspace.ai` is now serving:

```sh
$ curl -sS -H "Authorization: Bearer $SMALLSTORE_TOKEN" \
    "https://smallstore.labspace.ai/inbox/mailroom/spam-stats?limit=5" | jq
{
  "inbox": "mailroom",
  "senders_top_spam": [],
  "senders_recently_marked": [],
  "suggested_blocklist": [],
  "suggested_whitelist": []
}
```

Empty across all four lists — no spam marked yet on prod (we shipped before any real spam landed). The next operator session that finds spam can `sm_inbox_mark_spam` it; after a few marks the system will start surfacing candidates in `suggested_blocklist`.

## What's next (deliberately deferred)

- **Layer 5 — LLM classifier**: the brief documents the integration point but doesn't ship it. Trigger: 4-6 weeks of usage data showing rule-based + reputation-based catches are under-performing (e.g., uncertain senders that the user keeps marking spam without the rule-suggestion threshold firing). Cost gate: max N calls/hour to avoid bill blow-up.
- **Cross-user reputation sharing**: explicitly out of scope. Single-user mailroom, per-instance state.
- **Anti-spoofing crypto**: out of scope. Cloudflare Email Routing already filters at the edge.

## Lessons

- **Design before code, even on a one-day sprint.** The five edge-case decisions resolved before code started saved at least an hour of mid-implementation churn. The brief's "decisions" section is the durable artifact; tests reference it by decision number; future code can grep for `decision #N` and find both the answer and the rationale.
- **Trust the spec, but trust the tests more.** Lane C's salutation regex spec was wrong; tests caught it within seconds; comment explains the divergence. Don't write specs as if they're inviolate — they're a starting point, not a contract.
- **Fan-out only when files don't overlap.** Sprint 2's three lanes were file-disjoint by construction → 3 minutes parallel. Sprint 3's four pieces all touch `http-routes.ts` → ran sequentially. The bottleneck isn't agent count; it's file overlap.
- **Ship the manual triage path BEFORE the auto-rules.** Sprint 1's primitives generate the data shape that Sprints 2 and 3 consume. Reverse order would have meant guessing thresholds without real data. We still don't have real data on prod (clean state), but the system is set up to learn from the first 10 marks.
- **Production deploy is a hard wall.** Every deploy in this session needed explicit user authorization — "lets continue" wasn't enough for a production-changing action. Worth the friction; the cost of a bad deploy is much higher than the cost of asking.

## See also

- `.brief/spam-layers.md` — design brief (status: ready → shipped)
- `TASKS-MESSAGING.md § Spam layers` — phased task list (Sprints 1-3 all `[x]`)
- `mailroom-inbox/CLAUDE.md § Spam triage workflow` — operator-facing docs
- `src/messaging/spam-attribution.ts` / `spam-headers.ts` / `spam-reputation.ts` / `content-hash.ts` / `spam-stats.ts` — the five shipped modules
