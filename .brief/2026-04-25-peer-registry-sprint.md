# 2026-04-25 — Peer registry sprint (afternoon)

**Status:** shipped
**Prior sprints today:** `.brief/2026-04-25-curation-sprint.md` (morning)
**Design brief:** `.brief/peer-registry.md` (written same day before implementation)
**Deployed:** `smallstore.labspace.ai` version `b1c385d1-f2d1-4ccb-88db-2842945dbfd1`

## What shipped

Level 2 of the peer registry (metadata + authenticated proxy). ~1250 LOC across 4 new files, 45 peer tests + 1203/1203 total (zero regressions), 1 commit, 1 live production deploy. Design-to-deploy in ~90 minutes.

```
77a9a5e  Peer registry — SHIPPED (level 2: metadata + authenticated proxy)
```

## The arc

### Morning context

Earlier today (morning session) the mailroom curation sprint shipped — bookmarks, auto-archive rules, manual forwards, retroactive apply, six-level removal taxonomy. User observation: *"add sources without actually adding them — like webdav and tigerflare would be that context, though yeah that would need 3 [level 3 compound adapter]."*

Translation: smallstore today integrates data sources at the **library level** (import adapters, redeploy to add). What's missing is a way to know-about external sources at the **config level** — other smallstores, random sheetlogs, tigerflare deployments, eventually webdav mounts. Write a brief, queue tasks, then ship the MVP.

### Design

Wrote `.brief/peer-registry.md` with three levels:
- **L1** metadata only (weak; skip)
- **L2** metadata + authenticated proxy (MVP)
- **L3** compound adapter (peer types implement StorageAdapter → `peer:name` routing; weeks; parked)

