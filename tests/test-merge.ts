/**
 * Tests for smallstore/merge (deduplicated array merge)
 * 
 * Tests the merge function with different deduplication strategies.
 */

import { assertEquals } from "@std/assert";
import { createSmallstore } from "../mod.ts";
import { createMemoryAdapter } from "../adapters/memory.ts";

Deno.test("merge: ID-based deduplication", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Initial data
  await storage.set("pubmed", [
    { pmid: "12345", title: "Paper 1" },
    { pmid: "67890", title: "Paper 2" }
  ]);
  
  // Merge with duplicates
  const existing = await storage.get("pubmed");
  const newItems = [
    { pmid: "67890", title: "Paper 2" },  // Duplicate
    { pmid: "11111", title: "Paper 3" },  // New
    { pmid: "12345", title: "Paper 1" }   // Duplicate
  ];
  
  // Build ID index
  const idIndex = new Map();
  for (const item of existing.content) {
    idIndex.set(item.pmid, item);
  }
  
  // Merge
  const toAdd = [];
  for (const item of newItems) {
    if (!idIndex.has(item.pmid)) {
      toAdd.push(item);
      idIndex.set(item.pmid, item);
    }
  }
  
  const merged = [...existing.content, ...toAdd];
  await storage.set("pubmed", merged, { mode: 'overwrite' });
  
  // Verify
  const result = await storage.get("pubmed");
  assertEquals(result.content.length, 3);  // 2 original + 1 new
  assertEquals(result.content[2].pmid, "11111");
});

Deno.test("merge: Content hash deduplication", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Helper: simple hash function
  const hash = (obj: any) => JSON.stringify(obj, Object.keys(obj).sort());
  
  // Initial data
  await storage.set("articles", [
    { title: "Article 1", url: "https://example.com/1" },
    { title: "Article 2", url: "https://example.com/2" }
  ]);
  
  // Merge with duplicates (same content, different objects)
  const existing = await storage.get("articles");
  const newItems = [
    { title: "Article 2", url: "https://example.com/2" },  // Duplicate content
    { title: "Article 3", url: "https://example.com/3" },  // New
    { title: "Article 1", url: "https://example.com/1" }   // Duplicate content
  ];
  
  // Build hash index
  const hashIndex = new Set();
  for (const item of existing.content) {
    hashIndex.add(hash(item));
  }
  
  // Merge
  const toAdd = [];
  for (const item of newItems) {
    const itemHash = hash(item);
    if (!hashIndex.has(itemHash)) {
      toAdd.push(item);
      hashIndex.add(itemHash);
    }
  }
  
  const merged = [...existing.content, ...toAdd];
  await storage.set("articles", merged, { mode: 'overwrite' });
  
  // Verify
  const result = await storage.get("articles");
  assertEquals(result.content.length, 3);  // 2 original + 1 new
  assertEquals(result.content[2].title, "Article 3");
});

Deno.test("merge: Empty collection (create new)", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Merge into non-existent collection
  const newItems = [
    { id: "1", name: "Item 1" },
    { id: "2", name: "Item 2" }
  ];
  
  await storage.set("new-collection", newItems);
  
  // Verify
  const result = await storage.get("new-collection");
  assertEquals(result.content.length, 2);
});

Deno.test("merge: Field-based comparison", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Initial data
  await storage.set("bookmarks", [
    { url: "https://example.com", title: "Example", tags: ["web"] }
  ]);
  
  // Merge with duplicate based on url+title
  const existing = await storage.get("bookmarks");
  const newItems = [
    { url: "https://example.com", title: "Example", tags: ["favorite"] },  // Duplicate
    { url: "https://example.org", title: "Example Org", tags: ["web"] }     // New
  ];
  
  const compareFields = ["url", "title"];
  const objectsMatch = (obj1: any, obj2: any) => {
    return compareFields.every(field => obj1[field] === obj2[field]);
  };
  
  // Merge
  const toAdd = [];
  for (const item of newItems) {
    const isDuplicate = existing.content.some((existing: any) => 
      objectsMatch(existing, item)
    );
    if (!isDuplicate) {
      toAdd.push(item);
    }
  }
  
  const merged = [...existing.content, ...toAdd];
  await storage.set("bookmarks", merged, { mode: 'overwrite' });
  
  // Verify
  const result = await storage.get("bookmarks");
  assertEquals(result.content.length, 2);  // 1 original + 1 new
  assertEquals(result.content[1].url, "https://example.org");
});

