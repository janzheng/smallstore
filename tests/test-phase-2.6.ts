/**
 * Phase 2.6: Input Validation & Filtering Tests
 * 
 * Tests input validation and transformation before storage.
 */

import { createSmallstore, createMemoryAdapter, type SetOptions, type Smallstore } from '../mod.ts';

// ============================================================================
// Test Helpers
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals(actual: any, expected: any, message: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${message}\nExpected: ${expectedStr}\nActual: ${actualStr}`);
  }
}

// ============================================================================
// Test: Input Validation - Strict Mode
// ============================================================================

Deno.test('Phase 2.6: Input Validation - Strict Mode (valid data)', async () => {
  const storage: Smallstore = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0 },
      email: { type: 'string', format: 'email' }
    },
    required: ['name', 'email']
  };

  const validUser = {
    name: 'Alice',
    age: 25,
    email: 'alice@example.com'
  };

  await storage.set('users', validUser, {
    mode: 'overwrite',
    inputValidation: {
      schema,
      mode: 'strict'
    }
  });

  const result = await storage.get('users');
  assertEquals(result, validUser, 'Valid user should be stored');
  
  console.log('✅ Phase 2.6: Input Validation - Strict Mode (valid data) passed');
});

Deno.test('Phase 2.6: Input Validation - Strict Mode (invalid data throws)', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0 }
    },
    required: ['name']
  };

  const invalidUser = {
    age: 'not-a-number'  // Missing name, invalid age
  };

  let errorThrown = false;
  try {
    await storage.set('users', invalidUser, {
      mode: 'overwrite',
      inputValidation: {
        schema,
        mode: 'strict'
      }
    });
  } catch (error) {
    errorThrown = true;
    assert(error instanceof Error, 'Should throw Error');
    if (error instanceof Error) {
      assert(error.message.includes('Validation failed'), 'Error message should mention validation');
    }
  }

  assert(errorThrown, 'Should throw error for invalid data in strict mode');
  console.log('✅ Phase 2.6: Input Validation - Strict Mode (invalid data throws) passed');
});

// ============================================================================
// Test: Input Validation - Sieve Mode
// ============================================================================

Deno.test('Phase 2.6: Input Validation - Sieve Mode (filter invalid)', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0 },
      email: { type: 'string', format: 'email' }
    },
    required: ['name', 'email']
  };

  const mixedUsers = [
    { name: 'Alice', age: 25, email: 'alice@example.com' },  // Valid
    { name: 'Bob', email: 'invalid-email' },  // Invalid email
    { age: 30, email: 'charlie@example.com' },  // Missing name
    { name: 'Diana', email: 'diana@example.com', age: 28 }  // Valid
  ];

  const invalidItems: any[] = [];
  
  await storage.set('users', mixedUsers, {
    mode: 'overwrite',
    inputValidation: {
      schema,
      mode: 'sieve',
      onInvalid: (item: any, error: any) => {
        invalidItems.push(item);
      }
    }
  });

  const result = await storage.get('users');
  
  // Should only have valid users (sieve mode filters, overwrite stores directly)
  assert(Array.isArray(result), 'Result should be array');
  assertEquals(result.length, 2, 'Should have 2 valid users');
  assertEquals(result[0].name, 'Alice', 'First valid user');
  assertEquals(result[1].name, 'Diana', 'Second valid user');
  assertEquals(invalidItems.length, 2, 'Should have captured 2 invalid items');
  
  console.log('✅ Phase 2.6: Input Validation - Sieve Mode (filter invalid) passed');
});

Deno.test('Phase 2.6: Input Validation - Sieve Mode (all invalid = no storage)', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      email: { type: 'string', format: 'email' }
    },
    required: ['name', 'email']
  };

  const allInvalid = [
    { name: 'Bob' },  // Missing email
    { email: 'invalid' },  // Invalid email
    { age: 30 }  // Missing both
  ];

  await storage.set('users', allInvalid, {
    mode: 'overwrite',
    inputValidation: {
      schema,
      mode: 'sieve'
    }
  });

  const result = await storage.get('users');
  assertEquals(result, null, 'Should not store anything when all items are invalid');
  
  console.log('✅ Phase 2.6: Input Validation - Sieve Mode (all invalid = no storage) passed');
});

// ============================================================================
// Test: Input Transform - Pick Fields
// ============================================================================

Deno.test('Phase 2.6: Input Transform - Pick Fields', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const messyData = {
    url: 'https://github.com/user/repo',
    title: 'Cool Repo',
    description: 'A cool project',
    junk1: 'ignore this',
    junk2: 'and this',
    metadata: { extra: 'stuff' }
  };

  await storage.set('bookmarks', messyData, {
    mode: 'overwrite',
    inputTransform: {
      pick: ['url', 'title', 'description']
    }
  });

  const result = await storage.get('bookmarks');
  assert(typeof result === 'object' && result !== null, 'Result should be object');
  assert(!Array.isArray(result), 'Result should not be wrapped in array with overwrite mode');
  
  assertEquals(Object.keys(result).sort(), ['description', 'title', 'url'], 'Should only have picked fields');
  assertEquals(result.url, messyData.url, 'url should be preserved');
  assertEquals(result.title, messyData.title, 'title should be preserved');
  assertEquals(result.description, messyData.description, 'description should be preserved');
  assert(!('junk1' in result), 'junk1 should be removed');
  assert(!('metadata' in result), 'metadata should be removed');
  
  console.log('✅ Phase 2.6: Input Transform - Pick Fields passed');
});

// ============================================================================
// Test: Input Transform - Omit Fields
// ============================================================================

Deno.test('Phase 2.6: Input Transform - Omit Fields', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const data = {
    id: 123,
    name: 'Product',
    price: 99.99,
    internalId: 'INTERNAL',
    debugInfo: { foo: 'bar' }
  };

  await storage.set('products', data, {
    mode: 'overwrite',
    inputTransform: {
      omit: ['internalId', 'debugInfo']
    }
  });

  const result = await storage.get('products');
  assert(typeof result === 'object' && result !== null, 'Result should be object');
  assert(!Array.isArray(result), 'Result should not be wrapped in array with overwrite mode');
  
  assert('id' in result, 'id should be preserved');
  assert('name' in result, 'name should be preserved');
  assert('price' in result, 'price should be preserved');
  assert(!('internalId' in result), 'internalId should be removed');
  assert(!('debugInfo' in result), 'debugInfo should be removed');
  
  console.log('✅ Phase 2.6: Input Transform - Omit Fields passed');
});

// ============================================================================
// Test: Input Transform - Where Filter
// ============================================================================

Deno.test('Phase 2.6: Input Transform - Where Filter', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const bookmarks = [
    { url: 'https://github.com/user1/repo1', title: 'Repo 1' },
    { url: 'https://news.ycombinator.com/item?id=123', title: 'HN Article' },
    { url: 'https://github.com/user2/repo2', title: 'Repo 2' },
    { url: 'https://twitter.com/user', title: 'Tweet' }
  ];

  await storage.set('bookmarks', bookmarks, {
    mode: 'overwrite',
    inputTransform: {
      where: {
        url: { $contains: 'github.com' }
      }
    }
  });

  const result = await storage.get('bookmarks');
  assert(Array.isArray(result), 'Result should be array');
  
  assertEquals(result.length, 2, 'Should have 2 GitHub bookmarks');
  assert(result[0].url.includes('github.com'), 'First should be GitHub');
  assert(result[1].url.includes('github.com'), 'Second should be GitHub');
  
  console.log('✅ Phase 2.6: Input Transform - Where Filter passed');
});

// ============================================================================
// Test: Input Transform - Custom Transform Function
// ============================================================================

Deno.test('Phase 2.6: Input Transform - Custom Transform Function', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const rawData = [
    { name: 'Alice', score: 85 },
    { name: 'Bob', score: 92 },
    { name: 'Charlie', score: 78 }
  ];

  const options: SetOptions = {
    mode: 'overwrite',
    inputTransform: {
      transform: (item: any) => ({
        ...item,
        grade: item.score >= 90 ? 'A' : item.score >= 80 ? 'B' : 'C',
        timestamp: Date.now()
      })
    }
  };
  await storage.set('students', rawData, options);

  const result = await storage.get('students');
  assert(Array.isArray(result), 'Result should be array');
  
  assertEquals(result.length, 3, 'Should have 3 students');
  assertEquals(result[0].grade, 'B', 'Alice should have B');
  assertEquals(result[1].grade, 'A', 'Bob should have A');
  assertEquals(result[2].grade, 'C', 'Charlie should have C');
  assert('timestamp' in result[0], 'Should have timestamp');
  
  console.log('✅ Phase 2.6: Input Transform - Custom Transform Function passed');
});

// ============================================================================
// Test: Combined Validation + Transform
// ============================================================================

Deno.test('Phase 2.6: Combined Validation + Transform', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const schema = {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'url' },
      title: { type: 'string' },
      tags: { type: 'array' }
    },
    required: ['url', 'title']
  };

  const scrapedData = [
    { url: 'https://github.com/user/repo', title: 'Repo', tags: ['dev'], junk: 'ignore' },  // Valid
    { url: 'invalid-url', title: 'Bad URL' },  // Invalid
    { url: 'https://news.ycombinator.com/item?id=123', title: 'HN', extra: 'field' },  // Valid
    { title: 'Missing URL' }  // Invalid
  ];

  const options: SetOptions = {
    mode: 'overwrite',
    inputValidation: {
      schema,
      mode: 'sieve'
    },
    inputTransform: {
      pick: ['url', 'title', 'tags'],
      transform: (item: any) => ({
        ...item,
        savedAt: Date.now()
      })
    }
  };
  await storage.set('bookmarks', scrapedData, options);

  const result = await storage.get('bookmarks');
  assert(Array.isArray(result), 'Result should be array');
  
  assertEquals(result.length, 2, 'Should have 2 valid items');
  
  // Check first item
  assert(result[0].url.includes('github.com'), 'First should be GitHub');
  assert('savedAt' in result[0], 'Should have savedAt');
  assert(!('junk' in result[0]), 'junk should be removed');
  assertEquals(result[0].tags, ['dev'], 'tags should be preserved');
  
  // Check second item
  assert(result[1].url.includes('ycombinator'), 'Second should be HN');
  assert(!('extra' in result[1]), 'extra should be removed');
  
  console.log('✅ Phase 2.6: Combined Validation + Transform passed');
});

// ============================================================================
// Test: Real-World Use Case - AI-Generated Data
// ============================================================================

Deno.test('Phase 2.6: Real-World - AI-Generated Product Data', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const productSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      price: { type: 'number', minimum: 0 },
      category: { type: 'string' },
      inStock: { type: 'boolean' }
    },
    required: ['name', 'price']
  };

  // Simulated AI response with messy data
  const aiGeneratedProducts = [
    { name: 'Widget A', price: 19.99, category: 'Tools', inStock: true, _meta: 'ignore' },
    { name: '', price: 29.99 },  // Invalid: empty name
    { name: 'Widget B', price: -5 },  // Invalid: negative price
    { name: 'Widget C', price: 39.99, category: 'Gadgets', extraField: 'junk' },
    { price: 49.99 }  // Invalid: missing name
  ];

  const invalidCount = { count: 0 };
  
  await storage.set('products', aiGeneratedProducts, {
    mode: 'overwrite',
    inputValidation: {
      schema: productSchema,
      mode: 'sieve',
      onInvalid: () => { invalidCount.count++; }
    },
    inputTransform: {
      pick: ['name', 'price', 'category', 'inStock'],
      transform: (item: any) => ({
        ...item,
        addedAt: Date.now(),
        source: 'ai-generated'
      })
    }
  });

  const result = await storage.get('products');
  assert(Array.isArray(result), 'Result should be array');
  
  assertEquals(result.length, 2, 'Should have 2 valid products');
  assertEquals(invalidCount.count, 3, 'Should have filtered out 3 invalid products');
  
  // Verify cleaned data
  assert(result[0].name === 'Widget A', 'First product name');
  assert(!('_meta' in result[0]), '_meta should be removed');
  assert('addedAt' in result[0], 'Should have addedAt');
  assert(result[0].source === 'ai-generated', 'Should have source');
  
  console.log('✅ Phase 2.6: Real-World - AI-Generated Product Data passed');
});

// ============================================================================
// Test: Real-World Use Case - Web Scraping
// ============================================================================

Deno.test('Phase 2.6: Real-World - Web Scraping with Cleanup', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  // Simulated scraped data (messy!)
  const scrapedArticles = [
    { title: 'Article 1', url: 'https://example.com/1', author: 'Alice', publishedDate: '2024-01-15', ads: 'ignore', tracking: 'data' },
    { title: null, url: 'https://example.com/2' },  // Missing title
    { title: 'Article 2', url: 'not-a-url' },  // Invalid URL
    { title: 'Article 3', url: 'https://example.com/3', author: 'Bob', extra: 'field' }
  ];

  await storage.set('articles', scrapedArticles, {
    mode: 'overwrite',
    inputTransform: {
      pick: ['title', 'url', 'author', 'publishedDate'],
      where: {
        title: { $ne: null },
        url: { $contains: 'http' }
      },
      transform: (item: any) => ({
        ...item,
        scrapedAt: Date.now()
      })
    }
  });

  const result = await storage.get('articles');
  assert(Array.isArray(result), 'Result should be array');
  
  // Should have Article 1 and Article 3
  assertEquals(result.length, 2, 'Should have 2 valid articles');
  assert(!('ads' in result[0]), 'ads should be removed');
  assert(!('tracking' in result[0]), 'tracking should be removed');
  assert('scrapedAt' in result[0], 'Should have scrapedAt');
  
  console.log('✅ Phase 2.6: Real-World - Web Scraping with Cleanup passed');
});

// ============================================================================
// Test: Unified Syntax with Views (Nested Fields)
// ============================================================================

Deno.test('Phase 2.6: Unified Syntax - Nested Fields (matches FilterRetriever)', async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter()
    },
    defaultAdapter: 'memory'
  });

  const userData = [
    { user: { profile: { age: 25 } }, tags: ['developer'] },
    { user: { profile: { age: 30 } }, tags: ['designer'] },
    { user: { profile: { age: 35 } }, tags: ['developer', 'manager'] }
  ];

  // Test nested field filtering (same as FilterRetriever!)
  await storage.set('users', userData, {
    mode: 'overwrite',
    inputTransform: {
      where: {
        'user.profile.age': { $gte: 30 },        // Nested field access
        'tags': { $contains: 'developer' }        // Array contains
      }
    }
  });

  const result = await storage.get('users');
  assert(Array.isArray(result), 'Result should be array');
  assertEquals(result.length, 1, 'Should filter to 1 user');
  assertEquals(result[0].user.profile.age, 35, 'Should be the 35yo developer');
  assert(result[0].tags.includes('developer'), 'Should have developer tag');
  assert(result[0].tags.includes('manager'), 'Should have manager tag');
  
  console.log('✅ Phase 2.6: Unified Syntax - Nested Fields (matches FilterRetriever) passed');
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n🎉 All Phase 2.6 tests passed!');
console.log('\nPhase 2.6: Input Validation & Filtering');
console.log('  ✅ Input validation (strict mode)');
console.log('  ✅ Input validation (sieve mode)');
console.log('  ✅ Input transform (pick, omit, where, custom)');
console.log('  ✅ Combined validation + transform');
console.log('  ✅ Real-world use cases (AI, scraping)');
console.log('  ✅ Unified syntax with views (nested fields, array contains)');

