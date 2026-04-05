import "jsr:@std/dotenv/load";

const url = Deno.env.get('UPSTASH_REDIS_REST_URL')!;
const token = Deno.env.get('UPSTASH_REDIS_REST_TOKEN')!;

const res = await fetch(`${url}/keys/*`, { 
  headers: { Authorization: `Bearer ${token}` } 
});

const data = await res.json() as any;
console.log('\n📋 ALL Keys in Upstash:\n');
console.log(`Total: ${data.result.length} keys\n`);

// Group by prefix
const byPrefix: Record<string, string[]> = {};
for (const key of data.result) {
  const prefix = key.split(':')[0];
  if (!byPrefix[prefix]) byPrefix[prefix] = [];
  byPrefix[prefix].push(key);
}

for (const [prefix, keys] of Object.entries(byPrefix)) {
  console.log(`📁 ${prefix}:* (${keys.length} keys)`);
  keys.slice(0, 5).forEach(k => console.log(`   - ${k}`));
  if (keys.length > 5) console.log(`   ... and ${keys.length - 5} more`);
  console.log();
}

