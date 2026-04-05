/**
 * Examples: Notion Adapter High-Level Operations
 * 
 * Demonstrates how to use the composition-compatible methods
 * on the Notion adapter directly.
 */

import { createNotionAdapter } from '../notion.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Setup
// ============================================================================

const notionAdapter = createNotionAdapter({
  notionSecret: NOTION_SECRET,
  databaseId: '8aec500b9c8f4bd28411da2680848f65', // Example database
  mappings: [
    {
      notionProperty: 'Name',
      sourcePath: 'name',
      notionType: 'title',
      required: true,
    },
    {
      notionProperty: 'Email',
      sourcePath: 'email',
      notionType: 'email',
    },
    {
      notionProperty: 'Status',
      sourcePath: 'status',
      notionType: 'select',
    },
    {
      notionProperty: 'Tags',
      sourcePath: 'tags',
      notionType: 'multi_select',
    },
  ],
});

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
  
  const result = await notionAdapter.upsert(users, { idField: 'id' });
  
  console.log(`✅ Upserted ${result.count} users`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 2: Insert with auto-detection
// ============================================================================

async function example2_autoDetect() {
  console.log('\n=== Example 2: Insert with auto-detection ===\n');
  
  const newUsers = [
    { email: 'dave@example.com', name: 'Dave Wilson', status: 'Active' },
    { email: 'eve@example.com', name: 'Eve Brown', status: 'Active' },
  ];
  
  // Will auto-detect 'email' as the ID field
  const result = await notionAdapter.insert(newUsers, { autoDetect: true });
  
  console.log(`✅ Inserted ${result.count} users`);
  console.log(`Auto-detected ID field: ${result.idField}`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 3: Custom key generator
// ============================================================================

async function example3_keyGenerator() {
  console.log('\n=== Example 3: Custom key generator ===\n');
  
  const employees = [
    { firstName: 'John', lastName: 'Doe', email: 'john.doe@company.com' },
    { firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@company.com' },
  ];
  
  // Generate keys like "doe-john"
  const result = await notionAdapter.upsert(employees, {
    keyGenerator: (obj) => `${obj.lastName.toLowerCase()}-${obj.firstName.toLowerCase()}`
  });
  
  console.log(`✅ Upserted ${result.count} employees`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 4: Query with filters
// ============================================================================

async function example4_query() {
  console.log('\n=== Example 4: Query with filters ===\n');
  
  // Get all active users
  const activeUsers = await notionAdapter.query({
    filter: {
      property: 'Status',
      select: {
        equals: 'Active'
      }
    },
    sorts: [
      { property: 'Name', direction: 'ascending' }
    ]
  });
  
  console.log(`✅ Found ${activeUsers.length} active users`);
  activeUsers.forEach(user => {
    console.log(`  - ${user.name} (${user.email})`);
  });
}

// ============================================================================
// Example 5: List all items
// ============================================================================

async function example5_list() {
  console.log('\n=== Example 5: List all items ===\n');
  
  // Get first 10 items
  const items = await notionAdapter.list({ limit: 10 });
  
  console.log(`✅ Listed ${items.length} items`);
  items.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.name}`);
  });
}

// ============================================================================
// Example 6: Merge - NOT SUPPORTED (will throw error)
// ============================================================================

async function example6_mergeError() {
  console.log('\n=== Example 6: Merge - NOT SUPPORTED ===\n');
  
  try {
    await notionAdapter.merge('test', [{ foo: 'bar' }]);
  } catch (error: any) {
    console.log('❌ Expected error:', error.message);
    console.log('💡 Suggestion: Use insert() or upsert() instead');
  }
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Notion Adapter High-Level Operations Examples\n');
  
  try {
    await example1_upsert();
    await example2_autoDetect();
    await example3_keyGenerator();
    await example4_query();
    await example5_list();
    await example6_mergeError();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

