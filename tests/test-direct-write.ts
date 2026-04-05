/**
 * Test Direct Write to Upstash
 * 
 * Write directly to Upstash to verify keys are persisting
 */

import "jsr:@std/dotenv/load";
import { createUpstashAdapter } from './../mod.ts';

const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!;

console.log("\n🔍 Direct Upstash Write Test\n");

const adapter = createUpstashAdapter({
  url: UPSTASH_URL,
  token: UPSTASH_TOKEN,
});

// Write with a simple key
const testKey = "smallstore:migration-test:direct-write";
const testData = {
  message: "Direct write test",
  timestamp: Date.now(),
  data: ["item1", "item2", "item3"]
};

console.log(`📝 Writing to key: ${testKey}`);
console.log(`📦 Data:`, testData);

await adapter.set(testKey, testData);

console.log("✅ Write complete\n");

// Wait a moment
await new Promise(resolve => setTimeout(resolve, 1000));

// Read it back
console.log(`📖 Reading back from: ${testKey}`);
const readBack = await adapter.get(testKey);
console.log("📦 Read back:", readBack);

if (readBack) {
  console.log("\n✅ SUCCESS! Data persisted to Upstash");
} else {
  console.log("\n❌ FAILED! Data not found in Upstash");
}

// Check via direct API call
console.log("\n🔍 Verifying via direct Upstash API...");
const response = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(testKey)}`, {
  headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
});
const apiData = await response.json() as any;
console.log("📦 API response:", apiData);

console.log("\n");

