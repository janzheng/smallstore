/**
 * Examples: Schema Update Methods (Phase 3.6c)
 * 
 * Demonstrates how to update schemas after adapter creation.
 */

import "jsr:@std/dotenv/load";
import { createNotionAdapter } from '../notion.ts';
import { createAirtableAdapter } from '../airtable.ts';
import { getEnv } from '../../utils/env.ts';

// ============================================================================
// Example 1: syncSchema() - Refresh from Platform
// ============================================================================

async function example1_syncSchema() {
  console.log('\n=== Example 1: syncSchema() - Refresh from Platform ===\n');
  
  // Initial setup with introspection
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  console.log('Day 1: Initial schema detected');
  await adapter.upsert([
    { id: '1', name: 'Alice' }
  ], { idField: 'id' });
  
  const info1 = adapter.getSchemaInfo();
  console.log(`  Properties: ${info1.propertyCount}`);
  
  console.log('\nDay 30: User adds "Department" column in Notion');
  console.log('  (Simulated - imagine they added it in the Notion UI)');
  
  console.log('\nDay 31: Sync schema to pick up changes');
  await adapter.syncSchema();
  
  const info2 = adapter.getSchemaInfo();
  console.log(`  Properties: ${info2.propertyCount}`);
  
  console.log('\n✅ Schema refreshed from platform');
}

// ============================================================================
// Example 2: syncSchema() with Merge Options
// ============================================================================

async function example2_syncSchemaMerge() {
  console.log('\n=== Example 2: syncSchema() with Merge Options ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    mappings: [
      {
        notionProperty: 'Name',
        sourcePath: 'full_name',  // Custom path
        notionType: 'title',
        transform: (v: any) => v.toUpperCase()  // Custom transform
      }
    ]
  });
  
  console.log('Initial state: 1 property with custom transform');
  
  console.log('\nSync with merge (default):');
  await adapter.syncSchema({ merge: true, preserveCustomTransforms: true });
  console.log('  ✅ Custom transform preserved');
  console.log('  ✅ New properties added');
  
  console.log('\nSync with replace:');
  await adapter.syncSchema({ merge: false });
  console.log('  ❌ Custom transform lost');
  console.log('  ✅ All properties refreshed');
}

// ============================================================================
// Example 3: updateSchema() - Programmatic Updates
// ============================================================================

async function example3_updateSchema() {
  console.log('\n=== Example 3: updateSchema() - Programmatic Updates ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  console.log('Initial schema detected');
  const info1 = adapter.getSchemaInfo();
  console.log(`  Properties: ${info1.propertyCount}`);
  
  console.log('\nAdd new property programmatically:');
  await adapter.updateSchema({
    add: [{
      notionProperty: 'Internal Note',
      sourcePath: 'internal_note',
      notionType: 'rich_text'
    }]
  });
  
  console.log('\nModify existing property:');
  await adapter.updateSchema({
    modify: {
      'Name': {
        sourcePath: 'full_name',  // Change from 'name' to 'full_name'
        required: true
      }
    }
  });
  
  console.log('\nRemove property:');
  await adapter.updateSchema({
    remove: ['Internal Note']
  });
  
  const info2 = adapter.getSchemaInfo();
  console.log(`\n✅ Schema updated (${info2.propertyCount} properties)`);
}

// ============================================================================
// Example 4: introspectAndUpdate() - Smart Merge
// ============================================================================

async function example4_introspectAndUpdate() {
  console.log('\n=== Example 4: introspectAndUpdate() - Smart Merge ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    mappings: [
      {
        notionProperty: 'Name',
        sourcePath: 'name',
        notionType: 'title'
      },
      {
        notionProperty: 'Email',
        sourcePath: 'email',
        notionType: 'email'
      }
    ]
  });
  
  console.log('Initial: 2 explicit properties');
  
  console.log('\nIntrospect and update with merge:');
  const changes = await adapter.introspectAndUpdate({
    mode: 'merge',
    removeObsolete: false
  });
  
  console.log('\nChanges detected:');
  console.log(`  Added: ${changes.added.length} properties`);
  console.log(`    ${changes.added.join(', ')}`);
  console.log(`  Removed: ${changes.removed.length} properties`);
  console.log(`  Modified: ${changes.modified.length} properties`);
  
  const info = adapter.getSchemaInfo();
  console.log(`\n✅ Total properties: ${info.propertyCount}`);
}

