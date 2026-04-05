/**
 * Inspect Migration Data
 * 
 * Shows exactly what was written to Upstash and how to find it in the console
 */

import "jsr:@std/dotenv/load";

const url = Deno.env.get('UPSTASH_REDIS_REST_URL')!;
const token = Deno.env.get('UPSTASH_REDIS_REST_TOKEN')!;

console.log("\n🔍 Inspecting Migration Test Data in Upstash\n");
console.log("=" .repeat(60) + "\n");

// Get all keys
const allKeysRes = await fetch(`${url}/keys/*`, { 
  headers: { Authorization: `Bearer ${token}` } 
});
const allKeysData = await allKeysRes.json() as any;
const allKeys = allKeysData.result as string[];

// Filter for our test keys
const testKeys = allKeys.filter(k => k.includes('migration-test'));

if (testKeys.length === 0) {
  console.log("❌ No migration-test keys found in Upstash!");
  console.log("\nExpected keys with pattern:");
  console.log("   - smallstore:migration-test:*");
  console.log("   - smallstore:views:migration-test:*");
  console.log("\nTrying alternate patterns...\n");
  
  // Try other patterns
  const altPatterns = [
    'migration-test',
    'smallstore',
    'views',
  ];
  
  for (const pattern of altPatterns) {
    const matches = allKeys.filter(k => k.toLowerCase().includes(pattern.toLowerCase()));
    if (matches.length > 0) {
      console.log(`✅ Found ${matches.length} keys matching "${pattern}":`);
      matches.forEach(k => console.log(`   - ${k}`));
      console.log();
    }
  }
  
  console.log("\n📊 All keys in Upstash by prefix:\n");
  const byPrefix: Record<string, number> = {};
  for (const key of allKeys) {
    const prefix = key.split(':')[0];
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
  }
  for (const [prefix, count] of Object.entries(byPrefix).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${prefix}:* - ${count} keys`);
  }
  
  Deno.exit(0);
}

console.log(`✅ Found ${testKeys.length} migration test keys!\n`);

// Read and display each key
for (const key of testKeys) {
  console.log(`📝 Key: ${key}`);
  console.log("-".repeat(60));
  
  // Get the value
  const valueRes = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const valueData = await valueRes.json() as any;
  const value = valueData.result;
  
  // Parse if string
  let parsedValue = value;
  if (typeof value === 'string') {
    try {
      parsedValue = JSON.parse(value);
    } catch {
      // Not JSON
    }
  }
  
  // Show preview
  const preview = JSON.stringify(parsedValue, null, 2);
  if (preview.length > 500) {
    console.log(preview.slice(0, 500) + "\n... (truncated)");
  } else {
    console.log(preview);
  }
  
  console.log("\n");
}

console.log("=" .repeat(60));
console.log("\n🎯 In the Upstash Console:");
console.log(`   1. Go to: ${url.replace('//', '//')}  `);
console.log("   2. Look for keys starting with: 'smallstore:migration-test'");
console.log("   3. Or search for: 'migration-test'");
console.log("\n");

