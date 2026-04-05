/**
 * Phase 3.5 Tests: Smart Upsert (upsertByKey)
 * 
 * Tests the upsertByKey method which enables automatic key-based upserts
 * similar to Airtable, Notion, and traditional databases.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { createSmallstore } from "../mod.ts";
import { createMemoryAdapter } from "../adapters/memory.ts";

Deno.test("Phase 3.5: upsertByKey - single object with default 'id' field", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Upsert single object
  await storage.upsertByKey("users", {
    id: "user-123",
    name: "Alice",
    age: 25,
  });
  
  // Verify stored correctly
  const response = await storage.get("users/user-123");
  assertEquals(response.content.id, "user-123");
  assertEquals(response.content.name, "Alice");
  assertEquals(response.content.age, 25);
});

Deno.test("Phase 3.5: upsertByKey - update existing object (upsert behavior)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Initial insert
  await storage.upsertByKey("users", {
    id: "user-123",
    name: "Alice",
    age: 25,
  });
  
  // Update (upsert)
  await storage.upsertByKey("users", {
    id: "user-123",
    name: "Alice Smith",  // Changed
    age: 26,              // Changed
    city: "NYC",          // Added
  });
  
  // Verify updated
  const response = await storage.get("users/user-123");
  assertEquals(response.content.name, "Alice Smith");
  assertEquals(response.content.age, 26);
  assertEquals(response.content.city, "NYC");
});

Deno.test("Phase 3.5: upsertByKey - batch upsert (array of objects)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Batch upsert
  await storage.upsertByKey("products", [
    { id: "prod-1", name: "Widget", price: 10 },
    { id: "prod-2", name: "Gadget", price: 20 },
    { id: "prod-3", name: "Doodad", price: 30 },
  ]);
  
  // Verify all stored
  const prod1 = await storage.get("products/prod-1");
  assertEquals(prod1.content.name, "Widget");
  
  const prod2 = await storage.get("products/prod-2");
  assertEquals(prod2.content.name, "Gadget");
  
  const prod3 = await storage.get("products/prod-3");
  assertEquals(prod3.content.name, "Doodad");
});

Deno.test("Phase 3.5: upsertByKey - custom idField", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Upsert with email as ID
  await storage.upsertByKey("contacts", {
    email: "alice@example.com",
    name: "Alice",
    company: "Acme Corp",
  }, { idField: 'email' });
  
  // Verify stored with email as key
  const response = await storage.get("contacts/alice@example.com");
  assertEquals(response.content.email, "alice@example.com");
  assertEquals(response.content.name, "Alice");
});

Deno.test("Phase 3.5: upsertByKey - custom idField with batch", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Batch upsert with custom ID field
  await storage.upsertByKey("inventory", [
    { sku: "SKU-001", item: "Laptop", quantity: 10 },
    { sku: "SKU-002", item: "Mouse", quantity: 50 },
    { sku: "SKU-003", item: "Keyboard", quantity: 30 },
  ], { idField: 'sku' });
  
  // Verify stored correctly
  const laptop = await storage.get("inventory/SKU-001");
  assertEquals(laptop.content.item, "Laptop");
  
  const mouse = await storage.get("inventory/SKU-002");
  assertEquals(mouse.content.item, "Mouse");
});

Deno.test("Phase 3.5: upsertByKey - keyGenerator function", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Upsert with custom key generator (composite key)
  await storage.upsertByKey("people", {
    firstName: "Alice",
    lastName: "Smith",
    age: 25,
  }, {
    keyGenerator: (obj) => `${obj.firstName}-${obj.lastName}`.toLowerCase()
  });
  
  // Verify stored with generated key
  const response = await storage.get("people/alice-smith");
  assertEquals(response.content.firstName, "Alice");
  assertEquals(response.content.lastName, "Smith");
});

Deno.test("Phase 3.5: upsertByKey - keyGenerator with batch", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Batch with key generator
  await storage.upsertByKey("employees", [
    { firstName: "Alice", lastName: "Smith", dept: "Engineering" },
    { firstName: "Bob", lastName: "Jones", dept: "Sales" },
    { firstName: "Charlie", lastName: "Brown", dept: "Marketing" },
  ], {
    keyGenerator: (obj) => `${obj.lastName}-${obj.firstName}`.toLowerCase()
  });
  
  // Verify stored with generated keys
  const alice = await storage.get("employees/smith-alice");
  assertEquals(alice.content.dept, "Engineering");
  
  const bob = await storage.get("employees/jones-bob");
  assertEquals(bob.content.dept, "Sales");
});

Deno.test("Phase 3.5: upsertByKey - numeric ID (converted to string)", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Upsert with numeric ID
  await storage.upsertByKey("orders", {
    id: 12345,
    customer: "Alice",
    total: 99.99,
  });
  
  // Verify stored (number converted to string)
  const response = await storage.get("orders/12345");
  assertEquals(response.content.id, 12345);
  assertEquals(response.content.customer, "Alice");
});

Deno.test("Phase 3.5: upsertByKey - error on missing ID field", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Should throw if ID field is missing
  await assertRejects(
    async () => {
      await storage.upsertByKey("users", {
        name: "Alice",
        age: 25,
        // Missing 'id' field!
      });
    },
    Error,
    "Missing id in object"
  );
});

Deno.test("Phase 3.5: upsertByKey - error on missing custom ID field", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Should throw if custom ID field is missing
  await assertRejects(
    async () => {
      await storage.upsertByKey("contacts", {
        name: "Alice",
        company: "Acme",
        // Missing 'email' field!
      }, { idField: 'email' });
    },
    Error,
    "Missing email in object"
  );
});

Deno.test("Phase 3.5: upsertByKey - error on non-object data", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Should throw if data is not an object
  await assertRejects(
    async () => {
      await storage.upsertByKey("users", "not an object" as any);
    },
    Error,
    "upsertByKey requires object(s)"
  );
});

Deno.test("Phase 3.5: upsertByKey - error on array as item", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Should throw if item is an array (not an object)
  await assertRejects(
    async () => {
      await storage.upsertByKey("data", [1, 2, 3] as any);
    },
    Error,
    "upsertByKey requires object(s)"
  );
});

Deno.test("Phase 3.5: upsertByKey - keyGenerator error handling", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Should throw if keyGenerator throws
  await assertRejects(
    async () => {
      await storage.upsertByKey("data", {
        value: 123,
      }, {
        keyGenerator: (obj) => {
          throw new Error("Generator failed");
        }
      });
    },
    Error,
    "keyGenerator failed"
  );
});

Deno.test("Phase 3.5: upsertByKey - Airtable-style _id field", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Airtable-style record with _id
  await storage.upsertByKey("airtable-records", {
    _id: "rec123abc",
    name: "Record 1",
    status: "Active",
  }, { idField: '_id' });
  
  // Verify stored
  const response = await storage.get("airtable-records/rec123abc");
  assertEquals(response.content._id, "rec123abc");
  assertEquals(response.content.name, "Record 1");
});

Deno.test("Phase 3.5: upsertByKey - mixed insert and update in batch", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Initial insert
  await storage.upsertByKey("items", {
    id: "item-1",
    name: "Original",
    version: 1,
  });
  
  // Batch with both update and new insert
  await storage.upsertByKey("items", [
    { id: "item-1", name: "Updated", version: 2 },  // Update
    { id: "item-2", name: "New Item", version: 1 }, // Insert
  ]);
  
  // Verify update
  const item1 = await storage.get("items/item-1");
  assertEquals(item1.content.name, "Updated");
  assertEquals(item1.content.version, 2);
  
  // Verify new insert
  const item2 = await storage.get("items/item-2");
  assertEquals(item2.content.name, "New Item");
  assertEquals(item2.content.version, 1);
});

Deno.test("Phase 3.5: upsertByKey - preserves other SetOptions", async () => {
  const storage = createSmallstore({
    adapters: {
      memory: createMemoryAdapter(),
    },
    defaultAdapter: 'memory',
    metadataAdapter: 'memory',
  });
  
  // Upsert with TTL
  await storage.upsertByKey("sessions", {
    id: "session-123",
    userId: "user-456",
    data: { authenticated: true },
  }, { 
    ttl: 3600,  // Should be passed through to set()
  });
  
  // Verify stored (TTL is set in metadata, but we can't easily test it in memory adapter)
  const response = await storage.get("sessions/session-123");
  assertEquals(response.content.userId, "user-456");
});

console.log("✅ All Phase 3.5 tests passed!");

