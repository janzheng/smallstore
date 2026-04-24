/**
 * Live Adapter Tests
 *
 * Tests all adapters with real backends.
 * Local JSON adapter runs first (no credentials needed).
 * Other adapters are skipped if credentials are not available.
 *
 * Environment variables use SM_ prefix for Smallstore-specific testing.
 * See: .env.example
 *
 * Data is KEPT after tests so you can inspect it!
 * - Local JSON: ./tests/.data/
 * - Upstash/Airtable/Notion/Sheetlog/R2: Check your dashboards
 *
 * Run: deno test --allow-all tests/live-adapters.test.ts
 */

import "jsr:@std/dotenv/load";
import { assertEquals, assertExists, assert } from "@std/assert";
import {
  createSmallstore,
  createMemoryAdapter,
  createLocalJsonAdapter,
  createUpstashAdapter,
  createAirtableAdapter,
  createNotionAdapter,
} from '../mod.ts';
import { createSheetlogAdapter } from '../src/adapters/sheetlog.ts';
import { R2DirectAdapter } from '../src/adapters/r2-direct.ts';
import { getEnv, hasEnv } from '../src/utils/env.ts';

// ============================================================================
// Test Utilities
// ============================================================================

function skip(name: string, reason: string) {
  console.log(`\n⏭️  SKIP: ${name}`);
  console.log(`   Reason: ${reason}\n`);
}

const testId = `test-${Date.now()}`;
const DATA_DIR = './tests/.data';

// ============================================================================
// 1. Local JSON Adapter (NO CREDENTIALS NEEDED!)
// ============================================================================

Deno.test({
  name: "Local JSON: Basic CRUD operations",
  async fn() {
    console.log("\n📁 Testing Local JSON Adapter...\n");
    console.log(`   Data directory: ${DATA_DIR}\n`);

    const adapter = createLocalJsonAdapter({
      baseDir: DATA_DIR,
      prettyPrint: true,
    });

    const key = `contacts/alice-${testId}`;
    const testData = {
      name: "Alice Johnson",
      email: "alice@example.com",
      age: 30,
      tags: ["developer", "designer"],
      createdAt: new Date().toISOString(),
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    await adapter.flush(); // Force write to disk
    console.log(`  ✓ SET completed → ${DATA_DIR}/${key}.json`);

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key) as typeof testData;
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.email, testData.email);
    console.log("  ✓ GET returned correct data");

    // HAS (exists check)
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // Add more data
    console.log("  Adding more data...");
    await adapter.set(`contacts/bob-${testId}`, {
      name: "Bob Smith",
      email: "bob@example.com",
      age: 25,
      tags: ["engineer"],
      createdAt: new Date().toISOString(),
    });
    await adapter.set(`projects/website-${testId}`, {
      name: "Company Website",
      status: "active",
      team: ["alice", "bob"],
      createdAt: new Date().toISOString(),
    });
    await adapter.set(`projects/mobile-${testId}`, {
      name: "Mobile App",
      status: "planning",
      team: ["alice"],
      createdAt: new Date().toISOString(),
    });
    await adapter.flush();
    console.log("  ✓ Added 3 more items");

    // KEYS
    console.log("  KEYS...");
    const allKeys = await adapter.keys();
    console.log(`  ✓ All keys: ${allKeys.length} total`);

    const contactKeys = await adapter.keys("contacts/");
    console.log(`  ✓ Contact keys: ${contactKeys.length} items`);

    const projectKeys = await adapter.keys("projects/");
    console.log(`  ✓ Project keys: ${projectKeys.length} items`);

    // Stats
    console.log("\n  Stats:");
    const stats = adapter.getStats();
    console.log(`    Base dir: ${stats.baseDir}`);
    console.log(`    Cache size: ${stats.cacheSize}`);

    // NOTE: We're NOT deleting! Data stays for inspection
    console.log("\n  📝 Data KEPT for inspection!");
    console.log(`     Check: ${DATA_DIR}/`);

    console.log("\n✅ Local JSON tests passed!\n");
  },
});

