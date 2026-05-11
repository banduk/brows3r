import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "@/lib/fuzzy";

describe("fuzzyMatch", () => {
  it("returns null on no match", () => {
    expect(fuzzyMatch("abc", "xyz")).toBeNull();
    expect(fuzzyMatch("abc", "ab")).toBeNull(); // missing c
  });

  it("returns score 1 with empty match indexes for empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 1, matchIndexes: [] });
  });

  it("returns null when target is empty and query is not", () => {
    expect(fuzzyMatch("abc", "")).toBeNull();
  });

  it("matches characters in order (non-consecutive allowed)", () => {
    const m = fuzzyMatch("abc", "aXXbXXc");
    expect(m).not.toBeNull();
    expect(m?.matchIndexes).toEqual([0, 3, 6]);
  });

  it("is case-insensitive", () => {
    const m = fuzzyMatch("AbC", "aBc");
    expect(m).not.toBeNull();
    expect(m?.matchIndexes).toEqual([0, 1, 2]);
  });

  it("scores consecutive matches higher than spread-out ones", () => {
    const consecutive = fuzzyMatch("abc", "abc")?.score ?? 0;
    const spread = fuzzyMatch("abc", "aXXbXXc")?.score ?? 0;
    expect(consecutive).toBeGreaterThan(spread);
  });

  it("scores prefix matches higher than mid-string matches", () => {
    const prefix = fuzzyMatch("vac", "vacation.jpg")?.score ?? 0;
    const mid = fuzzyMatch("vac", "my-vacation.jpg")?.score ?? 0;
    expect(prefix).toBeGreaterThan(mid);
  });
});

describe("fuzzyFilter", () => {
  it("returns all items unchanged for empty query", () => {
    const items = ["alpha", "beta", "gamma"];
    expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
  });

  it("filters out non-matches and sorts by score", () => {
    const items = ["banana", "apple", "grape", "apricot"];
    const result = fuzzyFilter(items, "ap", (s) => s);
    // Both "apple" and "apricot" start with "ap"; "grape" matches "ap"
    // non-contiguously; "banana" has 'a' but no 'p' after it -> drop.
    expect(result).toContain("apple");
    expect(result).toContain("apricot");
    expect(result).toContain("grape");
    expect(result).not.toContain("banana");
    // Prefix matches should rank first.
    expect(result[0]).toMatch(/^ap/);
  });

  it("uses the getText projection", () => {
    interface Row {
      name: string;
      ignored: string;
    }
    const items: Row[] = [
      { name: "alpha", ignored: "zzz-match-zzz" },
      { name: "beta", ignored: "nope" },
    ];
    const result = fuzzyFilter(items, "match", (r) => r.ignored);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("alpha");
  });
});
