/**
 * Examples for R2 Direct Adapter (Phase 3.6g)
 * 
 * Demonstrates:
 * - Large dataset storage
 * - Signed upload URLs
 * - Auto-parsing JSON/CSV
 * - Raw mode
 * - S3-compatible operations
 */

import { R2DirectAdapter } from '../r2-direct.ts';
import { getEnv } from '../../utils/env.ts';

async function examples() {
  // Initialize adapter
  const r2 = new R2DirectAdapter({
    accountId: getEnv('R2_ACCOUNT_ID')!,
    accessKeyId: getEnv('R2_ACCESS_KEY_ID')!,
    secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY')!,
    bucketName: R2_BUCKET_NAME!
  });
  
  console.log('📦 R2 Direct Adapter Examples\n');
  
  // ============================================================================
  // Example 1: Store Large JSON Dataset
  // ============================================================================
  
  console.log('Example 1: Store Large JSON Dataset');
  
  const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    name: `Item ${i}`,
    value: Math.random() * 1000,
    timestamp: new Date().toISOString()
  }));
  
  await r2.set('datasets/large.json', largeDataset);
  console.log(`  ✓ Stored ${largeDataset.length} items`);
  
  const retrieved = await r2.get('datasets/large.json');
  console.log(`  ✓ Retrieved ${retrieved.length} items (auto-parsed JSON)`);
  console.log();
  
  // ============================================================================
  // Example 2: CSV Storage with Auto-Parse
  // ============================================================================
  
  console.log('Example 2: CSV Storage with Auto-Parse');
  
  const users = [
    { name: 'Alice', age: 25, role: 'Engineer' },
    { name: 'Bob', age: 30, role: 'Designer' },
    { name: 'Charlie', age: 35, role: 'Manager' }
  ];
  
  await r2.set('data/users.csv', users);
  console.log('  ✓ Stored array as CSV');
  
  const parsedUsers = await r2.get('data/users.csv');
  console.log('  ✓ Retrieved and auto-parsed as array of objects:');
  console.log('   ', parsedUsers[0]);
  console.log();
  
  // ============================================================================
  // Example 3: Raw Mode (No Parsing)
  // ============================================================================
  
  console.log('Example 3: Raw Mode');
  
  const rawCSV = await r2.get('data/users.csv', { raw: true });
  console.log('  ✓ Retrieved raw CSV string:');
  console.log('   ', rawCSV.substring(0, 50) + '...');
  console.log();
  
  // ============================================================================
  // Example 4: Signed Upload URL
  // ============================================================================
  
  console.log('Example 4: Signed Upload URL');
  
  const uploadUrl = await r2.getSignedUploadUrl('uploads/test-file.pdf', {
    expiresIn: 3600,
    maxSize: 10 * 1024 * 1024, // 10MB
    contentType: 'application/pdf'
  });
  
  console.log('  ✓ Generated signed upload URL:');
  console.log('   ', uploadUrl.substring(0, 80) + '...');
  console.log('  → Client can PUT directly to this URL');
  console.log();
  
  // ============================================================================
  // Example 5: Signed Download URL
  // ============================================================================
  
  console.log('Example 5: Signed Download URL');
  
  const downloadUrl = await r2.getSignedDownloadUrl('datasets/large.json', {
    expiresIn: 3600,
    filename: 'my-dataset.json'
  });
  
  console.log('  ✓ Generated signed download URL:');
  console.log('   ', downloadUrl.substring(0, 80) + '...');
  console.log('  → Client can GET directly from this URL');
  console.log();
  
  // ============================================================================
  // Example 6: List Keys
  // ============================================================================
  
  console.log('Example 6: List Keys');
  
  const allKeys = await r2.keys();
  console.log(`  ✓ Found ${allKeys.length} keys in bucket`);
  
  const dataKeys = await r2.keys('data/');
  console.log(`  ✓ Found ${dataKeys.length} keys with prefix "data/"`);
  console.log();
  
  // ============================================================================
  // Example 7: Binary Data (Images, PDFs)
  // ============================================================================
  
  console.log('Example 7: Binary Data');
  
  // Simulate image data
  const imageData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
  
  await r2.set('images/test.png', imageData);
  console.log('  ✓ Stored binary image data');
  
  const exists = await r2.has('images/test.png');
  console.log(`  ✓ File exists: ${exists}`);
  console.log();
  
  // ============================================================================
  // Example 8: Cleanup
  // ============================================================================
  
  console.log('Example 8: Cleanup');
  
  await r2.delete('datasets/large.json');
  await r2.delete('data/users.csv');
  await r2.delete('images/test.png');
  console.log('  ✓ Cleaned up test files');
  console.log();
  
  console.log('✅ All R2 Direct Adapter examples completed!\n');
}

if (import.meta.main) {
  await examples();
}