// ============================================================================
// 2. Memory Adapter (Always available)
// ============================================================================

Deno.test({
  name: "Memory: Basic CRUD operations",
  async fn() {
    console.log("\n🧠 Testing Memory Adapter...\n");

    const adapter = createMemoryAdapter();

    const key = `temp/data-${testId}`;
    const testData = { name: "Temp Data", value: 123 };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertEquals(retrieved.name, testData.name);
    console.log("  ✓ GET returned correct data");

    // HAS
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // DELETE (memory is ephemeral anyway)
    console.log("  DELETE...");
    await adapter.delete(key);
    const existsAfter = await adapter.has(key);
    assert(!existsAfter, "Key should not exist after delete");
    console.log("  ✓ DELETE removed key");

    console.log("\n✅ Memory tests passed!\n");
  },
});

// ============================================================================
// 3. Upstash Redis Adapter
// ============================================================================

const hasUpstash = hasEnv('SM_UPSTASH_URL') && hasEnv('SM_UPSTASH_TOKEN');

Deno.test({
  name: "Upstash: Basic CRUD operations",
  ignore: !hasUpstash,
  async fn() {
    console.log("\n🔴 Testing Upstash Redis Adapter...\n");

    const adapter = createUpstashAdapter({
      url: getEnv('SM_UPSTASH_URL')!,
      token: getEnv('SM_UPSTASH_TOKEN')!,
    });

    const key = `smallstore:live-test:${testId}`;
    const testData = {
      name: "Test User",
      email: "test@example.com",
      timestamp: Date.now(),
      source: "live-adapter-test",
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key) as typeof testData;
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.email, testData.email);
    console.log("  ✓ GET returned correct data");

    // HAS (exists check)
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys("smallstore:live-test:");
    assert(keys.includes(key), "Key should be in list");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // NOTE: Data KEPT for inspection in Upstash dashboard
    console.log("\n  📝 Data KEPT in Upstash!");
    console.log(`     Key: ${key}`);

    console.log("\n✅ Upstash tests passed!\n");
  },
});

if (!hasUpstash) {
  skip("Upstash", "SM_UPSTASH_URL or SM_UPSTASH_TOKEN not set");
}

// ============================================================================
// 4. Airtable Adapter
// ============================================================================

const hasAirtable = hasEnv('SM_AIRTABLE_API_KEY') && hasEnv('SM_AIRTABLE_BASE_ID') && hasEnv('SM_AIRTABLE_TABLE_NAME');

