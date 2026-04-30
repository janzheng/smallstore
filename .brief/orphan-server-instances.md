# Orphan smallstore-server instances from terminal-launched runs

**Status:** ready
**From:** investigation 2026-04-29 during `_deno/apps → __active/_apps` migration
**Task:** TBD — preflight check on `deno task serve` is the cheap fix (same pattern as brigade)

## Problem

Found **1 orphan smallstore-server process** (PID 43304) running for ~5 days from a closed terminal session: `deno task serve` was started in a Warp terminal, the user closed the terminal, the deno process was adopted by init (PPID=1) and kept running. No detection of an existing instance, no port-bind conflict failure (since it was the only smallstore-server running), no cleanup mechanism.

Unlike brigade, **smallstore doesn't have a launchd-managed "official" instance** to fall back on. The `com.smallstore.mailroom-sync.plist` runs a TigerFlare sync job (named misleadingly), not the smallstore HTTP server itself. So when we killed the orphan during the migration, nothing respawned — the server is just down until manually restarted.

## Sources

- `lsof` audit on 2026-04-29 turning up 1 smallstore-cwd process from `_deno/apps/smallstore` after the migration
- `ps`: PID 43304 ELAPSED ~5 days, PPID=1 (orphaned via parent shell exit)
- `deno.json`: `"serve": "deno run --allow-all serve.ts"` — no preflight, no PID file, no instance check
- Same root cause as `__active/_apps/brigade/.brief/orphan-server-instances.md` — terminal-launched, no detection of existing instance, orphans on shell exit

## Investigation

What we know:

- `deno task serve` runs `serve.ts` directly. No PID file, no port probe, no detection of an existing instance.
- The launchd plist `com.smallstore.mailroom-sync` is for **inbox-mirror syncing** (running tigerflare's `src/sync.ts`), not the smallstore HTTP server. The naming is misleading.
- Smallstore's HTTP server is currently a **dev-only / manual-start** thing — it doesn't have a "production stays-running" story like brigade's `com.brigade.hackernews`.
- Smallstore deploys to Cloudflare (`smallstore.labspace.ai`) — local serve is for development. So orphaned local servers are nuisance, not load-bearing.

What we don't know:

- Whether smallstore should have a launchd-managed local server at all, or whether local serve is purely development. If purely dev, the fix is just "fail loudly on duplicate" rather than "set up durable management."
- Whether there are other dev tasks (`serve:watch`, etc.) that should also fail-fast on duplicate.

## Recommendation

**Same preflight pattern as brigade**, but skip the launchd-plist work since smallstore deploys to Cloudflare and local serve is dev-only.

When `deno task serve` runs, before binding the port:

1. **Probe `http://127.0.0.1:<PORT>/health`** (or whatever existing endpoint can confirm an instance). If it responds, refuse with: "smallstore-server already running locally. Stop it (`pkill -f smallstore.*serve.ts`) or run on a different port."
2. **Optional `--force-replace`** flag — kills the existing instance and starts fresh.

Skip the launchd plist unless we explicitly decide smallstore needs a long-running local server.

## Implementation Sketch

### Preflight in `serve.ts`

Borrow the pattern from `__active/_apps/brigade/.brief/orphan-server-instances.md` § "Preflight in server.ts". Same logic, different port. Likely 10-15 lines of TypeScript at the top of `serve.ts`:

```typescript
const port = Number(Deno.env.get("SMALLSTORE_PORT") ?? 8080);

async function preflight() {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (resp.ok || resp.status === 404) {
      console.error(`Port ${port} already serving — smallstore-server already running locally.`);
      console.error(`Stop it: pkill -f smallstore.*serve.ts`);
      console.error(`Or run on a different port: SMALLSTORE_PORT=8081 deno task serve`);
      Deno.exit(1);
    }
  } catch {
    // no response — port is free, OK to start
  }
}
```

If smallstore-server doesn't already have a `/health` endpoint, add one returning `{ pid, started_at, version }` so the message can identify which instance is up.

### Rename or document the misleading plist

`com.smallstore.mailroom-sync.plist` runs tigerflare's sync — not a smallstore server. Either:
- Rename to `com.smallstore.inbox-mirror-sync.plist` (clearer)
- Or add a comment / README note explaining what it actually does

Low priority — naming nit, not load-bearing.

## What we did to recover from the bug on 2026-04-29

- Killed the orphan PID 43304.
- No respawn — smallstore-server is just down locally until manually started.
- Production smallstore on Cloudflare unaffected (`smallstore.labspace.ai`).
- The mailroom-sync plist (running tigerflare's sync against `__active/_apps/tigerflare`) was patched and respawned cleanly.

## See also

- `__active/_apps/brigade/.brief/orphan-server-instances.md` — same pattern, fix is identical.
- `__active/_apps/tigerflare/.brief/process-explosion.md` — same orphan-from-terminal pattern, plus a per-space process explosion.
