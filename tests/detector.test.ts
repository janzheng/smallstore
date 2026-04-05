/**
 * Data Detector Tests
 *
 * Verifies: detectDataType, analyzeData, calculateSize, formatSize
 */

import { assertEquals, assertExists } from "@std/assert";
import { analyzeData, detectDataType, calculateSize, formatSize } from '../src/detector.ts';

// ── detectDataType ──────────────────────────────────────────

Deno.test("detectDataType: string → kv", () => {
  assertEquals(detectDataType("hello"), "kv");
});

Deno.test("detectDataType: number → kv", () => {
  assertEquals(detectDataType(42), "kv");
});

Deno.test("detectDataType: boolean → kv", () => {
  assertEquals(detectDataType(true), "kv");
});

Deno.test("detectDataType: null → kv", () => {
  assertEquals(detectDataType(null), "kv");
});

Deno.test("detectDataType: object → object", () => {
  assertEquals(detectDataType({ name: "test" }), "object");
});

Deno.test("detectDataType: array → object", () => {
  assertEquals(detectDataType([1, 2, 3]), "object");
});

Deno.test("detectDataType: nested object → object", () => {
  assertEquals(detectDataType({ a: { b: { c: 1 } } }), "object");
});

Deno.test("detectDataType: Uint8Array → blob", () => {
  assertEquals(detectDataType(new Uint8Array([1, 2, 3])), "blob");
});

Deno.test("detectDataType: ArrayBuffer → blob", () => {
  assertEquals(detectDataType(new ArrayBuffer(8)), "blob");
});

// ── calculateSize ───────────────────────────────────────────

Deno.test("calculateSize: null → 0", () => {
  assertEquals(calculateSize(null), 0);
});

Deno.test("calculateSize: undefined → 0", () => {
  assertEquals(calculateSize(undefined), 0);
});

Deno.test("calculateSize: string → length * 1.2", () => {
  assertEquals(calculateSize("hello"), 6); // 5 * 1.2
});

Deno.test("calculateSize: number → 8", () => {
  assertEquals(calculateSize(42), 8);
});

Deno.test("calculateSize: boolean → 8", () => {
  assertEquals(calculateSize(true), 8);
});

Deno.test("calculateSize: Uint8Array → byteLength", () => {
  assertEquals(calculateSize(new Uint8Array(100)), 100);
});

Deno.test("calculateSize: object → JSON length * 1.2", () => {
  const obj = { name: "test" };
  const expected = JSON.stringify(obj).length * 1.2;
  assertEquals(calculateSize(obj), expected);
});

// ── formatSize ──────────────────────────────────────────────

Deno.test("formatSize: 0 → '0 B'", () => {
  assertEquals(formatSize(0), "0 B");
});

Deno.test("formatSize: bytes", () => {
  assertEquals(formatSize(100), "100 B");
});

Deno.test("formatSize: kilobytes", () => {
  assertEquals(formatSize(1024), "1.0 KB");
});

Deno.test("formatSize: megabytes", () => {
  assertEquals(formatSize(1024 * 1024), "1.0 MB");
});

Deno.test("formatSize: gigabytes", () => {
  assertEquals(formatSize(1024 * 1024 * 1024), "1.0 GB");
});

Deno.test("formatSize: fractional KB", () => {
  assertEquals(formatSize(1536), "1.5 KB");
});

// ── analyzeData (integration) ───────────────────────────────

Deno.test("analyzeData: string returns kv type", () => {
  const result = analyzeData("hello world");
  assertEquals(result.type, "kv");
  assertExists(result.sizeBytes);
  assertExists(result.size);
  assertExists(result.recommendedAdapter);
});

Deno.test("analyzeData: object returns object type", () => {
  const result = analyzeData({ name: "test", age: 30 });
  assertEquals(result.type, "object");
  assertEquals(result.recommendedAdapter, "memory");
});

Deno.test("analyzeData: array includes itemCount", () => {
  const result = analyzeData([1, 2, 3, 4, 5]);
  assertEquals(result.type, "object");
  assertEquals(result.itemCount, 5);
});

Deno.test("analyzeData: Uint8Array returns blob type", () => {
  const result = analyzeData(new Uint8Array(1024));
  assertEquals(result.type, "blob");
  assertEquals(result.sizeBytes, 1024);
  assertEquals(result.recommendedAdapter, "memory");
});

Deno.test("analyzeData: small kv recommends upstash", () => {
  const result = analyzeData("small value");
  assertEquals(result.type, "kv");
  assertEquals(result.recommendedAdapter, "upstash");
});
