---
date: 2026-04-29
tags: migration, mailroom, mirror, tigerflare, peer-registry, ops, preflight, mcp
type: synthesis
sources: smallstore, tigerflare, mcp-hub, brigade
---

# Migration cleanup, mirror handoff to tigerflare, and serve.ts preflight

Session was nominally "fix smallstore after `_deno/apps → __active/_apps` migration" but actually surfaced two distinct things: the mailroom mirror's role got handed to tigerflare's universal space-sync at some point today, and the orphan-server pattern from the migration motivated a real preflight ship.

## What we did

1. **Re-pointed user-scope MCP configs** for smallstore / tigerflare / brigade to the new `__active/_apps/` paths (CLAUDE.md already had the re-register command for smallstore — used same pattern for the others). Killed ~10 stale `deno run … _deno/apps/…/mcp-server.ts` zombies left over from old Claude Code sessions.
2. **Synced project-canonical `skills/smallstore/SKILL.md`** to the hub mirror at `mcp-hub/skills/smallstore/`, then ran `sync-skills.sh` + `sync-remote.sh` to push to local consumers + sparkie + erko. Hub copy was ~50 lines behind project (missing newsletter views, todos, mirror, replay tools).
3. **Shipped single-instance preflight on `deno task serve`** (commit `a321b11`). `serve.ts` probes its own `/health` before binding; refuses with a `kill <pid>` message identifying the running instance. `/health` enriched to return `{ status, pid, started_at }` so the message can fingerprint. Closes the closed-terminal-orphan pattern documented in `.brief/orphan-server-instances.md`.
4. **Cleaned up the obsolete mailroom mirror path.** `tf://scratch/mailroom-mirror/` (cloud) + `tigerflare/data/cloud/scratch/mailroom-mirror/` (local 736K) — both gone.
5. **Trivial doc fix** (commit `1ced8a7`): two `_deno/apps → __active/_apps` rewrites in `research/_workshop/messaging-plugins-inbox-outbox.md` the migration commit missed.

## The mistake worth remembering

User said "we disabled `com.smallstore.mailroom-sync.plist` during migration, kick it off properly." I did the literal thing — renamed `.disabled-2026-04-29` back to `.plist`, `launchctl load`. It loaded fine, /tmp logs looked clean.

What I didn't notice: **the smallstore peer config target had moved from `/scratch/mailroom-mirror/` to `/mailroom/` at some point during the session.** The plist still pointed at `/scratch/mailroom-mirror/` — pulling from a path that no longer received writes. It was a no-op that *looked* healthy because SSE connected and the initial sync correctly reported "Pulled: 0, Pushed: 0".

Another agent caught this and flagged it. I unloaded the plist + re-disabled it.

**Lesson:** when something has been "disabled during migration," don't re-enable on reflex. First check whether its function has been absorbed elsewhere. In this case tigerflare-server's universal `/mailroom` space sync (PIDs 95681/95682, spawned by `com.tigerflare.server`) had quietly taken over the role.

## The architecture clarification (worth keeping)

User asked "we're running mailroom and tigerflare in the same process? I thought they were two very different things?"

They are. The connection is the smallstore peer registry, not a process boundary:

- **smallstore** = pure CF Worker. No local process. Its 30-min cron renders the mailroom inbox to per-newsletter markdown and PUTs to whatever URL its `tigerflare-demo` peer points at.
- **tigerflare** = separate service with both a CF Worker (cloud side) and a local launchd daemon `com.tigerflare.server` (disk side, port 18787). The local daemon spawns per-space sync workers — one of those happens to be syncing the path called `/mailroom/` because that's where smallstore writes.
- The deno processes named with "mailroom" in their args are tigerflare's, not smallstore's. Tigerflare doesn't know or care that the data came from a mailroom inbox; from its perspective it's just files in a space.

Pre-migration the smallstore-specific plist `com.smallstore.mailroom-sync` ran a bespoke pull-only sync of `/scratch/mailroom-mirror/`. Post-migration tigerflare absorbed this into its general space-sync and the smallstore-specific plist became redundant — the user disabled it intentionally.

## What we kept out

- **`--force-replace` flag on preflight** — `kill <pid>` from the /health response is one keystroke shorter than a flag, and the orphan use case is rare enough to not earn the complexity.
- **Prod /health fingerprinting** — CF Workers run V8 isolates, no PID concept, can't be `kill`ed by the user. The preflight is local-dev specific by design. Prod stays `{status: 'ok'}`.
- **Making tigerflare's `/mailroom` space pull-only** — user said "keep it simple, treat it like any other tf/smallstore behavior for mailroom." Bidirectional is fine; user accesses the mirror via webdav anyway and isn't editing files.
- **Deleting `_deno/apps/{smallstore,tigerflare,brigade}` stale copies** — destructive, deferred. Tracked in TASKS.md as `[?]` for explicit go-ahead later.

## What surprised us

- **MCP servers really fork per Claude Code session.** User didn't know this — was confused by another agent's "16 zombie deno procs" claim. With 4 active sessions × 4 MCP servers (smallstore, tigerflare, brigade, deno-hub) = exactly 16. Not zombies, just legitimate session children. Closing idle Claude sessions is the cleanup.
- **The peer config target moved mid-session.** Probably another agent or the user did this around 18:03 PDT — by the time I checked, target was `/mailroom/` not `/scratch/mailroom-mirror/`. Worth knowing because the `tigerflare-demo` peer is the canonical wiring between smallstore and tigerflare, and it's editable at runtime via `sm_peers_update` — easy to miss if you're not looking.
- **Another agent's three-issue audit was 1/3 right.** The path-rewrite catch was good. The "bidirectional sync regression" was real but explained by the architecture shift, not introduced by me. The "16 zombie procs" was a miscount of live sessions.

## Open questions / followups

- The plist `com.smallstore.mailroom-sync.plist.disabled-2026-04-29` is now permanently retired (function absorbed by tigerflare). Could delete the file outright or rename to remove the misleading "smallstore" prefix. Tracked in TASKS.md as `[?]` plist naming nit.
- `deploy/.env` token is shared via working-directory env across many sessions — fine, but worth knowing if we ever rotate the smallstore token.
- TASKS.md still has `[?]` for cleaning the `_deno/apps/{smallstore,tigerflare,brigade}` copies. Cross-project chore — when that happens, the smallstore task entry can also point at the parallel cleanup needed in tigerflare + brigade.

---

<source>Session ran 16:23–19:00 PDT 2026-04-29 in `__active/_apps/smallstore`. Commits: `a321b11` (preflight), `1ced8a7` (path sweep). Brief: `.brief/orphan-server-instances.md`.</source>
