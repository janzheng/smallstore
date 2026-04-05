/**
 * Tests for External Data Sources (Phase 3.6g-c)
 * 
 * Tests virtual collections pointing to remote JSON/CSV data.
 */

import { createSmallstore, createMemoryAdapter } from '../mod.ts';
import { assertEquals, assertExists } from "@std/assert";

// Test with a simple local mock server
function createMockJsonServer(): Deno.HttpServer {
  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    
    if (url.pathname === '/data.json') {
      return new Response(JSON.stringify([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
        { id: 3, name: 'Item 3' },
      ]), {
        headers: { 
          'Content-Type': 'application/json',
          'ETag': '"abc123"',
          'Last-Modified': new Date().toUTCString()
        }
      });
    }
    
    if (url.pathname === '/data.csv') {
      return new Response(`id,name\n1,Item 1\n2,Item 2\n3,Item 3`, {
        headers: { 'Content-Type': 'text/csv' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  };
  
  return Deno.serve({ port: 8765, hostname: '127.0.0.1' }, handler);
}

Deno.test('External Sources - Register and fetch JSON', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    // Register external source
    await storage.registerExternal('external/mock-data', {
      url: 'http://127.0.0.1:8765/data.json',
      type: 'json',
      cacheTTL: 60000, // 1 minute
    });
    
    // Fetch data
    const data = await storage.get('external/mock-data');
    
    assertEquals(data.length, 3);
    assertEquals(data[0].name, 'Item 1');
    
    // Cleanup
    await storage.unregisterExternal('external/mock-data');
  } finally {
    await server.shutdown();
  }
});

Deno.test('External Sources - Caching works', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    await storage.registerExternal('external/cached', {
      url: 'http://127.0.0.1:8765/data.json',
      type: 'json',
      cacheTTL: 60000,
    });
    
    // First fetch
    const data1 = await storage.get('external/cached');
    assertEquals(data1.length, 3);
    
    // Second fetch should use cache
    const data2 = await storage.get('external/cached');
    assertEquals(data2.length, 3);
    
    // Verify source metadata was updated
    const source = await storage.getExternalSource('external/cached');
    assertExists(source?.lastFetched);
    assertExists(source?.cacheKey);
    
    await storage.unregisterExternal('external/cached');
  } finally {
    await server.shutdown();
  }
});

Deno.test('External Sources - Force refresh', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    await storage.registerExternal('external/refresh', {
      url: 'http://127.0.0.1:8765/data.json',
      type: 'json',
      cacheTTL: 60000,
    });
    
    // First fetch
    await storage.get('external/refresh');
    
    // Get last fetched time
    const source1 = await storage.getExternalSource('external/refresh');
    const lastFetched1 = source1?.lastFetched;
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Force refresh
    await storage.refreshExternal('external/refresh');
    
    // Verify last fetched was updated
    const source2 = await storage.getExternalSource('external/refresh');
    const lastFetched2 = source2?.lastFetched;
    
    assertEquals(lastFetched2! > lastFetched1!, true);
    
    await storage.unregisterExternal('external/refresh');
  } finally {
    await server.shutdown();
  }
});

Deno.test('External Sources - CSV parsing', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    await storage.registerExternal('external/csv-data', {
      url: 'http://127.0.0.1:8765/data.csv',
      type: 'csv',
      cacheTTL: 60000,
    });
    
    const data = await storage.get('external/csv-data');
    
    assertEquals(data.length, 3);
    assertEquals(data[0].id, '1');
    assertEquals(data[0].name, 'Item 1');
    
    await storage.unregisterExternal('external/csv-data');
  } finally {
    await server.shutdown();
  }
});

Deno.test('External Sources - List sources', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    // Register multiple sources
    await storage.registerExternal('external/source1', {
      url: 'http://127.0.0.1:8765/data.json',
      type: 'json',
      cacheTTL: 60000,
    });
    
    await storage.registerExternal('external/source2', {
      url: 'http://127.0.0.1:8765/data.csv',
      type: 'csv',
      cacheTTL: 60000,
    });
    
    // List sources
    const sources = await storage.listExternalSources();
    
    assertEquals(sources.length >= 2, true);
    assertEquals(sources.includes('external/source1'), true);
    assertEquals(sources.includes('external/source2'), true);
    
    await storage.unregisterExternal('external/source1');
    await storage.unregisterExternal('external/source2');
  } finally {
    await server.shutdown();
  }
});

Deno.test('External Sources - Update configuration', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    await storage.registerExternal('external/update-test', {
      url: 'http://127.0.0.1:8765/data.json',
      type: 'json',
      cacheTTL: 60000,
    });
    
    // Get initial config
    const config1 = await storage.getExternalSource('external/update-test');
    assertEquals(config1?.cacheTTL, 60000);
    
    // Update config
    await storage.updateExternalSource('external/update-test', {
      cacheTTL: 120000,
    });
    
    // Verify update
    const config2 = await storage.getExternalSource('external/update-test');
    assertEquals(config2?.cacheTTL, 120000);
    
    await storage.unregisterExternal('external/update-test');
  } finally {
    await server.shutdown();
  }
});

Deno.test('External Sources - No cache mode', async () => {
  const server = createMockJsonServer();
  
  try {
    const storage = createSmallstore({
      adapters: {
        memory: createMemoryAdapter(),
      },
      metadataAdapter: 'memory',
      defaultAdapter: 'memory',
    });
    
    // Register with cacheTTL: 0 (no cache)
    await storage.registerExternal('external/no-cache', {
      url: 'http://127.0.0.1:8765/data.json',
      type: 'json',
      cacheTTL: 0,
    });
    
    // Each fetch should hit the source
    const data1 = await storage.get('external/no-cache');
    assertEquals(data1.length, 3);
    
    const data2 = await storage.get('external/no-cache');
    assertEquals(data2.length, 3);
    
    // Verify no cache key was created
    const source = await storage.getExternalSource('external/no-cache');
    assertEquals(source?.cacheKey, undefined);
    
    await storage.unregisterExternal('external/no-cache');
  } finally {
    await server.shutdown();
  }
});

console.log('✅ All external source tests passed!');

