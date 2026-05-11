/**
 * Tests for the CSV worker parser logic.
 *
 * We test the exported `parseCsv` function directly rather than spawning an
 * actual Worker (not supported in jsdom). The function implements the full
 * worker contract: parse body → { headers, rows, totalRows, truncated }.
 *
 * Coverage:
 * 1. Basic CSV with headers → correct headers and rows.
 * 2. Single-column CSV.
 * 3. maxRows truncation → truncated = true, rows.length = maxRows.
 * 4. First-N badge: totalRows reflects true count, rows.length ≤ maxRows.
 * 5. Empty body → empty result.
 * 6. CSV with quoted fields.
 */

import { describe, expect, it } from "vitest";
import { parseCsv } from "../csv.worker";

const SIMPLE_CSV = `name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,Chicago`;

describe("parseCsv — basic parsing", () => {
  it("returns correct headers from first row", () => {
    const result = parseCsv(SIMPLE_CSV, 100);
    expect(result.headers).toEqual(["name", "age", "city"]);
  });

  it("returns all data rows (excluding header)", () => {
    const result = parseCsv(SIMPLE_CSV, 100);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual(["Alice", "30", "NYC"]);
    expect(result.rows[2]).toEqual(["Charlie", "35", "Chicago"]);
  });

  it("sets totalRows = number of data rows (excluding header)", () => {
    const result = parseCsv(SIMPLE_CSV, 100);
    expect(result.totalRows).toBe(3);
  });

  it("sets truncated = false when all rows fit", () => {
    const result = parseCsv(SIMPLE_CSV, 100);
    expect(result.truncated).toBe(false);
  });
});

describe("parseCsv — truncation", () => {
  it("truncates rows to maxRows and sets truncated = true", () => {
    const result = parseCsv(SIMPLE_CSV, 2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("reports totalRows as the full count even when truncated", () => {
    const result = parseCsv(SIMPLE_CSV, 1);
    expect(result.totalRows).toBe(3);
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe("parseCsv — edge cases", () => {
  it("returns empty result for empty body", () => {
    const result = parseCsv("", 100);
    expect(result.headers).toEqual([]);
    expect(result.rows).toHaveLength(0);
    expect(result.totalRows).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("handles quoted fields with commas", () => {
    const csv = `name,address\nAlice,"123 Main St, NYC"`;
    const result = parseCsv(csv, 100);
    expect(result.headers).toEqual(["name", "address"]);
    expect(result.rows[0]).toEqual(["Alice", "123 Main St, NYC"]);
  });

  it("handles single-column CSV", () => {
    const csv = `id\n1\n2\n3`;
    const result = parseCsv(csv, 100);
    expect(result.headers).toEqual(["id"]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual(["1"]);
  });
});
