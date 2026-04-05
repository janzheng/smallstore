/**
 * Cloudflare Workers TypeScript Examples
 * 
 * Copy-paste ready TypeScript examples for using Cloudflare adapters directly.
 * These are NOT for FunctionFlow pipelines - use cloudflare-*.examples.ts in 
 * modules/compositions/smallstore/v3/examples/ for those.
 * 
 * Environment Setup:
 * Add to your .env file:
 * SM_WORKERS_URL=https://your-workers.your-subdomain.workers.dev
 */

import "jsr:@std/dotenv/load";
import { 
  createCloudflareKVAdapter,
  createCloudflareD1Adapter,
  createCloudflareR2Adapter,
  getCloudflareConfig 
} from '../mod.ts';

// ============================================================================
// 1. Cache API Response (KV)
// ============================================================================

export async function cacheApiResponse() {
  const cache = createCloudflareKVAdapter({
    ...getCloudflareConfig(),
    namespace: 'api-cache',
  });

  const cacheKey = 'api:users:list';
  
  // Check cache first
  let data = await cache.get(cacheKey);
  
  if (!data) {
    // Cache miss - fetch from API
    const response = await fetch('https://api.example.com/users');
    data = await response.json();
    
    // Store in cache with 5 min TTL (300 seconds)
    await cache.set(cacheKey, data, 300);
  }
  
  return data;
}

// ============================================================================
// 2. User Session Management (KV)
// ============================================================================

export async function manageSession() {
  const sessions = createCloudflareKVAdapter({
    ...getCloudflareConfig(),
    namespace: 'sessions',
  });

  // Create session (1 hour TTL - 3600 seconds)
  const sessionId = 'sess_' + crypto.randomUUID();
  await sessions.set(sessionId, {
    userId: 'user-123',
    email: 'jan@example.com',
    loginTime: new Date().toISOString(),
  }, 3600);

  // Get session
  const session = await sessions.get(sessionId);
  
  // Delete session (logout)
  await sessions.delete(sessionId);
  
  return { sessionId, session };
}

// ============================================================================
// 3. Store Structured User Data (D1)
// ============================================================================

export async function storeUserData() {
  const users = createCloudflareD1Adapter({
    ...getCloudflareConfig(),
    table: 'users',
  });

  // Create user
  await users.set('user:123', {
    id: '123',
    name: 'Jan Zheng',
    email: 'jan@example.com',
    role: 'admin',
  });

  // Get user
  const user = await users.get('user:123');
  
  // Update user
  await users.set('user:123', {
    ...user,
    role: 'superadmin',
  });

  return user;
}

// ============================================================================
// 4. Upload Image to R2 as Blob
// ============================================================================

export async function uploadImageToR2() {
  const storage = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'images',
  });

  // Fetch image from URL
  const imageUrl = 'https://example.com/photo.jpg';
  const response = await fetch(imageUrl);
  const imageBlob = await response.blob();

  // Upload to R2
  const filename = `photo-${Date.now()}.jpg`;
  await storage.set(filename, imageBlob);

  console.log(`Image uploaded: ${filename}`);
  
  // Get the image back
  const retrievedImage = await storage.get(filename);
  console.log('Image type:', retrievedImage.type);
  
  return { filename, size: imageBlob.size };
}

// ============================================================================
// 5. Upload Local File to R2 (using Deno.readFile)
// ============================================================================

export async function uploadLocalFileToR2(filePath: string) {
  const storage = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'uploads',
  });

  // Read local file
  const fileData = await Deno.readFile(filePath);
  const fileName = filePath.split('/').pop() || 'file';

  // Create blob with appropriate MIME type
  const mimeType = getMimeType(fileName);
  const blob = new Blob([fileData], { type: mimeType });

  // Upload to R2
  await storage.set(fileName, blob);

  console.log(`File uploaded: ${fileName} (${blob.size} bytes)`);
  
  return { fileName, size: blob.size, type: mimeType };
}

// ============================================================================
// 6. Store JSON Data in R2
// ============================================================================

