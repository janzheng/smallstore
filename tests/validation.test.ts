/**
 * Input Validation & Filtering Tests
 */

import { assertEquals, assertRejects } from "@std/assert";
import { processInput, validateInput, transformInput } from "../mod.ts";

// ============================================================================
// validateInput — strict mode
// ============================================================================

Deno.test("validateInput strict - valid string passes", async () => {
  const result = await validateInput("hello", {
    schema: { type: "string" },
    mode: "strict",
  });
  assertEquals(result, "hello");
});

Deno.test("validateInput strict - wrong type throws", async () => {
  await assertRejects(() =>
    validateInput(42, { schema: { type: "string" }, mode: "strict" })
  );
});

Deno.test("validateInput strict - string minLength/maxLength", async () => {
  await assertRejects(() =>
    validateInput("hi", { schema: { type: "string", minLength: 5 }, mode: "strict" })
  );
  await assertRejects(() =>
    validateInput("toolong", { schema: { type: "string", maxLength: 3 }, mode: "strict" })
  );
});

Deno.test("validateInput strict - string pattern", async () => {
  const result = await validateInput("abc123", {
    schema: { type: "string", pattern: "^[a-z]+\\d+$" },
    mode: "strict",
  });
  assertEquals(result, "abc123");

  await assertRejects(() =>
    validateInput("NOPE", { schema: { type: "string", pattern: "^[a-z]+$" }, mode: "strict" })
  );
});

Deno.test("validateInput strict - email format", async () => {
  await validateInput("test@example.com", {
    schema: { type: "string", format: "email" },
    mode: "strict",
  });
  await assertRejects(() =>
    validateInput("not-an-email", { schema: { type: "string", format: "email" }, mode: "strict" })
  );
});

Deno.test("validateInput strict - number min/max", async () => {
  await validateInput(5, { schema: { type: "number", minimum: 0, maximum: 10 }, mode: "strict" });
  await assertRejects(() =>
    validateInput(-1, { schema: { type: "number", minimum: 0 }, mode: "strict" })
  );
});

Deno.test("validateInput strict - integer rejects float", async () => {
  await assertRejects(() =>
    validateInput(3.14, { schema: { type: "integer" }, mode: "strict" })
  );
  await validateInput(3, { schema: { type: "integer" }, mode: "strict" });
});

Deno.test("validateInput strict - boolean", async () => {
  await validateInput(true, { schema: { type: "boolean" }, mode: "strict" });
  await assertRejects(() =>
    validateInput("true", { schema: { type: "boolean" }, mode: "strict" })
  );
});

Deno.test("validateInput strict - null", async () => {
  await validateInput(null, { schema: { type: "null" }, mode: "strict" });
  await assertRejects(() =>
    validateInput(0, { schema: { type: "null" }, mode: "strict" })
  );
});

Deno.test("validateInput strict - array minItems/maxItems", async () => {
  await assertRejects(() =>
    validateInput([1], { schema: { type: "array", minItems: 2 }, mode: "strict" })
  );
  await assertRejects(() =>
    validateInput([1, 2, 3], { schema: { type: "array", maxItems: 2 }, mode: "strict" })
  );
});

Deno.test("validateInput strict - array items validation", async () => {
  // validateInput iterates array elements and validates each against the schema
  await validateInput([1, 2, 3], {
    schema: { type: "number" },
    mode: "strict",
  });
  await assertRejects(() =>
    validateInput([1, "two", 3], {
      schema: { type: "number" },
      mode: "strict",
    })
  );
});

Deno.test("validateInput strict - object required fields", async () => {
  await assertRejects(() =>
    validateInput({ name: "Alice" }, {
      schema: { type: "object", required: ["name", "email"], properties: { name: { type: "string" }, email: { type: "string" } } },
      mode: "strict",
    })
  );
});

Deno.test("validateInput strict - object additionalProperties false", async () => {
  await assertRejects(() =>
    validateInput({ name: "Alice", extra: true }, {
      schema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
      mode: "strict",
    })
  );
});

Deno.test("validateInput strict - object with property type validation", async () => {
  await assertRejects(() =>
    validateInput({ name: 42 }, {
      schema: { type: "object", properties: { name: { type: "string" } } },
      mode: "strict",
    })
  );
});

