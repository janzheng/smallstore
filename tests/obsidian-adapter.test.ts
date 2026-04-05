/**
 * Tests for ObsidianAdapter — CRUD operations, roundtrip, query.
 *
 * Uses a temp copy of the test vault to avoid mutating fixtures.
 */

import { assertEquals, assertExists } from "@std/assert";
import { ObsidianAdapter } from "../src/adapters/obsidian.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";
import { copy } from "@std/fs/copy";

const TEST_VAULT_SRC = new URL("./test-obsidian-vault", import.meta.url).pathname;

/** Create a temp copy of the test vault for each test */
async function makeTempVault(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "obsidian-test-" });
  await copy(TEST_VAULT_SRC, dir, { overwrite: true });
  return {
    dir,
    cleanup: async () => {
      try { await Deno.remove(dir, { recursive: true }); } catch { /* ok */ }
    },
  };
}

Deno.test("obsidian adapter: get returns Note JSON for existing file", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const note = await adapter.get("Note A");
    assertExists(note);
    assertEquals(note.title, "Note A");
    assertEquals(note.properties?.title, "Note A");
    assertEquals(note.properties?.status, "active");
    assertExists(note.body);
    assertExists(note.raw);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: get returns null for missing file", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const note = await adapter.get("Does Not Exist");
    assertEquals(note, null);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: get resolves wikilinks", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const note = await adapter.get("Note A");
    assertExists(note);
    assertExists(note.links);
    // Note A links to Note B
    const linkToB = note.links!.find((l) => l.target === "Note B");
    assertExists(linkToB);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: has returns true/false correctly", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    assertEquals(await adapter.has("Note A"), true);
    assertEquals(await adapter.has("Note B"), true);
    assertEquals(await adapter.has("subfolder/Note C"), true);
    assertEquals(await adapter.has("Nope"), false);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: keys lists all markdown files", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const allKeys = await adapter.keys();
    assertEquals(allKeys.length >= 3, true);
    assertEquals(allKeys.includes("Note A"), true);
    assertEquals(allKeys.includes("Note B"), true);
    assertEquals(allKeys.includes("subfolder/Note C"), true);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: keys with prefix filters correctly", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const subKeys = await adapter.keys("subfolder/");
    assertEquals(subKeys.length >= 1, true);
    assertEquals(subKeys.includes("subfolder/Note C"), true);
    assertEquals(subKeys.includes("Note A"), false);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: set with raw markdown", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const markdown = `---
title: New Note
tags:
  - created
---

# New Note

Created via adapter.
`;
    await adapter.set("New Note", markdown);
    assertEquals(await adapter.has("New Note"), true);

    const note = await adapter.get("New Note");
    assertExists(note);
    assertEquals(note.properties?.title, "New Note");
    assertEquals(note.raw.includes("Created via adapter"), true);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: set creates subdirectories", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    await adapter.set("deep/nested/Note", "---\ntitle: Deep\n---\n\nDeep note.\n");
    assertEquals(await adapter.has("deep/nested/Note"), true);

    const note = await adapter.get("deep/nested/Note");
    assertExists(note);
    assertEquals(note.properties?.title, "Deep");
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: delete removes file and index", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    assertEquals(await adapter.has("Note B"), true);
    await adapter.delete("Note B");
    assertEquals(await adapter.has("Note B"), false);
    assertEquals(await adapter.get("Note B"), null);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: delete non-existent key does not throw", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    await adapter.delete("Does Not Exist");
    // Should not throw
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: clear removes all files", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const before = await adapter.keys();
    assertEquals(before.length >= 3, true);

    await adapter.clear();

    const after = await adapter.keys();
    assertEquals(after.length, 0);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: roundtrip — set markdown, get Note, set Note back", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    // Write raw markdown
    const original = `---
title: Roundtrip Test
status: draft
---

# Roundtrip Test

Content with [[Note A]] link.
`;
    await adapter.set("Roundtrip Test", original);

    // Read as Note JSON
    const note = await adapter.get("Roundtrip Test");
    assertExists(note);
    assertEquals(note.properties?.title, "Roundtrip Test");
    assertEquals(note.properties?.status, "draft");

    // Write Note back (this should encode it back to markdown)
    await adapter.set("Roundtrip Test", note);

    // Read again and verify
    const note2 = await adapter.get("Roundtrip Test");
    assertExists(note2);
    assertEquals(note2.properties?.title, "Roundtrip Test");
    assertEquals(note2.properties?.status, "draft");
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: query with $search", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const result = await adapter.query({
      filter: { $search: "research" },
    });
    assertExists(result);
    assertEquals(result.data.length >= 1, true);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: query with frontmatter filter", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const result = await adapter.query({
      filter: { status: "active" },
    });
    assertExists(result);
    assertEquals(result.data.length >= 1, true);
    assertEquals(result.data[0].properties?.status, "active");
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: query with limit and skip", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const all = await adapter.query({});
    const limited = await adapter.query({ limit: 1 });
    const skipped = await adapter.query({ skip: 1, limit: 1 });

    assertEquals(limited.data.length, 1);
    assertEquals(limited.totalCount, all.totalCount);
    assertEquals(skipped.data.length, 1);
  } finally {
    adapter.close();
    await cleanup();
  }
});

Deno.test("obsidian adapter: getVault returns VaultGraph instance", async () => {
  const { dir, cleanup } = await makeTempVault();
  const adapter = new ObsidianAdapter({ vaultDir: dir });

  try {
    const vault = await adapter.getVault();
    assertExists(vault);

    const stats = vault.stats();
    assertEquals(stats.fileCount >= 3, true);
    assertEquals(stats.markdownFileCount >= 3, true);
    assertEquals(stats.linkCount >= 1, true);
  } finally {
    adapter.close();
    await cleanup();
  }
});
