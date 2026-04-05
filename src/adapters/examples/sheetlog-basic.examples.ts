/**
 * Sheetlog Adapter - Basic Usage Examples
 * 
 * Demonstrates basic operations with Sheetlog (Google Sheets as database).
 * 
 * Setup:
 * 1. Deploy Sheetlog Apps Script to your Google Sheet
 * 2. Get the deployment URL
 * 3. Set SHEET_URL environment variable
 * 
 * Run: deno run --allow-net --allow-env sheetlog-basic.examples.ts
 */

import { createSheetlogAdapter } from '../sheetlog.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Example 1: Basic Setup
// ============================================================================

export async function example1_basicSetup() {
  console.log('\n=== Example 1: Basic Setup ===\n');
  
  // Create Sheetlog adapter
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL || 'https://script.google.com/macros/s/.../exec',
    sheet: 'Demo',  // Sheet tab name
  });
  
  console.log('Adapter created:', adapter.capabilities.name);
  console.log('Supported types:', adapter.capabilities.supportedTypes);
  
  return adapter;
}

// ============================================================================
// Example 2: Store Array in Sheet (Default Pattern)
// ============================================================================

export async function example2_storeArray() {
  console.log('\n=== Example 2: Store Array in Sheet ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Movies',
  });
  
  const movies = [
    { title: 'The Shawshank Redemption', year: 1994, director: 'Frank Darabont', rating: 9.3 },
    { title: 'The Godfather', year: 1972, director: 'Francis Ford Coppola', rating: 9.2 },
    { title: 'The Dark Knight', year: 2008, director: 'Christopher Nolan', rating: 9.0 },
  ];
  
  // Store entire array in sheet
  console.log('Storing movies array...');
  await adapter.set('movies', movies);
  console.log('✅ Stored 3 movies');
  
  // Retrieve entire sheet
  const retrieved = await adapter.get('movies');
  console.log(`✅ Retrieved ${retrieved?.length || 0} movies`);
  console.log('First movie:', retrieved?.[0]);
  
  return { adapter, movies };
}

// ============================================================================
// Example 3: Auto ID Detection (First Column)
// ============================================================================

export async function example3_autoIdDetection() {
  console.log('\n=== Example 3: Auto ID Detection ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Products',
  });
  
  const products = [
    { sku: 'WIDGET-001', name: 'Widget', price: 10, inStock: true },
    { sku: 'GADGET-002', name: 'Gadget', price: 20, inStock: true },
    { sku: 'DOODAD-003', name: 'Doodad', price: 30, inStock: false },
  ];
  
  // Insert with auto ID detection
  // Will detect 'sku' (first column) as ID field
  console.log('Inserting products with auto ID detection...');
  const result = await adapter.insert(products);
  
  console.log('✅ Inserted:', result.count, 'products');
  console.log('✅ Detected ID field:', result.idField);
  console.log('✅ Keys:', result.keys);
  
  return { adapter, products };
}

// ============================================================================
// Example 4: Upsert by Key (Update if Exists)
// ============================================================================

export async function example4_upsertByKey() {
  console.log('\n=== Example 4: Upsert by Key ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Inventory',
  });
  
  // Initial data
  const initialData = [
    { productId: 'P001', name: 'Widget', stock: 100 },
    { productId: 'P002', name: 'Gadget', stock: 50 },
  ];
  
  console.log('Initial insert...');
  await adapter.insert(initialData, { idField: 'productId' });
  console.log('✅ Inserted 2 products');
  
  // Update existing + add new
  const updates = [
    { productId: 'P001', name: 'Widget', stock: 75 },  // Update stock
    { productId: 'P003', name: 'Doodad', stock: 200 }, // New product
  ];
  
  console.log('\nUpserting...');
  const result = await adapter.upsert(updates, { idField: 'productId' });
  console.log('✅ Upserted:', result.count, 'items');
  
  // Check final state
  const final = await adapter.get('inventory');
  console.log('✅ Final inventory:', final?.length, 'products');
  
  return { adapter };
}

// ============================================================================
// Example 5: Query and Filter
// ============================================================================

export async function example5_queryFilter() {
  console.log('\n=== Example 5: Query and Filter ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Books',
  });
  
  // Store some books
  const books = [
    { title: 'Clean Code', author: 'Robert Martin', year: 2008, pages: 464 },
    { title: 'The Pragmatic Programmer', author: 'Hunt & Thomas', year: 1999, pages: 352 },
    { title: 'Design Patterns', author: 'Gang of Four', year: 1994, pages: 416 },
    { title: 'Refactoring', author: 'Martin Fowler', year: 1999, pages: 448 },
  ];
  
  console.log('Storing books...');
  await adapter.set('books', books);
  console.log('✅ Stored', books.length, 'books');
  
  // Query: Books from 1999
  console.log('\nQuerying books from 1999...');
  const from1999 = await adapter.query({
    filter: (book) => book.year === 1999,
  });
  console.log('✅ Found:', from1999.length, 'books');
  from1999.forEach(book => console.log('  -', book.title));
  
  // Query: Books over 400 pages
  console.log('\nQuerying books over 400 pages...');
  const longBooks = await adapter.query({
    filter: (book) => book.pages > 400,
    limit: 2,
  });
  console.log('✅ Found:', longBooks.length, 'books (limited to 2)');
  longBooks.forEach(book => console.log('  -', book.title, `(${book.pages} pages)`));
  
  return { adapter, books };
}