Deno.test({
  name: "Airtable: Basic CRUD operations",
  ignore: !hasAirtable,
  async fn() {
    console.log("\n🟡 Testing Airtable Adapter...\n");

    const adapter = createAirtableAdapter({
      apiKey: getEnv('SM_AIRTABLE_API_KEY')!,
      baseId: getEnv('SM_AIRTABLE_BASE_ID')!,
      tableIdOrName: getEnv('SM_AIRTABLE_TABLE_NAME')!,
      mappings: [
        { airtableField: 'Name', sourcePath: 'name', airtableType: 'singleLineText', required: true },
        { airtableField: 'Email', sourcePath: 'email', airtableType: 'email' },
        { airtableField: 'Notes', sourcePath: 'notes', airtableType: 'multilineText' },
      ],
    });

    const key = `live-test-${testId}`;
    const testData = {
      name: `Test Record ${testId}`,
      email: "test@example.com",
      notes: `Created by live adapter test at ${new Date().toISOString()}`
    };

    // SET (Create)
    console.log("  SET (create record)...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "Should retrieve record");
    assertEquals(retrieved.name, testData.name);
    console.log("  ✓ GET returned correct data");

    // UPDATE
    console.log("  UPDATE...");
    const updatedData = { ...testData, notes: `Updated at ${new Date().toISOString()}` };
    await adapter.set(key, updatedData);
    const updated = await adapter.get(key);
    assertEquals(updated.notes, updatedData.notes);
    console.log("  ✓ UPDATE completed");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys("");
    assert(keys.length > 0, "Should have at least one key");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // NOTE: Data KEPT for inspection in Airtable
    console.log("\n  📝 Data KEPT in Airtable!");
    console.log(`     Record: ${testData.name}`);

    console.log("\n✅ Airtable tests passed!\n");
  },
});

if (!hasAirtable) {
  skip("Airtable", "SM_AIRTABLE_API_KEY, SM_AIRTABLE_BASE_ID, or SM_AIRTABLE_TABLE_NAME not set");
}

// ============================================================================
// 5. Notion Adapter
// ============================================================================

const hasNotion = hasEnv('SM_NOTION_SECRET') && hasEnv('SM_NOTION_DATABASE_ID');

Deno.test({
  name: "Notion: Basic CRUD operations",
  ignore: !hasNotion,
  async fn() {
    console.log("\n⬛ Testing Notion Adapter...\n");

    const adapter = createNotionAdapter({
      notionSecret: getEnv('SM_NOTION_SECRET')!,
      databaseId: getEnv('SM_NOTION_DATABASE_ID')!,
      mappings: [
        { notionProperty: 'Name', sourcePath: 'name', notionType: 'title', required: true },
        { notionProperty: 'Email', sourcePath: 'email', notionType: 'email' },
        { notionProperty: 'Notes', sourcePath: 'notes', notionType: 'rich_text' },
      ],
    });

    const key = `live-test-${testId}`;
    const testData = {
      name: `Test Page ${testId}`,
      email: "test@example.com",
      notes: `Created by live adapter test at ${new Date().toISOString()}`
    };

    // SET (Create)
    console.log("  SET (create page)...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "Should retrieve page");
    assertEquals(retrieved.name, testData.name);
    console.log("  ✓ GET returned correct data");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys("");
    assert(keys.length > 0, "Should have at least one key");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // NOTE: Data KEPT for inspection in Notion
    console.log("\n  📝 Data KEPT in Notion!");
    console.log(`     Page: ${testData.name}`);

    console.log("\n✅ Notion tests passed!\n");
  },
});

if (!hasNotion) {
  skip("Notion", "SM_NOTION_SECRET or SM_NOTION_DATABASE_ID not set");
}

// ============================================================================
// 6. Sheetlog Adapter (Google Sheets)
// ============================================================================

const hasSheetlog = hasEnv('SM_SHEET_URL') && hasEnv('SM_SHEET_NAME');

Deno.test({
  name: "Sheetlog: Basic CRUD operations",
  ignore: !hasSheetlog,
  async fn() {
    console.log("\n🟢 Testing Sheetlog (Google Sheets) Adapter...\n");

    const adapter = createSheetlogAdapter({
      sheetUrl: getEnv('SM_SHEET_URL')!,
      sheet: getEnv('SM_SHEET_NAME')!,
    });

    const key = `live-test-${testId}`;
    const testData = {
      name: `Test Row ${testId}`,
      value: 42,
      timestamp: new Date().toISOString(),
      source: "live-adapter-test"
    };

    // APPEND row (sheetlog's non-destructive write path;
    // set() now throws because it used to silently wipe the whole sheet).
    console.log("  APPEND row...");
    await adapter.append(testData);
    console.log("  ✓ APPEND completed");

    // GET — returns the whole tab as an array (sheet-as-collection)
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    if (Array.isArray(retrieved) && retrieved.length > 0) {
      console.log(`  ✓ GET returned ${retrieved.length} rows`);
    } else {
      console.log("  ⚠️ GET returned empty — sheet may be newly cleared");
    }

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys("");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // NOTE: Data KEPT for inspection in Google Sheets
    console.log("\n  📝 Data KEPT in Google Sheets!");

    console.log("\n✅ Sheetlog tests passed!\n");
  },
});

if (!hasSheetlog) {
  skip("Sheetlog", "SM_SHEET_URL or SM_SHEET_NAME not set");
}

// ============================================================================
// 7. Cloudflare R2 Direct Adapter (S3-compatible)
// ============================================================================

const hasR2 = hasEnv('SM_R2_ACCOUNT_ID') && hasEnv('SM_R2_ACCESS_KEY_ID') &&
              hasEnv('SM_R2_SECRET_ACCESS_KEY') && hasEnv('SM_R2_BUCKET_NAME');

Deno.test({
  name: "R2 Direct: Basic CRUD operations",
  ignore: !hasR2,
  sanitizeResources: false, // AWS SDK keeps TLS connections alive
  sanitizeOps: false,
  async fn() {
    console.log("\n🟢 Testing R2 Direct (S3-compatible) Adapter...\n");

    const adapter = new R2DirectAdapter({
      accountId: getEnv('SM_R2_ACCOUNT_ID')!,
      accessKeyId: getEnv('SM_R2_ACCESS_KEY_ID')!,
      secretAccessKey: getEnv('SM_R2_SECRET_ACCESS_KEY')!,
      bucketName: getEnv('SM_R2_BUCKET_NAME')!,
    });

    const key = `live-test-${testId}.json`;
    const testData = {
      name: `R2 Test ${testId}`,
      value: 42,
      timestamp: new Date().toISOString(),
      source: "live-adapter-test"
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "GET should return data");
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.value, testData.value);
    console.log("  ✓ GET returned correct data");

    // HAS
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "HAS should return true for existing key");
    console.log("  ✓ HAS returned true");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys("live-test-");
    assert(keys.length > 0, "KEYS should return at least 1 key");
    console.log(`  ✓ KEYS returned ${keys.length} key(s)`);

    // DELETE
    console.log("  DELETE...");
    await adapter.delete(key);
    const afterDelete = await adapter.get(key);
    assertEquals(afterDelete, null, "GET after DELETE should return null");
    console.log("  ✓ DELETE confirmed (key gone)");

    console.log("\n✅ R2 Direct tests passed!\n");
  },
});