// ============================================================================
// Example 5: introspectAndUpdate() - Replace Mode
// ============================================================================

async function example5_introspectAndUpdateReplace() {
  console.log('\n=== Example 5: introspectAndUpdate() - Replace Mode ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    mappings: [
      {
        notionProperty: 'Name',
        sourcePath: 'custom_name',  // Custom path
        notionType: 'title',
        transform: (v: any) => v.toUpperCase()  // Custom transform
      }
    ]
  });
  
  console.log('Initial: 1 property with custom logic');
  
  console.log('\nIntrospect and update with replace:');
  const changes = await adapter.introspectAndUpdate({
    mode: 'replace'
  });
  
  console.log('\nResult:');
  console.log('  ❌ Custom logic discarded');
  console.log('  ✅ All platform properties now available');
  console.log(`  ✅ ${changes.added.length} properties added`);
}

// ============================================================================
// Example 6: replaceSchema() - Complete Schema Replacement
// ============================================================================

async function example6_replaceSchema() {
  console.log('\n=== Example 6: replaceSchema() - Complete Replacement ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  console.log('Initial: Auto-detected schema');
  const info1 = adapter.getSchemaInfo();
  console.log(`  Properties: ${info1.propertyCount}`);
  
  console.log('\nReplace with custom schema:');
  await adapter.replaceSchema([
    {
      notionProperty: 'Name',
      sourcePath: 'name',
      notionType: 'title',
      required: true
    },
    {
      notionProperty: 'Email',
      sourcePath: 'email',
      notionType: 'email',
      required: true
    }
  ]);
  
  const info2 = adapter.getSchemaInfo();
  console.log(`  Properties: ${info2.propertyCount}`);
  console.log('  ⚠️  All other properties discarded');
}

// ============================================================================
// Example 7: getSchemaInfo() - Inspect Current Schema
// ============================================================================

async function example7_getSchemaInfo() {
  console.log('\n=== Example 7: getSchemaInfo() - Inspect Schema ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  // Trigger introspection
  await adapter.upsert([
    { id: '1', name: 'Test' }
  ], { idField: 'id' });
  
  const info = adapter.getSchemaInfo();
  
  console.log('📋 Schema Information:');
  console.log(`  Total Properties: ${info.propertyCount}`);
  console.log(`  Initialized: ${info.initialized}`);
  console.log(`  Introspection Enabled: ${info.introspectionEnabled}`);
  console.log('\n  Properties:');
  
  for (const prop of info.properties) {
    console.log(`    - ${prop.name} (${prop.type}) → ${prop.sourcePath}`);
  }
}

// ============================================================================
// Example 8: Schema Evolution Workflow
// ============================================================================

async function example8_schemaEvolutionWorkflow() {
  console.log('\n=== Example 8: Schema Evolution Workflow ===\n');
  
  console.log('Phase 1: Prototype with introspection');
  const prototypeAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    introspectSchema: true
  });
  
  await prototypeAdapter.upsert([
    { id: '1', name: 'Alice' }
  ], { idField: 'id' });
  console.log('  ✅ Rapid prototyping');
  
  console.log('\nPhase 2: Add custom logic for core fields');
  await prototypeAdapter.updateSchema({
    modify: {
      'Name': {
        transform: (v: any) => v.trim().toUpperCase()
      }
    }
  });
  console.log('  ✅ Custom transforms added');
  
  console.log('\nPhase 3: Sync periodically');
  setInterval(async () => {
    await prototypeAdapter.syncSchema({ 
      merge: true,
      preserveCustomTransforms: true
    });
    console.log('  ✅ Schema synced (custom logic preserved)');
  }, 24 * 60 * 60 * 1000); // Daily
  
  console.log('\nPhase 4: Production - explicit mappings');
  const productionAdapter = createNotionAdapter({
    databaseId: '8aec500b9c8f4bd28411da2680848f65',
    mappings: [
      // Explicit, documented, team-reviewed mappings
      {
        notionProperty: 'Name',
        sourcePath: 'name',
        notionType: 'title',
        required: true,
        transform: (v: any) => v.trim().toUpperCase()
      },
      // ... more fields ...
    ],
    unmappedStrategy: 'error'  // Strict in production
  });
  console.log('  ✅ Production-ready');
}

