/**
 * Examples: Auto-Field Creation (Phase 3.6d)
 * 
 * Demonstrates automatic field creation with type inference.
 */

import "jsr:@std/dotenv/load";
import { createNotionAdapter } from '../notion.ts';
import { createAirtableAdapter } from '../airtable.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Example 1: Basic Auto-Create
// ============================================================================

async function example1_basicAutoCreate() {
  console.log('\n=== Example 1: Basic Auto-Create ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    unmappedStrategy: 'auto-create'  // ✨ Enable auto-create
  });
  
  console.log('Storing data with new fields...');
  
  // Fields don't exist yet - they'll be auto-created!
  await adapter.set('researcher-1', {
    name: 'Dr. Alice Smith',
    email: 'alice@stanford.edu',  // → email property
    papers: 42,                     // → number property
    isVerified: true                // → checkbox property
  });
  
  console.log('✅ Data stored (fields auto-created!)');
}

// ============================================================================
// Example 2: Type Inference - Flexible vs Strict
// ============================================================================

async function example2_typeInference() {
  console.log('\n=== Example 2: Type Inference Strategies ===\n');
  
  console.log('Flexible (default) - Smart inference:');
  const flexAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    typeInference: 'flexible'  // Smart type detection
  });
  
  await flexAdapter.set('key1', {
    email: 'alice@example.com',      // → email property
    website: 'https://example.com',  // → url property
    bio: 'Some text'                 // → rich_text property
  });
  console.log('  ✅ Created: email, url, rich_text');
  
  console.log('\nStrict - Basic types only:');
  const strictAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    typeInference: 'strict'  // Only basic types
  });
  
  await strictAdapter.set('key2', {
    email: 'alice@example.com',      // → rich_text property
    website: 'https://example.com',  // → rich_text property
    bio: 'Some text'                 // → rich_text property
  });
  console.log('  ✅ Created: rich_text, rich_text, rich_text');
}

// ============================================================================
// Example 3: Evolving Schema
// ============================================================================

async function example3_evolvingSchema() {
  console.log('\n=== Example 3: Evolving Schema ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    unmappedStrategy: 'auto-create'
  });
  
  console.log('Week 1: Basic data');
  await adapter.upsert([
    { id: '1', name: 'Alice' }
  ], { idField: 'id' });
  console.log('  Schema: name');
  
  console.log('\nWeek 2: Add department');
  await adapter.upsert([
    { id: '2', name: 'Bob', department: 'Engineering' }
  ], { idField: 'id' });
  console.log('  Schema: name, department (auto-created!)');
  
  console.log('\nWeek 3: Add more fields');
  await adapter.upsert([
    {
      id: '3',
      name: 'Carol',
      department: 'Research',
      email: 'carol@example.com',
      yearsExp: 10,
      tags: ['senior', 'lead']
    }
  ], { idField: 'id' });
  console.log('  Schema: name, department, email, yearsExp, tags (all auto-created!)');
  
  console.log('\n✅ Schema grew organically over time!');
}

// ============================================================================
// Example 4: Mixed Data Types
// ============================================================================

async function example4_mixedDataTypes() {
  console.log('\n=== Example 4: Mixed Data Types ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    unmappedStrategy: 'auto-create',
    typeInference: 'flexible'
  });
  
  const testData = {
    // Strings
    name: 'Dr. Alice Smith',           // → rich_text
    email: 'alice@stanford.edu',       // → email
    website: 'https://stanford.edu',   // → url
    bio: 'A long bio...',              // → rich_text
    
    // Numbers
    papers: 42,                        // → number
    citations: 1337,                   // → number
    impact: 9.5,                       // → number
    
    // Booleans
    isVerified: true,                  // → checkbox
    isActive: false,                   // → checkbox
    
    // Arrays
    tags: ['genomics', 'CRISPR'],      // → multi_select
    interests: ['research', 'teaching'], // → multi_select
    
    // Dates
    joinDate: new Date(),              // → date
    lastUpdated: '2024-11-19'          // → date (string pattern)
  };
  
  console.log('Creating fields with type inference:');
  await adapter.set('researcher', testData);
  
  console.log('\n✅ Created fields:');
  console.log('  - name: rich_text');
  console.log('  - email: email');
  console.log('  - website: url');
  console.log('  - bio: rich_text');
  console.log('  - papers: number');
  console.log('  - citations: number');
  console.log('  - impact: number');
  console.log('  - isVerified: checkbox');
  console.log('  - isActive: checkbox');
  console.log('  - tags: multi_select');
  console.log('  - interests: multi_select');
  console.log('  - joinDate: date');
  console.log('  - lastUpdated: date');
}

