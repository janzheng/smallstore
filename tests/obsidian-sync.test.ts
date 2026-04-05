/**
 * Tests for cross-adapter sync: Obsidian <-> Memory and Obsidian <-> SQLite.
 *
 * Demonstrates syncing notes between an Obsidian vault and other adapters.
 */

import { assertEquals, assertExists } from "@std/assert";
import { ObsidianAdapter } from "../src/adapters/obsidian.ts";
import { MemoryAdapter } from "../src/adapters/memory.ts";
import { SQLiteAdapter } from "../src/adapters/sqlite.ts";
import { copy } from "@std/fs/copy";

const TEST_VAULT_SRC = new URL("./test-obsidian-vault", import.meta.url).pathname;

async function makeTempVault(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "obsidian-sync-test-" });
  await copy(TEST_VAULT_SRC, dir, { overwrite: true });
  return {
    dir,
    cleanup: async () => {
      try { await Deno.remove(dir, { recursive: true }); } catch { /* ok */ }
    },
  };
}

Deno.test("sync: export obsidian notes to memory adapter", async () => {
  const { dir, cleanup } = await makeTempVault();
  const obsidian = new ObsidianAdapter({ vaultDir: dir });
  const memory = new MemoryAdapter();

  try {
    // Get all keys from obsidian
    const keys = await obsidian.keys();
    assertEquals(keys.length >= 3, true);

    // Copy each note to memory adapter as JSON
    for (const key of keys) {
      const note = await obsidian.get(key);
      if (note) {
        await memory.set(key, note);
      }
    }

    // Verify memory has all the notes
    const memKeys = await memory.keys();
    assertEquals(memKeys.length, keys.length);

    // Verify content roundtrip
    const noteA = await memory.get("Note A");
    assertExists(noteA);
    assertEquals(noteA.properties?.title, "Note A");
    assertEquals(noteA.properties?.status, "active");
  } finally {
    obsidian.close();
    await cleanup();
  }
});

Deno.test("sync: import from memory adapter to obsidian", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "obsidian-import-test-" });
  const obsidian = new ObsidianAdapter({ vaultDir: tmpDir });
  const memory = new MemoryAdapter();

  try {
    // Populate memory adapter with some note data
    await memory.set("imported/Note 1", {
      id: "imported/note-1",
      title: "Imported Note 1",
      path: "imported/Note 1.md",
      raw: "---\ntitle: Imported Note 1\ntags:\n  - imported\n---\n\n# Imported Note 1\n\nThis was imported from memory.\n",
      body: "# Imported Note 1\n\nThis was imported from memory.\n",
      properties: { title: "Imported Note 1", tags: ["imported"] },
    });

    await memory.set("imported/Note 2", {
      id: "imported/note-2",
      title: "Imported Note 2",
      path: "imported/Note 2.md",
      raw: "---\ntitle: Imported Note 2\n---\n\n# Imported Note 2\n\nLinks to [[imported/Note 1]].\n",
      body: "# Imported Note 2\n\nLinks to [[imported/Note 1]].\n",
      properties: { title: "Imported Note 2" },
    });

    // Import from memory to obsidian
    const memKeys = await memory.keys();
    for (const key of memKeys) {
      const data = await memory.get(key);
      if (data && data.raw) {
        await obsidian.set(key, data.raw);
      }
    }

    // Verify obsidian has the imported notes
    const obsKeys = await obsidian.keys();
    assertEquals(obsKeys.length, 2);

    const note1 = await obsidian.get("imported/Note 1");
    assertExists(note1);
    assertEquals(note1.properties?.title, "Imported Note 1");

    const note2 = await obsidian.get("imported/Note 2");
    assertExists(note2);
    assertEquals(note2.properties?.title, "Imported Note 2");
  } finally {
    obsidian.close();
    try { await Deno.remove(tmpDir, { recursive: true }); } catch { /* ok */ }
  }
});

Deno.test("sync: bidirectional — update in obsidian, read in memory", async () => {
  const { dir, cleanup } = await makeTempVault();
  const obsidian = new ObsidianAdapter({ vaultDir: dir });
  const memory = new MemoryAdapter();

  try {
    // Initial sync: obsidian -> memory
    const keys = await obsidian.keys();
    for (const key of keys) {
      const note = await obsidian.get(key);
      if (note) await memory.set(key, note);
    }

    // Update a note in obsidian
    await obsidian.set("Note A", `---
title: Note A
tags:
  - project
  - important
  - updated
status: published
created: 2024-01-15
---

# Note A (Updated)

This note has been updated with new content.

## New Section

Brand new section added.
`);

    // Re-sync the updated note
    const updated = await obsidian.get("Note A");
    assertExists(updated);
    await memory.set("Note A", updated);

    // Verify memory has the update
    const memNote = await memory.get("Note A");
    assertExists(memNote);
    assertEquals(memNote.properties?.status, "published");
  } finally {
    obsidian.close();
    await cleanup();
  }
});