Deno.test("validateInput strict - type inferred from properties", async () => {
  // schema has properties but no explicit type — should infer object
  await validateInput({ name: "Alice" }, {
    schema: { properties: { name: { type: "string" } } },
    mode: "strict",
  });
});

Deno.test("validateInput strict - validates array of objects", async () => {
  const data = [{ name: "Alice" }, { name: "Bob" }];
  const result = await validateInput(data, {
    schema: { type: "object", properties: { name: { type: "string" } } },
    mode: "strict",
  });
  assertEquals(result, data);
});

// ============================================================================
// validateInput — sieve mode
// ============================================================================

Deno.test("validateInput sieve - filters invalid items from array", async () => {
  const data = [
    { name: "Alice", age: 30 },
    { name: 42, age: 25 },       // invalid name
    { name: "Carol", age: 28 },
  ];
  const result = await validateInput(data, {
    schema: { type: "object", properties: { name: { type: "string" } } },
    mode: "sieve",
  });
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Alice");
  assertEquals(result[1].name, "Carol");
});

Deno.test("validateInput sieve - returns null for invalid single item", async () => {
  const result = await validateInput(42, {
    schema: { type: "string" },
    mode: "sieve",
  });
  assertEquals(result, null);
});

Deno.test("validateInput sieve - onInvalid callback fires", async () => {
  const invalid: any[] = [];
  await validateInput([1, "two", 3], {
    schema: { type: "number" },
    mode: "sieve",
    onInvalid: (item) => invalid.push(item),
  });
  assertEquals(invalid.length, 1);
  assertEquals(invalid[0], "two");
});

Deno.test("validateInput sieve - empty array stays empty", async () => {
  const result = await validateInput([], {
    schema: { type: "number" },
    mode: "sieve",
  });
  assertEquals(result, []);
});

// ============================================================================
// validateInput — zodSchema
// ============================================================================

Deno.test("validateInput - zodSchema parse works", async () => {
  const mockZod = {
    parse: (item: any) => {
      if (typeof item.name !== "string") throw new Error("invalid");
    },
  };
  await validateInput({ name: "Alice" }, { zodSchema: mockZod, mode: "strict" });
  await assertRejects(() =>
    validateInput({ name: 42 }, { zodSchema: mockZod, mode: "strict" })
  );
});

// ============================================================================
// transformInput — pick
// ============================================================================

Deno.test("transformInput pick - keeps only specified fields", () => {
  const result = transformInput({ a: 1, b: 2, c: 3 }, { pick: ["a", "c"] });
  assertEquals(result, { a: 1, c: 3 });
});

Deno.test("transformInput pick - works on arrays", () => {
  const result = transformInput(
    [{ a: 1, b: 2 }, { a: 3, b: 4 }],
    { pick: ["a"] }
  );
  assertEquals(result, [{ a: 1 }, { a: 3 }]);
});

Deno.test("transformInput pick - missing fields are skipped", () => {
  const result = transformInput({ a: 1 }, { pick: ["a", "z"] });
  assertEquals(result, { a: 1 });
});

Deno.test("transformInput pick - primitives pass through", () => {
  assertEquals(transformInput("hello", { pick: ["a"] }), "hello");
  assertEquals(transformInput(null, { pick: ["a"] }), null);
});

// ============================================================================
// transformInput — omit
// ============================================================================

Deno.test("transformInput omit - removes specified fields", () => {
  const result = transformInput({ a: 1, b: 2, c: 3 }, { omit: ["b"] });
  assertEquals(result, { a: 1, c: 3 });
});

Deno.test("transformInput omit - works on arrays", () => {
  const result = transformInput(
    [{ a: 1, b: 2 }, { a: 3, b: 4 }],
    { omit: ["b"] }
  );
  assertEquals(result, [{ a: 1 }, { a: 3 }]);
});

// ============================================================================
// transformInput — where
// ============================================================================

Deno.test("transformInput where - simple equality", () => {
  const data = [{ name: "Alice" }, { name: "Bob" }, { name: "Alice" }];
  const result = transformInput(data, { where: { name: "Alice" } });
  assertEquals(result.length, 2);
});

Deno.test("transformInput where - $gt operator", () => {
  const data = [{ age: 20 }, { age: 30 }, { age: 40 }];
  const result = transformInput(data, { where: { age: { $gt: 25 } } });
  assertEquals(result.length, 2);
});