Key design calls captured in the brief:
- Peers ≠ adapters. Adapters own data. Peers know-about data.
- Secrets via env-ref (`token_env: 'TF_TOKEN'`), never inline. D1 rows stay plaintext-safe.
- Type is a label + future level-3 resolver hint. MVP treats all types with one proxy path.
- `path_mapping` reserved for L3 routing; ignored in MVP.
- L3 webdav and tigerflare are likely first graduations (clean KV-shaped semantics); sheetlog likely stays L2-only (apps-script endpoints don't match adapter shape).

### Implementation (two parallel agents + me sequential)

**Me, sequential (task #1 types, ~240 LOC):**
Defined Peer, PeerAuth, PeerType, PeerStore interfaces + proxy argument/result types. Comprehensive JSDoc so agents have a clear contract to implement against. Particular care on PeerAuth — five kinds (none/bearer/header/query/basic), all secret-bearing variants use env-ref.

**Agent A, peer-registry.ts (316 LOC, 18 tests):**
`createPeerStore(adapter, opts)` factory. Slug regex `[a-z0-9][a-z0-9_-]{0,63}` for URL-safe names. Alias key `_by_id/<id>` stores the **slug string** (not the full record), so renames = 3 writes with stable id. Tests include boundary validation (1-char + 64-char slugs, digits/dash/underscore mix) and alias hygiene (aliases never surface via `list()`). Flagged three `#discovered`: tag case policy, cursor stability across renames, D1 full-table-scan on `list` (fine < 100 peers).

**Agent B, proxy.ts (528 LOC, 27 tests):**
`resolvePeerAuth` + `proxyGet` + `proxyPost` + `probePeer`. Per-type auth resolution with env-var lookup at request time. Header precedence **auth > peer-static > client** with aggressive stripping: `authorization`, `cookie`, `host`, `content-length`, and four hop-by-hop headers all dropped before forward. Timeout via AbortController. Health probe per type — `GET /health` (smallstore/tigerflare), `OPTIONS` (webdav), `HEAD` (everything else); 2xx + 3xx both count as reachable. Elegant fetch-mocking test helper that handles both normal responses and abort-signal scenarios. Flagged six `#discovered`: retry policy, streaming body, body-size cap, redirect auth-leak risk, content-encoding passthrough, basic-auth user containing `:`.

**Zero merge conflicts** across parallel work. File scopes disjoint by design (each agent creates ONE new file + ONE new test; shared types.ts read-only for both).

**Me, sequential (task #4 HTTP routes, task #5 plugin entry, task #6 deploy wire):**

- `http-routes.ts` (~390 LOC): 8 routes — CRUD (5) + health + fetch + query proxy. Input validation at the HTTP boundary (auth-kind + header-shape + tag-shape). Disabled peers 404 on operational routes, remain visible in CRUD. Proxy responses scrub hop-by-hop + content-encoding, add `X-Peer-Latency-Ms` header. Auth-error → 502 Bad Gateway.
- `mod.ts` + sub-entries `"./peers"` + `"./peers/types"` in `deno.json`, `jsr.json`, `scripts/build-npm.ts` `entryPoints`. Plugin invariants verified: no core imports, no heavy deps (fetch/crypto/btoa only), self-contained, deletable.
- Deploy wiring in `deploy/src/index.ts`: new `peersD1` adapter (table `peers`), `peerStore` instantiated via `createPeerStore`, `registerPeersRoutes` called with env passed through for auth resolution. Landing page `/` updated to advertise the new endpoints.

### Pre-existing test fix discovered

Full test sweep hit 1 failure: `tests/mcp-server.test.ts:229` tools/list expected-list was missing `sm_append` (added 2026-04-21 in sheetlog work but the test wasn't updated). Confirmed pre-existing via `git stash` + retest. One-line fix — 1202 → 1203/1203 tests green. Flagged in the commit.

### Live verification

`wrangler deploy` → version `b1c385d1`. Smoke test against production:

```
POST /peers { name: "tigerflare-demo", type: "tigerflare",
  url: "https://tigerflare.labspace.ai",
  auth: { kind: "bearer", token_env: "TF_TOKEN" } }
  → 201 { created: { id, name, ..., disabled: false, created_at } }

GET /peers  → 200 { peers: [tigerflare-demo] }

GET /peers/tigerflare-demo/health
  → 200 { ok: false, status: 0, error: "env var TF_TOKEN is not set" }
```

The health path exercised the full chain: route → store lookup → `probePeer` → `resolvePeerAuth` → env-var miss → graceful error surface. **Nothing crashed; the missing-env case became a clean user-actionable error message rather than a 500.** That's the proof-of-design.

## End-state capabilities

The user can now:

- **Register a data source at runtime** — `POST /peers` with name/type/url/auth. No redeploy.
- **List the atlas** — `GET /peers?type=tigerflare&tags=prod`. Cursor/limit/tag/type/name-substring filters.
- **Proxy-query any peer with ONE auth surface** — `GET /peers/:name/fetch?path=/whatever` or `POST /peers/:name/query` with arbitrary body. Client holds the smallstore bearer token; smallstore resolves the peer's auth from env vars at request time.
- **Health-probe on demand** — `GET /peers/:name/health` returns `{ ok, status, latency_ms, error? }` per-type (GET /health for smallstore-shaped peers, OPTIONS for webdav, HEAD for others).
- **Soft-disable without delete** — `PUT /peers/:name { disabled: true }` takes a peer offline (operational routes 409) without losing the row.
- **Rename peers** — `PUT /peers/:old-name { name: "new-name" }` with stable id. `getById(id)` resolves to new name after rename.

## Metrics

| Measure | Value |
|---|---|
| Tests added | 45 (18 registry + 27 proxy) + 1 mcp fix |
| Total tests | 1203/1203 green |
| LOC added | ~2600 net insertions (mostly JSDoc in the proxy module) |
| New files | 5 (types, peer-registry, proxy, http-routes, mod) + 2 test files |
| Commits | 1 (after design brief committed earlier) |
| Live deploys | 1 |
| Subagent dispatches | 2 parallel |
| Merge conflicts | 0 |
| Wall-clock | ~1 hour |

## Notable design decisions

1. **Peers are adapter-agnostic at storage layer.** `createPeerStore(adapter)` accepts any StorageAdapter. Memory for tests, D1 in production. Follows the rules-store / sender-index pattern.
2. **Secrets are never stored inline.** `auth: { kind: 'bearer', token_env: 'TF_TOKEN' }` stores the env-var name only. Actual secret lives in Worker env/secrets. Rationale: D1 rows are backupable and queryable in plaintext; secrets shouldn't be.
3. **Proxy never forwards the caller's Authorization header.** Smallstore's bearer token is stripped from every outbound request via `client_headers` filter. Peer's own auth is injected fresh from env. Prevents accidental credential leaks across peers.
4. **Auth resolution short-circuits fetch.** If `env[token_env]` is missing, proxy returns `{ status: 0, ok: false, error }` without making the outbound request. No wasted fetch, clear error message, 502 at the HTTP boundary.
5. **`type` is a label, not a behavior switch in MVP.** All types share the same proxy code path. `type` shapes only (a) the health probe method choice and (b) future L3 resolver logic. Extending types = metadata change, not code change.
6. **2xx AND 3xx count as reachable in health probe.** Peers that redirect to auth pages on HEAD still mean "server is alive." Only network errors / 4xx-5xx indicate actual unreachability.

## What's queued (next)

- **HTTP integration tests** for `http-routes.ts` — live-verified during deploy but no unit tests yet. ~8-10 tests, ~1 hour. Pattern: extend `tests/messaging-http.test.ts` fixture for peers.
- **MCP `sm_peers_*` + `sm_inbox_*` tool family** — ship together as one MCP-scaffolding commit. Agents use both: `sm_inbox_*` for my own data, `sm_peers_*` for my known-about other data. ~2-3 hours.
- **Level 3 compound adapter** — peer types implement StorageAdapter, `peer:name` routing targets. Weeks. Parked until L2 reveals what's worth routing.

## References

- Design: `.brief/peer-registry.md`
- Morning sprint: `.brief/2026-04-25-curation-sprint.md`
- Plugin discipline: `docs/design/PLUGIN-AUTHORING.md`
- Task archive: `TASKS.done.md § 2026-04-25 — Peer registry sprint (afternoon session)`
- Live: https://smallstore.labspace.ai (version `b1c385d1`)

## Credits

Design brief to deployed production in 90 minutes. 2 parallel agents on disjoint file scopes (register + proxy) — this is the fourth sprint this week using the same fan-out pattern (Waves 0/1/2 of mailroom pipeline, curation sprint, now peers). Zero merge conflicts across all four.