// ============================================================================
// Example 5: Airtable Auto-Create
// ============================================================================

async function example5_airtableAutoCreate() {
  console.log('\n=== Example 5: Airtable Auto-Create ===\n');
  
  const adapter = createAirtableAdapter({
    apiKey: AIRTABLE_API_KEY || '',
    baseId: 'appXXXXXXXXXXXXXX',
    tableIdOrName: 'Contacts',
    introspectSchema: true,
    unmappedStrategy: 'auto-create'
  });
  
  console.log('Creating Airtable fields automatically:');
  
  await adapter.set('contact-1', {
    name: 'Alice',
    email: 'alice@example.com',       // → email
    website: 'https://example.com',   // → url
    notes: 'A very long note...',     // → multilineText (> 200 chars)
    age: 30,                           // → number
    isActive: true,                    // → checkbox
    tags: ['customer', 'premium']      // → multipleSelects
  });
  
  console.log('✅ Airtable fields created with correct types');
}

// ============================================================================
// Example 6: Hybrid - Explicit + Auto-Create
// ============================================================================

async function example6_hybrid() {
  console.log('\n=== Example 6: Hybrid Approach ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    mappings: [
      // Core fields - explicit control
      {
        notionProperty: 'Name',
        sourcePath: 'name',
        notionType: 'title',
        required: true,
        transform: (v: any) => v.toUpperCase()
      },
      {
        notionProperty: 'Email',
        sourcePath: 'email',
        notionType: 'email',
        required: true
      }
    ],
    unmappedStrategy: 'auto-create'  // Auto-create for others
  });
  
  console.log('Core fields (explicit): Name, Email');
  console.log('Other fields: auto-created');
  
  await adapter.set('key', {
    name: 'Alice',
    email: 'alice@example.com',
    // These will be auto-created:
    department: 'Engineering',
    yearsExp: 5,
    tags: ['senior', 'lead']
  });
  
  console.log('✅ Mixed: explicit + auto-create');
}

// ============================================================================
// Example 7: Comparison - All Strategies
// ============================================================================

async function example7_comparisonStrategies() {
  console.log('\n=== Example 7: Unmapped Strategy Comparison ===\n');
  
  const testData = {
    name: 'Alice',
    unknownField: 'This field doesn\'t exist'
  };
  
  console.log('Strategy: error');
  const errorAdapter = createNotionAdapter({
    databaseId: '...',
    mappings: [{ notionProperty: 'Name', sourcePath: 'name', notionType: 'title' }],
    unmappedStrategy: 'error'
  });
  try {
    await errorAdapter.set('key', testData);
  } catch (e) {
    console.log('  ❌ Throws error for unknownField');
  }
  
  console.log('\nStrategy: ignore');
  const ignoreAdapter = createNotionAdapter({
    databaseId: '...',
    mappings: [{ notionProperty: 'Name', sourcePath: 'name', notionType: 'title' }],
    unmappedStrategy: 'ignore'
  });
  await ignoreAdapter.set('key', testData);
  console.log('  ✅ Stores name, ignores unknownField');
  
  console.log('\nStrategy: store-as-json');
  const jsonAdapter = createNotionAdapter({
    databaseId: '...',
    mappings: [{ notionProperty: 'Name', sourcePath: 'name', notionType: 'title' }],
    unmappedStrategy: 'store-as-json'
  });
  await jsonAdapter.set('key', testData);
  console.log('  ✅ Stores name, puts unknownField in _extra_data');
  
  console.log('\nStrategy: auto-create');
  const autoAdapter = createNotionAdapter({
    databaseId: '...',
    mappings: [{ notionProperty: 'Name', sourcePath: 'name', notionType: 'title' }],
    unmappedStrategy: 'auto-create'
  });
  await autoAdapter.set('key', testData);
  console.log('  ✅ Stores name, creates unknownField property');
}

