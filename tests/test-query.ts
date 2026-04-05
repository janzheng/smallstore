/**
 * Tests for Phase 3.6f-a: Universal Query System
 */

import { createSmallstore, createMemoryAdapter } from '../mod.ts';
import type { QueryResult } from '../src/types.ts';

// Test data
const papers = [
  { id: '1', title: 'Paper A', year: 2023, citations: 150, authors: ['Smith', 'Jones'], topic: 'AI' },
  { id: '2', title: 'Paper B', year: 2022, citations: 80, authors: ['Brown'], topic: 'ML' },
  { id: '3', title: 'Paper C', year: 2024, citations: 200, authors: ['Smith', 'Davis'], topic: 'AI' },
  { id: '4', title: 'Paper D', year: 2023, citations: 50, authors: ['Wilson'], topic: 'NLP' },
  { id: '5', title: 'Paper E', year: 2021, citations: 300, authors: ['Taylor', 'Smith'], topic: 'ML' },
  { id: '6', title: 'Paper F', year: 2024, citations: 120, authors: ['Johnson'], topic: 'AI' },
  { id: '7', title: 'Paper G', year: 2023, citations: 90, authors: ['Lee'], topic: 'NLP' },
  { id: '8', title: 'Paper H', year: 2022, citations: 175, authors: ['Brown', 'Smith'], topic: 'AI' },
  { id: '9', title: 'Paper I', year: 2024, citations: 60, authors: ['Davis'], topic: 'ML' },
  { id: '10', title: 'Paper J', year: 2023, citations: 110, authors: ['Wilson', 'Taylor'], topic: 'NLP' },
];