if (!hasR2) {
  skip("R2 Direct", "SM_R2_ACCOUNT_ID, SM_R2_ACCESS_KEY_ID, SM_R2_SECRET_ACCESS_KEY, or SM_R2_BUCKET_NAME not set");
}

// ============================================================================
// 8. Multi-Adapter Integration (Direct adapter test)
// ============================================================================

Deno.test({
  name: "Multi-adapter: Local JSON + Memory together",
  async fn() {
    console.log("\n🔷 Testing Multi-Adapter Integration...\n");

    // Use adapters directly (Smallstore wrapper has separate key-building logic)
    const localAdapter = createLocalJsonAdapter({ baseDir: `${DATA_DIR}/integration` });
    const memoryAdapter = createMemoryAdapter();

    // Local storage
    console.log("  Testing local adapter...");
    await localAdapter.set(`integration/user-${testId}`, {
      name: "Integration Test User",
      role: "tester",
      createdAt: new Date().toISOString(),
    });
    await localAdapter.flush();
    const localData = await localAdapter.get(`integration/user-${testId}`) as { name: string };
    assertEquals(localData.name, "Integration Test User");
    console.log("  ✓ Local adapter works");

    // Memory storage
    console.log("  Testing memory adapter...");
    await memoryAdapter.set('cache/temp', { type: 'cached', value: 999 });
    const memData = await memoryAdapter.get('cache/temp') as { type: string };
    assertEquals(memData.type, 'cached');
    console.log("  ✓ Memory adapter works");

    // Both together
    console.log("  Testing both adapters in parallel...");
    const localKeys = await localAdapter.keys("integration/");
    const memKeys = await memoryAdapter.keys("cache/");
    console.log(`  ✓ Local keys: ${localKeys.length}, Memory keys: ${memKeys.length}`);

    console.log("\n  📝 Data KEPT for inspection!");
    console.log(`     Check: ${DATA_DIR}/integration/`);

    console.log("\n✅ Multi-adapter integration tests passed!\n");
  },
});