// ============================================================================
// Example 9: Airtable Schema Updates
// ============================================================================

async function example9_airtableUpdates() {
  console.log('\n=== Example 9: Airtable Schema Updates ===\n');
  
  const adapter = createAirtableAdapter({
    apiKey: AIRTABLE_API_KEY || '',
    baseId: 'appXXXXXXXXXXXXXX',
    tableIdOrName: 'Contacts',
    introspectSchema: true
  });
  
  console.log('Initial: Auto-detected schema');
  
  console.log('\nSync from Airtable:');
  await adapter.syncSchema();
  
  console.log('\nIntrospect and update:');
  const changes = await adapter.introspectAndUpdate({ mode: 'merge' });
  console.log(`  Added: ${changes.added.length}`);
  console.log(`  Removed: ${changes.removed.length}`);
  
  console.log('\nGet schema info:');
  const info = adapter.getSchemaInfo();
  console.log(`  Fields: ${info.fieldCount}`);
  console.log(`  Initialized: ${info.initialized}`);
}

// ============================================================================
// Example 10: Error Handling
// ============================================================================

async function example10_errorHandling() {
  console.log('\n=== Example 10: Error Handling ===\n');
  
  const adapter = createNotionAdapter({
    databaseId: 'invalid-id',
    introspectSchema: true
  });
  
  try {
    console.log('Attempting to sync schema...');
    await adapter.syncSchema();
  } catch (error: any) {
    console.log('❌ Expected error:', error.message);
    console.log('💡 Verify database ID and permissions');
  }
  
  try {
    console.log('\nAttempting to update non-existent property...');
    const adapter2 = createNotionAdapter({
      databaseId: '8aec500b9c8f4bd28411da2680848f65',
      introspectSchema: true
    });
    
    await adapter2.updateSchema({
      modify: {
        'NonExistentProperty': {
          sourcePath: 'new_path'
        }
      }
    });
    console.log('⚠️  Warning logged (property not found)');
  } catch (error: any) {
    console.log('❌ Error:', error.message);
  }
}

// ============================================================================
// Example 11: Best Practices
// ============================================================================

async function example11_bestPractices() {
  console.log('\n=== Example 11: Best Practices ===\n');
  
  console.log('✅ DO:');
  console.log('  - Use introspection for prototyping');
  console.log('  - Sync schema periodically (daily/weekly)');
  console.log('  - Preserve custom transforms when syncing');
  console.log('  - Use merge mode by default');
  console.log('  - Inspect schema before major operations');
  console.log('  - Transition to explicit mappings for production');
  
  console.log('\n❌ DON\'T:');
  console.log('  - Use replace mode without careful consideration');
  console.log('  - Sync on every operation (performance hit)');
  console.log('  - Rely on auto-generated source paths in production');
  console.log('  - Ignore schema change warnings');
  console.log('  - Use introspection without caching');
  
  console.log('\n💡 Recommended Workflow:');
  console.log('  1. Start: introspectSchema: true');
  console.log('  2. Develop: Add custom logic via updateSchema()');
  console.log('  3. Maintain: Sync periodically with merge');
  console.log('  4. Production: Migrate to explicit mappings');
}

// ============================================================================
// Run Examples
// ============================================================================

if (import.meta.main) {
  console.log('🚀 Schema Update Methods Examples\n');
  console.log('These examples show how to update schemas after adapter creation.\n');
  
  try {
    await example1_syncSchema();
    await example2_syncSchemaMerge();
    await example3_updateSchema();
    await example4_introspectAndUpdate();
    await example5_introspectAndUpdateReplace();
    await example6_replaceSchema();
    await example7_getSchemaInfo();
    await example8_schemaEvolutionWorkflow();
    await example9_airtableUpdates();
    await example10_errorHandling();
    await example11_bestPractices();
    
    console.log('\n✨ All examples completed!\n');
  } catch (error) {
    console.error('\n❌ Error:', error);
    Deno.exit(1);
  }
}

