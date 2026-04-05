/**
 * Cleanup Migration Test Data
 * 
 * Removes all test data created by test-migration-preview.ts
 * 
 * Run: deno run --allow-env --allow-net --allow-read shared/smallstore/examples/cleanup-migration-test.ts
 */

import "jsr:@std/dotenv/load";
import { createUpstashAdapter } from '../mod.ts';
import { getEnv } from '../src/utils/env.ts';

const UPSTASH_URL = getEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_TOKEN = getEnv('UPSTASH_REDIS_REST_TOKEN');

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error("❌ Missing Upstash credentials!");
  Deno.exit(1);
}

console.log("🧹 Cleaning up migration test data...\n");

const upstashAdapter = createUpstashAdapter({
  url: UPSTASH_URL,
  token: UPSTASH_TOKEN,
});

// Get all test keys
const testKeys = await upstashAdapter.keys("smallstore:migration-test");

if (testKeys.length === 0) {
  console.log("✅ No test data found. Already clean!\n");
  Deno.exit(0);
}

console.log(`Found ${testKeys.length} test keys to delete:\n`);
testKeys.forEach(key => {
  console.log(`   - ${key}`);
});

console.log("\n🗑️  Deleting...\n");

for (const key of testKeys) {
  await upstashAdapter.delete(key);
  console.log(`   ✅ Deleted: ${key}`);
}

console.log("\n✅ Cleanup complete!\n");