export async function storeJsonInR2() {
  const storage = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'data',
  });

  const data = {
    users: [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
    ],
    updatedAt: new Date().toISOString(),
  };

  // R2 adapter auto-detects JSON and sets correct content-type
  await storage.set('users.json', data);

  // Get it back (auto-parsed)
  const retrieved = await storage.get('users.json');
  console.log('Retrieved:', retrieved);
  
  return retrieved;
}

// ============================================================================
// 7. List Files in R2
// ============================================================================

export async function listR2Files() {
  const storage = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'images',
  });

  // List all files
  const allFiles = await storage.keys('');
  
  // List files with prefix
  const photoFiles = await storage.keys('photo-');
  
  console.log(`Total files: ${allFiles.length}`);
  console.log(`Photo files: ${photoFiles.length}`);
  
  return { allFiles, photoFiles };
}

// ============================================================================
// 8. Hybrid Storage: Metadata in D1, Files in R2
// ============================================================================

export async function hybridFileStorage() {
  const metadata = createCloudflareD1Adapter({
    ...getCloudflareConfig(),
    table: 'file_metadata',
  });

  const files = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'user-files',
  });

  // Upload file to R2
  const imageUrl = 'https://example.com/avatar.png';
  const response = await fetch(imageUrl);
  const imageBlob = await response.blob();
  const fileName = `avatar-${Date.now()}.png`;
  
  await files.set(fileName, imageBlob);

  // Store metadata in D1
  await metadata.set(`file:${fileName}`, {
    fileName,
    size: imageBlob.size,
    mimeType: imageBlob.type,
    uploadedAt: new Date().toISOString(),
    uploadedBy: 'user-123',
  });

  console.log(`File stored with metadata: ${fileName}`);
  
  return { fileName, size: imageBlob.size };
}

// ============================================================================
// 9. Download and Transform Image
// ============================================================================

export async function downloadAndTransformImage(imageKey: string) {
  const storage = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'images',
  });

  // Get image from R2
  const imageBlob = await storage.get(imageKey);
  
  if (!imageBlob) {
    throw new Error(`Image not found: ${imageKey}`);
  }

  // Convert blob to ArrayBuffer (for processing)
  const arrayBuffer = await imageBlob.arrayBuffer();
  
  console.log(`Downloaded: ${imageKey}`);
  console.log(`Size: ${arrayBuffer.byteLength} bytes`);
  console.log(`Type: ${imageBlob.type}`);
  
  // You could now process the image with an image library
  // For example: resize, crop, convert format, etc.
  
  return {
    key: imageKey,
    size: arrayBuffer.byteLength,
    type: imageBlob.type,
  };
}

// ============================================================================
// 10. Batch Upload Multiple Images
// ============================================================================

export async function batchUploadImages(imageUrls: string[]) {
  const storage = createCloudflareR2Adapter({
    ...getCloudflareConfig(),
    scope: 'gallery',
  });

  const results = [];

  for (const url of imageUrls) {
    const response = await fetch(url);
    const blob = await response.blob();
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${getExtensionFromMime(blob.type)}`;
    
    await storage.set(fileName, blob);
    
    results.push({
      url,
      fileName,
      size: blob.size,
      type: blob.type,
    });
  }

  console.log(`Uploaded ${results.length} images`);
  
  return results;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'pdf': 'application/pdf',
    'json': 'application/json',
    'txt': 'text/plain',
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

function getExtensionFromMime(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return extensions[mimeType] || 'bin';
}

// ============================================================================
// Example Usage
// ============================================================================

if (import.meta.main) {
  console.log('=== Cloudflare Adapter Examples ===\n');

  // Test KV cache
  console.log('1. Testing KV cache...');
  await cacheApiResponse();

  // Test sessions
  console.log('\n2. Testing sessions...');
  await manageSession();

  // Test D1 storage
  console.log('\n3. Testing D1 storage...');
  await storeUserData();

  // Test R2 image upload
  console.log('\n4. Testing R2 image upload...');
  await uploadImageToR2();

  // Test R2 JSON storage
  console.log('\n5. Testing R2 JSON storage...');
  await storeJsonInR2();

  // Test listing R2 files
  console.log('\n6. Testing R2 file listing...');
  await listR2Files();

  // Test hybrid storage
  console.log('\n7. Testing hybrid storage...');
  await hybridFileStorage();

  console.log('\n✅ All examples completed!');
}