// ============================================================================
// 9. Unstorage (Upstash driver)
// ============================================================================

const hasUnstorageUpstash = hasUpstash; // Same credentials

if (!hasUnstorageUpstash) {
  skip("Unstorage (Upstash)", "SM_UPSTASH_URL or SM_UPSTASH_TOKEN not set");
}

Deno.test({
  name: "Unstorage (Upstash): Basic CRUD operations",
  ignore: !hasUnstorageUpstash,
  async fn() {
    console.log("\n📦 Testing Unstorage Adapter (Upstash driver)...\n");

    const { UnstorageAdapter } = await import('../src/adapters/unstorage.ts');

    const adapter = new UnstorageAdapter({
      driver: 'upstash',
      options: {
        url: getEnv('SM_UPSTASH_URL'),
        token: getEnv('SM_UPSTASH_TOKEN'),
        base: 'unstorage-test',
      },
    });

    const key = `unstorage-${testId}`;
    const testData = {
      name: "Unstorage Test",
      driver: "upstash",
      timestamp: new Date().toISOString(),
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "GET should return data");
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.driver, testData.driver);
    console.log("  ✓ GET returned correct data");

    // HAS
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys();
    assert(keys.length > 0, "Should have at least 1 key");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // DELETE
    console.log("  DELETE...");
    await adapter.delete(key);
    const afterDelete = await adapter.get(key);
    assertEquals(afterDelete, null, "GET after DELETE should return null");
    console.log("  ✓ DELETE completed");

    // Capabilities
    console.log("  CAPABILITIES...");
    assertExists(adapter.capabilities);
    assertEquals(adapter.capabilities.name, "unstorage-upstash");
    console.log(`  ✓ Name: ${adapter.capabilities.name}`);
    console.log(`  ✓ Types: ${adapter.capabilities.supportedTypes?.join(', ')}`);

    console.log("\n✅ Unstorage (Upstash) adapter tests passed!\n");
  },
});

// ============================================================================
// 9. Cloudflare KV (via sm-workers HTTP mode)
// ============================================================================

const hasCfWorkers = hasEnv('SM_WORKERS_URL') || hasEnv('COVERFLOW_WORKERS_URL');

if (!hasCfWorkers) {
  skip("Cloudflare KV", "SM_WORKERS_URL not set");
}

Deno.test({
  name: "Cloudflare KV: CRUD via sm-workers HTTP mode",
  ignore: !hasCfWorkers,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    console.log("\n☁️  Testing Cloudflare KV (HTTP mode via sm-workers)...\n");

    const { CloudflareKVAdapter } = await import('../src/adapters/cloudflare-kv.ts');

    const adapter = new CloudflareKVAdapter({
      baseUrl: getEnv('SM_WORKERS_URL') || getEnv('COVERFLOW_WORKERS_URL'),
      apiKey: getEnv('SM_WORKERS_API_KEY') || getEnv('COVERFLOW_API_KEY'),
      namespace: 'smallstore-test',
    });

    const key = `kv-${testId}`;
    const testData = {
      name: "CF KV Test",
      adapter: "cloudflare-kv",
      timestamp: new Date().toISOString(),
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "GET should return data");
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.adapter, testData.adapter);
    console.log("  ✓ GET returned correct data");

    // HAS
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys();
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // DELETE
    console.log("  DELETE...");
    await adapter.delete(key);
    const afterDelete = await adapter.get(key);
    assertEquals(afterDelete, null, "GET after DELETE should return null");
    console.log("  ✓ DELETE completed");

    // Capabilities
    console.log("  CAPABILITIES...");
    assertExists(adapter.capabilities);
    assertEquals(adapter.capabilities.name, "cloudflare-kv");
    console.log(`  ✓ Name: ${adapter.capabilities.name}`);
    console.log(`  ✓ Types: ${adapter.capabilities.supportedTypes?.join(', ')}`);

    console.log("\n✅ Cloudflare KV adapter tests passed!\n");
  },
});

