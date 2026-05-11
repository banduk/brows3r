/**
 * Tests for the JSON/NDJSON worker parser logic.
 *
 * We test `parseJson` and `parseNdjson` directly rather than spawning an
 * actual Worker (not supported in jsdom).
 *
 * Coverage:
 * 1. JSON top-level array → correct headers and rows.
 * 2. JSON top-level non-array → empty result (not tabular).
 * 3. JSON parse error → empty result.
 * 4. JSON truncation → truncated = true.
 * 5. NDJSON: parses each line, collects headers from union.
 * 6. NDJSON: skips malformed lines.
 * 7. NDJSON: truncation.
 * 8. Nested object values → stringified.
 */

import { describe, expect, it } from "vitest";
import { parseJson, parseNdjson } from "../json.worker";

// ---------------------------------------------------------------------------
// JSON tests
// ---------------------------------------------------------------------------

const JSON_ARRAY = JSON.stringify([
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
  { name: "Charlie", age: 35 },
]);

describe("parseJson — top-level array", () => {
  it("extracts headers from first object keys", () => {
    const result = parseJson(JSON_ARRAY, 100);
    expect(result.headers).toContain("name");
    expect(result.headers).toContain("age");
  });

  it("returns correct row data", () => {
    const result = parseJson(JSON_ARRAY, 100);
    expect(result.rows).toHaveLength(3);
    // Find the row for Alice
    const aliceIdx = result.headers.indexOf("name");
    const ageIdx = result.headers.indexOf("age");
    expect(result.rows[0]?.[aliceIdx]).toBe("Alice");
    expect(result.rows[0]?.[ageIdx]).toBe("30");
  });

  it("sets totalRows = array length", () => {
    const result = parseJson(JSON_ARRAY, 100);
    expect(result.totalRows).toBe(3);
  });

  it("sets truncated = false when all fit", () => {
    const result = parseJson(JSON_ARRAY, 100);
    expect(result.truncated).toBe(false);
  });
});

describe("parseJson — non-array top level", () => {
  it("returns empty result for plain object", () => {
    const result = parseJson(JSON.stringify({ key: "value" }), 100);
    expect(result.headers).toHaveLength(0);
    expect(result.rows).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });

  it("returns empty result for string", () => {
    const result = parseJson(JSON.stringify("hello"), 100);
    expect(result.headers).toHaveLength(0);
  });

  it("returns empty result for number", () => {
    const result = parseJson(JSON.stringify(42), 100);
    expect(result.headers).toHaveLength(0);
  });
});

describe("parseJson — parse errors", () => {
  it("returns empty result for invalid JSON", () => {
    const result = parseJson("{not valid json}", 100);
    expect(result.headers).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });
});

describe("parseJson — truncation", () => {
  it("truncates to maxRows and sets truncated = true", () => {
    const result = parseJson(JSON_ARRAY, 2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.totalRows).toBe(3);
  });
});

describe("parseJson — nested values", () => {
  it("stringifies nested objects", () => {
    const data = JSON.stringify([{ meta: { x: 1 } }]);
    const result = parseJson(data, 100);
    const metaIdx = result.headers.indexOf("meta");
    expect(result.rows[0]?.[metaIdx]).toBe('{"x":1}');
  });
});

// ---------------------------------------------------------------------------
// NDJSON tests
// ---------------------------------------------------------------------------

const NDJSON_BODY = [
  JSON.stringify({ name: "Alice", score: 100 }),
  JSON.stringify({ name: "Bob", score: 85 }),
  JSON.stringify({ name: "Charlie", score: 90 }),
].join("\n");

describe("parseNdjson — basic parsing", () => {
  it("extracts headers from the union of all line keys", () => {
    const result = parseNdjson(NDJSON_BODY, 100);
    expect(result.headers).toContain("name");
    expect(result.headers).toContain("score");
  });

  it("returns correct row data", () => {
    const result = parseNdjson(NDJSON_BODY, 100);
    expect(result.rows).toHaveLength(3);
  });

  it("sets totalRows = number of lines", () => {
    const result = parseNdjson(NDJSON_BODY, 100);
    expect(result.totalRows).toBe(3);
  });
});

describe("parseNdjson — malformed lines", () => {
  it("skips malformed JSON lines", () => {
    const body = [
      JSON.stringify({ a: 1 }),
      "{ invalid }",
      JSON.stringify({ a: 2 }),
    ].join("\n");
    const result = parseNdjson(body, 100);
    // 3 total lines, 2 valid records
    expect(result.rows).toHaveLength(2);
  });
});

describe("parseNdjson — truncation", () => {
  it("truncates to maxRows and sets truncated = true", () => {
    const result = parseNdjson(NDJSON_BODY, 2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.totalRows).toBe(3);
  });
});

describe("parseNdjson — sparse columns", () => {
  it("handles sparse keys across lines (missing columns are empty)", () => {
    const body = [
      JSON.stringify({ a: 1, b: 2 }),
      JSON.stringify({ a: 3, c: 4 }),
    ].join("\n");
    const result = parseNdjson(body, 100);
    expect(result.headers).toContain("a");
    expect(result.headers).toContain("b");
    expect(result.headers).toContain("c");
    // Second row has no "b" → empty string
    const bIdx = result.headers.indexOf("b");
    const cIdx = result.headers.indexOf("c");
    expect(result.rows[1]?.[bIdx]).toBe("");
    expect(result.rows[0]?.[cIdx]).toBe("");
  });
});