// ── Obsidian <-> SQLite ──────────────────────────────────────────

Deno.test("sync: obsidian -> sqlite — export notes as structured JSON rows", async () => {
  const { dir, cleanup } = await makeTempVault();
  const obsidian = new ObsidianAdapter({ vaultDir: dir });
  const sqlite = new SQLiteAdapter({ path: ":memory:" });

  try {
    const keys = await obsidian.keys();
    assertEquals(keys.length >= 3, true);

    // Sync each note from obsidian into SQLite as a JSON row
    for (const key of keys) {
      const note = await obsidian.get(key);
      if (note) {
        // Store a simplified record: title, status, tags, raw markdown
        await sqlite.set(key, {
          title: note.title,
          properties: note.properties,
          tags: note.tags,
          linkCount: note.links.length,
          raw: note.raw,
        });
      }
    }

    // Verify SQLite has all the notes
    const sqlKeys = await sqlite.keys();
    assertEquals(sqlKeys.length, keys.length);

    // Verify structured data is queryable
    const noteA = await sqlite.get("Note A");
    assertExists(noteA);
    assertEquals(noteA.title, "Note A");
    assertEquals(noteA.properties?.status, "active");
    // tags are inline tags from body (Note A has frontmatter tags but no inline #tags)
    assertExists(noteA.tags);
    assertEquals(noteA.linkCount >= 1, true);
    assertExists(noteA.raw);

    // Verify subfolder note
    const noteC = await sqlite.get("subfolder/Note C");
    assertExists(noteC);
    assertEquals(noteC.title, "Note C");
    assertEquals(noteC.properties?.category, "research");
  } finally {
    obsidian.close();
    await cleanup();
  }
});

Deno.test("sync: sqlite -> obsidian — import structured data as markdown notes", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "obsidian-sqlite-import-" });
  const obsidian = new ObsidianAdapter({ vaultDir: tmpDir });
  const sqlite = new SQLiteAdapter({ path: ":memory:" });

  try {
    // Populate SQLite with structured data (simulating a database export)
    await sqlite.set("contacts/Alice", {
      title: "Alice Johnson",
      role: "Engineer",
      company: "Acme Corp",
      tags: ["engineering", "team-lead"],
      notes: "Met at conference 2024. Working on distributed systems.",
    });

    await sqlite.set("contacts/Bob", {
      title: "Bob Smith",
      role: "Designer",
      company: "Acme Corp",
      tags: ["design", "ux"],
      notes: "Collaborating on dashboard redesign. See [[contacts/Alice]].",
    });

    await sqlite.set("projects/Dashboard", {
      title: "Dashboard Redesign",
      status: "in-progress",
      team: ["Alice", "Bob"],
      description: "Redesign the main analytics dashboard.",
    });

    // Sync SQLite -> Obsidian by converting structured data to markdown
    const sqlKeys = await sqlite.keys();
    for (const key of sqlKeys) {
      const data = await sqlite.get(key);
      if (!data) continue;

      // Build markdown from structured data
      const { title, notes: bodyNotes, description, ...frontmatter } = data;
      const props = { title, ...frontmatter };
      const body = bodyNotes || description || "";

      const markdown = `---
${Object.entries(props).map(([k, v]) => {
  if (Array.isArray(v)) return `${k}:\n${v.map((i: string) => `  - ${i}`).join("\n")}`;
  return `${k}: ${v}`;
}).join("\n")}
---

# ${title}

${body}
`;
      await obsidian.set(key, markdown);
    }

    // Verify obsidian has all notes
    const obsKeys = await obsidian.keys();
    assertEquals(obsKeys.length, 3);

    // Verify contacts are proper Obsidian notes with frontmatter
    const alice = await obsidian.get("contacts/Alice");
    assertExists(alice);
    assertEquals(alice.properties?.title, "Alice Johnson");
    assertEquals(alice.properties?.role, "Engineer");
    assertEquals(alice.properties?.company, "Acme Corp");

    // Verify Bob's note has a wikilink that could resolve
    const bob = await obsidian.get("contacts/Bob");
    assertExists(bob);
    assertEquals(bob.links.length >= 1, true);
    assertEquals(bob.links[0].target, "contacts/Alice");

    // Verify project note
    const dashboard = await obsidian.get("projects/Dashboard");
    assertExists(dashboard);
    assertEquals(dashboard.properties?.status, "in-progress");
  } finally {
    obsidian.close();
    try { await Deno.remove(tmpDir, { recursive: true }); } catch { /* ok */ }
  }
});