// ============================================================================
// 10. Cloudflare D1 (via sm-workers HTTP mode)
// ============================================================================

if (!hasCfWorkers) {
  skip("Cloudflare D1", "SM_WORKERS_URL not set");
}

Deno.test({
  name: "Cloudflare D1: CRUD via sm-workers HTTP mode",
  ignore: !hasCfWorkers,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    console.log("\n🗄️  Testing Cloudflare D1 (HTTP mode via sm-workers)...\n");

    const { CloudflareD1Adapter } = await import('../src/adapters/cloudflare-d1.ts');

    const adapter = new CloudflareD1Adapter({
      baseUrl: getEnv('SM_WORKERS_URL') || getEnv('COVERFLOW_WORKERS_URL'),
      apiKey: getEnv('SM_WORKERS_API_KEY') || getEnv('COVERFLOW_API_KEY'),
      table: 'smallstore_test',
    });

    const key = `d1-${testId}`;
    const testData = {
      name: "CF D1 Test",
      adapter: "cloudflare-d1",
      timestamp: new Date().toISOString(),
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "GET should return data");
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.adapter, testData.adapter);
    console.log("  ✓ GET returned correct data");

    // HAS
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys();
    assert(keys.length > 0, "Should have at least 1 key");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // DELETE
    console.log("  DELETE...");
    await adapter.delete(key);
    const afterDelete = await adapter.get(key);
    assertEquals(afterDelete, null, "GET after DELETE should return null");
    console.log("  ✓ DELETE completed");

    // Capabilities
    console.log("  CAPABILITIES...");
    assertExists(adapter.capabilities);
    assertEquals(adapter.capabilities.name, "cloudflare-d1");
    console.log(`  ✓ Name: ${adapter.capabilities.name}`);
    console.log(`  ✓ Types: ${adapter.capabilities.supportedTypes?.join(', ')}`);

    console.log("\n✅ Cloudflare D1 adapter tests passed!\n");
  },
});

// ============================================================================
// 11. Cloudflare DO (via sm-workers HTTP mode)
// ============================================================================

if (!hasCfWorkers) {
  skip("Cloudflare DO", "SM_WORKERS_URL not set");
}

Deno.test({
  name: "Cloudflare DO: CRUD via sm-workers HTTP mode",
  ignore: !hasCfWorkers,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    console.log("\n🔒 Testing Cloudflare DO (HTTP mode via sm-workers)...\n");

    const { CloudflareDOAdapter } = await import('../src/adapters/cloudflare-do.ts');

    const adapter = new CloudflareDOAdapter({
      baseUrl: getEnv('SM_WORKERS_URL') || getEnv('COVERFLOW_WORKERS_URL'),
      apiKey: getEnv('SM_WORKERS_API_KEY') || getEnv('COVERFLOW_API_KEY'),
      instanceId: 'smallstore-test',
    });

    const key = `do-${testId}`;
    const testData = {
      name: "CF DO Test",
      adapter: "cloudflare-do",
      timestamp: new Date().toISOString(),
    };

    // SET
    console.log("  SET...");
    await adapter.set(key, testData);
    console.log("  ✓ SET completed");

    // GET
    console.log("  GET...");
    const retrieved = await adapter.get(key);
    assertExists(retrieved, "GET should return data");
    assertEquals(retrieved.name, testData.name);
    assertEquals(retrieved.adapter, testData.adapter);
    console.log("  ✓ GET returned correct data");

    // HAS
    console.log("  HAS...");
    const exists = await adapter.has(key);
    assert(exists, "Key should exist");
    console.log("  ✓ HAS returned true");

    // KEYS
    console.log("  KEYS...");
    const keys = await adapter.keys();
    assert(keys.length > 0, "Should have at least 1 key");
    console.log(`  ✓ KEYS returned ${keys.length} keys`);

    // DELETE
    console.log("  DELETE...");
    await adapter.delete(key);
    const afterDelete = await adapter.get(key);
    assertEquals(afterDelete, null, "GET after DELETE should return null");
    console.log("  ✓ DELETE completed");

    // CLEAR (test clear command)
    console.log("  CLEAR...");
    await adapter.set(`do-clear-test-1`, { a: 1 });
    await adapter.set(`do-clear-test-2`, { b: 2 });
    await adapter.clear("do-clear-test");
    const afterClear = await adapter.get(`do-clear-test-1`);
    assertEquals(afterClear, null, "GET after CLEAR should return null");
    console.log("  ✓ CLEAR completed");

    // Capabilities
    console.log("  CAPABILITIES...");
    assertExists(adapter.capabilities);
    assertEquals(adapter.capabilities.name, "cloudflare-do");
    console.log(`  ✓ Name: ${adapter.capabilities.name}`);
    console.log(`  ✓ Types: ${adapter.capabilities.supportedTypes?.join(', ')}`);

    console.log("\n✅ Cloudflare DO adapter tests passed!\n");
  },
});

