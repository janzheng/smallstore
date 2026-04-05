/**
 * Examples: Airtable Adapter High-Level Operations
 * 
 * Demonstrates how to use the composition-compatible methods
 * on the Airtable adapter directly.
 */

import { createAirtableAdapter } from '../airtable.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Setup
// ============================================================================

const airtableAdapter = createAirtableAdapter({
  apiKey: AIRTABLE_API_KEY || '',
  baseId: 'appXXXXXXXXXXXXXX', // Replace with your base ID
  tableIdOrName: 'Contacts',    // Replace with your table name
  mappings: [
    {
      airtableField: 'Name',
      sourcePath: 'name',
      airtableType: 'singleLineText',
      required: true,
    },
    {
      airtableField: 'Email',
      sourcePath: 'email',
      airtableType: 'email',
    },
    {
      airtableField: 'Status',
      sourcePath: 'status',
      airtableType: 'singleSelect',
    },
    {
      airtableField: 'Tags',
      sourcePath: 'tags',
      airtableType: 'multipleSelects',
    },
  ],
});

// ============================================================================
// Example 1: Upsert with explicit ID field
// ============================================================================

async function example1_upsert() {
  console.log('\n=== Example 1: Upsert with explicit ID field ===\n');
  
  const contacts = [
    { id: 'contact-001', name: 'Alice Smith', email: 'alice@example.com', status: 'Active' },
    { id: 'contact-002', name: 'Bob Jones', email: 'bob@example.com', status: 'Inactive' },
    { id: 'contact-003', name: 'Carol Davis', email: 'carol@example.com', status: 'Active' },
  ];
  
  const result = await airtableAdapter.upsert(contacts, { idField: 'id' });
  
  console.log(`✅ Upserted ${result.count} contacts`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 2: Insert with auto-detection
// ============================================================================

async function example2_autoDetect() {
  console.log('\n=== Example 2: Insert with auto-detection ===\n');
  
  const newContacts = [
    { email: 'dave@example.com', name: 'Dave Wilson', status: 'Active' },
    { email: 'eve@example.com', name: 'Eve Brown', status: 'Active' },
  ];
  
  // Will auto-detect 'email' as the ID field
  const result = await airtableAdapter.insert(newContacts, { autoDetect: true });
  
  console.log(`✅ Inserted ${result.count} contacts`);
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
  const result = await airtableAdapter.upsert(employees, {
    keyGenerator: (obj) => `${obj.lastName.toLowerCase()}-${obj.firstName.toLowerCase()}`
  });
  
  console.log(`✅ Upserted ${result.count} employees`);
  console.log('Keys:', result.keys);
}

// ============================================================================
// Example 4: Query with formula filters
// ============================================================================

async function example4_query() {
  console.log('\n=== Example 4: Query with formula filters ===\n');
  
  // Get all active contacts
  const activeContacts = await airtableAdapter.query({
    filterByFormula: '{Status} = "Active"',
    sort: [
      { field: 'Name', direction: 'asc' }
    ],
    maxRecords: 100
  });
  
  console.log(`✅ Found ${activeContacts.length} active contacts`);
  activeContacts.forEach(contact => {
    console.log(`  - ${contact.name} (${contact.email})`);
  });
}

// ============================================================================
// Example 5: List all items
// ============================================================================

async function example5_list() {
  console.log('\n=== Example 5: List all items ===\n');
  
  // Get first 10 items
  const items = await airtableAdapter.list({ limit: 10 });
  
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
    await airtableAdapter.merge('test', [{ foo: 'bar' }]);
  } catch (error: any) {
    console.log('❌ Expected error:', error.message);
    console.log('💡 Suggestion: Use insert() or upsert() instead');
  }
}

// ============================================================================
// Example 7: Batch operations
// ============================================================================

async function example7_batch() {
  console.log('\n=== Example 7: Batch operations ===\n');
  
  // Simulate API data
  const apiResponse = {
    users: [
      { userId: 'u1', name: 'User One', email: 'u1@api.com' },
      { userId: 'u2', name: 'User Two', email: 'u2@api.com' },
      { userId: 'u3', name: 'User Three', email: 'u3@api.com' },
    ]
  };
  
  // Batch insert with custom ID field
  const result = await airtableAdapter.insert(apiResponse.users, {
    idField: 'userId'
  });
  
  console.log(`✅ Batch inserted ${result.count} users from API`);
  console.log(`Using ID field: ${result.idField}`);
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Airtable Adapter High-Level Operations Examples\n');
  
  try {
    await example1_upsert();
    await example2_autoDetect();
    await example3_keyGenerator();
    await example4_query();
    await example5_list();
    await example6_mergeError();
    await example7_batch();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