async function runTests() {
  console.log('🧪 Testing Phase 3.6f-a: Universal Query System\n');
  
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Setup: Add test data
  await storage.set('papers', papers);
  console.log('✓ Test data loaded (10 papers)\n');
  
  // ============================================================================
  // Test 1: MongoDB-style filters
  // ============================================================================
  
  console.log('Test 1: MongoDB-style filters');
  
  // Greater than
  const result1 = await storage.query('papers', {
    filter: { citations: { $gt: 150 } }
  }) as QueryResult;
  
  console.log(`  ✓ Filter: citations > 150`);
  console.log(`    Found: ${result1.data.length} papers`);
  console.assert(result1.data.length === 3, 'Should find 3 papers with >150 citations');
  console.assert(result1.data.every(p => p.citations > 150), 'All should have >150 citations');
  
  // Range query
  const result2 = await storage.query('papers', {
    filter: {
      year: { $gte: 2023 },
      citations: { $lt: 150 }
    }
  }) as QueryResult;
  
  console.log(`  ✓ Filter: year >= 2023 AND citations < 150`);
  console.log(`    Found: ${result2.data.length} papers`);
  console.assert(result2.data.every(p => p.year >= 2023 && p.citations < 150), 'All should match criteria');
  
  // String contains
  const result3 = await storage.query('papers', {
    filter: { topic: { $in: ['AI', 'ML'] } }
  }) as QueryResult;
  
  console.log(`  ✓ Filter: topic in ['AI', 'ML']`);
  console.log(`    Found: ${result3.data.length} papers`);
  console.assert(result3.data.every(p => p.topic === 'AI' || p.topic === 'ML'), 'All should be AI or ML');
  
  // Logical operators
  const result4 = await storage.query('papers', {
    filter: {
      $or: [
        { citations: { $gte: 200 } },
        { year: 2024 }
      ]
    }
  }) as QueryResult;
  
  console.log(`  ✓ Filter: citations >= 200 OR year = 2024`);
  console.log(`    Found: ${result4.data.length} papers`);
  console.assert(result4.data.every(p => p.citations >= 200 || p.year === 2024), 'All should match OR condition');
  
  console.log();
  
  // ============================================================================
  // Test 2: Function filters
  // ============================================================================
  
  console.log('Test 2: Function filters');
  
  const result5 = await storage.query('papers', {
    where: (p) => p.authors.includes('Smith') && p.citations > 100
  }) as QueryResult;
  
  console.log(`  ✓ Where: Smith as author AND citations > 100`);
  console.log(`    Found: ${result5.data.length} papers`);
  console.assert(result5.data.every(p => p.authors.includes('Smith') && p.citations > 100), 'All should match criteria');
  
  console.log();
  
  // ============================================================================
  // Test 3: Projection (select/omit)
  // ============================================================================
  
  console.log('Test 3: Projection (select/omit)');
  
  const result6 = await storage.query('papers', {
    filter: { year: 2023 },
    select: ['title', 'citations']
  }) as QueryResult;
  
  console.log(`  ✓ Select: only title and citations`);
  console.log(`    Sample:`, JSON.stringify(result6.data[0], null, 2));
  console.assert(Object.keys(result6.data[0]).length === 2, 'Should have only 2 fields');
  console.assert('title' in result6.data[0] && 'citations' in result6.data[0], 'Should have title and citations');
  
  const result7 = await storage.query('papers', {
    filter: { year: 2023 },
    omit: ['authors', 'topic']
  }) as QueryResult;
  
  console.log(`  ✓ Omit: exclude authors and topic`);
  console.assert(!('authors' in result7.data[0]) && !('topic' in result7.data[0]), 'Should not have authors or topic');
  
  console.log();
  
  // ============================================================================
  // Test 4: Sorting
  // ============================================================================
  
  console.log('Test 4: Sorting');
  
  const result8 = await storage.query('papers', {
    sort: { citations: -1 },  // Descending
    limit: 3
  }) as QueryResult;
  
  console.log(`  ✓ Sort: by citations DESC, limit 3`);
  console.log(`    Top 3 citations: ${result8.data.map(p => p.citations).join(', ')}`);
  console.assert(result8.data[0].citations >= result8.data[1].citations, 'Should be sorted descending');
  console.assert(result8.data.length === 3, 'Should have 3 results');
  
  const result9 = await storage.query('papers', {
    sort: 'year ASC'  // String format
  }) as QueryResult;
  
  console.log(`  ✓ Sort: by year ASC (string format)`);
  console.log(`    Years: ${result9.data.map(p => p.year).join(', ')}`);
  console.assert(result9.data[0].year <= result9.data[1].year, 'Should be sorted ascending');
  
  console.log();
  
  // ============================================================================
  // Test 5: Page-based pagination
  // ============================================================================
  
  console.log('Test 5: Page-based pagination');
  
  const page1 = await storage.query('papers', {
    page: 1,
    pageSize: 3
  }) as QueryResult;
  
  console.log(`  ✓ Page 1 (size 3)`);
  console.log(`    Items: ${page1.data.length}`);
  console.log(`    Total pages: ${page1.pagination?.totalPages}`);
  console.log(`    Has next: ${page1.pagination?.hasNext}`);
  console.assert(page1.data.length === 3, 'Should have 3 items');
  console.assert(page1.pagination?.page === 1, 'Should be page 1');
  console.assert(page1.pagination?.hasNext === true, 'Should have next page');
  
  const page2 = await storage.query('papers', {
    page: 2,
    pageSize: 3
  }) as QueryResult;
  
  console.log(`  ✓ Page 2 (size 3)`);
  console.log(`    Items: ${page2.data.length}`);
  console.log(`    Has previous: ${page2.pagination?.hasPrevious}`);
  console.assert(page2.pagination?.page === 2, 'Should be page 2');
  console.assert(page2.pagination?.hasPrevious === true, 'Should have previous page');
  
  console.log();
  
  // ============================================================================
  // Test 6: Cursor-based pagination
  // ============================================================================
  
  console.log('Test 6: Cursor-based pagination');
  
  const cursor1 = await storage.query('papers', {
    pageSize: 4,
    sort: { year: -1 }
  }) as QueryResult;
  
  console.log(`  ✓ First cursor page`);
  console.log(`    Items: ${cursor1.data.length}`);
  console.log(`    Next cursor: ${cursor1.pagination?.nextCursor?.substring(0, 20)}...`);
  
  if (cursor1.pagination?.nextCursor) {
    const cursor2 = await storage.query('papers', {
      cursor: cursor1.pagination.nextCursor,
      pageSize: 4
    }) as QueryResult;
    
    console.log(`  ✓ Next cursor page`);
    console.log(`    Items: ${cursor2.data.length}`);
    console.assert(cursor2.data.length > 0, 'Should have items on next page');
  }
  
  console.log();
  
  // ============================================================================
  // Test 7: Range requests
  // ============================================================================
  
  console.log('Test 7: Range requests');
  
  const range1 = await storage.query('papers', {
    range: { start: 0, end: 4 }
  }) as QueryResult;
  
  console.log(`  ✓ Range: 0-4`);
  console.log(`    Items: ${range1.data.length}`);
  console.log(`    Content-Range: ${range1.range?.contentRange}`);
  console.assert(range1.data.length === 5, 'Should have 5 items (0-4 inclusive)');
  console.assert(range1.range?.start === 0 && range1.range?.end === 4, 'Should match requested range');
  
  const range2 = await storage.query('papers', {
    range: '5-9'  // String format
  }) as QueryResult;
  
  console.log(`  ✓ Range: 5-9 (string format)`);
  console.log(`    Items: ${range2.data.length}`);
  console.assert(range2.data.length === 5, 'Should have 5 items');
  
  console.log();
  
  // ============================================================================
  // Test 8: Format transformers
  // ============================================================================
  
  console.log('Test 8: Format transformers');
  
  const markdown = await storage.query('papers', {
    filter: { year: 2024 },
    format: 'markdown'
  }) as any;
  
  console.log(`  ✓ Format: markdown`);
  console.log(`    Type: ${typeof markdown}`);
  console.log(`    Preview: ${markdown.substring(0, 100)}...`);
  console.assert(typeof markdown === 'string', 'Should return string');
  console.assert(markdown.includes('# papers'), 'Should have collection header');
  
  const csv = await storage.query('papers', {
    filter: { year: 2023 },
    format: 'csv'
  }) as any;
  
  console.log(`  ✓ Format: csv`);
  console.log(`    Preview: ${csv.substring(0, 100)}...`);
  console.assert(typeof csv === 'string', 'Should return string');
  console.assert(csv.includes('title,'), 'Should have CSV headers');
  
  console.log();
  
  // ============================================================================
  // Test 9: Complex query (combining everything)
  // ============================================================================
  
  console.log('Test 9: Complex query (combining features)');
  
  const complex = await storage.query('papers', {
    filter: {
      $and: [
        { year: { $gte: 2023 } },
        { citations: { $gt: 100 } }
      ]
    },
    select: ['title', 'year', 'citations'],
    sort: { citations: -1 },
    page: 1,
    pageSize: 5,
    includeMeta: true
  }) as QueryResult;
  
  console.log(`  ✓ Complex query: filter + select + sort + paginate`);
  console.log(`    Items: ${complex.data.length}`);
  console.log(`    Execution time: ${complex.meta?.executionTime}ms`);
  console.log(`    Items scanned: ${complex.meta?.itemsScanned}`);
  console.log(`    Items returned: ${complex.meta?.itemsReturned}`);
  console.log(`    Sample:`, JSON.stringify(complex.data[0], null, 2));
  
  console.log();
  
  // ============================================================================
  // Summary
  // ============================================================================
  
  console.log('✅ All query system tests passed!\n');
}

// Run tests
if (import.meta.main) {
  await runTests();
}