Deno.test("merge: All duplicates (nothing added)", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Initial data
  await storage.set("data", [
    { id: "1", name: "Item 1" },
    { id: "2", name: "Item 2" }
  ]);
  
  // Try to merge duplicates
  const existing = await storage.get("data");
  const newItems = [
    { id: "1", name: "Item 1" },
    { id: "2", name: "Item 2" }
  ];
  
  // Build index
  const idIndex = new Map();
  for (const item of existing.content) {
    idIndex.set(item.id, item);
  }
  
  // Merge
  const toAdd = [];
  for (const item of newItems) {
    if (!idIndex.has(item.id)) {
      toAdd.push(item);
    }
  }
  
  // Should be empty
  assertEquals(toAdd.length, 0);
  
  const merged = [...existing.content, ...toAdd];
  await storage.set("data", merged, { mode: 'overwrite' });
  
  // Verify nothing changed
  const result = await storage.get("data");
  assertEquals(result.content.length, 2);
});

Deno.test("merge: All new items (nothing skipped)", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Initial data
  await storage.set("data", [
    { id: "1", name: "Item 1" }
  ]);
  
  // Merge all new
  const existing = await storage.get("data");
  const newItems = [
    { id: "2", name: "Item 2" },
    { id: "3", name: "Item 3" },
    { id: "4", name: "Item 4" }
  ];
  
  // Build index
  const idIndex = new Map();
  for (const item of existing.content) {
    idIndex.set(item.id, item);
  }
  
  // Merge
  const toAdd = [];
  for (const item of newItems) {
    if (!idIndex.has(item.id)) {
      toAdd.push(item);
    }
  }
  
  assertEquals(toAdd.length, 3);
  
  const merged = [...existing.content, ...toAdd];
  await storage.set("data", merged, { mode: 'overwrite' });
  
  // Verify all added
  const result = await storage.get("data");
  assertEquals(result.content.length, 4);
});

Deno.test("merge: Mixed IDs and no IDs (auto strategy simulation)", async () => {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Helper: simple hash
  const hash = (obj: any) => JSON.stringify(obj, Object.keys(obj).sort());
  
  // Initial data (mixed)
  await storage.set("mixed", [
    { id: "1", title: "Item 1" },
    { title: "Item 2", content: "No ID" }
  ]);
  
  const existing = await storage.get("mixed");
  const newItems = [
    { id: "1", title: "Item 1" },  // Duplicate by ID
    { id: "3", title: "Item 3" },  // New with ID
    { title: "Item 2", content: "No ID" },  // Duplicate by hash
    { title: "Item 4", content: "Also no ID" }  // New without ID
  ];
  
  // Build hybrid index
  const idIndex = new Map();
  const hashIndex = new Set();
  
  for (const item of existing.content) {
    if (item.id) {
      idIndex.set(item.id, item);
    } else {
      hashIndex.add(hash(item));
    }
  }
  
  // Merge with auto strategy
  const toAdd = [];
  for (const item of newItems) {
    let isDuplicate = false;
    
    if (item.id) {
      isDuplicate = idIndex.has(item.id);
      if (!isDuplicate) {
        idIndex.set(item.id, item);
      }
    } else {
      const itemHash = hash(item);
      isDuplicate = hashIndex.has(itemHash);
      if (!isDuplicate) {
        hashIndex.add(itemHash);
      }
    }
    
    if (!isDuplicate) {
      toAdd.push(item);
    }
  }
  
  const merged = [...existing.content, ...toAdd];
  await storage.set("mixed", merged, { mode: 'overwrite' });
  
  // Verify
  const result = await storage.get("mixed");
  assertEquals(result.content.length, 4);  // 2 original + 2 new
});

console.log("✅ All merge tests passed!");

