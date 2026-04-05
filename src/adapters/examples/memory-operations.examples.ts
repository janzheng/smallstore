/**
 * Examples: Memory Adapter High-Level Operations
 * 
 * Demonstrates the high-level operations available on the Memory adapter.
 */

import { createMemoryAdapter } from '../memory.ts';

// ============================================================================
// Setup
// ============================================================================

const memoryAdapter = createMemoryAdapter();

// ============================================================================
// Example 1: Upsert with explicit ID field
// ============================================================================

async function example1_upsert() {
  console.log('\n=== Example 1: Upsert with explicit ID field ===\n');
  
  const users = [
    { id: 'user-001', name: 'Alice Smith', email: 'alice@example.com', status: 'Active' },
    { id: 'user-002', name: 'Bob Jones', email: 'bob@example.com', status: 'Inactive' },
    { id: 'user-003', name: 'Carol Davis', email: 'carol@example.com', status: 'Active' },
  ];
  
  const result = await memoryAdapter.upsert(users, { idField: 'id' });
  
  console.log(`✅ Upserted ${result.count} users`);
  console.log('Keys:', result.keys);
  
  // Verify they're stored
  const alice = await memoryAdapter.get('user-001');
  console.log('Retrieved Alice:', alice);
}

// ============================================================================
// Example 2: Insert with auto-detection
// ============================================================================

async function example2_autoDetect() {
  console.log('\n=== Example 2: Insert with auto-detection ===\n');
  
  const papers = [
    { pmid: '12345', title: 'Paper 1', authors: ['Smith', 'Jones'] },
    { pmid: '67890', title: 'Paper 2', authors: ['Davis'] },
  ];
  
  // Will auto-detect 'pmid' as the ID field
  const result = await memoryAdapter.insert(papers, { autoDetect: true });
  
  console.log(`✅ Inserted ${result.count} papers`);
  console.log(`Auto-detected ID field: ${result.idField}`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 3: Merge arrays with deduplication
// ============================================================================

async function example3_merge() {
  console.log('\n=== Example 3: Merge arrays with deduplication ===\n');
  
  // Initial data
  await memoryAdapter.set('search-results', [
    { pmid: '111', title: 'Result 1' },
    { pmid: '222', title: 'Result 2' },
  ]);
  
  // New batch (222 is duplicate, 333 is new)
  const newResults = [
    { pmid: '222', title: 'Result 2' },
    { pmid: '333', title: 'Result 3' },
  ];
  
  const result = await memoryAdapter.merge('search-results', newResults, {
    strategy: 'id',
    idField: 'pmid'
  });
  
  console.log(`✅ Merged results`);
  console.log(`Total items: ${result.totalItems}`);
  console.log(`Added: ${result.added}, Skipped: ${result.skipped}`);
  
  // Verify
  const all = await memoryAdapter.get('search-results');
  console.log('All results:', all);
}

// ============================================================================
// Example 4: Query with filtering
// ============================================================================

async function example4_query() {
  console.log('\n=== Example 4: Query with filtering ===\n');
  
  // Store some test data
  await memoryAdapter.set('product-001', { id: '001', name: 'Widget', price: 10, inStock: true });
  await memoryAdapter.set('product-002', { id: '002', name: 'Gadget', price: 20, inStock: false });
  await memoryAdapter.set('product-003', { id: '003', name: 'Doohickey', price: 15, inStock: true });
  
  // Query: Get products in stock
  const inStock = await memoryAdapter.query({
    prefix: 'product-',
    filter: (item) => item.inStock === true
  });
  
  console.log(`✅ Found ${inStock.length} products in stock:`);
  inStock.forEach(p => console.log(`  - ${p.name} ($${p.price})`));
}

// ============================================================================
// Example 5: List all items with pagination
// ============================================================================

async function example5_list() {
  console.log('\n=== Example 5: List all items with pagination ===\n');
  
  // Get first 2 products
  const firstPage = await memoryAdapter.list({
    prefix: 'product-',
    limit: 2,
    offset: 0
  });
  
  console.log(`✅ First page (${firstPage.length} items):`);
  firstPage.forEach(p => console.log(`  - ${p.name}`));
  
  // Get next page
  const secondPage = await memoryAdapter.list({
    prefix: 'product-',
    limit: 2,
    offset: 2
  });
  
  console.log(`\n✅ Second page (${secondPage.length} items):`);
  secondPage.forEach(p => console.log(`  - ${p.name}`));
}

// ============================================================================
// Example 6: Custom key generator
// ============================================================================

async function example6_keyGenerator() {
  console.log('\n=== Example 6: Custom key generator ===\n');
  
  const employees = [
    { firstName: 'John', lastName: 'Doe', email: 'john.doe@company.com' },
    { firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@company.com' },
  ];
  
  // Generate keys like "doe-john"
  const result = await memoryAdapter.upsert(employees, {
    keyGenerator: (obj) => `${obj.lastName.toLowerCase()}-${obj.firstName.toLowerCase()}`
  });
  
  console.log(`✅ Upserted ${result.count} employees`);
  console.log('Keys:', result.keys);
  
  // Verify
  const john = await memoryAdapter.get('doe-john');
  console.log('Retrieved John:', john);
}

// ============================================================================
// Example 7: Content hash deduplication
// ============================================================================

async function example7_hashMerge() {
  console.log('\n=== Example 7: Content hash deduplication ===\n');
  
  // Initial data (no ID fields)
  await memoryAdapter.set('scraped-articles', [
    { title: 'Article 1', url: 'http://example.com/1' },
    { title: 'Article 2', url: 'http://example.com/2' },
  ]);
  
  // New batch (one duplicate, one new)
  const newArticles = [
    { title: 'Article 2', url: 'http://example.com/2' }, // Duplicate
    { title: 'Article 3', url: 'http://example.com/3' }, // New
  ];
  
  const result = await memoryAdapter.merge('scraped-articles', newArticles, {
    strategy: 'hash',
    hashFields: ['title', 'url']  // Hash based on these fields
  });
  
  console.log(`✅ Merged articles using content hash`);
  console.log(`Total items: ${result.totalItems}`);
  console.log(`Added: ${result.added}, Skipped: ${result.skipped}`);
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Memory Adapter High-Level Operations Examples\n');
  
  try {
    await example1_upsert();
    await example2_autoDetect();
    await example3_merge();
    await example4_query();
    await example5_list();
    await example6_keyGenerator();
    await example7_hashMerge();
    
    console.log('\n✨ All examples completed!\n');
    
    // Show storage stats
    console.log(`📊 Memory storage size: ${memoryAdapter.size()} items\n`);
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

