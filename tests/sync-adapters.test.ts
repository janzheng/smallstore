/**
 * Tests for syncAdapters() — generic adapter-to-adapter sync.
 */

import { assertEquals, assertExists } from "@std/assert";
import { MemoryAdapter } from "../src/adapters/memory.ts";
import { SQLiteAdapter } from "../src/adapters/sqlite.ts";
import { ObsidianAdapter } from "../src/adapters/obsidian.ts";
import { syncAdapters } from "../src/sync.ts";
import { copy } from "@std/fs/copy";

const TEST_VAULT_SRC = new URL("./test-obsidian-vault", import.meta.url).pathname;

async function makeTempVault(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "sync-test-" });
  await copy(TEST_VAULT_SRC, dir, { overwrite: true });
  return {
    dir,
    cleanup: async () => {
      try { await Deno.remove(dir, { recursive: true }); } catch { /* ok */ }
    },
  };
}

// ── Push mode ───────────────────────────────────────────────────

Deno.test("syncAdapters: push copies all keys from source to target", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { name: "Alice" });
  await source.set("b", { name: "Bob" });
  await source.set("c", { name: "Charlie" });

  const result = await syncAdapters(source, target, { mode: "push" });

  assertEquals(result.created, 3);
  assertEquals(result.updated, 0);
  assertEquals(result.skipped, 0);
  assertEquals(result.errors.length, 0);
  assertEquals(result.dryRun, false);

  assertEquals(await target.get("a"), { name: "Alice" });
  assertEquals(await target.get("b"), { name: "Bob" });
  assertEquals(await target.get("c"), { name: "Charlie" });
});

Deno.test("syncAdapters: push overwrites existing by default", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 2 });
  await target.set("a", { v: 1 });

  const result = await syncAdapters(source, target, { mode: "push" });

  assertEquals(result.updated, 1);
  assertEquals(result.created, 0);
  assertEquals(await target.get("a"), { v: 2 });
});

Deno.test("syncAdapters: push with overwrite=false skips existing", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 2 });
  await source.set("b", { v: 2 });
  await target.set("a", { v: 1 });

  const result = await syncAdapters(source, target, { mode: "push", overwrite: false });

  assertEquals(result.created, 1);
  assertEquals(result.skipped, 1);
  assertEquals(result.keys.skipped.includes("a"), true);
  assertEquals(await target.get("a"), { v: 1 }); // unchanged
  assertEquals(await target.get("b"), { v: 2 }); // created
});

// ── Pull mode ───────────────────────────────────────────────────

Deno.test("syncAdapters: pull copies from target to source", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await target.set("x", { from: "target" });
  await target.set("y", { from: "target" });

  const result = await syncAdapters(source, target, { mode: "pull" });

  assertEquals(result.created, 2);
  assertEquals(await source.get("x"), { from: "target" });
  assertEquals(await source.get("y"), { from: "target" });
});

// ── Sync mode (bidirectional) ───────────────────────────────────

Deno.test("syncAdapters: sync merges both directions (new keys only)", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("only-source", { from: "source" });
  await source.set("shared", { from: "source" });
  await target.set("only-target", { from: "target" });
  await target.set("shared", { from: "target" });

  const result = await syncAdapters(source, target, { mode: "sync" });

  // source-only → pushed to target
  assertEquals(await target.get("only-source"), { from: "source" });
  // target-only → pulled to source
  assertEquals(await source.get("only-target"), { from: "target" });
  // shared keys are NOT touched (no conflict resolution in v1)
  assertEquals(await source.get("shared"), { from: "source" });
  assertEquals(await target.get("shared"), { from: "target" });

  assertEquals(result.created, 2); // 1 push + 1 pull
});

// ── Dry run ─────────────────────────────────────────────────────

Deno.test("syncAdapters: dryRun reports changes without writing", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", 1);
  await source.set("b", 2);

  const result = await syncAdapters(source, target, { mode: "push", dryRun: true });

  assertEquals(result.dryRun, true);
  assertEquals(result.created, 2);
  // Target should be empty — nothing written
  assertEquals(await target.has("a"), false);
  assertEquals(await target.has("b"), false);
});

// ── Transform ───────────────────────────────────────────────────

