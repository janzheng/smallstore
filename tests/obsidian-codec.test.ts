/**
 * Tests for VaultGraph codec — decodeMarkdown / encodeMarkdown roundtrip.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  decodeMarkdown,
  encodeMarkdown,
  patchMarkdown,
  pathToId,
  pathToTitle,
} from "../src/vault-graph/codec.ts";

Deno.test("codec: decodeMarkdown parses frontmatter and body", async () => {
  const raw = `---
title: Hello
tags:
  - test
  - demo
---

# Hello

Some body content here.
`;
  const note = await decodeMarkdown(raw, "Hello.md");

  assertExists(note);
  assertEquals(note.id, "hello");
  assertEquals(note.title, "Hello");
  assertEquals(note.properties?.title, "Hello");
  assertEquals(note.properties?.tags, ["test", "demo"]);
  assertExists(note.raw);
  // body is NoteBlock[]
  assertExists(note.body);
  assertEquals(note.body.length >= 1, true);
});

Deno.test("codec: decodeMarkdown extracts wikilinks", async () => {
  const raw = `---
title: Linker
---

Link to [[Target Note]] and [[Other|display text]].
`;
  const note = await decodeMarkdown(raw, "Linker.md");

  assertExists(note.links);
  assertEquals(note.links.length >= 2, true);
  assertEquals(note.links[0].target, "Target Note");
  assertEquals(note.links[1].target, "Other");
  assertEquals(note.links[1].display, "display text");
});

Deno.test("codec: decodeMarkdown extracts headings", async () => {
  const raw = `# Main Title

## Section One

### Subsection

## Section Two
`;
  const note = await decodeMarkdown(raw, "Headings.md");

  assertExists(note.headings);
  assertEquals(note.headings.length, 4);
  assertEquals(note.headings[0].text, "Main Title");
  assertEquals(note.headings[0].level, 1);
  assertEquals(note.headings[1].text, "Section One");
  assertEquals(note.headings[1].level, 2);
});

Deno.test("codec: encodeMarkdown produces valid markdown from Note", () => {
  const note = {
    id: "test",
    title: "Test Note",
    path: "Test Note.md",
    raw: "",
    body: [
      { type: "paragraph" as const, content: "Hello world." },
    ],
    properties: {
      title: "Test Note",
      tags: ["a", "b"],
    },
    links: [],
    embeds: [],
    externalLinks: [],
    headings: [],
    tags: [],
    blockIds: [],
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    hash: "",
  };

  const md = encodeMarkdown(note);

  // Should contain frontmatter
  assertEquals(md.includes("---"), true);
  assertEquals(md.includes("title: Test Note"), true);
  assertEquals(md.includes("tags:"), true);
  // Should contain body
  assertEquals(md.includes("Hello world."), true);
});

Deno.test("codec: roundtrip decode -> decode from raw preserves content", async () => {
  const original = `---
title: Roundtrip
status: draft
---

# Roundtrip

Body text with [[Link]] and #tag.
`;

  const note = await decodeMarkdown(original, "Roundtrip.md");
  // Roundtrip via raw (the authoritative source)
  const decoded2 = await decodeMarkdown(note.raw, "Roundtrip.md");

  assertEquals(decoded2.properties?.title, "Roundtrip");
  assertEquals(decoded2.properties?.status, "draft");
  assertExists(decoded2.body);
});

Deno.test("codec: patchMarkdown appends content", () => {
  const original = `---
title: Original
---

# Original

Existing content.
`;

  const patched = patchMarkdown(original, {
    append: "\n\nAppended paragraph.",
  });

  assertEquals(patched.includes("Existing content."), true);
  assertEquals(patched.includes("Appended paragraph."), true);
});

Deno.test("codec: patchMarkdown prepends content", () => {
  const original = `---
title: Original
---

Existing content.
`;

  const patched = patchMarkdown(original, {
    prepend: "Prepended line.",
  });

  assertEquals(patched.includes("Prepended line."), true);
  assertEquals(patched.includes("Existing content."), true);
});

Deno.test("codec: patchMarkdown merges properties", () => {
  const original = `---
title: Original
status: draft
---

Body.
`;

  const patched = patchMarkdown(original, {
    properties: { status: "published", newProp: "hello" },
  });

  assertEquals(patched.includes("published"), true);
  assertEquals(patched.includes("newProp"), true);
  assertEquals(patched.includes("Original"), true);
});

Deno.test("codec: pathToId converts path to lowercase id", () => {
  // pathToId replaces all non-alphanumeric chars (including /) with hyphens
  assertEquals(pathToId("folder/My Note.md"), "folder-my-note");
  assertEquals(pathToId("Simple.md"), "simple");
  assertEquals(pathToId("Already lowercase.md"), "already-lowercase");
});

Deno.test("codec: pathToTitle extracts title from path", () => {
  assertEquals(pathToTitle("folder/My Note.md"), "My Note");
  assertEquals(pathToTitle("Simple.md"), "Simple");
  assertEquals(pathToTitle("deeply/nested/Note.md"), "Note");
});