Deno.test("transformInput where - $contains on string", () => {
  const data = [{ url: "github.com/foo" }, { url: "gitlab.com/bar" }];
  const result = transformInput(data, { where: { url: { $contains: "github" } } });
  assertEquals(result.length, 1);
});

Deno.test("transformInput where - $contains on array", () => {
  const data = [{ tags: ["ai", "ml"] }, { tags: ["web"] }];
  const result = transformInput(data, { where: { tags: { $contains: "ai" } } });
  assertEquals(result.length, 1);
});

Deno.test("transformInput where - $in operator", () => {
  const data = [{ status: "active" }, { status: "archived" }, { status: "draft" }];
  const result = transformInput(data, { where: { status: { $in: ["active", "draft"] } } });
  assertEquals(result.length, 2);
});

Deno.test("transformInput where - $startsWith/$endsWith", () => {
  const data = [{ name: "Alice" }, { name: "Bob" }, { name: "Anna" }];
  assertEquals(transformInput(data, { where: { name: { $startsWith: "A" } } }).length, 2);
  assertEquals(transformInput(data, { where: { name: { $endsWith: "e" } } }).length, 1);
});

Deno.test("transformInput where - dot notation for nested fields", () => {
  const data = [
    { user: { role: "admin" } },
    { user: { role: "viewer" } },
  ];
  const result = transformInput(data, { where: { "user.role": "admin" } });
  assertEquals(result.length, 1);
});

Deno.test("transformInput where - single item returns null if no match", () => {
  const result = transformInput({ age: 10 }, { where: { age: { $gt: 20 } } });
  assertEquals(result, null);
});

Deno.test("transformInput where - non-object items are filtered out", () => {
  const result = transformInput(["a", "b"], { where: { x: 1 } });
  assertEquals(result, []);
});

// ============================================================================
// transformInput — custom transform
// ============================================================================

Deno.test("transformInput transform - maps single item", () => {
  const result = transformInput({ name: "alice" }, {
    transform: (item: any) => ({ ...item, name: item.name.toUpperCase() }),
  });
  assertEquals(result.name, "ALICE");
});

Deno.test("transformInput transform - maps array items", () => {
  const result = transformInput([1, 2, 3], {
    transform: (n: number) => n * 2,
  });
  assertEquals(result, [2, 4, 6]);
});

// ============================================================================
// transformInput — combined
// ============================================================================

Deno.test("transformInput combined - where + pick", () => {
  const data = [
    { name: "Alice", age: 30, email: "a@b.c" },
    { name: "Bob", age: 20, email: "b@b.c" },
  ];
  const result = transformInput(data, {
    where: { age: { $gte: 25 } },
    pick: ["name", "email"],
  });
  assertEquals(result, [{ name: "Alice", email: "a@b.c" }]);
});

// ============================================================================
// processInput — integration
// ============================================================================

Deno.test("processInput - no options returns data unchanged", async () => {
  const data = { hello: "world" };
  const result = await processInput(data, {});
  assertEquals(result, data);
});

Deno.test("processInput - validate then transform", async () => {
  const data = [
    { name: "Alice", score: 95 },
    { name: 42, score: 80 },     // invalid — sieved out
    { name: "Carol", score: 70 },
  ];
  const result = await processInput(data, {
    inputValidation: {
      schema: { type: "object", properties: { name: { type: "string" } } },
      mode: "sieve",
    },
    inputTransform: {
      pick: ["name"],
    },
  });
  assertEquals(result, [{ name: "Alice" }, { name: "Carol" }]);
});

Deno.test("processInput - validation only", async () => {
  await assertRejects(() =>
    processInput("not a number", {
      inputValidation: { schema: { type: "number" }, mode: "strict" },
    })
  );
});

Deno.test("processInput - transform only", async () => {
  const result = await processInput({ a: 1, b: 2 }, {
    inputTransform: { omit: ["b"] },
  });
  assertEquals(result, { a: 1 });
});

// ============================================================================
// Edge cases
// ============================================================================

Deno.test("validateInput - requires schema or zodSchema", async () => {
  await assertRejects(() =>
    validateInput("data", { mode: "strict" } as any)
  );
});

Deno.test("validateInput - no type + no properties = assume valid", async () => {
  const result = await validateInput("anything", { schema: {}, mode: "strict" });
  assertEquals(result, "anything");
});
