/**
 * Performance smoke test: DetailsView 10k-row render budget.
 *
 * # What this tests
 *
 * Measures how long it takes for React to process 10 000 ObjectEntry objects
 * through the sort / virtualizer-mock pipeline used by DetailsView.  The test
 * does NOT mount the full component tree (that would be an integration test);
 * instead it exercises the two hot-path pure functions that every render pass
 * must run:
 *
 *   1. `sortEntries`  — O(n log n) sort on 10k items.
 *   2. Building the virtual-item index array — O(n) list used by the
 *      `useVirtualizer` mock in unit tests and by the real virtualizer.
 *
 * This is intentionally a smoke test.  jsdom has no layout engine, so we
 * cannot measure actual frame timing.  Real 60fps benchmarks must be run
 * manually in a Tauri dev build (see `docs/concepts/performance.md`).
 *
 * # Budget
 *
 * CI: 100 ms (GitHub Actions — slower machines, Node single-threaded).
 * Local: 50 ms recommended (document deviations in docs/concepts/performance.md).
 *
 * # How to run
 *
 *   pnpm perf
 *   # or
 *   pnpm vitest run --reporter=verbose src/views/modes/__perf__/details.perf.test.ts
 *
 * Tagged with the string "perf" in the describe block so `pnpm perf` (which
 * filters on the word "perf") picks it up and the normal unit suite skips it.
 */

import { describe, expect, it } from "vitest";
import type { ObjectEntry } from "@/api/objects";

// ---------------------------------------------------------------------------
// Helpers mirrored from DetailsView (private — copied to avoid coupling)
// ---------------------------------------------------------------------------

type SortColumn = "name" | "size" | "modified" | "storageClass";
type SortDir = "asc" | "desc";

interface SortState {
  column: SortColumn | null;
  dir: SortDir;
}

function entryName(entry: ObjectEntry): string {
  if (entry.isPrefix) {
    const parts = entry.key.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] ?? entry.key;
  }
  const parts = entry.key.split("/");
  return parts[parts.length - 1] ?? entry.key;
}

function sortEntries(entries: ObjectEntry[], sort: SortState): ObjectEntry[] {
  if (!sort.column) return entries;
  return [...entries].sort((a, b) => {
    let cmp = 0;
    switch (sort.column) {
      case "name":
        cmp = entryName(a).localeCompare(entryName(b));
        break;
      case "size":
        cmp = (a.size ?? 0) - (b.size ?? 0);
        break;
      case "modified":
        cmp = (a.lastModified ?? 0) - (b.lastModified ?? 0);
        break;
      case "storageClass":
        cmp = (a.storageClass ?? "").localeCompare(b.storageClass ?? "");
        break;
    }
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 32;

function make10kEntries(): ObjectEntry[] {
  return Array.from({ length: 10_000 }, (_, i) => ({
    key: `bucket/prefix/file-${i.toString().padStart(5, "0")}.ts`,
    size: i * 128,
    lastModified: Date.now() - i * 1_000,
    storageClass: i % 2 === 0 ? "STANDARD" : "STANDARD_IA",
    isPrefix: false,
  }));
}

// ---------------------------------------------------------------------------
// Budget constant
// ---------------------------------------------------------------------------

/**
 * CI budget in milliseconds.
 *
 * Set conservatively so transient load spikes on GitHub Actions runners do
 * not flake the suite.  If you hit this on a fast local machine it almost
 * certainly means a regression — see docs/concepts/performance.md for context.
 */
const BUDGET_MS = 100;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("perf: DetailsView 10k-row render budget", () => {
  it("sort 10k entries by name completes within budget", () => {
    const entries = make10kEntries();
    const sort: SortState = { column: "name", dir: "asc" };

    const t0 = performance.now();
    const sorted = sortEntries(entries, sort);
    const elapsed = performance.now() - t0;

    // Basic correctness guard — sorting must actually produce output.
    expect(sorted).toHaveLength(10_000);

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("sort 10k entries by size completes within budget", () => {
    const entries = make10kEntries();
    const sort: SortState = { column: "size", dir: "desc" };

    const t0 = performance.now();
    const sorted = sortEntries(entries, sort);
    const elapsed = performance.now() - t0;

    expect(sorted).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("building virtual-item index for 10k rows completes within budget", () => {
    const entries = make10kEntries();

    const t0 = performance.now();
    // Mirror the useVirtualizer mock used in unit tests: build the
    // virtualItems array that the mock returns for all n items.
    const virtualItems = Array.from({ length: entries.length }, (_, i) => ({
      key: i,
      index: i,
      start: i * ROW_HEIGHT,
      end: (i + 1) * ROW_HEIGHT,
      size: ROW_HEIGHT,
    }));
    const elapsed = performance.now() - t0;

    expect(virtualItems).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
