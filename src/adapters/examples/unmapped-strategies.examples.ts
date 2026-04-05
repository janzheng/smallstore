/**
 * Examples: Unmapped Field Strategies (Phase 3.6a)
 * 
 * Demonstrates how to handle fields that aren't in your schema mappings.
 */

import "jsr:@std/dotenv/load";
import { createNotionAdapter } from '../notion.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Setup: Example Notion Database
// ============================================================================

const baseConfig = {
  notionSecret: NOTION_SECRET,
  databaseId: '8aec500b9c8f4bd28411da2680848f65',
  mappings: [
    {
      notionProperty: 'Name',
      sourcePath: 'name',
      notionType: 'title' as const,
      required: true,
    },
    {
      notionProperty: 'Email',
      sourcePath: 'email',
      notionType: 'email' as const,
    },
  ],
};

// ============================================================================
// Example 1: Strategy 'error' (Default - Strict)
// ============================================================================

async function example1_error() {
  console.log('\n=== Example 1: Strategy "error" (Default) ===\n');
  
  const adapter = createNotionAdapter({
    ...baseConfig,
    unmappedStrategy: 'error'  // Default behavior
  });
  
  // This works - all fields are mapped
  try {
    await adapter.upsert([
      { id: '1', name: 'Alice', email: 'alice@example.com' }
    ], { idField: 'id' });
    console.log('✅ Mapped fields only: Success');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
  
  // This fails - 'role' is not in mappings
  try {
    await adapter.upsert([
      { id: '2', name: 'Bob', email: 'bob@example.com', role: 'admin' }
    ], { idField: 'id' });
    console.log('✅ Unexpected success');
  } catch (error: any) {
    console.log('❌ Expected error:', error.message);
    console.log('💡 Suggestions:', error.details?.suggestions);
  }
}

// ============================================================================
// Example 2: Strategy 'ignore' (Permissive)
// ============================================================================

async function example2_ignore() {
  console.log('\n=== Example 2: Strategy "ignore" (Permissive) ===\n');
  
  const adapter = createNotionAdapter({
    ...baseConfig,
    unmappedStrategy: 'ignore'  // Silently drop unmapped fields
  });
  
  // Unmapped fields are silently dropped
  await adapter.upsert([
    {
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'admin',           // Will be ignored
      department: 'Engineering', // Will be ignored
      level: 5                 // Will be ignored
    }
  ], { idField: 'id' });
  
  console.log('✅ Data stored (unmapped fields dropped)');
  
  // Retrieved data only has mapped fields
  const alice = await adapter.query({
    filter: {
      property: 'Name',
      title: { equals: 'Alice' }
    }
  });
  
  console.log('Retrieved:', alice[0]);
  // { name: 'Alice', email: 'alice@example.com' }
  // Note: role, department, level are gone
}

// ============================================================================
// Example 3: Strategy 'store-as-json' (Hybrid)
// ============================================================================

async function example3_storeAsJson() {
  console.log('\n=== Example 3: Strategy "store-as-json" (Hybrid) ===\n');
  
  const adapter = createNotionAdapter({
    ...baseConfig,
    unmappedStrategy: 'store-as-json',
    unmappedProperty: '_extra_data'  // Where to store overflow
  });
  
  // Known fields → columns, unknown → JSON
  await adapter.upsert([
    {
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',  // → Email column
      role: 'admin',               // → _extra_data JSON
      department: 'Engineering',   // → _extra_data JSON
      metadata: {                  // → _extra_data JSON
        joined: '2024-01-01',
        timezone: 'PST'
      }
    }
  ], { idField: 'id' });
  
  console.log('✅ Data stored (unmapped in _extra_data column)');
  
  // Retrieved data has all fields merged
  const alice = await adapter.query({
    filter: {
      property: 'Name',
      title: { equals: 'Alice' }
    }
  });
  
  console.log('Retrieved:', alice[0]);
  // All fields are back, merged from _extra_data
}

// ============================================================================
// Example 4: Real-World - API Data Evolution
// ============================================================================

async function example4_apiEvolution() {
  console.log('\n=== Example 4: Real-World - API Data Evolution ===\n');
  
  const adapter = createNotionAdapter({
    ...baseConfig,
    unmappedStrategy: 'store-as-json'
  });
  
  // Simulate API responses evolving over time
  
  // Week 1: Basic user data
  await adapter.upsert([
    { id: '1', name: 'Alice', email: 'alice@example.com' }
  ], { idField: 'id' });
  console.log('Week 1: Stored basic user data');
  
  // Week 5: API adds new fields
  await adapter.upsert([
    {
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'admin',           // New field!
      lastLogin: '2024-11-19'  // New field!
    }
  ], { idField: 'id' });
  console.log('Week 5: API added role and lastLogin (stored in _extra_data)');
  
  // Week 10: More new fields
  await adapter.upsert([
    {
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'super-admin',     // Updated
      lastLogin: '2024-11-20', // Updated
      preferences: {           // New nested field!
        theme: 'dark',
        notifications: true
      }
    }
  ], { idField: 'id' });
  console.log('Week 10: API added preferences (all in _extra_data)');
  
  // All fields are preserved!
  const user = await adapter.query({
    filter: {
      property: 'Name',
      title: { equals: 'Alice' }
    }
  });
  
  console.log('\n✅ Final data (all evolution preserved):');
  console.log(JSON.stringify(user[0], null, 2));
}

// ============================================================================
// Example 5: Choosing the Right Strategy
// ============================================================================

async function example5_choosingStrategy() {
  console.log('\n=== Example 5: Choosing the Right Strategy ===\n');
  
  console.log('When to use each strategy:\n');
  
  console.log('📋 "error" (default):');
  console.log('  ✅ Production systems with strict schemas');
  console.log('  ✅ When you want to catch schema mismatches early');
  console.log('  ✅ Team collaboration (force schema updates)');
  console.log('  ❌ Exploratory data analysis');
  console.log('  ❌ Rapidly evolving APIs\n');
  
  console.log('🚫 "ignore":');
  console.log('  ✅ Prototyping / quick experiments');
  console.log('  ✅ When you only care about specific fields');
  console.log('  ✅ Data cleanup (filter unwanted fields)');
  console.log('  ❌ When you need to preserve all data');
  console.log('  ❌ Production systems\n');
  
  console.log('📦 "store-as-json":');
  console.log('  ✅ Evolving APIs (new fields over time)');
  console.log('  ✅ Mixed structured/unstructured data');
  console.log('  ✅ Data warehousing (keep everything)');
  console.log('  ✅ When you want flexibility + structure');
  console.log('  ❌ When JSON column gets too large');
  console.log('  ❌ When you need to query unmapped fields\n');
}

// ============================================================================
// Example 6: Migration Path
// ============================================================================

async function example6_migration() {
  console.log('\n=== Example 6: Migration Path ===\n');
  
  console.log('Step 1: Start with "store-as-json" for flexibility');
  const flexAdapter = createNotionAdapter({
    ...baseConfig,
    unmappedStrategy: 'store-as-json'
  });
  
  // Store data with unknown fields
  await flexAdapter.upsert([
    {
      id: '1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'admin',
      department: 'Engineering'
    }
  ], { idField: 'id' });
  console.log('✅ Data stored with _extra_data');
  
  console.log('\nStep 2: Analyze what fields are actually used');
  console.log('  - Check _extra_data to see what fields appear');
  console.log('  - Decide which should become real columns');
  
  console.log('\nStep 3: Add new mappings for common fields');
  const strictAdapter = createNotionAdapter({
    ...baseConfig,
    mappings: [
      ...baseConfig.mappings,
      {
        notionProperty: 'Role',
        sourcePath: 'role',
        notionType: 'select' as const
      },
      {
        notionProperty: 'Department',
        sourcePath: 'department',
        notionType: 'select' as const
      }
    ],
    unmappedStrategy: 'error'  // Now enforce schema
  });
  console.log('✅ Schema updated, now strict');
  
  console.log('\nStep 4: New data follows strict schema');
  try {
    await strictAdapter.upsert([
      {
        id: '2',
        name: 'Bob',
        email: 'bob@example.com',
        role: 'user',
        department: 'Sales'
      }
    ], { idField: 'id' });
    console.log('✅ Strict schema enforced');
  } catch (error: any) {
    console.error('❌ Schema violation:', error.message);
  }
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Unmapped Field Strategies Examples\n');
  console.log('These examples show how to handle fields not in your schema.\n');
  
  try {
    await example1_error();
    await example2_ignore();
    await example3_storeAsJson();
    await example4_apiEvolution();
    await example5_choosingStrategy();
    await example6_migration();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

