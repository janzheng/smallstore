# Smallstore — Race Condition Fixes

Audit date: 2026-03-26. All bugs confirmed by code review. All fixes verified — 617 tests pass (4 pre-existing failures unrelated to race conditions).

## Group A: Middleware Races (independent, no shared deps)

- [x] [done: atomic startRefreshIfNotInFlight() method] **A1: SWR duplicate refresh** — `src/http/middleware/response-cache.ts` #middleware #critical
- [x] [done: verified already synchronous, added safety comment] **A2: Rate limiter bypass** — `src/http/middleware/rate-limiter.ts` #middleware #high
- [x] [done: snapshot keys to array before iteration] **A3: Distributed cache L1 invalidation iterator** — `src/http/middleware/distributed-cache.ts` #middleware #medium
- [x] [done: guard eviction with has() check] **A4: Distributed cache L1 promotion race** — `src/http/middleware/distributed-cache.ts` #middleware #medium

## Group B: Router/KeyIndex Races (interdependent)

- [x] [done: AsyncKeyLock per-key mutex wrapping critical section] **B1: Router append/merge read-modify-write** — `src/router.ts` #router #high
- [x] [done: same per-key lock] **B2: Router patch() lost updates** — `src/router.ts` #router #high
- [x] [done: same per-key lock] **B3: Router deleteFromArray() lost deletions** — `src/router.ts` #router #high
- [x] [done: same per-key lock] **B4: Router deleteProperty() resurrection** — `src/router.ts` #router #high
- [x] [done: per-collection lock on __keyindex__ operations] **B5: Key index concurrent modifications** — `src/keyindex/storage.ts` #router #medium

## Group C: Adapter Races (independent per adapter)

- [x] [done: structuredClone on get() for object/array values] **C1: LocalJSON cache returns references** — `src/adapters/local-json.ts` #adapter #high
- [x] [done: PRAGMA busy_timeout = 5000 in both SQLite adapters] **C2: SQLite missing busy_timeout** — `src/adapters/sqlite.ts` + `structured-sqlite.ts` #adapter #high
- [x] [done: async mutex serializes snapshot()] **C3: Overlay snapshot torn reads** — `src/adapters/overlay.ts` #adapter #high
- [x] [done: async mutex serializes commit()] **C4: Overlay commit tombstone resurrection** — `src/adapters/overlay.ts` #adapter #critical
- [x] [done: structuredClone on get() and set()] **C5: Memory adapter returns references** — `src/adapters/memory.ts` #adapter #medium

## Group D: Search/Module Races (independent per provider)

- [x] [done: build state in locals, apply synchronously] **D1: BM25 partial index state** — `src/search/memory-bm25-provider.ts` #search #medium
- [~] [deferred: already correct — map updated only after embed completes] **D2: Vector search stale entries during embed** — `src/search/memory-vector-provider.ts` #search #low
- [x] [done: wrapped DELETE+INSERT in BEGIN/COMMIT transaction] **D3: SQLite FTS non-atomic delete+insert** — `src/search/sqlite-fts-provider.ts` #search #medium
- [x] [done: refreshInFlight Set deduplicates concurrent refreshes] **D4: Materialized view on-write refresh storm** — `src/views/materialized.ts` #module #medium
- [x] [done: post-validation after edge creation, rollback if node deleted] **D5: Graph store edge→deleted node** — `src/graph/store.ts` #module #medium
- [x] [done: per-key async lock on boost()] **D6: Episodic boost lost updates** — `src/episodic/store.ts` #module #medium
