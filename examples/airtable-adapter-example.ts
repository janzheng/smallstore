/**
 * Airtable Adapter - Usage Example
 * 
 * This example shows how to use Smallstore with an Airtable table.
 * 
 * Prerequisites:
 * 1. Create an Airtable base at https://airtable.com
 * 2. Create a table with the fields you want to use
 * 3. Get an API key from https://airtable.com/account
 * 4. Set AIRTABLE_PRIVATE_API environment variable
 * 5. Get your base ID from the base URL
 */

import "jsr:@std/dotenv/load";
import {
  createSmallstore,
  createMemoryAdapter,
  createAirtableAdapter,
} from '../mod.ts';
import { getEnv } from '../src/utils/env.ts';

// ============================================================================
// Configuration
// ============================================================================

const AIRTABLE_BASE_ID = getEnv('AIRTABLE_BASE_ID') || 'appXXXXXXXXXXXXXX';
const AIRTABLE_TABLE_NAME = getEnv('AIRTABLE_TABLE_NAME') || 'Contacts';

// ============================================================================
// Create Airtable Adapter
// ============================================================================

const airtableAdapter = createAirtableAdapter({
  // API key from environment
  apiKey: getEnv('AIRTABLE_PRIVATE_API')!,
  baseId: AIRTABLE_BASE_ID,
  tableIdOrName: AIRTABLE_TABLE_NAME,
  
  // Schema mappings: Airtable field → Smallstore data path
  mappings: [
    {
      airtableField: 'Name',            // Airtable column name
      sourcePath: 'name',               // Smallstore data field
      airtableType: 'singleLineText',   // Airtable field type
      required: true,
    },
    {
      airtableField: 'Email',
      sourcePath: 'contact.email',      // Nested field!
      airtableType: 'email',
    },
    {
      airtableField: 'Phone',
      sourcePath: 'contact.phone',
      airtableType: 'phoneNumber',
    },
    {
      airtableField: 'Age',
      sourcePath: 'age',
      airtableType: 'number',
    },
    {
      airtableField: 'Tags',
      sourcePath: 'tags',               // Array → multiple selects
      airtableType: 'multipleSelects',
    },
    {
      airtableField: 'Active',
      sourcePath: 'active',
      airtableType: 'checkbox',
    },
    {
      airtableField: 'Website',
      sourcePath: 'website',
      airtableType: 'url',
    },
    {
      airtableField: 'Notes',
      sourcePath: 'notes',
      airtableType: 'multilineText',
    },
  ],
});

// ============================================================================
// Create Smallstore with Airtable
// ============================================================================

const storage = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
    airtable: airtableAdapter,
  },
  defaultAdapter: 'memory',
  metadataAdapter: 'memory',
  
  // Route contact data to Airtable
  routing: {
    'contacts:*': { adapter: 'airtable' },
  },
});

// ============================================================================
// Usage Examples
// ============================================================================

async function main() {
  console.log('🚀 Airtable Adapter Example\n');
  
  // Example 1: Create a contact
  console.log('Creating contact...');
  await storage.set('contacts/alice', {
    name: 'Alice Johnson',
    age: 30,
    contact: {
      email: 'alice@example.com',
      phone: '+1-555-0100',
    },
    tags: ['customer', 'premium'],
    active: true,
    website: 'https://alice.example.com',
    notes: 'Important customer - premium tier',
  });
  console.log('✓ Contact created in Airtable\n');
  
  // Example 2: Read the contact back
  console.log('Reading contact...');
  const contact = await storage.get('contacts/alice');
  console.log('Contact data:', JSON.stringify(contact, null, 2));
  console.log('✓ Contact retrieved from Airtable\n');
  
  // Example 3: Update the contact
  console.log('Updating contact...');
  await storage.set('contacts/alice', {
    name: 'Alice Johnson',
    age: 31,  // Updated!
    contact: {
      email: 'alice@example.com',
      phone: '+1-555-0100',
    },
    tags: ['customer', 'premium', 'vip'],  // Added tag!
    active: true,
    website: 'https://alice.example.com',
    notes: 'VIP customer - upgraded to VIP tier',  // Updated!
  });
  console.log('✓ Contact updated in Airtable\n');
  
  // Example 4: Create another contact
  console.log('Creating another contact...');
  await storage.set('contacts/bob', {
    name: 'Bob Smith',
    age: 25,
    contact: {
      email: 'bob@example.com',
      phone: '+1-555-0200',
    },
    tags: ['customer'],
    active: true,
    website: 'https://bob.example.com',
    notes: 'New customer',
  });
  console.log('✓ Another contact created\n');
  
  // Example 5: List all contacts
  console.log('Listing contacts...');
  const contactKeys = await storage.keys('contacts/');
  console.log('Contact keys:', contactKeys);
  console.log('✓ Listed contacts\n');
  
  // Example 6: Delete a contact
  console.log('Deleting contact...');
  await storage.delete('contacts/alice');
  console.log('✓ Contact deleted from Airtable\n');
  
  // Example 7: List remaining contacts
  console.log('Listing remaining contacts...');
  const remainingKeys = await storage.keys('contacts/');
  console.log('Remaining contact keys:', remainingKeys);
  console.log('✓ Listed remaining contacts\n');
  
  // Clean up
  console.log('Cleaning up...');
  await storage.clear('contacts/');
  console.log('✓ All contacts deleted\n');
  
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

