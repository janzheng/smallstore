/**
 * Tests for Phase 3.6f-b: Data Operations
 * 
 * Tests merge, slice, split, and deduplicate operations.
 */

import { createSmallstore, createMemoryAdapter } from '../mod.ts';

async function runTests() {
  console.log('🧪 Testing Phase 3.6f-b: Data Operations\n');
  
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Test data
  const papers2021 = [
    { id: '1', title: 'Paper A', year: 2021 },
    { id: '2', title: 'Paper B', year: 2021 },
  ];
  
  const papers2022 = [
    { id: '2', title: 'Paper B Updated', year: 2022 },  // Duplicate ID
    { id: '3', title: 'Paper C', year: 2022 },
  ];
  
  const papers2023 = [
    { id: '4', title: 'Paper D', year: 2023 },
    { id: '5', title: 'Paper E', year: 2023 },
  ];
  
  // Setup
  await storage.set('papers-2021', papers2021);
  await storage.set('papers-2022', papers2022);
  await storage.set('papers-2023', papers2023);
  
  // Test 1: Merge
  console.log('Test 1: Merge');
  await storage.merge(['papers-2021', 'papers-2022', 'papers-2023'], 'papers-all');
  const merged = await storage.get('papers-all');
  console.log(`  ✓ Merged: ${merged.length} items`);
  console.assert(merged.length === 6, 'Should have 6 items');
  
  // Test 2: Merge with deduplication
  console.log('Test 2: Merge with deduplication');
  await storage.merge(['papers-2021', 'papers-2022'], 'papers-dedup', {
    deduplicate: true,
    idField: 'id',
    onConflict: 'replace'
  });
  const dedup = await storage.get('papers-dedup');
  console.log(`  ✓ Deduplicated: ${dedup.length} items`);
  console.assert(dedup.length === 3, 'Should have 3 unique items');
  
  // Test 3: Slice
  console.log('Test 3: Slice');
  const sliced = await storage.slice('papers-all', { start: 0, end: 3 });
  console.log(`  ✓ Sliced: ${sliced?.length} items`);
  console.assert(sliced?.length === 3, 'Should have 3 items');
  
  // Test 4: Split by year
  console.log('Test 4: Split');
  await storage.split('papers-all', {
    by: 'year',
    destPattern: 'papers-year-{value}'
  });
  const split2021 = await storage.get('papers-year-2021');
  console.log(`  ✓ Split by year: ${split2021.length} items in 2021`);
  console.assert(split2021.length === 2, 'Should have 2 items for 2021');
  
  // Test 5: Deduplicate
  console.log('Test 5: Deduplicate');
  await storage.set('papers-dup', [
    { id: '1', title: 'Paper A' },
    { id: '1', title: 'Paper A' },  // Duplicate
    { id: '2', title: 'Paper B' },
  ]);
  await storage.deduplicate('papers-dup', { idField: 'id' });
  const deduped = await storage.get('papers-dup');
  console.log(`  ✓ Deduplicated: ${deduped.length} unique items`);
  console.assert(deduped.length === 2, 'Should have 2 unique items');
  
  console.log('\n✅ All data operations tests passed!\n');
}

if (import.meta.main) {
  await runTests();
}

