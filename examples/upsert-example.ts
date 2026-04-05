/**
 * Phase 3.5 Example: Smart Upsert with upsertByKey()
 * 
 * Demonstrates automatic key-based upserts for object storage.
 * Run: deno run --allow-env --allow-read examples/upsert-example.ts
 */

import { createSmallstore } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapters/memory.ts";

// Create storage instance
const storage = createSmallstore({
  adapters: {
    memory: createMemoryAdapter(),
  },
  defaultAdapter: 'memory',
  metadataAdapter: 'memory',
});

console.log("🔑 Phase 3.5: Smart Upsert Examples\n");

// ============================================================================
// Example 1: Default 'id' field
// ============================================================================

console.log("📝 Example 1: Default 'id' field");
console.log("──────────────────────────────────");

await storage.upsertByKey("users", {
  id: "user-123",
  name: "Alice",
  email: "alice@example.com",
  age: 25
});

console.log("✅ Inserted: users/user-123");

// Update the same user
await storage.upsertByKey("users", {
  id: "user-123",
  name: "Alice Smith",  // Changed
  email: "alice.smith@example.com",  // Changed
  age: 26,  // Changed
  city: "NYC"  // Added
});

const user = await storage.get("users/user-123");
console.log("✅ Updated: users/user-123");
console.log(JSON.stringify(user.content, null, 2));

// ============================================================================
// Example 2: Batch Upsert
// ============================================================================

console.log("\n📝 Example 2: Batch Upsert");
console.log("──────────────────────────────────");

await storage.upsertByKey("products", [
  { id: "prod-1", name: "Widget", price: 10, stock: 100 },
  { id: "prod-2", name: "Gadget", price: 20, stock: 50 },
  { id: "prod-3", name: "Doodad", price: 30, stock: 75 }
]);

console.log("✅ Batch inserted 3 products");

// Update some, insert new
await storage.upsertByKey("products", [
  { id: "prod-1", name: "Widget Pro", price: 15, stock: 120 },  // Update
  { id: "prod-4", name: "Thingamajig", price: 40, stock: 60 }   // New
]);

const allProducts = await storage.getAsJson("products");
console.log(`✅ Total products: ${allProducts.metadata.count}`);

// ============================================================================
// Example 3: Custom ID Field
// ============================================================================

console.log("\n📝 Example 3: Custom ID Field");
console.log("──────────────────────────────────");

await storage.upsertByKey("contacts", [
  { email: "alice@example.com", name: "Alice", company: "Acme" },
  { email: "bob@example.com", name: "Bob", company: "BigCo" },
  { email: "charlie@example.com", name: "Charlie", company: "StartupXYZ" }
], { idField: 'email' });

console.log("✅ Inserted 3 contacts using 'email' as key");

const alice = await storage.get("contacts/alice@example.com");
console.log(`✅ Retrieved: ${alice.content.name} (${alice.content.email})`);

// ============================================================================
// Example 4: Key Generator (Composite Keys)
// ============================================================================

console.log("\n📝 Example 4: Key Generator (Composite Keys)");
console.log("──────────────────────────────────");

await storage.upsertByKey("employees", [
  { firstName: "Alice", lastName: "Smith", dept: "Engineering" },
  { firstName: "Bob", lastName: "Jones", dept: "Sales" },
  { firstName: "Charlie", lastName: "Brown", dept: "Marketing" }
], {
  keyGenerator: (obj) => `${obj.lastName}-${obj.firstName}`.toLowerCase()
});

console.log("✅ Inserted 3 employees with composite keys");

const aliceSmith = await storage.get("employees/smith-alice");
console.log(`✅ Retrieved: ${aliceSmith.content.firstName} ${aliceSmith.content.lastName} (${aliceSmith.content.dept})`);

// ============================================================================
// Example 5: Airtable-Style _id Field
// ============================================================================

console.log("\n📝 Example 5: Airtable-Style _id Field");
console.log("──────────────────────────────────");

// Simulating Airtable records
const airtableRecords = [
  { _id: "rec123abc", name: "Project Alpha", status: "Active", priority: "High" },
  { _id: "rec456def", name: "Project Beta", status: "Planning", priority: "Medium" },
  { _id: "rec789ghi", name: "Project Gamma", status: "Complete", priority: "Low" }
];

await storage.upsertByKey("airtable-data", airtableRecords, { idField: '_id' });

console.log("✅ Synced 3 Airtable records");

const project = await storage.get("airtable-data/rec123abc");
console.log(`✅ Retrieved: ${project.content.name} (Status: ${project.content.status})`);

// ============================================================================
// Example 6: Time-Series Deduplication
// ============================================================================

console.log("\n📝 Example 6: Time-Series Deduplication");
console.log("──────────────────────────────────");

const sensorReadings = [
  { sensorId: "temp-1", timestamp: "2024-11-19T10:00:00Z", value: 72.5 },
  { sensorId: "temp-1", timestamp: "2024-11-19T10:05:00Z", value: 73.2 },
  { sensorId: "temp-2", timestamp: "2024-11-19T10:00:00Z", value: 68.9 },
  { sensorId: "temp-2", timestamp: "2024-11-19T10:05:00Z", value: 69.1 }
];

await storage.upsertByKey("metrics", sensorReadings, {
  keyGenerator: (obj) => `${obj.sensorId}-${obj.timestamp}`
});

console.log("✅ Stored 4 sensor readings with deduplication");

// Try to insert duplicate (will update instead)
await storage.upsertByKey("metrics", {
  sensorId: "temp-1",
  timestamp: "2024-11-19T10:00:00Z",
  value: 72.8  // Updated value
}, {
  keyGenerator: (obj) => `${obj.sensorId}-${obj.timestamp}`
});

const reading = await storage.get("metrics/temp-1-2024-11-19T10:00:00Z");
console.log(`✅ Updated reading: ${reading.content.value} (was 72.5)`);

// ============================================================================
// Example 7: Mixed Types in Collection
// ============================================================================

console.log("\n📝 Example 7: Mixed Types in Collection");
console.log("──────────────────────────────────");

// Inventory items with different ID strategies
await storage.upsertByKey("inventory", [
  { id: "SKU-001", type: "product", name: "Laptop", quantity: 10 },
  { id: "SKU-002", type: "product", name: "Mouse", quantity: 50 }
]);

await storage.upsertByKey("inventory", [
  { sku: "PART-A1", type: "component", name: "Circuit Board", quantity: 100 },
  { sku: "PART-B2", type: "component", name: "Resistor", quantity: 500 }
], { idField: 'sku' });

const inventoryJson = await storage.getAsJson("inventory");
console.log(`✅ Inventory has ${inventoryJson.metadata.count} items (mixed key strategies)`);

// ============================================================================
// Summary
// ============================================================================

console.log("\n🎉 Summary");
console.log("──────────────────────────────────");
console.log("✅ Default 'id' field: Automatic, zero config");
console.log("✅ Batch operations: Efficient bulk upserts");
console.log("✅ Custom fields: Use any field as key");
console.log("✅ Key generators: Composite keys, deduplication");
console.log("✅ External services: Airtable, Notion, APIs");
console.log("✅ Automatic upsert: Insert if new, update if exists");
console.log("\n🔑 Smart Upsert makes object storage simple and natural!");