// ============================================================================
// Example 8: Batch Operations with Auto-Create
// ============================================================================

async function example8_batchAutoCreate() {
  console.log('\n=== Example 8: Batch Operations ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    unmappedStrategy: 'auto-create'
  });
  
  console.log('Batch inserting with evolving schema:');
  
  const researchers = [
    { id: '1', name: 'Alice', email: 'alice@example.com' },
    { id: '2', name: 'Bob', email: 'bob@example.com', department: 'Engineering' },
    { id: '3', name: 'Carol', department: 'Research', yearsExp: 10 },
    { id: '4', name: 'Dave', tags: ['lead', 'senior'], isVerified: true }
  ];
  
  await adapter.insert(researchers);
  
  console.log('✅ All fields auto-created during batch insert:');
  console.log('  - email (from record 1)');
  console.log('  - department (from record 2)');
  console.log('  - yearsExp (from record 3)');
  console.log('  - tags (from record 4)');
  console.log('  - isVerified (from record 4)');
}

// ============================================================================
// Example 9: Error Handling
// ============================================================================

async function example9_errorHandling() {
  console.log('\n=== Example 9: Error Handling ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: 'invalid-id',
    introspectSchema: true,
    unmappedStrategy: 'auto-create'
  });
  
  try {
    console.log('Attempting to create field in invalid database...');
    await adapter.set('key', {
      name: 'Alice',
      newField: 'This will fail'
    });
  } catch (error: any) {
    console.log('❌ Expected error:', error.message);
    console.log('💡 Auto-create fails gracefully, provides clear error');
  }
}

// ============================================================================
// Example 10: Best Practices
// ============================================================================

async function example10_bestPractices() {
  console.log('\n=== Example 10: Best Practices ===\n');
  
  console.log('✅ DO:');
  console.log('  - Use auto-create for prototyping and exploratory work');
  console.log('  - Use flexible inference for smart type detection');
  console.log('  - Start with auto-create, migrate to explicit for production');
  console.log('  - Test with small datasets first');
  console.log('  - Monitor created fields in Notion/Airtable UI');
  
  console.log('\n❌ DON\'T:');
  console.log('  - Use auto-create in production without testing');
  console.log('  - Rely on auto-create for critical schemas');
  console.log('  - Forget that fields are permanent once created');
  console.log('  - Use auto-create with untrusted/unvalidated data');
  console.log('  - Mix auto-create with strict schema requirements');
  
  console.log('\n💡 Recommended Workflow:');
  console.log('  1. Prototype: auto-create + flexible inference');
  console.log('  2. Development: auto-create + review created fields');
  console.log('  3. Staging: Migrate to explicit mappings');
  console.log('  4. Production: Explicit mappings + error strategy');
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Auto-Field Creation Examples\n');
  console.log('Demonstrates automatic field creation with type inference.\n');
  
  try {
    await example1_basicAutoCreate();
    await example2_typeInference();
    await example3_evolvingSchema();
    await example4_mixedDataTypes();
    await example5_airtableAutoCreate();
    await example6_hybrid();
    await example7_comparisonStrategies();
    await example8_batchAutoCreate();
    await example9_errorHandling();
    await example10_bestPractices();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

