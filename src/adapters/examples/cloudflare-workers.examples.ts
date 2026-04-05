/**
 * Cloudflare Workers Adapters Examples
 * 
 * Demonstrates HTTP and native binding modes for all Cloudflare adapters.
 */

import {
  createCloudflareKVAdapter,
  createCloudflareR2Adapter,
  createCloudflareD1Adapter,
  createCloudflareDOAdapter,
} from '../mod.ts';

// ============================================================================
// Example 1: Cloudflare KV - HTTP Mode
// ============================================================================

export async function exampleKVHttp() {
  const adapter = createCloudflareKVAdapter({
    baseUrl: 'https://your-workers.your-subdomain.workers.dev',
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
  
  // List keys with prefix
  const keys = await adapter.keys('user:');
  console.log('User keys:', keys);
  
  // Upsert objects
  const result = await adapter.upsert([
    { id: '456', name: 'Alice', role: 'user' },
    { id: '789', name: 'Bob', role: 'user' },
  ], { idField: 'id' });
  console.log('Upserted:', result);
  
  // Query with filter
  const admins = await adapter.query({
    filter: (item: any) => item.role === 'admin',
  });
  console.log('Admins:', admins);
}

// ============================================================================
// Example 2: Cloudflare KV - Native Mode (inside Workers)
// ============================================================================

export async function exampleKVNative(env: any) {
  const adapter = createCloudflareKVAdapter({
    binding: env.SM_KV,
    namespace: 'my-app',
  });
  
  // Set with TTL (expires in 1 hour)
  await adapter.set('session:abc123', {
    userId: '123',
    token: 'xyz',
  }, 3600);
  
  // Get value
  const session = await adapter.get('session:abc123');
  console.log('Session:', session);
  
  // Delete
  await adapter.delete('session:abc123');
}

// ============================================================================
// Example 3: Cloudflare R2 - HTTP Mode
// ============================================================================

export async function exampleR2Http() {
  const adapter = createCloudflareR2Adapter({
    baseUrl: 'https://your-workers.your-subdomain.workers.dev',
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
  
  // Store CSV data
  const csvData = [
    { name: 'Alice', age: 30 },
    { name: 'Bob', age: 25 },
  ];
  await adapter.set('users.csv', csvData);
  
  // List files
  const files = await adapter.keys('');
  console.log('Files:', files);
}

// ============================================================================
// Example 4: Cloudflare R2 - Native Mode (inside Workers)
// ============================================================================

export async function exampleR2Native(env: any) {
  const adapter = createCloudflareR2Adapter({
    binding: env.SM_R2,
    scope: 'images',
  });
  
  // Store binary data
  const imageData = new Uint8Array([/* ... */]);
  await adapter.set('photo.jpg', imageData);
  
  // Get raw data
  const raw = await adapter.get('photo.jpg', { raw: true });
  console.log('Raw data:', raw);
  
  // Check if exists
  const exists = await adapter.has('photo.jpg');
  console.log('Exists:', exists);
  
  // Clear all with prefix
  await adapter.clear('temp/');
}

// ============================================================================
// Example 5: Cloudflare D1 - HTTP Mode
// ============================================================================

export async function exampleD1Http() {
  const adapter = createCloudflareD1Adapter({
    baseUrl: 'https://your-workers.your-subdomain.workers.dev',
    table: 'settings',
  });
  
  // Set key-value in D1
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
  
  // List keys with prefix
  const appKeys = await adapter.keys('app:');
  console.log('App keys:', appKeys);
}

// ============================================================================
// Example 6: Cloudflare D1 - Native Mode (inside Workers)
// ============================================================================

export async function exampleD1Native(env: any) {
  const adapter = createCloudflareD1Adapter({
    binding: env.SM_D1,
    table: 'user_preferences',
  });
  
  // Store user preferences
  await adapter.set('user:123:prefs', {
    notifications: true,
    theme: 'dark',
  });
  
  // Query preferences
  const prefs = await adapter.query({
    prefix: 'user:',
    filter: (item: any) => item.notifications === true,
  });
  console.log('Users with notifications:', prefs);
  
  // List all
  const allPrefs = await adapter.list({
    limit: 10,
    offset: 0,
  });
  console.log('All preferences:', allPrefs);
}

// ============================================================================
// Example 7: Cloudflare DO - HTTP Mode
// ============================================================================

export async function exampleDOHttp() {
  const adapter = createCloudflareDOAdapter({
    baseUrl: 'https://your-workers.your-subdomain.workers.dev',
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
  
  // Store complex objects
  await adapter.set('session', {
    userId: '123',
    started: new Date().toISOString(),
    actions: [],
  });
}

// ============================================================================
// Example 8: Cloudflare DO - Native Mode (inside Workers)
// ============================================================================

export async function exampleDONative(env: any) {
  const adapter = createCloudflareDOAdapter({
    binding: env.SM_DO,
    namespace: 'storage',
    instanceId: 'room-abc',
  });
  
  // Store room state (strongly consistent)
  await adapter.set('participants', ['alice', 'bob']);
  await adapter.set('messages', [
    { user: 'alice', text: 'Hello!' },
    { user: 'bob', text: 'Hi there!' },
  ]);
  
  // Get room state
  const participants = await adapter.get('participants');
  const messages = await adapter.get('messages');
  console.log('Room state:', { participants, messages });
  
  // List all keys in DO
  const keys = await adapter.keys();
  console.log('DO keys:', keys);
  
  // Clear specific prefix
  await adapter.clear('temp:');
}

// ============================================================================
// Example 9: Mixed Usage - Combine Multiple Adapters
// ============================================================================

export async function exampleMixedUsage(env: any) {
  // Fast cache in KV
  const cache = createCloudflareKVAdapter({
    binding: env.SM_KV,
    namespace: 'cache',
  });
  
  // Large files in R2
  const files = createCloudflareR2Adapter({
    binding: env.SM_R2,
    scope: 'assets',
  });
  
  // Metadata in D1
  const metadata = createCloudflareD1Adapter({
    binding: env.SM_D1,
    table: 'file_metadata',
  });
  
  // Coordination with DO
  const coordinator = createCloudflareDOAdapter({
    binding: env.SM_DO,
    namespace: 'jobs',
    instanceId: 'job-processor',
  });
  
  // Workflow: Upload file, store metadata, cache result
  const fileKey = 'document.pdf';
  const fileData = new Uint8Array([/* ... */]);
  
  // 1. Upload to R2
  await files.set(fileKey, fileData);
  
  // 2. Store metadata in D1
  await metadata.set(fileKey, {
    name: 'document.pdf',
    size: fileData.length,
    uploaded: new Date().toISOString(),
    type: 'application/pdf',
  });
  
  // 3. Cache metadata in KV (with TTL)
  await cache.set(`meta:${fileKey}`, {
    name: 'document.pdf',
    size: fileData.length,
  }, 3600);
  
  // 4. Update job status in DO
  await coordinator.set('status', 'completed');
  
  console.log('File uploaded and indexed!');
}

// ============================================================================
// Example 10: HTTP API Direct Usage (no adapter)
// ============================================================================

export async function exampleDirectHTTP() {
  const baseUrl = 'https://your-workers.your-subdomain.workers.dev';
  
  // KV: Set value
  await fetch(`${baseUrl}/kv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'test',
      value: { foo: 'bar' },
      scope: 'demo',
      ttl: 3600,
    }),
  });
  
  // KV: Get value
  const kvResponse = await fetch(`${baseUrl}/kv?key=test&scope=demo`);
  const kvData = await kvResponse.json();
  console.log('KV data:', kvData);
  
  // R2: Upload file (multipart)
  const formData = new FormData();
  formData.append('files', new Blob(['test content']), 'test.txt');
  formData.append('scope', 'uploads');
  
  await fetch(`${baseUrl}/r2`, {
    method: 'POST',
    body: formData,
  });
  
  // D1: Set key-value
  await fetch(`${baseUrl}/d1/kv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'config',
      value: { enabled: true },
      table: 'settings',
    }),
  });
  
  // DO: Send command
  await fetch(`${baseUrl}/do/storage/instance-123`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'set',
      params: {
        key: 'data',
        value: { count: 42 },
      },
    }),
  });
}

