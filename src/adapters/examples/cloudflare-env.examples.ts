/**
 * Cloudflare Workers Examples - Using Environment Variables
 * 
 * These examples use Deno.env to automatically load the worker URL.
 * 
 * Setup:
 * 1. Create .env file in project root:
 *    SM_WORKERS_URL=https://your-workers.your-subdomain.workers.dev
 *
 * 2. For local dev, change to:
 *    SM_WORKERS_URL=http://localhost:8787
 */

import {
  createCloudflareKVAdapter,
  createCloudflareR2Adapter,
  createCloudflareD1Adapter,
  createCloudflareDOAdapter,
  getCloudflareConfig,
} from '../mod.ts';

// ============================================================================
// Example 1: KV Adapter with Environment Config
// ============================================================================

export async function exampleKVWithEnv() {
  const adapter = createCloudflareKVAdapter({
    ...getCloudflareConfig(), // Automatically loads SM_WORKERS_URL
    namespace: 'my-app',
  });
  
  // Set key-value
  await adapter.set('user:123', {
    name: 'Jan',
    role: 'admin',
  });
  
  // Get value
  const user = await adapter.get('user:123');
  console.log('User:', user);
  
  // List keys
  const keys = await adapter.keys('user:');
  console.log('User keys:', keys);
}

// ============================================================================
// Example 2: R2 Adapter with Environment Config
// ============================================================================

export async function exampleR2WithEnv() {
  const adapter = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'uploads',
  });
  
  // Store JSON data
  await adapter.set('config.json', {
    theme: 'dark',
    language: 'en',
  });
  
  // Get and auto-parse JSON
  const config = await adapter.get('config.json');
  console.log('Config:', config);
  
  // List files
  const files = await adapter.keys('');
  console.log('Files:', files);
}

// ============================================================================
// Example 3: D1 Adapter with Environment Config
// ============================================================================

export async function exampleD1WithEnv() {
  const adapter = createCloudflareD1Adapter({
    ...getCloudflareConfig(),
    table: 'settings',
  });
  
  // Set key-value
  await adapter.set('app:theme', 'dark');
  await adapter.set('app:lang', 'en');
  
  // Get value
  const theme = await adapter.get('app:theme');
  console.log('Theme:', theme);
  
  // Upsert objects
  await adapter.upsert([
    { id: 'feature-1', enabled: true },
    { id: 'feature-2', enabled: false },
  ], { idField: 'id' });
  
  // List keys
  const appKeys = await adapter.keys('app:');
  console.log('App keys:', appKeys);
}

// ============================================================================
// Example 4: DO Adapter with Environment Config
// ============================================================================

export async function exampleDOWithEnv() {
  const adapter = createCloudflareDOAdapter({
    ...getCloudflareConfig(),
    namespace: 'storage',
    instanceId: 'user-123',
  });
  
  // Store in DO (strongly consistent)
  await adapter.set('counter', 0);
  
  // Get value
  const counter = await adapter.get('counter');
  console.log('Counter:', counter);
  
  // Update counter
  await adapter.set('counter', (counter || 0) + 1);
}

// ============================================================================
// Example 5: All Adapters Together
// ============================================================================

export async function exampleAllAdaptersWithEnv() {
  // All adapters automatically use SM_WORKERS_URL from env
  
  const kv = createCloudflareKVAdapter({
    ...getCloudflareConfig(),
    namespace: 'cache',
  });
  
  const r2 = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'files',
  });
  
  const d1 = createCloudflareD1Adapter({
    ...getCloudflareConfig(),
    table: 'metadata',
  });
  
  const dobj = createCloudflareDOAdapter({
    ...getCloudflareConfig(),
    namespace: 'coordination',
    instanceId: 'task-123',
  });
  
  // Use them together
  await kv.set('status', 'processing');
  await r2.set('output.json', { result: 'success' });
  await d1.set('task-123', { status: 'completed' });
  await dobj.set('state', { progress: 100 });
  
  console.log('All adapters working with env config!');
}

// ============================================================================
// Example 6: Switch Between Dev and Prod
// ============================================================================

export async function exampleSwitchEnvironments() {
  // Just change SM_WORKERS_URL in .env:
  // - Production: https://your-workers.your-subdomain.workers.dev
  // - Local dev: http://localhost:8787
  
  const adapter = createCloudflareKVAdapter({
    ...getCloudflareConfig(), // Uses whatever is in env
    namespace: 'test',
  });
  
  await adapter.set('env-test', 'works everywhere!');
  const value = await adapter.get('env-test');
  console.log('From env:', value);
}