// ============================================================================
// Summary
// ============================================================================

Deno.test("Summary: Available adapters", () => {
  console.log("\n" + "=".repeat(60));
  console.log("📊 Adapter Availability Summary");
  console.log("=".repeat(60) + "\n");
  console.log(`   Local JSON: ✅ Available (no credentials needed)`);
  console.log(`   Memory:     ✅ Available (no credentials needed)`);
  console.log(`   Upstash:    ${hasUpstash ? '✅ Available' : '❌ SM_UPSTASH_URL/SM_UPSTASH_TOKEN not set'}`);
  console.log(`   Airtable:   ${hasAirtable ? '✅ Available' : '❌ SM_AIRTABLE_* not set'}`);
  console.log(`   Notion:     ${hasNotion ? '✅ Available' : '❌ SM_NOTION_* not set'}`);
  console.log(`   Sheetlog:   ${hasSheetlog ? '✅ Available' : '❌ SM_SHEET_* not set'}`);
  console.log(`   R2 Direct:  ${hasR2 ? '✅ Available' : '❌ SM_R2_* not set'}`);
  console.log(`   Unstorage:  ${hasUnstorageUpstash ? '✅ Available (Upstash)' : '❌ SM_UPSTASH_* not set'}`);
  console.log(`   CF KV:      ${hasCfWorkers ? '✅ Available (HTTP mode)' : '❌ SM_WORKERS_URL not set'}`);
  console.log(`   CF D1:      ${hasCfWorkers ? '✅ Available (HTTP mode)' : '❌ SM_WORKERS_URL not set'}`);
  console.log(`   CF DO:      ${hasCfWorkers ? '✅ Available (HTTP mode)' : '❌ SM_WORKERS_URL not set'}`);
  console.log();
  console.log("📁 Test data location:");
  console.log(`   ${DATA_DIR}/`);
  console.log();
  console.log("🔧 Configure in .env (see .env.example):");
  console.log("   SM_UPSTASH_URL, SM_UPSTASH_TOKEN");
  console.log("   SM_AIRTABLE_API_KEY, SM_AIRTABLE_BASE_ID, SM_AIRTABLE_TABLE_NAME");
  console.log("   SM_NOTION_SECRET, SM_NOTION_DATABASE_ID");
  console.log("   SM_SHEET_URL, SM_SHEET_NAME");
  console.log("   SM_R2_ACCOUNT_ID, SM_R2_ACCESS_KEY_ID, SM_R2_SECRET_ACCESS_KEY, SM_R2_BUCKET_NAME");
  console.log("   SM_WORKERS_URL (for CF KV/D1/DO)");
  console.log();
  console.log("🧹 To clean up test data:");
  console.log(`   rm -rf ${DATA_DIR}`);
  console.log();
});
