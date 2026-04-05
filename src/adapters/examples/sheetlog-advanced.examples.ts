/**
 * Sheetlog Adapter - Advanced Usage Examples
 * 
 * Demonstrates advanced patterns:
 * - Batch upsert operations
 * - Dynamic column creation
 * - Multiple sheets as collections
 * - Custom key generators
 * - Content hash deduplication
 * 
 * Run: deno run --allow-net --allow-env sheetlog-advanced.examples.ts
 */

import { createSheetlogAdapter } from '../sheetlog.ts';
import { createSmallstore } from '../../mod.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Example 1: Batch Upsert with Large Dataset
// ============================================================================

export async function example1_batchUpsert() {
  console.log('\n=== Example 1: Batch Upsert ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'BatchTest',
  });
  
  // Generate large dataset
  const batchSize = 100;
  const products = Array.from({ length: batchSize }, (_, i) => ({
    productId: `PROD-${String(i + 1).padStart(4, '0')}`,
    name: `Product ${i + 1}`,
    price: Math.floor(Math.random() * 1000) + 10,
    category: ['Electronics', 'Clothing', 'Food', 'Books'][i % 4],
    inStock: Math.random() > 0.3,
  }));
  
  console.log(`Batch upserting ${batchSize} products...`);
  const startTime = Date.now();
  
  const result = await adapter.upsert(products, {
    idField: 'productId',
  });
  
  const duration = Date.now() - startTime;
  console.log('✅ Batch upsert complete!');
  console.log(`  - Count: ${result.count} products`);
  console.log(`  - Duration: ${duration}ms`);
  console.log(`  - Rate: ${(batchSize / (duration / 1000)).toFixed(1)} items/sec`);
  
  // Update subset
  console.log('\nUpdating Electronics products...');
  const updates = products
    .filter(p => p.category === 'Electronics')
    .map(p => ({ ...p, price: p.price * 1.1 }));  // 10% price increase
  
  const updateResult = await adapter.upsert(updates, {
    idField: 'productId',
  });
  console.log(`✅ Updated ${updateResult.count} Electronics products`);
  
  return { adapter, products };
}

// ============================================================================
// Example 2: Dynamic Column Creation
// ============================================================================

export async function example2_dynamicColumns() {
  console.log('\n=== Example 2: Dynamic Column Creation ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'DynamicSchema',
  });
  
  // Day 1: Basic user data
  console.log('Day 1: Adding basic user data...');
  await adapter.set('users', [
    { email: 'alice@example.com', name: 'Alice' },
    { email: 'bob@example.com', name: 'Bob' },
  ]);
  console.log('✅ Stored with columns: email, name');
  
  // Day 2: Add age field (new column!)
  console.log('\nDay 2: Adding age field...');
  await adapter.upsert([
    { email: 'alice@example.com', name: 'Alice', age: 30 },
    { email: 'charlie@example.com', name: 'Charlie', age: 25 },
  ], { idField: 'email' });
  console.log('✅ Created new "age" column automatically');
  
  // Day 3: Add role and department (more new columns!)
  console.log('\nDay 3: Adding role and department...');
  await adapter.upsert([
    { email: 'alice@example.com', name: 'Alice', age: 30, role: 'Engineer', department: 'R&D' },
    { email: 'bob@example.com', name: 'Bob', role: 'Designer', department: 'Product' },
  ], { idField: 'email' });
  console.log('✅ Created "role" and "department" columns automatically');
  
  // Verify final schema
  const users = await adapter.get('users');
  if (users && users.length > 0) {
    console.log('\n✅ Final schema has columns:', Object.keys(users[0]));
  }
  
  return { adapter };
}

// ============================================================================
// Example 3: Multiple Sheets as Collections
// ============================================================================

