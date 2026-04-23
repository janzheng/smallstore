# Peer registry — smallstore knows about other data sources

**Status:** shaping (not started)
**From:** 2026-04-25 conversation — user asked about linking smallstore to tigerflare / sheetlogs / other smallstores without fully importing them
**Pairs with:** `sm_inbox_*` MCP tool family (both contribute to agent-facing data-landscape tooling)

## The idea in one line

**Peers are to adapters what symlinks are to files** — smallstore knows a data source exists over there and has a standard way to reach it, without owning it.

## Motivation

Today, smallstore adapters are library-level: you import `createCloudflareD1Adapter`, `createSheetlogAdapter`, etc. in code and configure them at deploy-time. Adding a new data source means redeploying the Worker.

But the user's actual landscape has **many data sources already out there**: tigerflare (its own D1+R2), random google sheetlogs (apps-script endpoints), other smallstore deployments, maybe webdav later. A user's personal "data atlas" is fragmented across these by design — they're separate projects with separate storage — but there's no way for smallstore to *know* about them so an agent could:

- List "what data sources do I have access to?"
- Query any of them from a single HTTP surface
- Eventually route writes through them as if they were native adapters

The user's phrasing: *"add sources without actually adding them"*, *"'symlink' the tigerflare_db repo so at least smallstore can 'know' about it"*, *"index all the random google sheetlogs, other smallstores, and storages that are everywhere."*

## Adapters vs. peers — the key distinction

| | **Adapter** | **Peer** |
|---|---|---|
| Lives where | Code (library import) | D1 row (runtime config) |
| Added via | Redeploy | `POST /peers` |
| Smallstore "owns" the data? | Yes | No — another system does |
| Routing target? | Yes (`notion/*` → notion adapter) | Not in MVP (level 3) |
| Interface | StorageAdapter (`get/set/delete/query`) | Arbitrary HTTP / type-specific |
| Examples | D1, R2, Notion, Airtable, Upstash | tigerflare-prod, random sheetlogs, webdav mount, another smallstore |

Peers are **a layer above adapters**. They don't replace the adapter concept — they augment it. Every adapter this smallstore has is NOT a peer (owned). Every external data source is NOT an adapter in MVP (not routable). Some things eventually graduate from peer to adapter-via-peer when level 3 ships.

## Three levels of power

### Level 1 — Metadata only (weak)

Smallstore has a list of peers with names, types, URLs. No actual connectivity.

```
GET /peers                     → list
GET /peers/:name               → metadata
POST/PUT/DELETE /peers[/:name] → CRUD
```

Agent-side: `sm_peers_list()` returns the atlas. Useful as "what data exists?" reference but you still have to hit each peer directly with its own auth.

**Verdict:** too weak alone. Skip unless there's a reason to stage.

### Level 2 — Metadata + proxy (MVP)

Everything in level 1, plus smallstore acts as an authenticated proxy:

```
GET  /peers/:name/fetch?path=<url-encoded-path>  → forwards GET to peer.url + path
POST /peers/:name/query                          → forwards POST body to peer.url
GET  /peers/:name/health                         → probe with best-effort HEAD
```