Deno.test("syncAdapters: transform maps keys and values", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("user/alice", { name: "Alice", age: 30 });
  await source.set("user/bob", { name: "Bob", age: 25 });

  const result = await syncAdapters(source, target, {
    mode: "push",
    transform: (key, value) => ({
      key: key.replace("user/", "people/"),
      value: { displayName: value.name },
    }),
  });

  assertEquals(result.created, 2);
  assertEquals(await target.get("people/alice"), { displayName: "Alice" });
  assertEquals(await target.get("people/bob"), { displayName: "Bob" });
});

Deno.test("syncAdapters: transform returning null skips key", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("keep", { v: 1 });
  await source.set("skip", { v: 2 });

  const result = await syncAdapters(source, target, {
    mode: "push",
    transform: (key, value) => key === "skip" ? null : { key, value },
  });

  assertEquals(result.created, 1);
  assertEquals(result.skipped, 1);
  assertEquals(await target.has("keep"), true);
  assertEquals(await target.has("skip"), false);
});

// ── Prefix filtering ────────────────────────────────────────────

Deno.test("syncAdapters: prefix filters source keys", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("notes/a", 1);
  await source.set("notes/b", 2);
  await source.set("config/x", 3);

  const result = await syncAdapters(source, target, {
    mode: "push",
    prefix: "notes/",
  });

  assertEquals(result.created, 2);
  assertEquals(await target.has("notes/a"), true);
  assertEquals(await target.has("notes/b"), true);
  assertEquals(await target.has("config/x"), false);
});

// ── Target prefix ───────────────────────────────────────────────

Deno.test("syncAdapters: targetPrefix adds prefix on push", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("Note A", { title: "A" });
  await source.set("Note B", { title: "B" });

  const result = await syncAdapters(source, target, {
    mode: "push",
    targetPrefix: "vault/",
  });

  assertEquals(result.created, 2);
  assertEquals(await target.get("vault/Note A"), { title: "A" });
  assertEquals(await target.get("vault/Note B"), { title: "B" });
});

// ── Progress callback ───────────────────────────────────────────

Deno.test("syncAdapters: onProgress fires for each key", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();
  const events: { key: string; index: number }[] = [];

  await source.set("a", 1);
  await source.set("b", 2);

  await syncAdapters(source, target, {
    mode: "push",
    onProgress: (e) => events.push({ key: e.key, index: e.index }),
  });

  assertEquals(events.length, 2);
  assertEquals(events[0].index, 0);
  assertEquals(events[1].index, 1);
});

// ── Batch delay ─────────────────────────────────────────────────

Deno.test("syncAdapters: batchDelay slows down operations", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", 1);
  await source.set("b", 2);

  const start = performance.now();
  await syncAdapters(source, target, { mode: "push", batchDelay: 50 });
  const elapsed = performance.now() - start;

  // Should take at least 100ms (2 items × 50ms delay)
  assertEquals(elapsed >= 80, true); // allow some slack
});

// ── Error handling ──────────────────────────────────────────────

Deno.test("syncAdapters: errors are collected, not thrown", async () => {
  const source = new MemoryAdapter();
  // Create a target that throws on set
  const target: any = {
    capabilities: { name: "broken", supportedTypes: ["object"] },
    has: () => Promise.resolve(false),
    set: () => { throw new Error("write failed"); },
    get: () => Promise.resolve(null),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };

  await source.set("a", 1);
  await source.set("b", 2);

  const result = await syncAdapters(source, target, { mode: "push" });

  assertEquals(result.errors.length, 2);
  assertEquals(result.keys.errors.length, 2);
  assertEquals(result.created, 0);
});

// ── Cross-adapter: Memory <-> SQLite ────────────────────────────

Deno.test("syncAdapters: push Memory → SQLite", async () => {
  const memory = new MemoryAdapter();
  const sqlite = new SQLiteAdapter({ path: ":memory:" });

  await memory.set("users/alice", { name: "Alice", role: "engineer" });
  await memory.set("users/bob", { name: "Bob", role: "designer" });

  const result = await syncAdapters(memory, sqlite, { mode: "push" });

  assertEquals(result.created, 2);
  const alice = await sqlite.get("users/alice");
  assertExists(alice);
  assertEquals(alice.name, "Alice");
});