export async function example3_multipleSheets() {
  console.log('\n=== Example 3: Multiple Sheets as Collections ===\n');
  
  // Use Smallstore with multiple Sheetlog adapters
  const storage = createSmallstore({
    adapters: {
      moviesSheet: createSheetlogAdapter({
        sheetUrl: SHEET_URL!,
        sheet: 'Movies',
      }),
      booksSheet: createSheetlogAdapter({
        sheetUrl: SHEET_URL!,
        sheet: 'Books',
      }),
      musicSheet: createSheetlogAdapter({
        sheetUrl: SHEET_URL!,
        sheet: 'Music',
      }),
    },
    defaultAdapter: 'moviesSheet',
  });
  
  // Configure collections
  console.log('Configuring collections...');
  await storage.setCollectionMetadata('movies', {
    adapter: { type: 'moviesSheet' },
    name: 'Movie Collection',
    description: 'My favorite movies',
  });
  
  await storage.setCollectionMetadata('books', {
    adapter: { type: 'booksSheet' },
    name: 'Book Collection',
    description: 'Books to read',
  });
  
  await storage.setCollectionMetadata('music', {
    adapter: { type: 'musicSheet' },
    name: 'Music Collection',
    description: 'Favorite albums',
  });
  
  // Store data in different sheets
  console.log('\nStoring data across multiple sheets...');
  
  await storage.set('movies', [
    { title: 'Inception', year: 2010, rating: 8.8 },
    { title: 'Interstellar', year: 2014, rating: 8.6 },
  ]);
  console.log('✅ Stored movies in "Movies" sheet');
  
  await storage.set('books', [
    { title: 'Dune', author: 'Frank Herbert', year: 1965 },
    { title: '1984', author: 'George Orwell', year: 1949 },
  ]);
  console.log('✅ Stored books in "Books" sheet');
  
  await storage.set('music', [
    { album: 'Dark Side of the Moon', artist: 'Pink Floyd', year: 1973 },
    { album: 'Thriller', artist: 'Michael Jackson', year: 1982 },
  ]);
  console.log('✅ Stored music in "Music" sheet');
  
  // Retrieve from different sheets
  console.log('\nRetrieving data...');
  const movies = await storage.get('movies');
  const books = await storage.get('books');
  const music = await storage.get('music');
  
  console.log(`✅ Retrieved:`);
  console.log(`  - ${movies?.length || 0} movies`);
  console.log(`  - ${books?.length || 0} books`);
  console.log(`  - ${music?.length || 0} albums`);
  
  return { storage };
}

// ============================================================================
// Example 4: Custom Key Generator (Composite Keys)
// ============================================================================

export async function example4_customKeyGenerator() {
  console.log('\n=== Example 4: Custom Key Generator ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Employees',
  });
  
  const employees = [
    { firstName: 'Alice', lastName: 'Smith', department: 'Engineering' },
    { firstName: 'Bob', lastName: 'Jones', department: 'Sales' },
    { firstName: 'Charlie', lastName: 'Brown', department: 'Engineering' },
  ];
  
  console.log('Inserting employees with composite key...');
  const result = await adapter.insert(employees, {
    keyGenerator: (emp) => `${emp.lastName}-${emp.firstName}`.toLowerCase(),
  });
  
  console.log('✅ Inserted:', result.count, 'employees');
  console.log('✅ Keys:', result.keys);
  // Keys: ["smith-alice", "jones-bob", "brown-charlie"]
  
  // Update using same key generator
  console.log('\nUpdating Alice Smith...');
  await adapter.upsert([
    { firstName: 'Alice', lastName: 'Smith', department: 'Engineering', role: 'Senior Engineer' },
  ], {
    keyGenerator: (emp) => `${emp.lastName}-${emp.firstName}`.toLowerCase(),
  });
  console.log('✅ Updated Alice with new role');
  
  return { adapter, employees };
}

// ============================================================================
// Example 5: Content Hash Deduplication
// ============================================================================

export async function example5_hashDedup() {
  console.log('\n=== Example 5: Content Hash Deduplication ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Articles',
  });
  
  // Initial articles
  const articles1 = [
    { url: 'https://example.com/article1', title: 'Article 1', content: 'Content 1' },
    { url: 'https://example.com/article2', title: 'Article 2', content: 'Content 2' },
  ];
  
  console.log('Storing initial articles...');
  await adapter.set('articles', articles1);
  console.log('✅ Stored', articles1.length, 'articles');
  
  // New batch with duplicates (same content, different URLs)
  const articles2 = [
    { url: 'https://mirror.com/article1', title: 'Article 1', content: 'Content 1' },  // Duplicate content
    { url: 'https://example.com/article3', title: 'Article 3', content: 'Content 3' },  // New
  ];
  
  console.log('\nMerging new articles (hash-based deduplication)...');
  const result = await adapter.merge('articles', articles2, {
    strategy: 'hash',
    hashFields: ['title', 'content'],  // Hash based on title + content
  });
  
  console.log('✅ Merge result:');
  console.log('  - Total items:', result.totalItems);
  console.log('  - Added:', result.added);
  console.log('  - Skipped (duplicate content):', result.skipped);
  
  return { adapter };
}

