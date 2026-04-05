/**
 * Tests for Collection Metadata
 * 
 * Tests user-defined metadata on collections (folder prompts, tags, etc.)
 */

import { assertEquals, assertExists } from "@std/assert";
import { createSmallstore } from '../mod.ts';
import { createMemoryAdapter } from '../src/adapters/memory.ts';

Deno.test("Collection Metadata: Set and get basic metadata", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Set metadata
  await storage.setCollectionMetadata('research/ai-papers', {
    name: 'AI Research Papers',
    description: 'Papers about AI agents',
    tags: ['ai', 'research'],
  });
  
  // Get metadata
  const metadata = await storage.getCollectionMetadata('research/ai-papers');
  
  assertEquals(metadata.name, 'AI Research Papers');
  assertEquals(metadata.description, 'Papers about AI agents');
  assertEquals(metadata.tags, ['ai', 'research']);
  assertExists(metadata.created);
  assertExists(metadata.updated);
  
  console.log('✅ Basic metadata set and retrieved');
});

Deno.test("Collection Metadata: Folder prompts", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Set folder prompt
  await storage.setCollectionMetadata('podcasts/episode-1', {
    name: 'Episode 1: Getting Started',
    prompt: 'This episode is about getting started with Deno. Focus on beginner-friendly content.',
    workflow: 'podcast-production',
  });
  
  // Get metadata
  const metadata = await storage.getCollectionMetadata('podcasts/episode-1');
  
  assertEquals(metadata.prompt, 'This episode is about getting started with Deno. Focus on beginner-friendly content.');
  assertEquals(metadata.workflow, 'podcast-production');
  
  console.log('✅ Folder prompt stored');
});

Deno.test("Collection Metadata: Merge with existing", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Set initial metadata
  await storage.setCollectionMetadata('projects/website', {
    name: 'Website Project',
    status: 'active',
  });
  
  // Add more metadata (should merge)
  await storage.setCollectionMetadata('projects/website', {
    client: 'ACME Corp',
    deadline: '2025-12-31',
  });
  
  // Get metadata - should have both
  const metadata = await storage.getCollectionMetadata('projects/website');
  
  assertEquals(metadata.name, 'Website Project');
  assertEquals(metadata.status, 'active');
  assertEquals(metadata.client, 'ACME Corp');
  assertEquals(metadata.deadline, '2025-12-31');
  
  console.log('✅ Metadata merged correctly');
});

Deno.test("Collection Metadata: Arbitrary keys", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Set custom metadata
  await storage.setCollectionMetadata('custom/collection', {
    my_custom_field: 'value',
    nested: {
      data: 'here'
    },
    array: [1, 2, 3],
  });
  
  // Get metadata
  const metadata = await storage.getCollectionMetadata('custom/collection');
  
  assertEquals(metadata.my_custom_field, 'value');
  assertEquals(metadata.nested.data, 'here');
  assertEquals(metadata.array, [1, 2, 3]);
  
  console.log('✅ Arbitrary metadata keys work');
});

Deno.test("Collection Metadata: Empty collection (no data yet)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Set metadata on collection that has no data yet
  await storage.setCollectionMetadata('future/collection', {
    name: 'Planned Collection',
    notes: 'Will add data here later',
  });
  
  // Get metadata
  const metadata = await storage.getCollectionMetadata('future/collection');
  
  assertEquals(metadata.name, 'Planned Collection');
  assertEquals(metadata.notes, 'Will add data here later');
  
  console.log('✅ Metadata works on empty collections');
});

console.log('\n🎉 All collection metadata tests completed!\n');