Deno.test("syncAdapters: sync SQLite <-> Memory bidirectional", async () => {
  const memory = new MemoryAdapter();
  const sqlite = new SQLiteAdapter({ path: ":memory:" });

  await memory.set("mem-only", { from: "memory" });
  await sqlite.set("sql-only", { from: "sqlite" });

  const result = await syncAdapters(memory, sqlite, { mode: "sync" });

  assertEquals(result.created, 2);
  assertEquals(await sqlite.get("mem-only"), { from: "memory" });
  assertEquals(await memory.get("sql-only"), { from: "sqlite" });
});

// ── Cross-adapter: Obsidian → Memory ────────────────────────────

Deno.test("syncAdapters: push Obsidian → Memory with transform", async () => {
  const { dir, cleanup } = await makeTempVault();
  const obsidian = new ObsidianAdapter({ vaultDir: dir });
  const memory = new MemoryAdapter();

  try {
    const result = await syncAdapters(obsidian, memory, {
      mode: "push",
      transform: (key, note) => ({
        key,
        value: {
          title: note.title,
          status: note.properties?.status ?? "unknown",
          linkCount: note.links?.length ?? 0,
        },
      }),
    });

    assertEquals(result.created >= 3, true);

    const noteA = await memory.get("Note A");
    assertExists(noteA);
    assertEquals(noteA.title, "Note A");
    assertEquals(noteA.status, "active");
    assertEquals(noteA.linkCount >= 1, true);
  } finally {
    obsidian.close();
    await cleanup();
  }
});

// ── Cross-adapter: SQLite → Obsidian ────────────────────────────

Deno.test("syncAdapters: push SQLite → Obsidian with markdown transform", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sync-obs-import-" });
  const obsidian = new ObsidianAdapter({ vaultDir: tmpDir });
  const sqlite = new SQLiteAdapter({ path: ":memory:" });

  try {
    await sqlite.set("contacts/Alice", {
      title: "Alice Johnson",
      role: "Engineer",
      notes: "Met at conference.",
    });
    await sqlite.set("contacts/Bob", {
      title: "Bob Smith",
      role: "Designer",
      notes: "Working on dashboard.",
    });

    const result = await syncAdapters(sqlite, obsidian, {
      mode: "push",
      transform: (key, data) => ({
        key,
        value: `---\ntitle: "${data.title}"\nrole: ${data.role}\n---\n\n# ${data.title}\n\n${data.notes}\n`,
      }),
    });

    assertEquals(result.created, 2);

    const alice = await obsidian.get("contacts/Alice");
    assertExists(alice);
    assertEquals(alice.properties?.title, "Alice Johnson");
    assertEquals(alice.properties?.role, "Engineer");
  } finally {
    obsidian.close();
    try { await Deno.remove(tmpDir, { recursive: true }); } catch { /* ok */ }
  }
});

// ── skipUnchanged ───────────────────────────────────────────────

Deno.test("syncAdapters: skipUnchanged skips identical values", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { name: "Alice", age: 30 });
  await source.set("b", { name: "Bob", age: 25 });
  await target.set("a", { name: "Alice", age: 30 }); // identical
  await target.set("b", { name: "Bob", age: 99 });   // different

  const result = await syncAdapters(source, target, {
    mode: "push",
    skipUnchanged: true,
  });

  assertEquals(result.skipped, 1);   // "a" skipped (identical)
  assertEquals(result.updated, 1);   // "b" updated (different)
  assertEquals(result.keys.skipped.includes("a"), true);
  assertEquals(result.keys.updated.includes("b"), true);
  assertEquals(await target.get("b"), { name: "Bob", age: 25 }); // updated
});

Deno.test("syncAdapters: skipUnchanged handles key ordering differences", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  // Same data, different property order
  await source.set("x", { b: 2, a: 1 });
  await target.set("x", { a: 1, b: 2 });

  const result = await syncAdapters(source, target, {
    mode: "push",
    skipUnchanged: true,
  });

  assertEquals(result.skipped, 1); // should detect as identical
});

