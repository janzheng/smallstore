/**
 * Examples for Phase 3.6f-a: Universal Query System
 * 
 * Demonstrates:
 * - MongoDB-style filters
 * - Function filters
 * - Projection (select/omit)
 * - Sorting
 * - Page & cursor-based pagination
 * - Range requests
 * - Format transformation
 */

import { createSmallstore, createMemoryAdapter } from '../mod.ts';

// Sample data: Research papers
const papers = [
  { id: '1', title: 'Attention Is All You Need', year: 2017, citations: 50000, authors: ['Vaswani', 'Shazeer'], topic: 'transformers' },
  { id: '2', title: 'BERT: Pre-training of Deep Bidirectional Transformers', year: 2019, citations: 30000, authors: ['Devlin', 'Chang'], topic: 'nlp' },
  { id: '3', title: 'GPT-3: Language Models are Few-Shot Learners', year: 2020, citations: 15000, authors: ['Brown', 'Mann'], topic: 'llm' },
  { id: '4', title: 'ResNet: Deep Residual Learning', year: 2016, citations: 80000, authors: ['He', 'Zhang'], topic: 'cv' },
  { id: '5', title: 'AlphaGo: Mastering the game of Go', year: 2016, citations: 10000, authors: ['Silver', 'Huang'], topic: 'rl' },
];

