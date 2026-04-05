/**
 * Notion Database Adapter - Usage Example
 * 
 * This example shows how to use Smallstore with a Notion database.
 * 
 * Prerequisites:
 * 1. Create a Notion integration at https://www.notion.so/my-integrations
 * 2. Share your database with the integration
 * 3. Set NOTION_API_KEY environment variable
 * 4. Get your database ID from the database URL
 */

import "jsr:@std/dotenv/load";
import {
  createSmallstore,
  createMemoryAdapter,
  createNotionAdapter,
} from '../mod.ts';
import { getEnv } from '../src/utils/env.ts';

// ============================================================================
// Configuration
// ============================================================================

const NOTION_DATABASE_ID = getEnv('NOTION_DATABASE_ID') || 'your-database-id';

// ============================================================================
// Create Notion Adapter
// ============================================================================

const notionAdapter = createNotionAdapter({
  // API key will be auto-read from NOTION_API_KEY env var
  databaseId: NOTION_DATABASE_ID,
  
  // Schema mappings: Notion property → Smallstore data path
  mappings: [
    {
      notionProperty: 'Name',           // Notion column name
      sourcePath: 'name',               // Smallstore data field
      notionType: 'title',              // Notion property type
      required: true,
    },
    {
      notionProperty: 'Email',
      sourcePath: 'contact.email',      // Nested field!
      notionType: 'email',
    },
    {
      notionProperty: 'Age',
      sourcePath: 'age',
      notionType: 'number',
    },
    {
      notionProperty: 'Tags',
      sourcePath: 'tags',               // Array → multi_select
      notionType: 'multi_select',
    },
    {
      notionProperty: 'Active',
      sourcePath: 'active',
      notionType: 'checkbox',
    },
    {
      notionProperty: 'Website',
      sourcePath: 'website',
      notionType: 'url',
    },
    {
      notionProperty: 'Created',
      sourcePath: 'metadata.created',
      notionType: 'date',
    },
  ],
});

// ============================================================================
// Create Smallstore with Notion
// ============================================================================

const storage = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    notion: notionAdapter,
  },
  defaultAdapter: 'memory',
  metadataAdapter: 'memory',
  
  // Route user data to Notion
  routing: {
    'users:*': { adapter: 'notion' },
  },
});

// ============================================================================
// Usage Examples
// ============================================================================

async function main() {
  console.log('🚀 Notion Adapter Example\n');
  
  // Example 1: Create a user
  console.log('Creating user...');
  await storage.set('users/alice', {
    name: 'Alice Johnson',
    age: 30,
    contact: {
      email: 'alice@example.com',
    },
    tags: ['developer', 'designer'],
    active: true,
    website: 'https://alice.dev',
    metadata: {
      created: '2025-01-01',
    },
  });
  console.log('✓ User created in Notion\n');
  
  // Example 2: Read the user back
  console.log('Reading user...');
  const user = await storage.get('users/alice');
  console.log('User data:', JSON.stringify(user, null, 2));
  console.log('✓ User retrieved from Notion\n');
  
  // Example 3: Update the user
  console.log('Updating user...');
  await storage.set('users/alice', {
    name: 'Alice Johnson',
    age: 31,  // Updated!
    contact: {
      email: 'alice@example.com',
    },
    tags: ['developer', 'designer', 'manager'],  // Added tag!
    active: true,
    website: 'https://alice.dev',
    metadata: {
      created: '2025-01-01',
    },
  });
  console.log('✓ User updated in Notion\n');
  
  // Example 4: List all users
  console.log('Listing users...');
  const userKeys = await storage.keys('users/');
  console.log('User keys:', userKeys);
  console.log('✓ Listed users\n');
  
  // Example 5: Delete the user
  console.log('Deleting user...');
  await storage.delete('users/alice');
  console.log('✓ User deleted (archived) in Notion\n');
  
  console.log('✅ All examples complete!');
}

// Run if executed directly
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('❌ Error:', error);
    Deno.exit(1);
  }
}

