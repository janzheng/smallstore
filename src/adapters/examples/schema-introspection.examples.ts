/**
 * Examples: Schema Introspection (Phase 3.6b)
 * 
 * Demonstrates how to use schema introspection to auto-detect database/table schemas.
 */

import "jsr:@std/dotenv/load";
import { createNotionAdapter } from '../notion.ts';
import { createAirtableAdapter } from '../airtable.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Example 1: Zero-Config Notion Adapter (Just Works!)
// ============================================================================

async function example1_notionZeroConfig() {
  console.log('\n=== Example 1: Zero-Config Notion (Just Works!) ===\n');
  
  // No mappings needed! Schema is auto-detected from Notion
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true  // ✨ Auto-detect everything
  });
  
  console.log('✅ Adapter created (no mappings specified)');
  
  // First operation triggers schema introspection
  await adapter.upsert([
    { id: '1', name: 'Alice' }
  ], { idField: 'id' });
  
  console.log('✅ Data stored (schema auto-detected on first write)');
  
  // Subsequent operations use cached schema
  await adapter.upsert([
    { id: '2', name: 'Bob' }
  ], { idField: 'id' });
  
  console.log('✅ More data stored (using cached schema)');
}

// ============================================================================
// Example 2: Manual Schema Introspection
// ============================================================================

async function example2_manualIntrospection() {
  console.log('\n=== Example 2: Manual Schema Introspection ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  // Introspect schema manually (before any operations)
  const schema = await adapter.introspectSchema();
  
  console.log('📋 Database Schema:');
  for (const [propName, propType] of schema.entries()) {
    console.log(`  - ${propName}: ${propType}`);
  }
  
  // Example output:
  // - Name: title
  // - Email: email
  // - Status: select
  // - Created: created_time
  // - Tags: multi_select
}

// ============================================================================
// Example 3: Airtable Zero-Config
// ============================================================================

async function example3_airtableZeroConfig() {
  console.log('\n=== Example 3: Airtable Zero-Config ===\n');
  
  const adapter = createAirtableAdapter({
    apiKey: AIRTABLE_API_KEY || '',
    baseId: 'appXXXXXXXXXXXXXX',
    tableIdOrName: 'Contacts',
    introspectSchema: true  // ✨ Auto-detect!
  });
  
  console.log('✅ Airtable adapter created (no mappings)');
  
  // Schema detected automatically
  await adapter.upsert([
    { id: '1', name: 'Alice', email: 'alice@example.com' }
  ], { idField: 'id' });
  
  console.log('✅ Data stored (schema auto-detected)');
}

// ============================================================================
// Example 4: Hybrid - Explicit + Introspection
// ============================================================================

async function example4_hybrid() {
  console.log('\n=== Example 4: Hybrid Approach ===\n');
  
  // Start with explicit mappings for core fields
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    mappings: [
      {
        notionProperty: 'Name',
        sourcePath: 'name',
        notionType: 'title',
        required: true
      },
      {
        notionProperty: 'Email',
        sourcePath: 'email',
        notionType: 'email'
      }
    ],
    unmappedStrategy: 'store-as-json',  // Handle unknown fields flexibly
  });
  
  console.log('✅ Explicit mappings for core fields');
  console.log('✅ Unmapped fields go to _extra_data');
  
  // Later, you can introspect to see what other fields exist
  const schema = await adapter.introspectSchema();
  console.log(`\n📋 Full schema has ${schema.size} fields`);
  console.log('💡 You can add mappings for these later');
}

// ============================================================================
// Example 5: Schema Evolution Workflow
// ============================================================================

async function example5_schemaEvolution() {
  console.log('\n=== Example 5: Schema Evolution Workflow ===\n');
  
  console.log('Day 1: Start with introspection');
  const dayOneAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  await dayOneAdapter.upsert([
    { id: '1', name: 'Alice' }
  ], { idField: 'id' });
  console.log('✅ Data stored (auto-detected schema)');
  
  console.log('\nDay 30: User adds "Department" column in Notion UI');
  
  console.log('\nDay 31: Re-introspect to pick up changes');
  const dayThirtyOneAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    cacheSchema: false  // Don't use cache, force fresh introspection
  });
  
  const newSchema = await dayThirtyOneAdapter.introspectSchema();
  console.log(`✅ Schema refreshed (${newSchema.size} fields detected)`);
  
  // New field is automatically available
  await dayThirtyOneAdapter.upsert([
    { id: '2', name: 'Bob', department: 'Engineering' }  // New field!
  ], { idField: 'id' });
  console.log('✅ New field automatically supported');
}