async function examples() {
  const storage = createSmallstore({
    adapters: { memory: createMemoryAdapter() },
    defaultAdapter: 'memory',
  });
  
  // Setup: Add papers
  await storage.set('research/papers', papers);
  
  console.log('📚 Universal Query System Examples\n');
  
  // ============================================================================
  // Example 1: MongoDB-Style Filters
  // ============================================================================
  
  console.log('Example 1: MongoDB-Style Filters\n');
  
  // Find recent high-impact papers
  const result1 = await storage.query('research/papers', {
    filter: {
      year: { $gte: 2019 },
      citations: { $gte: 10000 }
    }
  });
  
  console.log('High-impact papers (2019+, 10k+ citations):');
  console.log(JSON.stringify(result1.data, null, 2));
  console.log();
  
  // Find papers by topic
  const result2 = await storage.query('research/papers', {
    filter: {
      topic: { $in: ['nlp', 'llm'] }
    }
  });
  
  console.log('NLP/LLM papers:');
  console.log(result2.data.map(p => p.title).join('\n'));
  console.log();
  
  // Logical OR: Find papers that are either recent or highly cited
  const result3 = await storage.query('research/papers', {
    filter: {
      $or: [
        { year: { $gte: 2020 } },
        { citations: { $gte: 50000 } }
      ]
    }
  });
  
  console.log('Recent (2020+) OR highly cited (50k+):');
  console.log(result3.data.map(p => `${p.title} (${p.year}, ${p.citations})`).join('\n'));
  console.log();
  
  // ============================================================================
  // Example 2: Function Filters
  // ============================================================================
  
  console.log('Example 2: Function Filters\n');
  
  // Complex custom logic
  const result4 = await storage.query('research/papers', {
    where: (paper) => {
      const isRecent = paper.year >= 2018;
      const hasAuthor = paper.authors.some((a: string) => a.startsWith('B'));
      return isRecent && hasAuthor;
    }
  });
  
  console.log('Recent papers with author starting with B:');
  console.log(result4.data.map(p => `${p.title} by ${p.authors.join(', ')}`).join('\n'));
  console.log();
  
  // ============================================================================
  // Example 3: Projection (Select/Omit)
  // ============================================================================
  
  console.log('Example 3: Projection\n');
  
  // Select only specific fields
  const result5 = await storage.query('research/papers', {
    select: ['title', 'year', 'citations'],
    sort: { citations: -1 },
    limit: 3
  });
  
  console.log('Top 3 papers (title, year, citations only):');
  console.log(JSON.stringify(result5.data, null, 2));
  console.log();
  
  // Omit sensitive fields
  const result6 = await storage.query('research/papers', {
    omit: ['id'],
    limit: 2
  });
  
  console.log('Papers (without IDs):');
  console.log(JSON.stringify(result6.data, null, 2));
  console.log();
  
  // ============================================================================
  // Example 4: Sorting
  // ============================================================================
  
  console.log('Example 4: Sorting\n');
  
  // Sort by citations (descending)
  const result7 = await storage.query('research/papers', {
    sort: { citations: -1 }
  });
  
  console.log('Papers sorted by citations (DESC):');
  console.log(result7.data.map(p => `${p.title}: ${p.citations} citations`).join('\n'));
  console.log();
  
  // Sort by year (ascending) - string format
  const result8 = await storage.query('research/papers', {
    sort: 'year ASC'
  });
  
  console.log('Papers sorted by year (ASC):');
  console.log(result8.data.map(p => `${p.year}: ${p.title}`).join('\n'));
  console.log();
  
  // ============================================================================
  // Example 5: Page-Based Pagination
  // ============================================================================
  
  console.log('Example 5: Page-Based Pagination\n');
  
  // First page
  const page1 = await storage.query('research/papers', {
    page: 1,
    pageSize: 2,
    sort: { year: -1 }
  });
  
  console.log('Page 1:');
  console.log(`  Items: ${page1.data.length}`);
  console.log(`  Total: ${page1.pagination?.totalItems}`);
  console.log(`  Pages: ${page1.pagination?.totalPages}`);
  console.log(`  Has next: ${page1.pagination?.hasNext}`);
  console.log(`  Papers: ${page1.data.map(p => p.title).join(', ')}`);
  console.log();
  
  // Second page
  const page2 = await storage.query('research/papers', {
    page: 2,
    pageSize: 2,
    sort: { year: -1 }
  });
  
  console.log('Page 2:');
  console.log(`  Has previous: ${page2.pagination?.hasPrevious}`);
  console.log(`  Papers: ${page2.data.map(p => p.title).join(', ')}`);
  console.log();
  
  // ============================================================================
  // Example 6: Cursor-Based Pagination
  // ============================================================================
  
  console.log('Example 6: Cursor-Based Pagination\n');
  
  // First cursor page
  const cursor1 = await storage.query('research/papers', {
    pageSize: 2,
    sort: { citations: -1 }
  });
  
  console.log('Cursor Page 1:');
  console.log(`  Papers: ${cursor1.data.map(p => p.title).join(', ')}`);
  console.log(`  Next cursor: ${cursor1.pagination?.nextCursor}`);
  console.log();
  
  // Use cursor for next page
  if (cursor1.pagination?.nextCursor) {
    const cursor2 = await storage.query('research/papers', {
      cursor: cursor1.pagination.nextCursor,
      pageSize: 2
    });
    
    console.log('Cursor Page 2:');
    console.log(`  Papers: ${cursor2.data.map(p => p.title).join(', ')}`);
    console.log();
  }
  
  // ============================================================================
  // Example 7: Range Requests
  // ============================================================================
  
  console.log('Example 7: Range Requests\n');
  
  // Get items 0-2
  const range1 = await storage.query('research/papers', {
    range: { start: 0, end: 2 },
    sort: { year: -1 }
  });
  
  console.log('Range 0-2:');
  console.log(`  Content-Range: ${range1.range?.contentRange}`);
  console.log(`  Papers: ${range1.data.map(p => p.title).join(', ')}`);
  console.log();
  
  // String format
  const range2 = await storage.query('research/papers', {
    range: '2-4',
    sort: { year: -1 }
  });
  
  console.log('Range 2-4 (string format):');
  console.log(`  Papers: ${range2.data.map(p => p.title).join(', ')}`);
  console.log();
  
  // ============================================================================
  // Example 8: Format Transformation
  // ============================================================================
  
  console.log('Example 8: Format Transformation\n');
  
  // Export as Markdown
  const markdown = await storage.query('research/papers', {
    filter: { topic: 'llm' },
    format: 'markdown'
  });
  
  console.log('Markdown format:');
  console.log(markdown);
  console.log();
  
  // Export as CSV
  const csv = await storage.query('research/papers', {
    select: ['title', 'year', 'citations'],
    sort: { citations: -1 },
    limit: 3,
    format: 'csv'
  });
  
  console.log('CSV format (top 3):');
  console.log(csv);
  console.log();
  
  // ============================================================================
  // Example 9: Complex Real-World Query
  // ============================================================================
  
  console.log('Example 9: Complex Real-World Query\n');
  
  // Find recent papers (2018+) with high citations (10k+), 
  // show only essential fields, sorted by citations, paginated
  const complex = await storage.query('research/papers', {
    filter: {
      $and: [
        { year: { $gte: 2018 } },
        { citations: { $gte: 10000 } }
      ]
    },
    select: ['title', 'year', 'citations', 'topic'],
    sort: { citations: -1 },
    page: 1,
    pageSize: 3,
    includeMeta: true
  });
  
  console.log('Recent high-impact papers:');
  console.log(JSON.stringify(complex.data, null, 2));
  console.log(`\nMetadata:`);
  console.log(`  Execution time: ${complex.meta?.executionTime}ms`);
  console.log(`  Items scanned: ${complex.meta?.itemsScanned}`);
  console.log(`  Items returned: ${complex.meta?.itemsReturned}`);
  console.log();
  
  // ============================================================================
  // Example 10: API Response Pattern
  // ============================================================================
  
  console.log('Example 10: API Response Pattern\n');
  
  // Simulate REST API endpoint
  function buildApiResponse(query: string, year?: number, pageNumber?: number) {
    return storage.query('research/papers', {
      filter: year ? { year: { $gte: year } } : {},
      where: query ? (p) => p.title.toLowerCase().includes(query.toLowerCase()) : undefined,
      page: pageNumber || 1,
      pageSize: 10,
      sort: { citations: -1 },
      includeMeta: true
    });
  }
  
  // Example API call: GET /api/papers?q=learning&year=2016&page=1
  const apiResponse = await buildApiResponse('learning', 2016, 1);
  
  console.log('API Response:');
  console.log(JSON.stringify({
    data: apiResponse.data,
    pagination: apiResponse.pagination,
    meta: apiResponse.meta
  }, null, 2));
}

// Run examples
if (import.meta.main) {
  await examples();
}

