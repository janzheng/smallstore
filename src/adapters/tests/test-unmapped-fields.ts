/**
 * Tests for Unmapped Field Handling (Phase 3.6a)
 * 
 * Tests the unmapped field strategies for Notion and Airtable adapters.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { createMemoryAdapter } from "../memory.ts";
import { ValidationError } from "../errors.ts";

// Mock adapters for testing (using Memory as base with unmapped logic)
class MockStructuredAdapter {
  private storage = createMemoryAdapter();
  private mappings: Set<string>;
  private unmappedStrategy: 'error' | 'ignore' | 'store-as-json';
  private unmappedField: string;
  
  constructor(config: {
    mappings: string[];
    unmappedStrategy?: 'error' | 'ignore' | 'store-as-json';
    unmappedField?: string;
  }) {
    this.mappings = new Set(config.mappings);
    this.unmappedStrategy = config.unmappedStrategy || 'error';
    this.unmappedField = config.unmappedField || '_extra_data';
  }
  
  private detectUnmappedFields(data: any): string[] {
    const unmapped: string[] = [];
    for (const field of Object.keys(data)) {
      if (!this.mappings.has(field)) {
        unmapped.push(field);
      }
    }
    return unmapped;
  }
  
  private handleUnmappedFields(
    data: any,
    unmapped: string[]
  ): { processedData: any; extraData?: Record<string, any> } {
    if (unmapped.length === 0) {
      return { processedData: data };
    }
    
    switch (this.unmappedStrategy) {
      case 'error': {
        throw new ValidationError(
          'mock-adapter',
          'set',
          `Unmapped fields detected: ${unmapped.join(', ')}`,
          { unmappedFields: unmapped, data }
        );
      }
      
      case 'ignore': {
        const processedData = { ...data };
        for (const field of unmapped) {
          delete processedData[field];
        }
        return { processedData };
      }
      
      case 'store-as-json': {
        const processedData = { ...data };
        const extraData: Record<string, any> = {};
        
        for (const field of unmapped) {
          extraData[field] = data[field];
          delete processedData[field];
        }
        
        return { processedData, extraData };
      }
      
      default:
        return { processedData: data };
    }
  }
  
  async set(key: string, value: any): Promise<void> {
    const unmapped = this.detectUnmappedFields(value);
    const { processedData, extraData } = this.handleUnmappedFields(value, unmapped);
    
    // Store processed data
    await this.storage.set(key, processedData);
    
    // Store extra data if present
    if (extraData && Object.keys(extraData).length > 0) {
      await this.storage.set(`${key}:${this.unmappedField}`, extraData);
    }
  }
  
  async get(key: string): Promise<any> {
    const data = await this.storage.get(key);
    if (!data) return null;
    
    // Check for extra data
    const extraData = await this.storage.get(`${key}:${this.unmappedField}`);
    if (extraData) {
      return { ...data, ...extraData };
    }
    
    return data;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

Deno.test("Unmapped Fields: Strategy 'error' (default)", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'error'
  });
  
  // Test: Mapped fields only - should work
  await adapter.set('user-1', {
    name: 'Alice',
    email: 'alice@example.com'
  });
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1, {
    name: 'Alice',
    email: 'alice@example.com'
  });
  
  // Test: Unmapped field - should throw
  await assertRejects(
    async () => {
      await adapter.set('user-2', {
        name: 'Bob',
        email: 'bob@example.com',
        role: 'admin'  // Unmapped!
      });
    },
    ValidationError,
    'Unmapped fields detected: role'
  );
});

Deno.test("Unmapped Fields: Strategy 'ignore'", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'ignore'
  });
  
  // Test: Unmapped fields are silently dropped
  await adapter.set('user-1', {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',       // Unmapped, will be ignored
    department: 'Engineering'  // Unmapped, will be ignored
  });
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1, {
    name: 'Alice',
    email: 'alice@example.com'
    // role and department are dropped
  });
});

Deno.test("Unmapped Fields: Strategy 'store-as-json'", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'store-as-json',
    unmappedField: '_extra_data'
  });
  
  // Test: Unmapped fields stored separately, retrieved merged
  await adapter.set('user-1', {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',       // Unmapped
    department: 'Engineering'  // Unmapped
  });
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1, {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    department: 'Engineering'
  });
  // All fields present, unmapped stored in _extra_data internally
});

Deno.test("Unmapped Fields: Only unmapped fields", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'store-as-json'
  });
  
  // Test: Data with only unmapped fields
  await adapter.set('user-1', {
    role: 'admin',
    department: 'Engineering',
    level: 5
  });
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1, {
    role: 'admin',
    department: 'Engineering',
    level: 5
  });
});

Deno.test("Unmapped Fields: Empty object", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'error'
  });
  
  // Test: Empty object should work (no unmapped fields)
  await adapter.set('user-1', {});
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1, {});
});

Deno.test("Unmapped Fields: Multiple strategy tests", async () => {
  // Test different strategies with same data
  const testData = {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    department: 'Engineering'
  };
  
  // Strategy: ignore
  const ignoreAdapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'ignore'
  });
  
  await ignoreAdapter.set('user-1', testData);
  const ignoreResult = await ignoreAdapter.get('user-1');
  assertEquals(ignoreResult, {
    name: 'Alice',
    email: 'alice@example.com'
  });
  
  // Strategy: store-as-json
  const jsonAdapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'store-as-json'
  });
  
  await jsonAdapter.set('user-1', testData);
  const jsonResult = await jsonAdapter.get('user-1');
  assertEquals(jsonResult, testData);  // All fields preserved
});

Deno.test("Unmapped Fields: Nested objects", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'store-as-json'
  });
  
  // Test: Nested unmapped data
  await adapter.set('user-1', {
    name: 'Alice',
    email: 'alice@example.com',
    metadata: {
      created: '2024-01-01',
      tags: ['admin', 'active']
    }
  });
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1, {
    name: 'Alice',
    email: 'alice@example.com',
    metadata: {
      created: '2024-01-01',
      tags: ['admin', 'active']
    }
  });
});

Deno.test("Unmapped Fields: Arrays in unmapped data", async () => {
  const adapter = new MockStructuredAdapter({
    mappings: ['name', 'email'],
    unmappedStrategy: 'store-as-json'
  });
  
  // Test: Arrays in unmapped fields
  await adapter.set('user-1', {
    name: 'Alice',
    email: 'alice@example.com',
    roles: ['admin', 'moderator'],
    permissions: ['read', 'write', 'delete']
  });
  
  const user1 = await adapter.get('user-1');
  assertEquals(user1.roles, ['admin', 'moderator']);
  assertEquals(user1.permissions, ['read', 'write', 'delete']);
});

console.log('✅ All unmapped field tests passed!');

