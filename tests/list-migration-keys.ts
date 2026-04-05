/**
 * List Migration Test Keys
 * 
 * Shows all keys created by the migration preview
 */

import "jsr:@std/dotenv/load";
import { createUpstashAdapter } from '../mod.ts';

const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL");
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error("❌ Missing credentials!");
  Deno.exit(1);
}

const adapter = createUpstashAdapter({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

console.log("\n📋 Smallstore Keys in Upstash:\n");

const smallstoreKeys = await adapter.keys("smallstore:");
console.log(`Found ${smallstoreKeys.length} Smallstore keys:\n`);
smallstoreKeys.forEach((key: string) => console.log(`   - ${key}`));

console.log("\n📋 View Keys (metadata):\n");
const viewKeys = await adapter.keys("smallstore:views:");
console.log(`Found ${viewKeys.length} view definitions:\n`);
viewKeys.forEach((key: string) => console.log(`   - ${key}`));

console.log("\n");