Deno.test("syncAdapters: skipUnchanged still creates new keys", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("new", { v: 1 });
  await source.set("existing", { v: 2 });
  await target.set("existing", { v: 2 });

  const result = await syncAdapters(source, target, {
    mode: "push",
    skipUnchanged: true,
  });

  assertEquals(result.created, 1);  // "new" created
  assertEquals(result.skipped, 1);  // "existing" skipped (identical)
  assertEquals(result.updated, 0);
});

Deno.test("syncAdapters: skipUnchanged with transform compares transformed value", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { name: "Alice", extra: "ignored" });
  await target.set("a", { displayName: "Alice" }); // matches transformed output

  const result = await syncAdapters(source, target, {
    mode: "push",
    skipUnchanged: true,
    transform: (key, value) => ({
      key,
      value: { displayName: value.name },
    }),
  });

  assertEquals(result.skipped, 1); // transformed value matches target
});

// ── Default mode is push ────────────────────────────────────────

Deno.test("syncAdapters: defaults to push mode", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", 1);

  const result = await syncAdapters(source, target);

  assertEquals(result.created, 1);
  assertEquals(await target.get("a"), 1);
});

// ── Bidirectional sync with baseline ────────────────────────────

Deno.test("bidirectional: initial sync creates baseline and syncs both sides", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("s-only", { v: 1 });
  await target.set("t-only", { v: 2 });

  const result = await syncAdapters(source, target, {
    mode: "sync",
    syncId: "test-1",
  });

  // Source-only pushed, target-only pulled, no conflicts on first sync
  assertEquals(result.created, 2);
  assertEquals(await target.get("s-only"), { v: 1 });
  assertEquals(await source.get("t-only"), { v: 2 });

  // Baseline was saved
  assertExists(result.baseline);
  assertEquals(result.baseline!.syncId, "test-1");
  assertEquals(Object.keys(result.baseline!.entries).length, 2);
});

Deno.test("bidirectional: detects source-side change after baseline", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  // Initial sync to establish baseline
  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  const r1 = await syncAdapters(source, target, { mode: "sync", syncId: "test-2" });
  assertExists(r1.baseline);

  // Modify source only
  await source.set("a", { v: 2 });

  // Sync again — source change should push to target
  const r2 = await syncAdapters(source, target, { mode: "sync", syncId: "test-2" });

  assertEquals(r2.updated, 1);
  assertEquals(r2.conflicts, 0);
  assertEquals(await target.get("a"), { v: 2 });
});

Deno.test("bidirectional: detects target-side change after baseline", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  // Initial sync
  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-3" });

  // Modify target only
  await target.set("a", { v: 99 });

  // Sync — target change should pull to source
  const r2 = await syncAdapters(source, target, { mode: "sync", syncId: "test-3" });

  assertEquals(r2.updated, 1);
  assertEquals(r2.conflicts, 0);
  assertEquals(await source.get("a"), { v: 99 });
});

Deno.test("bidirectional: both sides changed → conflict with skip", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-4" });

  // Both sides change
  await source.set("a", { v: "from-source" });
  await target.set("a", { v: "from-target" });

  const r2 = await syncAdapters(source, target, {
    mode: "sync",
    syncId: "test-4",
    conflictResolution: "skip",
  });

  assertEquals(r2.conflicts, 1);
  assertEquals(r2.keys.conflicts.includes("a"), true);
  // Neither side overwritten
  assertEquals(await source.get("a"), { v: "from-source" });
  assertEquals(await target.get("a"), { v: "from-target" });
});

Deno.test("bidirectional: conflict resolution source-wins", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-5" });

  await source.set("a", { v: "src" });
  await target.set("a", { v: "tgt" });

  const r2 = await syncAdapters(source, target, {
    mode: "sync",
    syncId: "test-5",
    conflictResolution: "source-wins",
  });

  assertEquals(r2.updated, 1);
  assertEquals(r2.conflicts, 0);
  assertEquals(await target.get("a"), { v: "src" });
  assertEquals(await source.get("a"), { v: "src" }); // source unchanged
});

Deno.test("bidirectional: conflict resolution target-wins", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-6" });

  await source.set("a", { v: "src" });
  await target.set("a", { v: "tgt" });

  const r2 = await syncAdapters(source, target, {
    mode: "sync",
    syncId: "test-6",
    conflictResolution: "target-wins",
  });

  assertEquals(r2.updated, 1);
  assertEquals(await source.get("a"), { v: "tgt" });
  assertEquals(await target.get("a"), { v: "tgt" }); // target unchanged
});