// ============================================================================
// Example 6: Merge with Deduplication
// ============================================================================

export async function example6_mergeDedup() {
  console.log('\n=== Example 6: Merge with Deduplication ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Papers',
  });
  
  // Initial papers
  const initialPapers = [
    { pmid: '12345', title: 'Paper A', year: 2020 },
    { pmid: '67890', title: 'Paper B', year: 2021 },
  ];
  
  console.log('Initial papers...');
  await adapter.set('papers', initialPapers);
  console.log('✅ Stored', initialPapers.length, 'papers');
  
  // New papers (with one duplicate)
  const newPapers = [
    { pmid: '12345', title: 'Paper A', year: 2020 },  // Duplicate
    { pmid: '11111', title: 'Paper C', year: 2022 },  // New
    { pmid: '22222', title: 'Paper D', year: 2023 },  // New
  ];
  
  console.log('\nMerging new papers...');
  const result = await adapter.merge('papers', newPapers, {
    strategy: 'id',
    idField: 'pmid',
  });
  
  console.log('✅ Merge result:');
  console.log('  - Total items:', result.totalItems);
  console.log('  - Added:', result.added);
  console.log('  - Skipped (duplicates):', result.skipped);
  
  return { adapter };
}

// ============================================================================
// Example 7: List with Pagination
// ============================================================================

export async function example7_pagination() {
  console.log('\n=== Example 7: List with Pagination ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Logs',
  });
  
  // Create some log entries
  const logs = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    message: `Log entry ${i + 1}`,
    timestamp: new Date(Date.now() - i * 60000).toISOString(),
  }));
  
  console.log('Creating log entries...');
  await adapter.set('logs', logs);
  console.log('✅ Created', logs.length, 'log entries');
  
  // Page 1
  console.log('\nFetching page 1 (10 items)...');
  const page1 = await adapter.list({ limit: 10, offset: 0 });
  console.log('✅ Page 1:', page1.length, 'items');
  console.log('  First:', page1[0]?.message);
  console.log('  Last:', page1[page1.length - 1]?.message);
  
  // Page 2
  console.log('\nFetching page 2 (10 items)...');
  const page2 = await adapter.list({ limit: 10, offset: 10 });
  console.log('✅ Page 2:', page2.length, 'items');
  console.log('  First:', page2[0]?.message);
  console.log('  Last:', page2[page2.length - 1]?.message);
  
  return { adapter, logs };
}

// ============================================================================
// Example 8: Has and Clear
// ============================================================================

export async function example8_hasAndClear() {
  console.log('\n=== Example 8: Has and Clear ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Temp',
  });
  
  // Check if empty
  console.log('Checking if sheet has data...');
  const hasData1 = await adapter.has('temp');
  console.log('✅ Has data:', hasData1);
  
  // Add some data
  console.log('\nAdding test data...');
  await adapter.set('temp', [
    { id: 1, value: 'test1' },
    { id: 2, value: 'test2' },
  ]);
  
  const hasData2 = await adapter.has('temp');
  console.log('✅ Has data now:', hasData2);
  
  // Clear
  console.log('\nClearing sheet...');
  await adapter.clear();
  
  const hasData3 = await adapter.has('temp');
  console.log('✅ Has data after clear:', hasData3);
  
  return { adapter };
}

// ============================================================================
// Run All Examples
// ============================================================================

if (import.meta.main) {
  console.log('🎬 Sheetlog Adapter - Basic Usage Examples');
  console.log('==========================================\n');
  
  if (!SHEET_URL) {
    console.error('❌ Error: SHEET_URL environment variable not set');
    console.error('   Set it to your Sheetlog Apps Script deployment URL');
    console.error('   Example: export SHEET_URL="https://script.google.com/macros/s/.../exec"');
    Deno.exit(1);
  }
  
  try {
    // Run examples (comment out as needed)
    await example1_basicSetup();
    // await example2_storeArray();
    // await example3_autoIdDetection();
    // await example4_upsertByKey();
    // await example5_queryFilter();
    // await example6_mergeDedup();
    // await example7_pagination();
    // await example8_hasAndClear();
    
    console.log('\n✅ All examples completed successfully!');
  } catch (error: any) {
    console.error('\n❌ Error:', error?.message || error);
    console.error(error);
    Deno.exit(1);
  }
}