Agent holds ONE bearer token (smallstore's), uses `sm_peers_fetch('tigerflare-prod', '/inbox/mailroom.md')` and smallstore resolves the peer's auth from its env vars + forwards. Cross-source query becomes trivial.

**Verdict: MVP target.** Ships in a day, already useful, doesn't preclude level 3.

### Level 3 — Compound adapter (future)

Per-type adapter implementations. `type: 'tigerflare'` resolves to a `TigerflareAdapter` that implements `StorageAdapter`. Routing table accepts `peer:name` targets:

```ts
routing: {
  'tf/*': { target: 'peer:tigerflare-prod' },
  'dav/*': { target: 'peer:home-webdav' },
}
```

Then `tf_write(path, data)` in the smallstore MCP tool routes writes through the tigerflare peer. Same for webdav (PROPFIND/PUT semantics wrapped in adapter shape). This is the "compound adapter" the user named.

**Verdict: weeks of work, premature until level 2 reveals what's actually worth routing.** Webdav is the clearest level-3 case since it has adapter-shaped semantics (files in folders = keys in a k/v store). Tigerflare is the second (HTTP-backed KV with some extras). Sheetlog is trickier — apps-script endpoints don't cleanly match adapter semantics; might stay level-2-only forever.

## MVP design (level 2)

### Peer shape

```ts
interface Peer {
  id: string;                          // uuid, PK in D1
  name: string;                        // url-safe slug, unique, used in paths
  type: PeerType;                      // 'smallstore' | 'tigerflare' | 'sheetlog' | 'http-json' | 'webdav' | 'generic'
  url: string;                         // base URL (no trailing slash)
  description?: string;                // human note
  auth?: PeerAuth;                     // auth config (stored, but secret values via env ref)
  headers?: Record<string, string>;    // static headers to forward on every request
  tags?: string[];                     // for filtering ('prod', 'personal', 'archive')
  capabilities?: string[];             // advertised: ['read', 'write', 'list', 'query']
  disabled?: boolean;
  created_at: string;
  updated_at?: string;
  // Level-3 hooks (ignored in MVP):
  path_mapping?: Record<string, string>;
}

type PeerAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token_env: string }         // Authorization: Bearer <env[token_env]>
  | { kind: 'header'; name: string; value_env: string }  // custom header
  | { kind: 'query'; name: string; value_env: string }   // auth via query param (sheetlog style)
  | { kind: 'basic'; user_env: string; pass_env: string };// HTTP basic (webdav)
```

**Secrets always via env ref, never inline.** The D1 row stores `{ kind: 'bearer', token_env: 'TF_TOKEN' }` — the actual token lives in Worker env vars / secrets. Resolution happens at request time. Rationale: D1 rows are backup-able + queryable in plaintext; secrets shouldn't be.

### Peer types

Minimal per-type knowledge in MVP. Most types share the same proxy path; `type` is a label for UX + future level-3 resolution.

- `smallstore` — bearer-auth proxy to another smallstore Worker (/api, /inbox, etc.)
- `tigerflare` — bearer-auth proxy to a tigerflare Worker
- `sheetlog` — query-param-auth proxy to an apps-script web app
- `http-json` — generic HTTP JSON endpoint (no type-specific smarts)
- `webdav` — basic-auth; mostly a placeholder in MVP (full support = level 3)
- `generic` — fallback; proxy as-is

### Storage

D1 table `peers` via `createCloudflareD1Adapter({ table: 'peers' })` in generic k/v mode. Same pattern as `mailroom_senders` + `mailroom_rules`. Adapter-agnostic so tests use MemoryAdapter.

### HTTP surface

All behind `requireAuth`:

```
GET    /peers                             — list (cursor + limit + tags[] filter)
GET    /peers/:name                       — metadata
POST   /peers                             — create
PUT    /peers/:name                       — partial update
DELETE /peers/:name                       — remove
GET    /peers/:name/health                — best-effort probe (HEAD peer.url, 5s timeout)
GET    /peers/:name/fetch?path=<path>     — proxy GET; forwards auth
POST   /peers/:name/query                 — proxy POST; body forwarded verbatim
```

Proxy routes add outbound auth per `peer.auth`:
- `bearer` → `Authorization: Bearer ${env[token_env]}`
- `header` → `${name}: ${env[value_env]}`
- `query` → append `?${name}=${env[value_env]}` to the path
- `basic` → `Authorization: Basic ${base64(user:pass)}`

### Path handling on proxy

`GET /peers/tigerflare-prod/fetch?path=%2Finbox%2Ftest.md` → forwards to `${peer.url}/inbox/test.md`. URL-decode the `path` query param, concat with `peer.url`, preserve any other query params from the client request (so `?path=/inbox&cursor=abc` forwards `cursor=abc` too).

### MCP tools (pair with sm_inbox_* family)

```
sm_peers_list()                        — returns all peers (name + type + url)
sm_peers_get(name)                     — metadata
sm_peers_create(peer)                  — create
sm_peers_update(name, patch)
sm_peers_delete(name)
sm_peers_fetch(name, path)             — proxy GET, returns body
sm_peers_query(name, body)             — proxy POST, returns body
sm_peers_health(name)                  — returns reachability + latency
```

Ship alongside `sm_inbox_*` family in one shot — agents use both: inbox for "my own data" + peers for "my known-about other data."

### Seeding

If the smallstore skill in mcp-hub has a companion data repo (pattern: `__resources/collections/smallstore/`), the repo can ship a `peers.seed.json` that's loaded on first boot into the registry. Optional — the HTTP API lets you add peers live too. Stale entries in the seed don't overwrite existing rows unless `?overwrite=true` on boot.

### Health + probe semantics

`GET /peers/:name/health` probes the peer with the SHORTEST safe request per type:
- `smallstore` / `tigerflare` — `HEAD ${peer.url}/health`
- `sheetlog` — `HEAD ${peer.url}` (apps-script doesn't have a standard health)
- `webdav` — `OPTIONS ${peer.url}`
- `http-json` / `generic` — `HEAD ${peer.url}`

Returns `{ ok: boolean, status?: number, latency_ms: number, error?: string }`. Never caches (real-time probe).

## Relationship to existing primitives

- **Not** a replacement for adapters — distinct layer
- **Not** a plugin like messaging — peers is a first-class smallstore core concept (or a sibling plugin-family, follows the 4 invariants)
- **Pairs with** the MCP `sm_inbox_*` tool family — both are agent-facing surfaces for data awareness
- **Consumers of existing primitives:** peers storage reuses the StorageAdapter pattern (MemoryAdapter in tests, D1 in prod); peers routes reuse the `requireAuth` middleware; peers auth uses the existing env-var pattern

## Task queue (ordered by dependency)

### Foundational

- [ ] **`src/peers/types.ts`** — Peer, PeerAuth, PeerType, PeerStore interfaces. ~100 LOC #peers-types
- [ ] **`src/peers/peer-registry.ts`** — `createPeerStore(adapter, opts)` with CRUD + health + auth resolution helper `resolvePeerAuth(peer, env) → {headers, urlSuffix}`. Adapter-agnostic. ~300 LOC #peers-store
- [ ] **`src/peers/proxy.ts`** — `proxyGet(peer, path, env, clientHeaders?)` + `proxyPost(peer, body, env, clientHeaders?)` + `probePeer(peer, env)`. Wraps `fetch` with per-type auth + timeout + header forwarding. ~200 LOC #peers-proxy

### HTTP

- [ ] **`src/peers/http-routes.ts`** — `registerPeersRoutes(app, { peerStore, requireAuth, env })`. 8 routes (list, get, create, update, delete, health, fetch, query). Validation via `validatePeerInput` helper. ~250 LOC #peers-http

### Plugin discipline

- [ ] Mod entry + exports: `src/peers/mod.ts` exports `createPeerStore`, `registerPeersRoutes`, types. Add sub-entry `@yawnxyz/smallstore/peers` to `deno.json` + `jsr.json` + `scripts/build-npm.ts` `entryPoints`. Follow PLUGIN-AUTHORING.md invariants (no core imports, no heavy deps, self-contained, deletable) #peers-plugin-entry

### Deploy wiring

- [ ] `deploy/src/index.ts` — instantiate `peersD1 = createCloudflareD1Adapter({ binding: env.MAILROOM_D1, table: 'peers' })`, `peerStore = createPeerStore(peersD1)`. Register routes: `registerPeersRoutes(app, { peerStore, requireAuth, env })`. #peers-deploy-wire

### MCP

- [ ] `sm_peers_*` MCP tools — list/get/create/update/delete/fetch/query/health. Ship with `sm_inbox_*` family as one MCP tool-suite commit for consistency. Requires the `sm_inbox_*` work to land first (since they share the MCP scaffolding) #peers-mcp #needs:mcp-inbox-family

### Tests

- [ ] `tests/peers-registry.test.ts` — CRUD + validation + disabled rules + tags filter. 10-12 tests #peers-tests-registry
- [ ] `tests/peers-proxy.test.ts` — mock fetch, verify auth injection per PeerAuth kind + timeout + header forwarding. 8-10 tests #peers-tests-proxy
- [ ] `tests/peers-http.test.ts` — extends existing http test fixture. CRUD + fetch/query proxy + health + 501 when peerStore not wired. 10-12 tests #peers-tests-http

### Live verification

- [ ] Seed one tigerflare peer + one sheetlog peer + one other-smallstore peer against the live deploy. Verify `GET /peers/:name/fetch` returns expected payload from each. Document what's reachable via the atlas #peers-live-verify #needs:peers-deploy-wire

## Out of scope (explicitly parked)

Each has its own future task when the trigger fires:

- **Level 3 compound adapter** — peer types implement StorageAdapter, `peer:name` routing targets, full webdav / tigerflare KV semantics. Promote when MVP reveals a specific peer type that really needs routing-level integration (webdav is the likely first). #peers-level-3-compound
- **Per-type query translation** — sheetlog's apps-script query semantics → smallstore's InboxFilter DSL. Useful but non-obvious; defer until someone hits it. #peers-sheetlog-query-bridge
- **Smallstore-to-smallstore federated search** — `POST /peers/:smallstore-peer/inbox/:remote-inbox/query` effectively federates. Trivially supported by proxy today; "federated" becomes a feature when you want to query N peers at once and merge results. #peers-federated-search
- **Peer-to-peer graph** — peers that know about other peers. Makes discovery transitive. Fun but YAGNI until there's a real graph #peers-p2p-discovery
- **Multi-tenant peer scoping** — peers visible to specific users/tokens only. Current model is "the smallstore owner sees all peers." #peers-multi-tenant
- **Rate limiting / quotas** — per-peer request budgets. Useful for public-ish peers that might throttle us. Add when metrics show it matters #peers-rate-limit

## Success criteria

User can do all of this in one afternoon after the MVP ships:

```bash
# Register tigerflare as a peer
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "tigerflare-prod",
    "type": "tigerflare",
    "url": "https://tigerflare.labspace.ai",
    "auth": { "kind": "bearer", "token_env": "TF_TOKEN" },
    "description": "primary tigerflare — mac/erko/sparkie sync",
    "tags": ["prod", "personal"]
  }' \
  "https://smallstore.labspace.ai/peers"

# Read a tigerflare path through the smallstore proxy
curl -H "Authorization: Bearer $TOKEN" \
  "https://smallstore.labspace.ai/peers/tigerflare-prod/fetch?path=/inbox/test.md"

# From an agent in Claude Code (once MCP family ships):
# sm_peers_list() → returns tigerflare, sheetlog-faves, smallstore-v2, etc.
# sm_peers_fetch('tigerflare-prod', '/inbox/test.md') → content
```

And the **agentic workflow** the atlas unlocks:

- Agent asks: "what data sources do I have?" → `sm_peers_list` returns labeled atlas
- Agent asks: "is there anything in my tigerflare inbox about X?" → `sm_peers_fetch('tigerflare-prod', '/inbox/?grep=X')`
- Agent asks: "dump a summary of every data source" → `sm_peers_list` → map over `sm_peers_health` in parallel → report coverage

## References

- Pairs with: `sm_inbox_*` MCP tool family (queued in `TASKS-MESSAGING.md`)
- Pattern precedent: `src/messaging/rules.ts` (adapter-agnostic store, CRUD, runtime config in D1) — good template
- Plugin discipline: `docs/design/PLUGIN-AUTHORING.md` (4 invariants to follow)
- Future compound adapter reference: tigerflare `src/worker/index.ts` (HTTP-backed KV) — shape tigerflare peer-as-adapter would need
- External: webdav spec (RFC 4918) for level-3 webdav peer
