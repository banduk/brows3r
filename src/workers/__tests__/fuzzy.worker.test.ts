import { describe, expect, it } from "vitest";
import type { ObjectEntry } from "@/api/objects";
import { runFuzzyFilter } from "@/workers/fuzzy.worker";

function makeEntry(key: string, isPrefix = false): ObjectEntry {
  return {
    key,
    size: 0,
    lastModified: 0,
    storageClass: "STANDARD",
    eTag: null,
    isPrefix,
  } as ObjectEntry;
}

describe("runFuzzyFilter", () => {
  it("returns the input unchanged when the query is empty", () => {
    const items = [makeEntry("a/x.txt"), makeEntry("a/y.txt")];
    const out = runFuzzyFilter({
      requestId: 1,
      items,
      query: "",
      prefix: "a/",
    });
    expect(out.results).toBe(items);
    expect(out.requestId).toBe(1);
  });

  it("matches against the basename, ignoring the current prefix", () => {
    const items = [
      makeEntry("photos/2023/vacation.jpg"),
      makeEntry("photos/2023/work.pdf"),
    ];
    const out = runFuzzyFilter({
      requestId: 2,
      items,
      query: "vac",
      prefix: "photos/2023/",
    });
    expect(out.results.map((e) => e.key)).toEqual(["photos/2023/vacation.jpg"]);
  });

  it("strips trailing slash on folder entries so 'vac' matches 'vacation/'", () => {
    const items = [
      makeEntry("photos/2023/vacation/", true),
      makeEntry("photos/2023/work/", true),
    ];
    const out = runFuzzyFilter({
      requestId: 3,
      items,
      query: "vac",
      prefix: "photos/2023/",
    });
    expect(out.results.map((e) => e.key)).toEqual(["photos/2023/vacation/"]);
  });

  it("preserves the requestId so callers can drop stale responses", () => {
    const out = runFuzzyFilter({
      requestId: 42,
      items: [makeEntry("a.txt")],
      query: "a",
      prefix: "",
    });
    expect(out.requestId).toBe(42);
  });
});