Deno.test("bidirectional: conflict resolution callback", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-7" });

  await source.set("a", { v: "src" });
  await target.set("a", { v: "tgt" });

  const r2 = await syncAdapters(source, target, {
    mode: "sync",
    syncId: "test-7",
    conflictResolution: (_key, srcVal, tgtVal) => ({
      value: { merged: true, src: srcVal.v, tgt: tgtVal.v },
      writeTo: "both",
    }),
  });

  assertEquals(r2.updated, 1);
  const expected = { merged: true, src: "src", tgt: "tgt" };
  assertEquals(await source.get("a"), expected);
  assertEquals(await target.get("a"), expected);
});

Deno.test("bidirectional: deletion detection — target deletes, source unchanged", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-8" });

  // Target deletes
  await target.delete("a");

  const r2 = await syncAdapters(source, target, { mode: "sync", syncId: "test-8" });

  assertEquals(r2.deleted, 1);
  assertEquals(r2.keys.deleted.includes("a"), true);
  assertEquals(await source.has("a"), false); // propagated
});

Deno.test("bidirectional: deletion detection — source deletes, target unchanged", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-9" });

  // Source deletes
  await source.delete("a");

  const r2 = await syncAdapters(source, target, { mode: "sync", syncId: "test-9" });

  assertEquals(r2.deleted, 1);
  assertEquals(await target.has("a"), false); // propagated
});

Deno.test("bidirectional: edit-vs-delete conflict", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  await syncAdapters(source, target, { mode: "sync", syncId: "test-10" });

  // Source edits, target deletes
  await source.set("a", { v: 2 });
  await target.delete("a");

  const r2 = await syncAdapters(source, target, { mode: "sync", syncId: "test-10" });

  assertEquals(r2.conflicts, 1);
  assertEquals(r2.keys.conflicts.includes("a"), true);
  // Source value preserved (skip means no action)
  assertEquals(await source.get("a"), { v: 2 });
});

Deno.test("bidirectional: first sync without baseline — shared keys are conflicts", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  // Both have same key with different values, no prior sync
  await source.set("shared", { from: "source" });
  await target.set("shared", { from: "target" });
  await source.set("s-only", { v: 1 });

  const result = await syncAdapters(source, target, {
    mode: "sync",
    syncId: "test-11",
  });

  // "shared" is a conflict (no baseline to determine which changed)
  assertEquals(result.conflicts, 1);
  assertEquals(result.keys.conflicts.includes("shared"), true);
  // "s-only" still pushed
  assertEquals(result.created, 1);
  assertEquals(await target.get("s-only"), { v: 1 });
  // Baseline created for next sync
  assertExists(result.baseline);
});

Deno.test("bidirectional: baseline stored in adapter", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", 1);
  const result = await syncAdapters(source, target, { mode: "sync", syncId: "my-sync" });

  // Baseline key exists in source adapter
  assertEquals(await source.has("__sync_baseline:my-sync"), true);
  const raw = await source.get("__sync_baseline:my-sync");
  assertEquals(raw.syncId, "my-sync");
  // entries is stored as a JSON string for adapter compatibility
  const entries = typeof raw.entries === "string" ? JSON.parse(raw.entries) : raw.entries;
  assertExists(entries.a);

  // result.baseline has parsed entries
  assertExists(result.baseline);
  assertExists(result.baseline!.entries.a);
});

Deno.test("bidirectional: unchanged keys are skipped", async () => {
  const source = new MemoryAdapter();
  const target = new MemoryAdapter();

  await source.set("a", { v: 1 });
  await target.set("a", { v: 1 });
  const r1 = await syncAdapters(source, target, { mode: "sync", syncId: "test-13" });
  assertExists(r1.baseline);

  // No changes on either side
  const r2 = await syncAdapters(source, target, { mode: "sync", syncId: "test-13" });

  assertEquals(r2.created, 0);
  assertEquals(r2.updated, 0);
  assertEquals(r2.conflicts, 0);
  assertEquals(r2.deleted, 0);
});