// ============================================================================
// Example 6: Comparing Explicit vs Introspection
// ============================================================================

async function example6_comparison() {
  console.log('\n=== Example 6: Explicit vs Introspection ===\n');
  
  console.log('📋 Explicit Mappings:');
  console.log('  ✅ Full control over field mapping');
  console.log('  ✅ Custom transformations');
  console.log('  ✅ Explicit source paths (name → userName)');
  console.log('  ❌ Must update when schema changes');
  console.log('  ❌ More verbose configuration');
  
  console.log('\n🔍 Schema Introspection:');
  console.log('  ✅ Zero configuration');
  console.log('  ✅ Automatically adapts to schema changes');
  console.log('  ✅ Quick prototyping');
  console.log('  ❌ Generic source paths (lowercase + underscores)');
  console.log('  ❌ No custom transformations');
  console.log('  ❌ Requires API call on init');
  
  console.log('\n💡 Best Practice:');
  console.log('  - Start with introspection for prototyping');
  console.log('  - Add explicit mappings for production');
  console.log('  - Use hybrid for gradual migration');
}

// ============================================================================
// Example 7: Introspection with Error Handling
// ============================================================================

async function example7_errorHandling() {
  console.log('\n=== Example 7: Error Handling ===\n');
  
  try {
    const adapter = createNotionAdapter({
      databaseId: 'invalid-database-id',
      introspectSchema: true
    });
    
    // This will fail (invalid database ID)
    await adapter.upsert([
      { id: '1', name: 'Test' }
    ], { idField: 'id' });
    
  } catch (error: any) {
    console.log('❌ Expected error:', error.message);
    console.log('💡 Schema introspection failed - check database ID and permissions');
  }
}

// ============================================================================
// Example 8: Performance - Schema Caching
// ============================================================================

async function example8_caching() {
  console.log('\n=== Example 8: Schema Caching ===\n');
  
  console.log('With caching (default):');
  const cachedAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    cacheSchema: true  // Default
  });
  
  console.log('  - First operation: Introspects schema (API call)');
  console.log('  - Subsequent operations: Use cached schema (fast)');
  
  console.log('\nWithout caching:');
  const uncachedAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true,
    cacheSchema: false
  });
  
  console.log('  - Every operation: Re-introspects schema (slow)');
  console.log('  - Use when schema changes frequently');
  console.log('  - Or when testing schema changes');
}

// ============================================================================
// Example 9: Migration from Explicit to Introspection
// ============================================================================

async function example9_migration() {
  console.log('\n=== Example 9: Migration Path ===\n');
  
  console.log('Before (explicit mappings):');
  console.log(`
const oldAdapter = createNotionAdapter({
  databaseId: '...',
  mappings: [
    { notionProperty: 'Name', sourcePath: 'name', notionType: 'title' },
    { notionProperty: 'Email', sourcePath: 'email', notionType: 'email' },
    { notionProperty: 'Status', sourcePath: 'status', notionType: 'select' },
    // ... 20 more fields ...
  ]
});
  `.trim());
  
  console.log('\n\nAfter (introspection):');
  console.log(`
const newAdapter = createNotionAdapter({
  databaseId: '...',
  introspectSchema: true  // That's it!
});
  `.trim());
  
  console.log('\n\n✨ Same functionality, 90% less code!');
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Schema Introspection Examples\n');
  console.log('These examples show how to auto-detect schemas from Notion/Airtable.\n');
  
  try {
    await example1_notionZeroConfig();
    await example2_manualIntrospection();
    await example3_airtableZeroConfig();
    await example4_hybrid();
    await example5_schemaEvolution();
    await example6_comparison();
    await example7_errorHandling();
    await example8_caching();
    await example9_migration();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

