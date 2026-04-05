# Smallstore — Honest Assessment

*Deep dive — analysis of what smallstore is, where it's strong, where it's fragile, and what it could become.*

## The idea

Smallstore is a universal storage abstraction: one API, 17 backends, "messy desk" philosophy. You `set()` data and it routes to the right adapter (blob to R2, objects to SQLite, KV to memory). Swap backends with config, not code.

## What's genuinely impressive

**The adapter breadth is real.** 17 adapters isn't vaporware — Memory, SQLite, Upstash, Airtable, Notion, 4 Cloudflare services, S3/R2, Obsidian, Google Sheets. These aren't thin wrappers either; the Notion adapter handles page body blocks and auto-field creation. The Airtable adapter creates fields on the fly. This is hard, unglamorous work and it's done.

**The preset system is the right abstraction.** `createSmallstore({ preset: 'local-sqlite' })` — one line, working storage. This is the kind of DX that gets adoption. Seven presets covering testing → development → production → serverless is a complete ladder.

**VFS for agents is a genuinely novel idea.** Giving an LLM a bash-like interface (`ls`, `cat`, `grep`, `tree`) over arbitrary storage backends is clever. It means an agent doesn't need to know if data lives in SQLite, Notion, or R2 — it just runs `cat notes/todo`. 15 commands, pipe support, chaining. This could be the killer feature.

**Search is surprisingly deep.** Five providers (BM25, FTS5, Vector/brute-force, Zvec/HNSW, Hybrid with reciprocal rank fusion). User-provided `embed()` callback keeps it provider-agnostic. The hybrid search combining keyword + semantic is what most apps actually need.

**It's genuinely standalone.** Zero Coverflow dependencies. Ready for JSR. This isn't a tangled internal module masquerading as a package.

## What concerns me

### Scope vs. surface area

17 adapters + 5 search providers + graph store + episodic memory + progressive disclosure + VFS + HTTP server + materialized views + overlay/COW + sync. That's a lot of surface for a v0.1.

The core value prop is "one API, many backends." Graph store, episodic memory, and progressive disclosure are interesting but they're different products. Each one is 2,500+ lines of code that needs testing, documenting, and maintaining. If this ships to JSR, users will find these features, try them, hit bugs, and file issues.

**Question:** Should graph/episodic/disclosure be separate packages or feature-flagged? They dilute the "simple storage" message.

### The testing gap is the real risk

The adapter coverage is uneven:

| Tier | Adapters | Test coverage |
|------|----------|---------------|
| Well-tested | Memory, SQLite, LocalJSON, LocalFile, DenoFS, Overlay | Good |
| Partially tested | Airtable, Notion, Obsidian | Live tests only |
| Untested | Unstorage, all 4 Cloudflare adapters | Zero dedicated tests |

The Cloudflare gap is particularly concerning because that's where the serverless story lives. If someone picks `preset: 'cloud'` and hits an untested edge case, the "it just works" promise breaks.

The search providers are also unevenly wired — BM25 works on Memory/LocalJSON, FTS5 on SQLite, but Notion, Airtable, Upstash, and all Cloudflare adapters have no search. That's a confusing user experience: search works on some backends, silently fails on others.

### Documentation volume vs. clarity

68 docs. 15 user guides, 7 design docs, 8 guides, 12+ reference/audits, plus phase-completion records. For a v0.1 storage library, this is overwhelming. A new user opening `docs/` sees a wall of text and doesn't know where to start.

Compare: Unstorage (which smallstore wraps for some backends) has one README with clear sections. That's probably too little, but the right answer is closer to 5 docs than 68.

**What I'd keep:** getting-started.md, adapters.md, presets.md, search.md, http-api.md. Everything else is internal reference that should live in code comments or a separate `docs/internals/` folder.

### The "messy desk" framing

"Throw data in, organize later" is honest but potentially off-putting. It suggests the tool is for disorganized data, when really it's for heterogeneous data that needs flexible backends. The value isn't messiness — it's that you don't have to choose your storage backend upfront.

Better framing: "Storage that adapts to your data, not the other way around."

## Where it could win

### 1. Agent-native storage

The VFS + search combo is uniquely positioned for the AI agent ecosystem. Most agent frameworks punt on storage ("just use a vector DB"). Smallstore could be the answer to "where does my agent put stuff?" with VFS as the interface and smart routing handling the rest.

### 2. The "SQLite for prototypes, Upstash for production" story

The preset ladder (`memory` → `local-sqlite` → `cloud`) is exactly how indie developers build. Start local, deploy to serverless, change one config line. If smallstore nails this migration path, it becomes the default for small apps.

### 3. Notion/Airtable as a database

Most storage libraries ignore structured SaaS tools. Smallstore treats Notion and Airtable as first-class backends. For non-technical users who already live in these tools, this is powerful — their existing data becomes queryable through a real API.

## What I'd do next (if I were shipping v0.1)

1. **Publish core only.** Ship the router, presets, adapters, search, HTTP, and VFS. Move graph/episodic/disclosure to `@smallstore/extras` or just don't export them yet.

2. **Close the Cloudflare test gap.** If the serverless story matters (and it should — that's where growth is), the 4 Cloudflare adapters need real integration tests, even if they run against Miniflare locally.

3. **Trim docs to 5 files.** Getting started, adapter reference, search guide, HTTP API, and a "how it works" overview. Archive everything else.

4. **Make search failure explicit.** If an adapter doesn't support search, throw a clear error ("Notion adapter doesn't support local search — use BM25 wrapper or query Notion's API directly") instead of silently returning empty results.

5. **Lead with VFS in marketing.** "Give your AI agent a filesystem over any storage backend" is a much more compelling pitch than "universal storage abstraction."

## Open questions

- Is the target audience developers building agents, or developers building apps? The answer changes which features to emphasize.
- Should Cloudflare be the primary cloud story, or should there be a "bring your own cloud" approach (Vercel KV, Supabase, etc.)?
- How does smallstore handle schema evolution? If I start with `preset: 'local'` and switch to `preset: 'cloud'`, does my data migrate? (It doesn't seem to, which is a gap in the "swap backends" story.)
- The 3-type system (object/blob/kv) — is this enough? What about streams, queues, time-series?

## Discussion

### 2026-03-19 — First deep read

Smallstore has done the hard work. 17 adapters that actually work, a clean preset system, and a novel VFS layer. The core is solid. The risk is scope creep — graph stores and episodic memory are distractions from shipping a clean v0.1 that developers can trust.

The biggest gap isn't features, it's confidence. Without Cloudflare tests, without consistent search coverage, users can't trust "it just works." Fix the tests, trim the scope, lead with VFS, and this could be the default storage layer for small apps and AI agents.

The "messy desk" philosophy is actually a strength once you reframe it: smallstore is for data that doesn't fit neatly into one backend. That's most real-world data. Own that story.