// ============================================================================
// Example 6: Field-Based Deduplication
// ============================================================================

export async function example6_fieldDedup() {
  console.log('\n=== Example 6: Field-Based Deduplication ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'Contacts',
  });
  
  // Initial contacts
  const contacts1 = [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com', phone: '111-1111' },
    { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.com', phone: '222-2222' },
  ];
  
  console.log('Storing initial contacts...');
  await adapter.set('contacts', contacts1);
  console.log('✅ Stored', contacts1.length, 'contacts');
  
  // New contacts (duplicate name but different email)
  const contacts2 = [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice.new@example.com', phone: '333-3333' },  // Same name
    { firstName: 'Charlie', lastName: 'Brown', email: 'charlie@example.com', phone: '444-4444' },  // New
  ];
  
  console.log('\nMerging contacts (field-based deduplication on firstName+lastName)...');
  const result = await adapter.merge('contacts', contacts2, {
    strategy: 'fields',
    compareFields: ['firstName', 'lastName'],
  });
  
  console.log('✅ Merge result:');
  console.log('  - Total items:', result.totalItems);
  console.log('  - Added:', result.added);
  console.log('  - Skipped (duplicate name):', result.skipped);
  
  return { adapter };
}

// ============================================================================
// Example 7: Progressive Schema Evolution
// ============================================================================

export async function example7_schemaEvolution() {
  console.log('\n=== Example 7: Progressive Schema Evolution ===\n');
  
  const adapter = createSheetlogAdapter({
    sheetUrl: SHEET_URL!,
    sheet: 'UserProfiles',
  });
  
  console.log('Week 1: MVP - Basic user info');
  await adapter.set('profiles', [
    { email: 'user1@example.com', name: 'User 1' },
  ]);
  console.log('✅ Schema: email, name');
  
  console.log('\nWeek 2: Add authentication');
  await adapter.upsert([
    { email: 'user1@example.com', name: 'User 1', passwordHash: 'hash1', lastLogin: new Date().toISOString() },
  ], { idField: 'email' });
  console.log('✅ Schema: email, name, passwordHash, lastLogin');
  
  console.log('\nWeek 3: Add profile fields');
  await adapter.upsert([
    { email: 'user1@example.com', bio: 'Software engineer', avatar: 'https://...', location: 'SF' },
  ], { idField: 'email' });
  console.log('✅ Schema: email, name, passwordHash, lastLogin, bio, avatar, location');
  
  console.log('\nWeek 4: Add social features');
  await adapter.upsert([
    { email: 'user1@example.com', followers: 42, following: 18, posts: 7 },
  ], { idField: 'email' });
  console.log('✅ Schema: email, name, passwordHash, lastLogin, bio, avatar, location, followers, following, posts');
  
  const finalProfile = await adapter.get('profiles');
  if (finalProfile && finalProfile.length > 0) {
    console.log('\n✅ Final profile has', Object.keys(finalProfile[0]).length, 'fields');
    console.log('   Fields:', Object.keys(finalProfile[0]).join(', '));
  }
  
  return { adapter };
}

// ============================================================================
// Run All Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Sheetlog Adapter - Advanced Usage Examples');
  console.log('=============================================\n');
  
  if (!SHEET_URL) {
    console.error('❌ Error: SHEET_URL environment variable not set');
    console.error('   Set it to your Sheetlog Apps Script deployment URL');
    console.error('   Example: export SHEET_URL="https://script.google.com/macros/s/.../exec"');
    Deno.exit(1);
  }
  
  try {
    // Run examples (comment out as needed)
    // await example1_batchUpsert();
    // await example2_dynamicColumns();
    // await example3_multipleSheets();
    // await example4_customKeyGenerator();
    // await example5_hashDedup();
    // await example6_fieldDedup();
    await example7_schemaEvolution();
    
    console.log('\n✅ All examples completed successfully!');
  } catch (error: any) {
    console.error('\n❌ Error:', error?.message || error);
    console.error(error);
    Deno.exit(1);
  }
}