Deno.test("sync: obsidian <-> sqlite bidirectional — edit in both, resync", async () => {
  const { dir, cleanup } = await makeTempVault();
  const obsidian = new ObsidianAdapter({ vaultDir: dir });
  const sqlite = new SQLiteAdapter({ path: ":memory:" });

  try {
    // Step 1: Initial sync obsidian -> sqlite
    const keys = await obsidian.keys();
    for (const key of keys) {
      const note = await obsidian.get(key);
      if (note) {
        await sqlite.set(key, {
          title: note.title,
          properties: note.properties,
          tags: note.tags,
          raw: note.raw,
          hash: note.hash,
        });
      }
    }

    // Step 2: Edit in SQLite (simulate updating properties)
    const existing = await sqlite.get("Note A");
    assertExists(existing);
    await sqlite.set("Note A", {
      ...existing,
      properties: { ...existing.properties, status: "archived", priority: "low" },
    });

    // Step 3: Add new note in SQLite
    await sqlite.set("From SQLite", {
      title: "From SQLite",
      properties: { title: "From SQLite", source: "database" },
      tags: [],
      raw: "---\ntitle: From SQLite\nsource: database\n---\n\n# From SQLite\n\nCreated in SQLite, synced to Obsidian.\n",
      hash: "new",
    });

    // Step 4: Sync changes back to obsidian
    // - Detect what changed in SQLite by comparing hashes
    const sqlKeys = await sqlite.keys();
    for (const key of sqlKeys) {
      const sqlData = await sqlite.get(key);
      if (!sqlData) continue;

      const obsNote = await obsidian.get(key);
      if (!obsNote) {
        // New in SQLite -> create in obsidian
        if (sqlData.raw) {
          await obsidian.set(key, sqlData.raw);
        }
      } else if (obsNote.hash !== sqlData.hash) {
        // Changed -> if raw is available, push to obsidian
        if (sqlData.raw) {
          await obsidian.set(key, sqlData.raw);
        }
      }
    }

    // Step 5: Verify results
    // New note appeared in obsidian
    assertEquals(await obsidian.has("From SQLite"), true);
    const fromSql = await obsidian.get("From SQLite");
    assertExists(fromSql);
    assertEquals(fromSql.properties?.source, "database");

    // Obsidian vault now has 4 markdown files (3 original + 1 new)
    const finalKeys = await obsidian.keys();
    assertEquals(finalKeys.length, 4);
  } finally {
    obsidian.close();
    await cleanup();
  }
});

// ── Obsidian <-> Obsidian (vault duplication) ───────────────────

Deno.test("sync: manifest diffing between two vaults", async () => {
  // This test verifies the sync infrastructure works at the manifest level
  const { dir: dir1, cleanup: cleanup1 } = await makeTempVault();
  const { dir: dir2, cleanup: cleanup2 } = await makeTempVault();

  const adapter1 = new ObsidianAdapter({ vaultDir: dir1 });
  const adapter2 = new ObsidianAdapter({ vaultDir: dir2 });

  try {
    // Both start identical
    const keys1 = await adapter1.keys();
    const keys2 = await adapter2.keys();
    assertEquals(keys1.length, keys2.length);

    // Modify vault 1
    await adapter1.set("Note A", `---
title: Note A
status: modified
---

Modified in vault 1.
`);

    // Add new note to vault 2
    await adapter2.set("Vault2 Only", `---
title: Vault2 Only
---

This note only exists in vault 2.
`);

    // Verify divergence
    const keys1After = await adapter1.keys();
    const keys2After = await adapter2.keys();
    assertEquals(keys2After.length, keys1After.length + 1);

    // Vault 2 has the extra note
    assertEquals(await adapter2.has("Vault2 Only"), true);
    assertEquals(await adapter1.has("Vault2 Only"), false);

    // Vault 1 has modified content
    const noteA1 = await adapter1.get("Note A");
    assertExists(noteA1);
    assertEquals(noteA1.properties?.status, "modified");

    // Vault 2 still has original
    const noteA2 = await adapter2.get("Note A");
    assertExists(noteA2);
    assertEquals(noteA2.properties?.status, "active");
  } finally {
    adapter1.close();
    adapter2.close();
    await cleanup1();
    await cleanup2();
  }
});
